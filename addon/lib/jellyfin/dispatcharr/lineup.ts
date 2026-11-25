// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import type { DispatcharrClient } from './client';
import type { DispatcharrSettings } from './settings';

const logger = consola.withTag('JellyfinDispatcharr');

/** The prefix of every channel's meta id: the same ids the Dispatcharr addon gave, so favourites carry over. */
export const ID_PREFIX = 'dispatcharr:';
export const CHANNEL_TYPE = 'tv';
// The group of a channel Dispatcharr puts in none.
const NO_GROUP = 'Channels';

export interface DispatcharrChannel {
  /** Dispatcharr's channel id, also its XC stream id. */
  id: number;
  uuid: string;
  metaId: string;
  number: number | null;
  name: string;
  group: string;
  logoId: number | null;
  epgDataId: number | null;
  catchupDays: number;
}

export interface Lineup {
  channels: DispatcharrChannel[];
  byMetaId: Map<string, DispatcharrChannel>;
  /** In channel-number order (each group where its first channel is), or in JELLYFIN_DISPATCHARR_GROUPS' order. */
  groups: string[];
  /** M3U account names by id, and those switched off. */
  accounts: Map<number, string>;
  inactive: Set<number>;
  at: number;
}

const finite = (value: unknown): number | null => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? n : null;
};

/** Catch-up days from an XC channel entry (tv_archive / tv_archive_duration), 0 without one. */
export function catchupDaysOf(entry: any): number {
  if (!entry || Number(entry.tv_archive) !== 1) return 0;
  return Math.max(0, Number(entry.tv_archive_duration) || 0);
}

/** The channel a meta id names (`dispatcharr:7`, or a programme's `dispatcharr:7:<start>:<end>`). */
export function channelIdOf(metaId: string): string | null {
  if (!metaId.startsWith(ID_PREFIX)) return null;
  const id = metaId.slice(ID_PREFIX.length).split(':')[0];
  return /^\d+$/.test(id) ? id : null;
}

function ordered(groups: string[], wanted: string[]): string[] {
  if (!wanted.length) return groups;
  const rank = new Map(wanted.map((g, i) => [g.toLowerCase(), i]));
  return [...groups].sort((a, b) => (rank.get(a.toLowerCase()) ?? Infinity) - (rank.get(b.toLowerCase()) ?? Infinity));
}

/** Builds the lineup from Dispatcharr's answers: hidden channels left out, effective values used. */
export function buildLineup(settings: DispatcharrSettings, rows: { channels: any[]; groups: any[]; accounts: any[]; xc: any[] | null }): Lineup {
  const groupNames = new Map<number, string>(rows.groups.filter((g) => g && typeof g.name === 'string').map((g) => [Number(g.id), g.name]));
  const accounts = new Map<number, string>(rows.accounts.filter((a) => a && typeof a.name === 'string').map((a) => [Number(a.id), a.name]));
  const inactive = new Set<number>(rows.accounts.filter((a) => a?.is_active === false).map((a) => Number(a.id)));
  // With an XC login: that user's channels only, and their catch-up days.
  const visible = rows.xc ? new Map(rows.xc.map((x) => [String(x?.stream_id), x])) : null;
  const wanted = new Set(settings.groups.map((g) => g.toLowerCase()));
  const channels: DispatcharrChannel[] = [];
  for (const c of rows.channels) {
    if (!c || c.hidden_from_output === true || finite(c.id) === null || typeof c.uuid !== 'string') continue;
    if (visible && !visible.has(String(c.id))) continue;
    const group = groupNames.get(Number(c.effective_channel_group_id ?? c.channel_group_id)) ?? NO_GROUP;
    if (wanted.size && !wanted.has(group.toLowerCase())) continue;
    const name = String(c.effective_name ?? c.name ?? '').trim() || `Channel ${c.id}`;
    channels.push({
      id: Number(c.id),
      uuid: c.uuid,
      metaId: `${ID_PREFIX}${c.id}`,
      number: finite(c.effective_channel_number ?? c.channel_number),
      name,
      group,
      logoId: finite(c.effective_logo_id ?? c.logo_id),
      epgDataId: finite(c.effective_epg_data_id ?? c.epg_data_id),
      catchupDays: catchupDaysOf(visible?.get(String(c.id))),
    });
  }
  channels.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.name.localeCompare(b.name));
  return {
    channels,
    byMetaId: new Map(channels.map((c) => [c.metaId, c])),
    groups: ordered([...new Set(channels.map((c) => c.group))], settings.groups),
    accounts,
    inactive,
    at: Date.now(),
  };
}

/** Reads the lineup: channels, groups and M3U accounts, and the XC login's channels where one is set. */
export async function readLineup(client: DispatcharrClient, settings: DispatcharrSettings): Promise<Lineup> {
  const started = Date.now();
  const [channels, groups, accounts, xc] = await Promise.all([
    client.list('/api/channels/channels/'),
    client.list('/api/channels/groups/'),
    // Needs a Standard or Admin user; without it, sources are named by their place.
    client.list('/api/m3u/accounts/').catch(() => []),
    settings.xc ? client.xcLiveStreams(settings.xc) : Promise.resolve(null),
  ]);
  const lineup = buildLineup(settings, { channels, groups, accounts, xc });
  const as = xc ? ' (as the XC login sees them)' : '';
  logger.info(`Read ${lineup.channels.length} channels in ${lineup.groups.length} groups from Dispatcharr in ${((Date.now() - started) / 1000).toFixed(1)}s${as}`);
  return lineup;
}

export function logoUrl(settings: DispatcharrSettings, channel: DispatcharrChannel): string | undefined {
  return channel.logoId !== null ? `${settings.streamUrl}/api/channels/logos/${channel.logoId}/cache/` : undefined;
}

/** A channel as a catalog meta, the shape the Live TV code reads channels in. */
export function channelMeta(settings: DispatcharrSettings, channel: DispatcharrChannel, now?: string): any {
  const logo = logoUrl(settings, channel);
  return {
    id: channel.metaId,
    type: CHANNEL_TYPE,
    name: channel.name,
    ...(logo ? { poster: logo, logo } : {}),
    posterShape: 'square',
    genres: [channel.group],
    ...(channel.number !== null ? { channelNumber: String(channel.number) } : {}),
    ...(now ? { description: `Now: ${now}` } : {}),
    behaviorHints: { isLive: true, ...(channel.catchupDays ? { catchupDays: channel.catchupDays } : {}) },
  };
}

/** The lineup's channels a catalog request asks for: by ids, else by group and search words. */
export function selectChannels(lineup: Lineup, extra: { genre?: string; search?: string; ids?: string }): DispatcharrChannel[] {
  if (extra.ids) {
    const ids = new Set(extra.ids.split(',').map((id) => channelIdOf(id.trim())).filter((id): id is string => !!id));
    return lineup.channels.filter((c) => ids.has(String(c.id)));
  }
  let list = lineup.channels;
  if (extra.genre) list = list.filter((c) => c.group === extra.genre);
  if (extra.search) {
    const words = extra.search.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((c) => {
      const text = `${c.number ?? ''} ${c.name} ${c.group}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }
  return list;
}
