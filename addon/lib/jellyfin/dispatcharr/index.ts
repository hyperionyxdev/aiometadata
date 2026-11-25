// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { DispatcharrClient } from './client';
import { Guide, type GuideProgramme } from './guide';
import { CHANNEL_TYPE, channelIdOf, channelMeta, readLineup, selectChannels, type Lineup } from './lineup';
import { STREAM_GROUP, catchupSources, liveSources } from './playback';
import { allowedFor, dispatcharrSettings, settingsFingerprint, type DispatcharrSettings, type WhoProfile } from './settings';

export type { GuideProgramme } from './guide';
export { allowedFor, type WhoProfile } from './settings';

const logger = consola.withTag('JellyfinDispatcharr');

// How often the running channels' streams are read, and how long a login that may not read them is left alone.
const STATUS_MS = 10 * 1000;
const STATUS_REFUSED_MS = 60 * 60 * 1000;
// How long a channel's streams are kept for its sources.
const STREAMS_MS = 60 * 1000;
const LINEUP_RETRY_MS = 30 * 1000;
// The longest a chosen version's answer waits for its channel to be switched.
const SWITCH_WAIT_MS = 3 * 1000;

/**
 * Live TV read straight from Dispatcharr: the lineup, a day of the guide and a channel's sources,
 * in the shapes the Live TV code reads from a stream addon's live catalog (channel metas, programmes
 * and Stremio-style streams), so it serves them the same way. No group name ever goes into a path.
 */
export class DispatcharrLive {
  readonly client: DispatcharrClient;
  readonly guide: Guide;
  private lineupHeld: Lineup | null = null;
  private lineupLoading: Promise<Lineup> | null = null;
  private lineupFailure: { at: number; error: any } | null = null;
  private status: { at: number; map: Map<string, number> } | null = null;
  private statusLoading: Promise<void> | null = null;
  private statusRefusedAt = 0;
  private channelStreams = new Map<number, { at: number; streams: any[] }>();
  private streamsLoading = new Map<number, Promise<any[]>>();
  // The stream last chosen for a channel that wasn't running yet, switched to once it runs.
  private wanted = new Map<string, number>();

  constructor(readonly settings: DispatcharrSettings) {
    this.client = new DispatcharrClient(settings);
    this.guide = new Guide(this.client, settings.cacheMs);
  }

  /** The lineup read last, without reading it. */
  known(): Lineup | null {
    return this.lineupHeld;
  }

  /** The lineup: a fresh copy, else a kept one at once while a new one is read, else the first read. */
  async lineup(): Promise<Lineup> {
    const held = this.lineupHeld;
    if (held && Date.now() - held.at < this.settings.cacheMs) return held;
    // Never read yet and just failed: every request in the next moments fails at once rather than waiting again.
    if (!held && this.lineupFailure && Date.now() - this.lineupFailure.at < LINEUP_RETRY_MS) throw this.lineupFailure.error;
    this.lineupLoading ??= readLineup(this.client, this.settings)
      .then((lineup) => {
        this.lineupFailure = null;
        return (this.lineupHeld = lineup);
      })
      .catch((error: any) => {
        logger.warn(`Dispatcharr's channels could not be read: ${error?.message || error}`);
        this.lineupFailure = { at: Date.now(), error };
        if (!this.lineupHeld) throw error;
        return this.lineupHeld;
      })
      .finally(() => (this.lineupLoading = null));
    return held ?? this.lineupLoading;
  }

  /** Channel metas for a catalog request: by `ids`, else by `genre` and `search`; the whole list, unpaged. */
  async catalog(extra: Record<string, string | undefined>): Promise<any[]> {
    const lineup = await this.lineup();
    const now = Date.now();
    return selectChannels(lineup, extra).map((channel) => channelMeta(this.settings, channel, this.guide.airing(channel, now)));
  }

  /** A UTC day of the guide for these channels by meta id, or null when Dispatcharr could not be read for it. */
  async guideDay(day: string, metaIds: string[]): Promise<Map<string, GuideProgramme[]> | null> {
    const lineup = await this.lineup();
    const read = await this.guide.day(day, lineup);
    if (!read) return null;
    const out = new Map<string, GuideProgramme[]>();
    for (const metaId of metaIds) {
      const channel = lineup.byMetaId.get(metaId);
      if (channel) out.set(metaId, this.guide.programmes(read, channel));
    }
    return out;
  }

  /** Which stream each running channel is on, read at most every ten seconds; null for a login that may not. */
  private async activeStreams(): Promise<Map<string, number> | null> {
    if (Date.now() - this.statusRefusedAt < STATUS_REFUSED_MS) return null;
    if (this.status && Date.now() - this.status.at < STATUS_MS) return this.status.map;
    this.statusLoading ??= this.client.activeStreams()
      .then((map) => {
        if (map === null) this.statusRefusedAt = Date.now();
        else this.status = { at: Date.now(), map };
      })
      .catch((error: any) => logger.debug(`Dispatcharr's running channels could not be read: ${error?.message || error}`))
      .finally(() => (this.statusLoading = null));
    await this.statusLoading;
    return this.status?.map ?? null;
  }

