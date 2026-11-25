// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import type { DispatcharrClient } from './client';
import type { DispatcharrChannel, Lineup } from './lineup';

const logger = consola.withTag('JellyfinDispatcharr');

const DAY_MS = 24 * 60 * 60 * 1000;
// A kept day older than this isn't handed out while a new read is made: its programmes may stop
// where Dispatcharr's guide stopped then. The new read is waited for instead.
const STALE_GUIDE_MS = 30 * 60 * 1000;
// A day that could not be read is not asked for again for this long.
const FAILED_MS = 60 * 1000;
const EPG_IDS_MS = 6 * 60 * 60 * 1000;
// The guide-id list is read again this soon when a channel's guide is one it lacks.
const EPG_IDS_RECHECK_MS = 60 * 1000;
// The guide is read from a week back to a week ahead, the window /LiveTv/GuideInfo reports, plus
// the day before it (the Live TV code asks for that day too, for programmes begun before midnight).
// A day outside it answers with no programmes and is never read; kept days are held within it.
const WINDOW_DAYS = 7;

/** The first and last UTC day starts that are read. */
function window(now = Date.now()): { first: number; last: number } {
  return {
    first: Math.floor((now - WINDOW_DAYS * DAY_MS) / DAY_MS) * DAY_MS - DAY_MS,
    last: Math.floor((now + WINDOW_DAYS * DAY_MS) / DAY_MS) * DAY_MS,
  };
}

/** A programme in the Live TV code's shape, with what Dispatcharr's guide adds. */
export interface GuideProgramme {
  id: string;
  name: string;
  overview: string | null;
  start: number;
  end: number;
  season: number | null;
  episode: number | null;
  thumbnail: string | null;
  episodeTitle?: string;
  genres?: string[];
  live?: boolean;
  isNew?: boolean;
  premiere?: boolean;
  finale?: boolean;
  /** One of Dispatcharr's own placeholder programmes, made for a channel without a real guide. */
  placeholder?: boolean;
}

/** A grid row, kept with only what is used. */
interface Row {
  start: number;
  end: number;
  title: string;
  subTitle: string;
  description: string | null;
  season: number | null;
  episode: number | null;
  live: boolean;
  isNew: boolean;
  premiere: boolean;
  finale: boolean;
  placeholder: boolean;
  categories: string[];
  icon: string | null;
}

interface Day {
  at: number;
  /** Rows by tvg id, or by channel uuid for Dispatcharr's placeholders. */
  byKey: Map<string, Row[]>;
  epgIds: Map<number, string>;
  /** Each channel's programmes, made once per read. */
  made: Map<string, GuideProgramme[]>;
}

const finite = (value: unknown): number | null => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? n : null;
};
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function rowOf(p: any): { key: string; row: Row } | null {
  if (!p || typeof p.tvg_id !== 'string' || !p.tvg_id) return null;
  const start = Date.parse(String(p.start_time ?? ''));
  const end = Date.parse(String(p.end_time ?? ''));
  if (!(start < end)) return null;
  const custom = p.custom_properties && typeof p.custom_properties === 'object' ? p.custom_properties : {};
  const icon = text(custom.icon);
  return {
    key: p.tvg_id,
    row: {
      start,
      end,
      title: text(p.title),
      subTitle: text(p.sub_title),
      description: text(p.description) || null,
      season: finite(p.season),
      episode: finite(p.episode),
      live: p.is_live === true,
      isNew: p.is_new === true,
      premiere: p.is_premiere === true,
      finale: p.is_finale === true,
      placeholder: typeof p.id === 'string' && /^dummy-/.test(p.id),
      categories: Array.isArray(custom.categories) ? custom.categories.map(text).filter(Boolean) : [],
      icon: /^https?:\/\//i.test(icon) ? icon : null,
    },
  };
}

/**
 * The subtitle worth showing: the episode's name, or what a placeholder's own subtitle template made.
 * Not one that only says what kind of channel it is: Dispatcharr's "24/7 Channel", or the channel's
 * own group ("Soccer"), which would otherwise read as part of every programme.
 */
export function shownSubtitle(subTitle: string, group: string): string | undefined {
  const sub = subTitle.trim();
  if (!sub) return undefined;
  if (/^24\s*\/\s*7\b/i.test(sub)) return undefined;
  if (group && sub.toLowerCase() === group.toLowerCase()) return undefined;
  return sub;
}

function programmeOf(channel: DispatcharrChannel, row: Row): GuideProgramme {
  const episodeTitle = shownSubtitle(row.subTitle, channel.group);
  return {
    // The same ids the Dispatcharr addon gave its programmes: channel, start and end.
    id: `${channel.metaId}:${Math.floor(row.start / 1000)}:${Math.floor(row.end / 1000)}`,
    name: row.title,
    overview: row.description,
    start: row.start,
    end: row.end,
    season: row.season,
    episode: row.episode,
    thumbnail: row.icon,
    ...(episodeTitle ? { episodeTitle } : {}),
    ...(row.categories.length ? { genres: row.categories } : {}),
    live: row.live,
    isNew: row.isNew,
    premiere: row.premiere,
    finale: row.finale,
    ...(row.placeholder ? { placeholder: true } : {}),
  };
}

export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * Dispatcharr's guide, a UTC day at a time from /api/epg/grid/, matched to channels the way
 * Dispatcharr matches them: a stored programme by its guide's tvg id (through /api/epg/epgdata/), a
 * placeholder by the channel's uuid. Requests for the same day share one read.
 */
