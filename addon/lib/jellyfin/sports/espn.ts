// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';
import consola from 'consola';
import { BoxingSource } from './boxing';
import { LEAGUES, type League } from './leagues';
import { boxerbookKey } from './settings';

const logger = consola.withTag('JellyfinSports');

/**
 * Games, scores and team details from ESPN's public scoreboard: one league's day per request, kept
 * for as long as it can't have changed much. Only a league and a date are sent; nothing about this
 * server, its users or its guide.
 *
 * The scoreboard is public but not documented, so anything it leaves out or sends differently is
 * read as missing, and a league that can't be read is reported as failed rather than as having no
 * games.
 */
export const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const PARALLEL = 6;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Kept while a game is on: its score and clock.
const LIVE_TTL_MS = 30 * 1000;
// Kept while a game is about to begin, so it's seen to start.
const SOON_TTL_MS = 2 * MINUTE;
const SOON_MS = 30 * MINUTE;
// Kept for a day still ahead or under way: records, times and channels change now and then.
const DAY_TTL_MS = HOUR;
// Kept for a day whose games are all over.
const DONE_TTL_MS = 6 * HOUR;
const FAILED_TTL_MS = 2 * MINUTE;

export type GameState = 'pre' | 'in' | 'post';

export interface Team {
  id: string;
  /** "Philadelphia 76ers". */
  name: string;
  /** "76ers"; "Man City". */
  short: string;
  /** "76ers"; "Fighting Irish". */
  nickname?: string;
  /** "Philadelphia"; "Notre Dame". */
  location?: string;
  abbreviation?: string;
  logo?: string;
  /** Hex, without the #. */
  color?: string;
  alternateColor?: string;
  /** "15-4"; "7-4-6" for wins, draws and losses. */
  record?: string;
  /** A poll's rank, where one is held (college). */
  rank?: number;
  /** Once the game has begun. */
  score?: string;
  winner?: boolean;
  home: boolean;
}

/** One fight on a card. */
export interface Bout {
  /** "Middleweight", "W Featherweight". */
  weight?: string;
  /** What's at stake: "WBC heavyweight title". */
  title?: string;
  start: number;
  state: GameState;
  /** The card's main event. */
  main?: boolean;
  /** The first-named fighter and the second, as Team (a fighter's flag as the logo). */
  a: Team;
  b: Team;
  /** Once it's over: "KO/TKO", "Submission", "Decision". */
  method?: string;
  /** The round it ended in, or is in, and the time in it. */
  round?: number;
  time?: string;
}

export interface Game {
  /** ESPN's event id, with the league's key: "nba:401810123". */
  id: string;
  league: string;
  leagueName: string;
  /** "Miami Heat at New York Knicks". */
  name: string;
  /** "MIA @ NY". */
  shortName: string;
  start: number;
  state: GameState;
  /** "Final", "Q3 4:12", "11/27 - 7:00 PM EST", "Postponed". */
  detail: string;
  completed: boolean;
  /** Put off or called off: it won't be played when listed. */
  off: boolean;
  period?: number;
  clock?: string;
  home: Team;
  away: Team;
  venue?: string;
  city?: string;
  neutral?: boolean;
  /** Where it's on nationally, as ESPN lists it ("ESPN", "Prime Video"). */
  broadcasts: string[];
  /** "NBA Cup - Group Play". */
  note?: string;
  /** A fight card: its main event's fighters are `away` and `home`, and its fights are `bouts`. */
  kind?: 'card';
  /** A card's name before its main event: "UFC 334", "UFC Fight Night", "PFL Lyon". */
  title?: string;
  bouts?: Bout[];
  /** When a card's last fight is due to end. */
  end?: number;
  /** When a guide may list it, where that's wider than a game's usual times (a boxing card's). */
  window?: { from: number; to: number };
  /** Its day is known but not its time. */
  untimed?: boolean;
  /** Who its details are from, to be shown with them where the source asks for it. */
  credit?: { text: string; url: string };
}

