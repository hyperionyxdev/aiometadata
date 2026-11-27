// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { ListedChannel } from '../livetv/lineup';
import type { Programme } from '../livetv/programmes';
import { LEAGUES } from './leagues';
import type { Game, Scoreboard } from './espn';
import { gameOfChannel, gamesNamed, looksLikeGame, showsGame, TeamNames } from './match';

const HOUR = 60 * 60 * 1000;
const BEHIND_MS = 6 * HOUR;
const AHEAD_MS = 30 * HOUR;
const MAX_LISTED = 300;

/**
 * How well a configuration's guide is matched to the day's games: each game with the channels found
 * showing it, and what in the guide looks like a game but matched none. For the owner to read, in the
 * dashboard, before anything is shown in the apps.
 */
export interface CheckSource {
  channels(): Promise<ListedChannel[]>;
  programmes(channels: ListedChannel[], from: number, to: number): Promise<Map<string, Programme[]>>;
}

export interface CheckedChannel {
  channel: string;
  number?: string;
  /** Matched by a programme's name, or by the channel's own (a channel made for the game). */
  by: 'programme' | 'channel';
  programme?: string;
}

export interface CheckedGame {
  league: string;
  game: string;
  start: string;
  state: Game['state'];
  detail: string;
  channels: CheckedChannel[];
}

export interface SportsCheck {
  checkedAt: string;
  from: string;
  to: string;
  channels: number;
  channelsWithGuide: number;
  programmes: number;
  leagues: Array<{ league: string; games: number; withChannels: number }>;
  failed: Array<{ league: string; why: string }>;
  games: CheckedGame[];
  /** Programmes named like a game and marked live or as sport, that matched no game. */
  unmatchedProgrammes: Array<{ channel: string; number?: string; programme: string; start: string }>;
  /** Channels named like a game that matched none. */
  unmatchedChannels: Array<{ channel: string; number?: string }>;
}

const keyOf = (channel: ListedChannel): string => `${channel.meta.type}|${channel.meta.id}`;
const iso = (at: number): string => new Date(at).toISOString();
const textOf = (programme: Programme): string => [programme.title, programme.episodeTitle].filter(Boolean).join(' · ');
const sporty = (programme: Programme): boolean =>
  programme.live === true || (programme.genres ?? []).some((genre) => /sport/i.test(genre));

export async function sportsCheck(source: CheckSource, board: Scoreboard, now: number): Promise<SportsCheck> {
  const from = now - BEHIND_MS;
  const to = now + AHEAD_MS;
  const [read, channels] = await Promise.all([board.games(from, to), source.channels()]);
  const games = read.games;
  const guide = await source.programmes(channels, from - 2 * HOUR, to + 4 * HOUR);
  const names = new TeamNames(games);

  const found = new Map<string, CheckedChannel[]>();
  const add = (game: Game, entry: CheckedChannel) => {
    const list = found.get(game.id) ?? [];
    if (!list.some((c) => c.channel === entry.channel && c.number === entry.number)) list.push(entry);
    found.set(game.id, list);
  };
  const unmatchedProgrammes: SportsCheck['unmatchedProgrammes'] = [];
  const unmatchedChannels: SportsCheck['unmatchedChannels'] = [];
  let programmes = 0;

  for (const channel of channels) {
    const own = guide.get(keyOf(channel)) ?? [];
    programmes += own.length;
    const number = channel.number ?? channel.meta.channelNumber;
    const shown = (entry: Omit<CheckedChannel, 'channel' | 'number'>): CheckedChannel => ({ channel: channel.meta.name, ...(number ? { number } : {}), ...entry });
    const byName = gameOfChannel(gamesNamed(channel.meta.name, games, names), now);
    if (byName) add(byName, shown({ by: 'channel' }));
    else if (looksLikeGame(channel.meta.name) && unmatchedChannels.length < MAX_LISTED) {
      unmatchedChannels.push({ channel: channel.meta.name, ...(number ? { number } : {}) });
    }
    for (const programme of own) {
      const text = textOf(programme);
      const shows = gamesNamed(text, games, names).filter((game) => showsGame(programme, game));
      for (const game of shows) add(game, shown({ by: 'programme', programme: text }));
      if (!shows.length && !byName && programme.start >= from && programme.start <= to && sporty(programme) && looksLikeGame(text)
        && unmatchedProgrammes.length < MAX_LISTED) {
        unmatchedProgrammes.push({ channel: channel.meta.name, ...(number ? { number } : {}), programme: text, start: iso(programme.start) });
      }
    }
  }

  const leagues = LEAGUES.map((league) => {
    const own = games.filter((game) => game.league === league.key);
    return { league: league.name, games: own.length, withChannels: own.filter((game) => found.has(game.id)).length };
  }).filter((row) => row.games > 0);

  return {
    checkedAt: iso(now),
    from: iso(from),
    to: iso(to),
    channels: channels.length,
    channelsWithGuide: channels.filter((channel) => (guide.get(keyOf(channel)) ?? []).length > 0).length,
    programmes,
    leagues,
    failed: read.failed.map(({ league, why }) => ({ league: LEAGUES.find((l) => l.key === league)?.name ?? league, why })),
    games: games.slice(0, MAX_LISTED).map((game) => ({
      league: game.leagueName,
      game: game.name,
      start: iso(game.start),
      state: game.state,
      detail: game.detail,
      channels: found.get(game.id) ?? [],
    })),
    unmatchedProgrammes,
    unmatchedChannels,
  };
}
