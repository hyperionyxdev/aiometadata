// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { liveTvReady, type GateDeps } from '../livetv/gate';
import { programmesFor } from '../livetv/guide';
import { listChannels } from '../livetv/lineup';
import { sportsCheck, type SportsCheck } from './check';
import { scoreboard } from './espn';

// Every channel the configuration lists, as the apps' own lists can reach them.
const ALL_CHANNELS = 5000;

/** The sports check over a configuration's own Live TV; null where it has none. */
export async function checkSportsFor(gate: GateDeps, config: any, now = Date.now()): Promise<SportsCheck | null> {
  const live = await liveTvReady(gate, config);
  if (!live) return null;
  return sportsCheck({
    channels: async () => (await listChannels(gate.addon, live.base, live.catalogs, { startIndex: 0, limit: ALL_CHANNELS })).channels,
    programmes: (channels, from, to) => programmesFor(gate.addon, live.base, live.reach, channels.map((channel) => channel.meta), from, to),
  }, scoreboard, now);
}