const text = (value: unknown, max = 200): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

const hex = (value: unknown): string | undefined => {
  const raw = text(value, 8);
  return raw && /^[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : undefined;
};

const https = (value: unknown): string | undefined => {
  const raw = text(value, 500);
  return raw && /^https:\/\//i.test(raw) ? raw : undefined;
};

function teamOf(competitor: any, started: boolean): Team | null {
  const team = competitor?.team;
  const id = text(team?.id, 40);
  const name = text(team?.displayName) ?? text(team?.name);
  if (!id || !name) return null;
  const records: any[] = Array.isArray(competitor.records) ? competitor.records : [];
  const record = records.find((r) => r?.type === 'total' || r?.name === 'overall') ?? records[0];
  const rank = Number(competitor.curatedRank?.current);
  const parsed: Team = {
    id,
    name,
    short: text(team.shortDisplayName) ?? name,
    home: competitor.homeAway === 'home',
  };
  const optional: Partial<Team> = {
    nickname: text(team.name),
    location: text(team.location),
    abbreviation: text(team.abbreviation, 10),
    logo: https(team.logo) ?? https(Array.isArray(team.logos) ? team.logos[0]?.href : undefined),
    color: hex(team.color),
    alternateColor: hex(team.alternateColor),
    record: text(record?.summary, 20),
    rank: Number.isInteger(rank) && rank >= 1 && rank <= 25 ? rank : undefined,
    score: started ? text(competitor.score, 10) : undefined,
    winner: competitor.winner === true ? true : undefined,
  };
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) (parsed as any)[key] = value;
  return parsed;
}

function fighterOf(competitor: any): Team | null {
  const athlete = competitor?.athlete;
  const id = text(competitor?.id, 40) ?? text(athlete?.id, 40);
  const name = text(athlete?.displayName) ?? text(athlete?.fullName);
  if (!id || !name) return null;
  const short = text(athlete.shortName) ?? name;
  // "I. Machado Garry": the surname, as a guide names a fight ("Adesanya vs. Magomedov").
  const surname = short.replace(/^(?:\S\.\s*)+/, '').trim();
  const records: any[] = Array.isArray(competitor.records) ? competitor.records : [];
  const fighter: Team = { id, name, short, home: false };
  if (surname && surname !== name) fighter.nickname = surname;
  const flag = https(athlete.flag?.href);
  if (flag) fighter.logo = flag;
  const record = text((records.find((r) => r?.type === 'total') ?? records[0])?.summary, 20);
  if (record) fighter.record = record;
  if (competitor.winner === true) fighter.winner = true;
  return fighter;
}

const stateOf = (status: any): GameState => (status?.type?.state === 'in' || status?.type?.state === 'post' ? status.type.state : 'pre');