  /** A channel's streams in its own order, read when its sources are asked for. */
  private async streamsOf(id: number): Promise<any[]> {
    const held = this.channelStreams.get(id);
    if (held && Date.now() - held.at < STREAMS_MS) return held.streams;
    let reading = this.streamsLoading.get(id);
    if (!reading) {
      reading = this.client.get(`/api/channels/channels/${id}/?include_streams=true`)
        .then((row) => {
          const streams = Array.isArray(row?.streams) ? row.streams.filter((s: unknown) => s && typeof s === 'object') : [];
          this.channelStreams.set(id, { at: Date.now(), streams });
          return streams;
        })
        .catch((error: any) => {
          // The channel still plays as itself (Auto); its streams are left out until they can be read.
          logger.warn(`A channel's streams could not be read from Dispatcharr: ${error?.message || error}`);
          return held?.streams ?? [];
        })
        .finally(() => this.streamsLoading.delete(id));
      this.streamsLoading.set(id, reading);
    }
    return reading;
  }

  /**
   * The sources for a channel (`dispatcharr:7`) or a programme (`dispatcharr:7:<start>:<end>`): a
   * programme plays live while it's on, and from catch-up once it has ended, where the channel has it.
   */
  async streams(type: string, metaId: string): Promise<any[]> {
    if (type !== CHANNEL_TYPE) return [];
    const id = channelIdOf(metaId);
    if (!id) return [];
    const lineup = await this.lineup();
    const channel = lineup.byMetaId.get(`dispatcharr:${id}`);
    if (!channel) return [];
    const [, start, end] = metaId.slice('dispatcharr:'.length).split(':').map(Number);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const now = Date.now() / 1000;
      if (start > now) return [];
      if (end <= now) return catchupSources(this.settings, channel, start, end, now);
    }
    const [streams, active] = await Promise.all([this.streamsOf(channel.id), this.activeStreams()]);
    return liveSources(this.settings, lineup, channel, streams, active);
  }

  /**
   * A version was chosen to play. With switching on, one of a channel's streams switches the
   * channel to it: a running channel before the answer where Dispatcharr is quick, one that isn't
   * running yet once it starts. The answer waits `waitMs` at most; a slower switch goes on after it.
   */
  async chosen(metaId: string, bingeGroup: unknown, waitMs = SWITCH_WAIT_MS): Promise<void> {
    if (!this.settings.switchStreams) return;
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    });
    await Promise.race([this.switchChosen(metaId, bingeGroup), waited]);
    clearTimeout(timer);
  }

  private async switchChosen(metaId: string, bingeGroup: unknown): Promise<void> {
    const match = STREAM_GROUP.exec(String(bingeGroup ?? ''));
    const id = channelIdOf(metaId);
    const channel = id ? this.lineupHeld?.byMetaId.get(`dispatcharr:${id}`) : undefined;
    if (!match || !channel) return;
    const streamId = Number(match[1]);
    this.wanted.set(channel.uuid, streamId);
    try {
      const map = await this.client.activeStreams();
      if (map === null) throw new Error('reading which channels are running needs an admin login');
      const running = map.get(channel.uuid);
      if (running !== undefined) await this.switchTo(channel.uuid, streamId, running);
      else this.switchOnceRunning(channel.uuid, streamId);
    } catch (error: any) {
      logger.warn(`A channel could not be switched to the stream chosen: ${error?.message || error}`);
    }
  }

  private async switchTo(uuid: string, streamId: number, running: number): Promise<void> {
    if (running !== streamId) await this.client.changeStream(uuid, streamId);
    // The next sources read the stream it's on now.
    this.status = null;
    if (this.wanted.get(uuid) === streamId) this.wanted.delete(uuid);
  }

  /** Waits up to 30 seconds for the channel to start, then switches it; a newer choice takes over. */
  private async switchOnceRunning(uuid: string, streamId: number): Promise<void> {
    let lastError: any;
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000).unref?.());
      if (this.wanted.get(uuid) !== streamId) return;
      const running = (await this.client.activeStreams().catch(() => null))?.get(uuid);
      if (running === undefined) continue;
      try {
        return await this.switchTo(uuid, streamId, running);
      } catch (error) {
        // Dispatcharr may turn a switch down while the channel is still starting; the loop tries again.
        lastError = error;
      }
    }
    if (this.wanted.get(uuid) === streamId) this.wanted.delete(uuid);
    logger.warn(`A channel could not be switched to the stream chosen: ${lastError?.message ?? 'it did not start within 30 seconds'}`);
  }
}

let current: { fingerprint: string; live: DispatcharrLive } | null = null;
let announced = false;

/** Dispatcharr Live TV as the environment sets it up, or null when it isn't. */
export function dispatcharrLive(): DispatcharrLive | null {
  const settings = dispatcharrSettings();
  if (!settings) {
    current = null;
    return null;
  }
  const fingerprint = settingsFingerprint(settings);
  if (current?.fingerprint !== fingerprint) {
    current = { fingerprint, live: new DispatcharrLive(settings) };
    if (!announced) {
      announced = true;
      const who = settings.users.length ? `${settings.users.length} listed configuration(s) or profile(s)` : 'every configuration on this server';
      logger.info(`Live TV comes straight from Dispatcharr, for ${who}${settings.xc ? ', with catch-up through the XC login' : ''}`);
    }
  }
  return current.live;
}

/** Dispatcharr Live TV for this configuration's profile, or null to use the stream addon's live catalogs. */
export function dispatcharrFor(who: { userUUID?: string; profiles?: WhoProfile[] }): DispatcharrLive | null {
  const live = dispatcharrLive();
  return live && allowedFor(live.settings, who) ? live : null;
}
