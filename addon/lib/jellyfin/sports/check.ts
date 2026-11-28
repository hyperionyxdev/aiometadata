// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { ListedChannel } from '../livetv/lineup';
import type { Programme } from '../livetv/programmes';
import { LEAGUES } from './leagues';
import type { Game, Scoreboard } from './espn';
import { channelsByGame, GameFinder } from './guide';
import { looksLikeGame, teamKey } from './match';

const HOUR = 60 * 60 * 1000;
const BEHIND_MS = 12 * HOUR;
const AHEAD_MS = 30 * HOUR;
const MAX_LISTED = 300;
// Around a game not found: programmes this near its start that name one of its teams.
const NEAR_MS = 3 * HOUR;
const NEAR_PER_GAME = 5;
const MAX_NEAR_GAMES = 150;

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

export interface NearMiss {
  league: string;
  game: string;
  start: string;
  programmes: Array<{ channel: string; number?: string; programme: string; start: string }>;
}

export interface SportsCheck {
  /** Which guide it is: configurations with the same Live TV share one. */
  guide?: string;
  checkedAt: string;
  from: string;
  to: string;
  /** Channels listed, how many of them were read (sports channels first) in the time given, and that time. */
  channels: number;
  channelsRead: number;
  seconds: number;
  channelsWithGuide: number;
  programmes: number;
  leagues: Array<{ league: string; games: number; withChannels: number }>;
  failed: Array<{ league: string; why: string }>;
  games: CheckedGame[];
  /** Programmes named like a game and marked live or as sport, that matched no game. */
  unmatchedProgrammes: Array<{ channel: string; number?: string; programme: string; start: string }>;
  /** Channels named like a game that matched none. */
  unmatchedChannels: Array<{ channel: string; number?: string }>;
  /** Games found on no channel, with programmes near their start that name one of their teams. */
  nearMisses: NearMiss[];
}

const keyOf = (channel: ListedChannel): string => `${channel.meta.type}|${channel.meta.id}`;
const iso = (at: number): string => new Date(at).toISOString();
const textOf = (programme: Programme): string => [programme.title, programme.episodeTitle].filter(Boolean).join(' · ');
const sporty = (programme: Programme): boolean =>
  programme.live === true || (programme.genres ?? []).some((genre) => /sport/i.test(genre));

/** Channels likely to show sport, by their name or group, read first when time is short. */
const SPORTY_CHANNEL = /sport|espn|fox ?sports|tudn|dazn|bein|tsn|sky ?sports|tnt ?sports|nba|nfl|mlb|nhl|mls|ufc|ppv|event|deporte|futbol|fútbol|liga|premier|football|soccer|golf|tennis|racing|fight|boxing|box(eo)?\b|match|game|acc ?network|sec ?network|big ?ten|pac-?12|peacock|paramount|prime|flo/i;

/** Sports channels first, then the rest, each in the lineup's order. */
export function sportsFirst(channels: ListedChannel[]): ListedChannel[] {
  const sporty = (c: ListedChannel) => SPORTY_CHANNEL.test(c.meta.name) || (c.meta.groups ?? []).some((group) => SPORTY_CHANNEL.test(group));
  return [...channels.filter(sporty), ...channels.filter((c) => !sporty(c))];
}

export interface CheckOptions {
  /** How long the guide is read for before the check answers with what it has. */
  budgetMs?: number;
  /** Channels read at a time. */
  chunk?: number;
  clock?: () => number;
}