/** A fight card: its bouts in the order listed (prelims first), the main event the one its name names. */
function cardOf(event: any, league: League): Game | null {
  const id = text(event?.id, 40);
  const competitions: any[] = Array.isArray(event?.competitions) ? event.competitions : [];
  const name = text(event?.name);
  const start = Date.parse(event?.date ?? competitions[0]?.date ?? '');
  if (!id || !name || !competitions.length || !Number.isFinite(start)) return null;
  const bouts: Bout[] = [];
  let end = start;
  for (const competition of competitions) {
    const fighters = (Array.isArray(competition?.competitors) ? competition.competitors : [])
      .slice()
      .sort((x: any, y: any) => (Number(x?.order) || 0) - (Number(y?.order) || 0))
      .map(fighterOf)
      .filter((f: Team | null): f is Team => f !== null);
    if (fighters.length !== 2) continue;
    const boutStart = Date.parse(competition.date ?? '') || start;
    const state = stateOf(competition.status);
    const bout: Bout = { start: boutStart, state, a: fighters[0], b: fighters[1] };
    const weight = text(competition.type?.abbreviation, 40);
    if (weight) bout.weight = weight;
    const round = Number(competition.status?.period);
    if (state !== 'pre' && Number.isInteger(round) && round > 0) bout.round = round;
    const time = text(competition.status?.displayClock, 10);
    if (state !== 'pre' && time && time !== '-') bout.time = time;
    const won = (Array.isArray(competition.details) ? competition.details : [])
      .map((d: any) => text(d?.type?.text, 60))
      .find((t: string | undefined) => t && /winner/i.test(t));
    if (state === 'post' && won) bout.method = won.replace(/^.*winner\s*/i, '').trim() || undefined;
    if (!bout.method) delete bout.method;
    bouts.push(bout);
    // A fight over ends when it ended; one to come is listed at its part of the card's start (prelims,
    // main card), which runs for up to three hours.
    const boutEnd = Date.parse(competition.endDate ?? '');
    end = Math.max(end, state === 'post' && Number.isFinite(boutEnd) ? boutEnd : boutStart + 3 * 60 * 60 * 1000);
  }
  if (!bouts.length) return null;
  const words = (t: string) => t.toLowerCase();
  const main = bouts.find((b) => [b.a, b.b].every((f) => words(name).includes(words(f.nickname ?? f.name)))) ?? bouts[bouts.length - 1];
  main.main = true;
  const status = event.status ?? {};
  const state = stateOf(status);
  const now = bouts.find((b) => b.state === 'in');
  const left = bouts.filter((b) => b.state === 'pre').length;
  const detail = state === 'in' && now
    ? `${now.a.nickname ?? now.a.short} vs ${now.b.nickname ?? now.b.short}${now.round ? ` · R${now.round}` : ''}${left ? ` · ${left} to go` : ''}`
    : text(status.type?.shortDetail) ?? '';
  const venue = competitions.find((c) => c?.venue)?.venue;
  const broadcasts = new Set<string>();
  for (const competition of competitions) {
    for (const broadcast of Array.isArray(competition?.broadcasts) ? competition.broadcasts : []) {
      for (const shown of Array.isArray(broadcast?.names) ? broadcast.names : []) if (text(shown, 60)) broadcasts.add(text(shown, 60)!);
    }
  }
  const card: Game = {
    id: `${league.key}:${id}`,
    league: league.key,
    leagueName: league.name,
    name,
    shortName: text(event.shortName, 60) ?? name,
    start,
    state,
    detail,
    completed: status.type?.completed === true,
    off: /POSTPONED|CANCELED|CANCELLED/.test(String(status.type?.name ?? '').toUpperCase()),
    away: main.a,
    home: { ...main.b, home: true },
    broadcasts: [...broadcasts].slice(0, 10),
    kind: 'card',
    title: name.includes(':') ? name.slice(0, name.indexOf(':')).trim() : name.replace(/\s+vs\.?\s+.*$/i, '').trim(),
    bouts,
    end,
  };
  if (venue?.fullName) card.venue = text(venue.fullName);
  const city = [text(venue?.address?.city), text(venue?.address?.state ?? venue?.address?.country)].filter(Boolean).join(', ');
  if (city) card.city = city;
  return card;
}

