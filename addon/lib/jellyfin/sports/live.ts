// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { liveTvReady, type GateDeps } from '../livetv/gate';
import { programmesFor } from '../livetv/guide';
import { listChannels, type ListedChannel } from '../livetv/lineup';
import type { Programme } from '../livetv/programmes';
import { sportsCheck, type SportsCheck } from './check';
import { scoreboard } from './espn';

// Every channel the configuration lists.
const ALL_CHANNELS = 100000;
// The guide is read this many channels at a time: one read of a very large guide stops short.
const CHANNELS_AT_ONCE = 1000;

/** A guide's programmes for many channels, read a share at a time. */
export async function programmesInParts(read: (metas: ListedChannel['meta'][]) => Promise<Map<string, Programme[]>>, channels: ListedChannel[]): Promise<Map<string, Programme[]>> {
  const all = new Map<string, Programme[]>();
  for (let n = 0; n < channels.length; n += CHANNELS_AT_ONCE) {
    for (const [key, list] of await read(channels.slice(n, n + CHANNELS_AT_ONCE).map((channel) => channel.meta))) all.set(key, list);
  }
  return all;
}

/** The sports check over a configuration's own Live TV; null where it has none. */
export async function checkSportsFor(gate: GateDeps, config: any, now = Date.now()): Promise<SportsCheck | null> {
  const live = await liveTvReady(gate, config);
  if (!live) return null;
  const check = await sportsCheck({
    channels: async () => (await listChannels(gate.addon, live.base, live.catalogs, { startIndex: 0, limit: ALL_CHANNELS })).channels,
    programmes: (channels, from, to) => programmesInParts((metas) => programmesFor(gate.addon, live.base, live.reach, metas, from, to), channels),
  }, scoreboard, now);
  return { guide: [live.base, ...live.catalogs.map((catalog) => `${catalog.type}/${catalog.id}`)].join('|'), ...check };
}
