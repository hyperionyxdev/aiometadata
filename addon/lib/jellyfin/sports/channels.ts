// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { ListedChannel } from '../livetv/lineup';
import type { Programme } from '../livetv/programmes';
import { sportsFirst, sportyChannel } from './check';
import type { Game } from './espn';
import { channelsByGame, GameFinder, type GameChannel } from './guide';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// The channels known to show sport are read again this often, for new games and changed listings.
const SPORTS_EVERY_MS = 5 * MINUTE;
// The whole guide is read again this often, for a channel showing sport for the first time.
const WHOLE_EVERY_MS = 6 * HOUR;
// How long the first ask waits for the first reading, before answering without channels.
const FIRST_WAIT_MS = 3000;
const CHUNK = 1000;

export interface ChannelSource {
  channels(): Promise<ListedChannel[]>;
  programmes(channels: ListedChannel[]): Promise<Map<string, Programme[]>>;
  games(): Promise<Game[]>;
}

interface Held {
  at: number;
  wholeAt: number;
  byGame: Map<string, GameChannel[]>;
  /** The channels found showing a game in the last whole reading and since. */
  sports: Set<string>;
  reading: Promise<void> | null;
}

const keyOf = (channel: ListedChannel): string => `${channel.meta.type}|${channel.meta.id}`;
const held = new Map<string, Held>();

/** For tests: forget what was found. */
export function forgetGameChannels(): void {
  held.clear();
}

async function read(state: Held, source: ChannelSource, whole: boolean, clock: () => number): Promise<void> {
  const [listed, games] = await Promise.all([source.channels(), source.games()]);
  const channels = whole ? sportsFirst(listed) : listed.filter((c) => state.sports.has(keyOf(c)) || sportyChannel(c));
  const finder = new GameFinder(games, clock());
  const byGame = new Map<string, GameChannel[]>();
  const sports = whole ? new Set<string>() : new Set(state.sports);
  for (let at = 0; at < channels.length; at += CHUNK) {
    // Between shares, the server answers whatever else is waiting.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const part = channels.slice(at, at + CHUNK);
    const guide = await source.programmes(part);
    for (const [game, list] of channelsByGame(finder, part, guide)) {
      byGame.set(game, [...(byGame.get(game) ?? []), ...list]);
      for (const { channel } of list) sports.add(keyOf(channel));
    }
  }
  state.byGame = byGame;
  state.sports = sports;
  state.at = clock();
  if (whole) state.wholeAt = state.at;
}

/**
 * Which channels show which game, for a guide: the whole guide read once (sports channels first),
 * then every few minutes only the channels found showing sport, and the whole again every few hours.
 * Read in the background, a share at a time, so the list of games answers at once with what was
 * found last; the first ask waits a moment for the first reading. `complete` is false until then.
 */
export async function gameChannels(guide: string, source: ChannelSource, clock: () => number = Date.now): Promise<{ byGame: Map<string, GameChannel[]>; complete: boolean }> {
  let state = held.get(guide);
  if (!state) {
    state = { at: 0, wholeAt: 0, byGame: new Map(), sports: new Set(), reading: null };
    held.set(guide, state);
  }
  const now = clock();
  if (!state.reading && now - state.at >= SPORTS_EVERY_MS) {
    const whole = now - state.wholeAt >= WHOLE_EVERY_MS;
    const current = state;
    current.reading = read(current, source, whole, clock)
      .catch(() => undefined)
      .finally(() => {
        current.reading = null;
      });
  }
  if (!state.at && state.reading) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([state.reading, new Promise<void>((resolve) => (timer = setTimeout(resolve, FIRST_WAIT_MS)))]);
    clearTimeout(timer);
  }
  return { byGame: state.byGame, complete: state.at > 0 };
}
