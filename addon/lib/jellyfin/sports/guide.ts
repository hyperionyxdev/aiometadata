// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { ListedChannel } from '../livetv/lineup';
import type { Programme } from '../livetv/programmes';
import type { Game, Team } from './espn';
import { gameOfChannel, gamesNamed, showsGame, TeamNames } from './match';

const HOUR = 60 * 60 * 1000;
// How far from its game a channel made for it still counts as carrying it: its build-up and wrap-up.
const AROUND_MS = 24 * HOUR;

/** Where a programme stands to its game: the game itself, or a channel's build-up or wrap-up around it. */
export type GamePart = 'game' | 'before' | 'after';

export interface Showing {
  game: Game;
  part: GamePart;
  /** Found by the programme's own name, or by its channel's (a channel made for the game). */
  by: 'programme' | 'channel';
}

const keyOf = (channel: ListedChannel): string => `${channel.meta.type}|${channel.meta.id}`;
const textOf = (programme: Programme): string => [programme.title, programme.episodeTitle].filter(Boolean).join(' · ');

/**
 * The day's games, ready to be found in a guide: which game a programme shows, by its name and
 * times, or by its channel's name for a channel made for one game, whose build-up and wrap-up are
 * that game's too.
 */
export class GameFinder {
  private readonly names: TeamNames;
  private readonly byChannel = new Map<string, Game | null>();

  constructor(readonly games: Game[], private readonly now: number) {
    this.names = new TeamNames(games);
  }

  /** The teams a text names, as `league:team` keys. */
  teamsIn(text: string): Set<string> {
    return this.names.teamsIn(text);
  }

  /** The game a channel's own name is for, if it's named for one. */
  channelGame(channel: ListedChannel): Game | undefined {
    const key = keyOf(channel);
    let game = this.byChannel.get(key);
    if (game === undefined) {
      game = gameOfChannel(gamesNamed(channel.meta.name, this.games, this.names), this.now) ?? null;
      this.byChannel.set(key, game);
    }
    return game ?? undefined;
  }

  /** The games a programme's own name names and its times fit. */
  programmeGames(programme: Programme): Game[] {
    return gamesNamed(textOf(programme), this.games, this.names).filter((game) => showsGame(programme, game));
  }

  /** What a programme shows of a game, if anything. */
  showing(channel: ListedChannel, programme: Programme): Showing | undefined {
    const own = this.programmeGames(programme)[0];
    const ofChannel = this.channelGame(channel);
    if (ofChannel && (!own || own.id === ofChannel.id)) {
      if (programme.end < ofChannel.start - AROUND_MS || programme.start > ofChannel.start + AROUND_MS) return own ? { game: own, part: 'game', by: 'programme' } : undefined;
      const part: GamePart = own || showsGame(programme, ofChannel) ? 'game' : programme.start < ofChannel.start ? 'before' : 'after';
      return { game: ofChannel, part, by: 'channel' };
    }
    return own ? { game: own, part: 'game', by: 'programme' } : undefined;
  }
}

export interface GameChannel {
  channel: ListedChannel;
  by: 'programme' | 'channel';
  /** The programme that is the game on it, where the guide has one. */
  programme?: Programme;
}

/** Each game with the channels showing it, from a guide's programmes over the games' time. */
export function channelsByGame(finder: GameFinder, channels: ListedChannel[], guide: Map<string, Programme[]>): Map<string, GameChannel[]> {
  const found = new Map<string, GameChannel[]>();
  const add = (game: Game, entry: GameChannel) => {
    const list = found.get(game.id) ?? [];
    const held = list.find((c) => keyOf(c.channel) === keyOf(entry.channel));
    if (!held) list.push(entry);
    else if (!held.programme && entry.programme) held.programme = entry.programme;
    found.set(game.id, list);
  };
  for (const channel of channels) {
    const own = guide.get(keyOf(channel)) ?? [];
    const named = finder.channelGame(channel);
    if (named) add(named, { channel, by: 'channel', programme: own.find((p) => showsGame(p, named)) });
    for (const programme of own) for (const game of finder.programmeGames(programme)) add(game, { channel, by: 'programme', programme });
  }
  return found;
}

/**
 * The best of a game's channels first: one made for the game, in 4K before the rest; then a
 * programme marked live; then any other; each in channel number order.
 */
export function ranked(list: GameChannel[]): GameChannel[] {
  const sharp = (c: GameChannel) => /\b(4k|uhd)\b/i.test(c.channel.meta.name);
  const score = (c: GameChannel) => (c.by === 'channel' ? 0 : c.programme?.live === true ? 2 : 3) - (sharp(c) ? 1 : 0);
  const number = (c: GameChannel) => {
    const n = Number(c.channel.number ?? c.channel.meta.channelNumber);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };
  return [...list].sort((a, b) => score(a) - score(b) || number(a) - number(b));
}

/** Where the apps fetch a team's logo from, through this server. */
export const logoPath = (league: string, team: string): string => `/AIOStreams/Sports/Logo/${encodeURIComponent(league)}/${encodeURIComponent(team)}`;

function teamInfo(game: Game, team: Team): any {
  const info: any = { id: team.id, name: team.name, short: team.short };
  if (team.abbreviation) info.abbreviation = team.abbreviation;
  if (team.logo) info.logo = logoPath(game.league, team.id);
  for (const key of ['color', 'alternateColor', 'record', 'rank', 'score', 'winner'] as const) {
    if (team[key] !== undefined) info[key] = team[key];
  }
  return info;
}

/** A game as the apps are sent it, on a programme (`aiostreams.game`) or in the list of games. */
export function gameInfo(game: Game, part?: GamePart): any {
  const info: any = {
    id: game.id,
    league: game.league,
    leagueName: game.leagueName,
    name: game.name,
    shortName: game.shortName,
    start: new Date(game.start).toISOString(),
    state: game.state,
    detail: game.detail,
    home: teamInfo(game, game.home),
    away: teamInfo(game, game.away),
  };
  if (part) info.part = part;
  if (game.kind === 'card') {
    info.kind = 'card';
    if (game.title) info.title = game.title;
    if (game.end) info.end = new Date(game.end).toISOString();
    info.bouts = (game.bouts ?? []).map((bout) => {
      const shown: any = { start: new Date(bout.start).toISOString(), state: bout.state, a: teamInfo(game, bout.a), b: teamInfo(game, bout.b) };
      for (const key of ['weight', 'main', 'method', 'round', 'time'] as const) if (bout[key] !== undefined) shown[key] = bout[key];
      return shown;
    });
  }
  if (game.off) info.off = true;
  if (game.period !== undefined) info.period = game.period;
  if (game.clock) info.clock = game.clock;
  if (game.venue) info.venue = game.venue;
  if (game.city) info.city = game.city;
  if (game.neutral) info.neutral = true;
  if (game.broadcasts.length) info.broadcasts = game.broadcasts;
  if (game.note) info.note = game.note;
  return info;
}