export async function sportsCheck(source: CheckSource, board: Scoreboard, now: number, options: CheckOptions = {}): Promise<SportsCheck> {
  const budgetMs = options.budgetMs ?? 90 * 1000;
  const chunk = options.chunk ?? 1000;
  const clock = options.clock ?? Date.now;
  const began = clock();
  const from = now - BEHIND_MS;
  const to = now + AHEAD_MS;
  const [read, listed] = await Promise.all([board.games(from, to), source.channels()]);
  const games = read.games;
  const channels = sportsFirst(listed);
  const finder = new GameFinder(games, now);
  const numberOf = (channel: ListedChannel) => channel.number ?? channel.meta.channelNumber;
  const found = new Map<string, CheckedChannel[]>();
  const unmatchedProgrammes: SportsCheck['unmatchedProgrammes'] = [];
  const unmatchedChannels: SportsCheck['unmatchedChannels'] = [];
  const wanted = new Set(games.flatMap((game) => [teamKey(game, game.home), teamKey(game, game.away)]));
  const byTeam = new Map<string, Array<{ channel: ListedChannel; programme: Programme }>>();
  let programmes = 0;
  let withGuide = 0;
  let readCount = 0;

  // A share of the guide at a time, matched and let go, until all is read or the time is up.
  for (let at = 0; at < channels.length; at += chunk) {
    if (at > 0 && clock() - began > budgetMs) break;
    // Between shares, the server answers whatever else is waiting (its health check included).
    await new Promise<void>((resolve) => setImmediate(resolve));
    const part = channels.slice(at, at + chunk);
    const guide = await source.programmes(part, from - 2 * HOUR, to + 4 * HOUR);
    readCount += part.length;
    for (const [gameId, list] of channelsByGame(finder, part, guide)) {
      const held = found.get(gameId) ?? [];
      for (const { channel, by, programme } of list) {
        const number = numberOf(channel);
        held.push({ channel: channel.meta.name, ...(number ? { number } : {}), by, ...(by === 'programme' && programme ? { programme: textOf(programme) } : {}) });
      }
      found.set(gameId, held);
    }
    for (const channel of part) {
      const own = guide.get(keyOf(channel)) ?? [];
      programmes += own.length;
      if (own.length) withGuide++;
      const number = numberOf(channel);
      const named = finder.channelGame(channel);
      if (!named && looksLikeGame(channel.meta.name) && unmatchedChannels.length < MAX_LISTED) {
        unmatchedChannels.push({ channel: channel.meta.name, ...(number ? { number } : {}) });
      }
      for (const programme of own) {
        const text = textOf(programme);
        if (programme.start >= from - NEAR_MS && programme.start <= to + NEAR_MS) {
          for (const team of finder.teamsIn(text)) {
            if (!wanted.has(team)) continue;
            const list = byTeam.get(team) ?? [];
            if (list.length < 50) list.push({ channel, programme });
            byTeam.set(team, list);
          }
        }
        if (named || programme.start < from || programme.start > to || !sporty(programme) || !looksLikeGame(text)) continue;
        if (finder.programmeGames(programme).length || unmatchedProgrammes.length >= MAX_LISTED) continue;
        unmatchedProgrammes.push({ channel: channel.meta.name, ...(number ? { number } : {}), programme: text, start: iso(programme.start) });
      }
    }
  }

  // Programmes naming a team, near enough a game of it found nowhere to be worth a look.
  const unfound = games.filter((game) => !found.has(game.id));
  const nearMisses: NearMiss[] = [];
  for (const game of unfound) {
    if (nearMisses.length >= MAX_NEAR_GAMES) break;
    const seen = new Set<string>();
    const near = [...(byTeam.get(teamKey(game, game.home)) ?? []), ...(byTeam.get(teamKey(game, game.away)) ?? [])]
      .filter(({ programme }) => Math.abs(programme.start - game.start) <= NEAR_MS)
      .filter(({ channel, programme }) => {
        const key = `${keyOf(channel)}|${programme.start}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Math.abs(a.programme.start - game.start) - Math.abs(b.programme.start - game.start))
      .slice(0, NEAR_PER_GAME);
    if (!near.length) continue;
    nearMisses.push({
      league: game.leagueName,
      game: game.name,
      start: iso(game.start),
      programmes: near.map(({ channel, programme }) => {
        const number = numberOf(channel);
        return { channel: channel.meta.name, ...(number ? { number } : {}), programme: textOf(programme), start: iso(programme.start) };
      }),
    });
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
    channelsRead: readCount,
    channelsWithGuide: withGuide,
    seconds: Math.round((clock() - began) / 1000),
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
    nearMisses,
  };
}