/** One league's scoreboard, as games; whatever can't be read is left out. */
export function gamesOf(body: any, league: League): Game[] {
  const games: Game[] = [];
  if (league.sport === 'mma') {
    for (const event of Array.isArray(body?.events) ? body.events : []) {
      const card = cardOf(event, league);
      if (card) games.push(card);
    }
    return games.sort((a, b) => a.start - b.start);
  }
  for (const event of Array.isArray(body?.events) ? body.events : []) {
    const competition = Array.isArray(event?.competitions) ? event.competitions[0] : undefined;
    const id = text(event?.id, 40);
    const start = Date.parse(event?.date ?? competition?.date ?? '');
    if (!id || !competition || !Number.isFinite(start)) continue;
    const status = event.status ?? competition.status ?? {};
    const type = status.type ?? {};
    const state: GameState = type.state === 'in' || type.state === 'post' ? type.state : 'pre';
    const competitors: any[] = Array.isArray(competition.competitors) ? competition.competitors : [];
    const teams = competitors.map((c) => teamOf(c, state !== 'pre')).filter((t): t is Team => t !== null);
    if (teams.length !== 2) continue;
    const home = teams.find((t) => t.home) ?? teams[1];
    const away = teams.find((t) => t !== home) ?? teams[0];
    const statusName = String(type.name ?? '').toUpperCase();
    const broadcasts = new Set<string>();
    for (const broadcast of Array.isArray(competition.broadcasts) ? competition.broadcasts : []) {
      for (const name of Array.isArray(broadcast?.names) ? broadcast.names : []) {
        const shown = text(name, 60);
        if (shown) broadcasts.add(shown);
      }
    }
    const game: Game = {
      id: `${league.key}:${id}`,
      league: league.key,
      leagueName: league.name,
      name: text(event.name) ?? `${away.name} at ${home.name}`,
      shortName: text(event.shortName, 60) ?? `${away.short} @ ${home.short}`,
      start,
      state,
      detail: text(type.shortDetail) ?? text(type.detail) ?? text(type.description) ?? '',
      completed: type.completed === true,
      off: /POSTPONED|CANCELED|CANCELLED|SUSPENDED|FORFEIT/.test(statusName),
      home,
      away,
      broadcasts: [...broadcasts].slice(0, 10),
    };
    const period = Number(status.period);
    if (state === 'in' && Number.isInteger(period) && period > 0) game.period = period;
    const clock = text(status.displayClock, 20);
    if (state === 'in' && clock) game.clock = clock;
    const venue = text(competition.venue?.fullName);
    if (venue) game.venue = venue;
    const city = [text(competition.venue?.address?.city), text(competition.venue?.address?.state ?? competition.venue?.address?.country)]
      .filter(Boolean)
      .join(', ');
    if (city) game.city = city;
    if (competition.neutralSite === true) game.neutral = true;
    const note = Array.isArray(competition.notes) ? text(competition.notes[0]?.headline) : undefined;
    if (note) game.note = note;
    games.push(game);
  }
  return games.sort((a, b) => a.start - b.start);
}