export class Guide {
  private days = new Map<number, Day>();
  private loading = new Map<number, Promise<Day | null>>();
  private failedAt = new Map<number, number>();
  private epgIds: { at: number; byId: Map<number, string> } | null = null;
  private epgLoading: Promise<void> | null = null;

  constructor(private readonly client: DispatcharrClient, private readonly cacheMs: number) {}

  /** The tvg id Dispatcharr files each guide under, by guide (EPG data) id. */
  private async guideIds(lineup: Lineup | null): Promise<Map<number, string>> {
    const age = this.epgIds ? Date.now() - this.epgIds.at : Infinity;
    // A channel pointing at a guide id the list doesn't hold (its guide was changed in Dispatcharr)
    // makes the list due again after a minute rather than six hours.
    const missing = (lineup?.channels ?? []).some((c) => c.epgDataId !== null && !this.epgIds?.byId.has(c.epgDataId));
    if (this.epgIds && age < EPG_IDS_MS && !(missing && age > EPG_IDS_RECHECK_MS)) return this.epgIds.byId;
    this.epgLoading ??= this.client.list('/api/epg/epgdata/')
      .then((rows) => {
        this.epgIds = { at: Date.now(), byId: new Map(rows.filter((r) => finite(r?.id) !== null && typeof r.tvg_id === 'string').map((r) => [Number(r.id), r.tvg_id])) };
      })
      .catch((error: any) => logger.warn(`Dispatcharr's guide ids could not be read: ${error?.message || error}`))
      .finally(() => (this.epgLoading = null));
    // While the new list loads, the held one serves, unless it is the one missing a channel's guide.
    if (this.epgIds && !missing) return this.epgIds.byId;
    await this.epgLoading;
    return this.epgIds?.byId ?? new Map();
  }

  private async read(start: number, lineup: Lineup | null): Promise<Day | null> {
    const started = Date.now();
    const query = new URLSearchParams({ start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() });
    try {
      const [data, epgIds] = await Promise.all([this.client.get(`/api/epg/grid/?${query}`), this.guideIds(lineup)]);
      const byKey = new Map<string, Row[]>();
      let count = 0;
      for (const p of Array.isArray(data?.data) ? data.data : []) {
        const found = rowOf(p);
        if (!found) continue;
        const list = byKey.get(found.key);
        if (list) list.push(found.row);
        else byKey.set(found.key, [found.row]);
        count++;
      }
      const day: Day = { at: Date.now(), byKey, epgIds, made: new Map() };
      this.days.set(start, day);
      this.failedAt.delete(start);
      logger.info(`Read Dispatcharr's guide for ${new Date(start).toISOString().slice(0, 10)}: ${count} programmes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      this.trim();
      return day;
    } catch (error: any) {
      logger.warn(`Dispatcharr's guide for ${new Date(start).toISOString().slice(0, 10)} could not be read: ${error?.message || error}`);
      this.failedAt.set(start, Date.now());
      this.trim();
      return this.days.get(start) ?? null;
    }
  }

  /** Drops kept days and failures outside the window, so neither grows while the days go by. */
  private trim(): void {
    const { first, last } = window();
    for (const held of [this.days, this.failedAt]) {
      for (const key of held.keys()) if (key < first || key > last) held.delete(key);
    }
  }

  /**
   * One UTC day, or null when it could not be read. A kept copy younger than the cache time answers;
   * one up to half an hour old answers at once while a new read is made; an older one waits for it.
   */
  async day(day: string, lineup: Lineup | null): Promise<Day | null> {
    const start = dayStart(day);
    if (!Number.isFinite(start)) return null;
    const { first, last } = window();
    if (start < first || start > last) return { at: Date.now(), byKey: new Map(), epgIds: new Map(), made: new Map() };
    const kept = this.days.get(start);
    const age = kept ? Date.now() - kept.at : Infinity;
    if (kept && age < this.cacheMs) return kept;
    const failed = this.failedAt.get(start);
    if (failed !== undefined && Date.now() - failed < FAILED_MS) return kept ?? null;
    let reading = this.loading.get(start);
    if (!reading) {
      reading = this.read(start, lineup).finally(() => this.loading.delete(start));
      this.loading.set(start, reading);
    }
    return kept && age < STALE_GUIDE_MS ? kept : reading;
  }

  /** A channel's programmes in a day that was read, in time order. */
  programmes(day: Day, channel: DispatcharrChannel): GuideProgramme[] {
    const held = day.made.get(channel.metaId);
    if (held) return held;
    const tvg = channel.epgDataId !== null ? day.epgIds.get(channel.epgDataId) : undefined;
    const rows = (tvg ? day.byKey.get(tvg) : undefined) ?? day.byKey.get(channel.uuid) ?? [];
    const list = rows.map((row) => programmeOf(channel, row)).sort((a, b) => a.start - b.start);
    day.made.set(channel.metaId, list);
    return list;
  }

  /** What is on now on a channel, from a kept copy of today only (never a read): for the channel's "Now:" line. */
  airing(channel: DispatcharrChannel, now = Date.now()): string | undefined {
    const day = this.days.get(Math.floor(now / DAY_MS) * DAY_MS);
    if (!day || now - day.at > STALE_GUIDE_MS) return undefined;
    const on = this.programmes(day, channel).find((p) => p.start <= now && now < p.end);
    return on?.name ? (on.episodeTitle ? `${on.name} – ${on.episodeTitle}` : on.name) : undefined;
  }
}