/** The day ESPN files a time under: its date in US Eastern time, as YYYYMMDD. */
export function espnDay(at: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

/** The ESPN days a span touches, the day before its start included, where late games are filed. */
export function espnDays(from: number, to: number): string[] {
  const days: string[] = [];
  for (let at = from - 24 * HOUR; at <= to + 12 * HOUR; at += 12 * HOUR) {
    const day = espnDay(at);
    if (!days.includes(day)) days.push(day);
  }
  return days.filter((day) => day <= espnDay(to));
}

/** How long a league's day may be kept, by what its games are doing. */
export function keepFor(games: Game[], now: number): number {
  if (games.some((g) => g.state === 'in' || g.bouts?.some((b) => b.state === 'in'))) return LIVE_TTL_MS;
  if (games.some((g) => g.state === 'pre' && !g.off && g.start - now < SOON_MS && now - g.start < 6 * HOUR)) return SOON_TTL_MS;
  if (games.length && games.every((g) => g.state === 'post' || g.off)) return DONE_TTL_MS;
  return DAY_TTL_MS;
}

interface Held {
  games: Game[];
  failed?: string;
}

export interface ScoreboardOptions {
  base?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Where boxing is read (boxing.ts). */
  boxing?: BoxingSource;
}

export interface GamesRead {
  games: Game[];
  /** Leagues whose scoreboard couldn't be read for one of the days. */
  failed: Array<{ league: string; why: string }>;
}

export class Scoreboard {
  private readonly held = new LRUCache<string, Held>({ max: 2000, ttl: DAY_TTL_MS });
  private readonly reading = new Map<string, Promise<Held>>();
  /** Each team's logo, by league and team, as last read. */
  private readonly logos = new LRUCache<string, string>({ max: 5000 });
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly boxing: BoxingSource;

  constructor(options: ScoreboardOptions = {}) {
    this.base = (options.base ?? ESPN_BASE).replace(/\/+$/, '');
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.boxing = options.boxing ?? new BoxingSource({ now: this.now, key: boxerbookKey });
  }

  /** A league's games filed under one ESPN day. */
  day(league: League, day: string): Promise<Held> {
    const key = `${league.key}|${day}`;
    const held = this.held.get(key);
    if (held) return Promise.resolve(held);
    const reading = this.reading.get(key);
    if (reading) return reading;
    const read = this.read(league, day).then((result) => {
      const ttl = result.failed ? FAILED_TTL_MS : keepFor(result.games, this.now());
      this.held.set(key, result, { ttl });
      return result;
    }).finally(() => this.reading.delete(key));
    this.reading.set(key, read);
    return read;
  }

  private async read(league: League, day: string): Promise<Held> {
    const url = `${this.base}/${league.path}/scoreboard?dates=${day}${league.query ? `&${league.query}` : ''}`;
    try {
      const response = await this.fetcher(url, {
        headers: { accept: 'application/json', 'user-agent': 'AIOMetadata' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return { games: [], failed: `HTTP ${response.status}` };
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_BYTES) return { games: [], failed: 'too large' };
      const body = await response.text();
      if (body.length > MAX_BYTES) return { games: [], failed: 'too large' };
      const games = gamesOf(JSON.parse(body), league);
      for (const game of games) {
        const sides = [game.home, game.away, ...(game.bouts ?? []).flatMap((bout) => [bout.a, bout.b])];
        for (const team of sides) if (team.logo) this.logos.set(`${league.key}|${team.id}`, team.logo);
      }
      return { games };
    } catch (error: any) {
      const why = error?.name === 'TimeoutError' ? 'timed out' : error instanceof SyntaxError ? 'not JSON' : 'unreachable';
      logger.warn(`${league.name} scoreboard for ${day}: ${why}`);
      return { games: [], failed: why };
    }
  }

  /** A team's logo, as its league's scoreboard last gave it. */
  logoOf(league: string, team: string): string | undefined {
    return this.logos.get(`${league}|${team}`);
  }

  /** Every game starting in a span, of these leagues, soonest first. */
  async games(from: number, to: number, leagues: League[] = LEAGUES): Promise<GamesRead> {
    const days = espnDays(from, to);
    const boxing = leagues.filter((league) => league.source === 'boxerbook');
    const fights = Promise.all(boxing.map(async (league) => ({ league, read: await this.boxing.games(league, from, to) })));
    const work = leagues.filter((league) => !league.source).flatMap((league) => days.map((day) => ({ league, day })));
    const results: Array<{ league: League; held: Held }> = [];
    for (let n = 0; n < work.length; n += PARALLEL) {
      const batch = work.slice(n, n + PARALLEL);
      results.push(...(await Promise.all(batch.map(async ({ league, day }) => ({ league, held: await this.day(league, day) })))));
    }
    const byId = new Map<string, Game>();
    const failed = new Map<string, string>();
    for (const { league, held } of results) {
      if (held.failed) failed.set(league.key, held.failed);
      for (const game of held.games) if (game.start >= from && game.start <= to) byId.set(game.id, game);
    }
    for (const { league, read } of await fights) {
      if (read.failed) failed.set(league.key, read.failed);
      for (const game of read.games) byId.set(game.id, game);
    }
    return {
      games: [...byId.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)),
      failed: [...failed].map(([league, why]) => ({ league, why })),
    };
  }
}

export const scoreboard = new Scoreboard();
