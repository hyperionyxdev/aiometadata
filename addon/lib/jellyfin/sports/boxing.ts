// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import type { Bout, Game, GameState, Team } from './espn';
import type { League } from './leagues';

const logger = consola.withTag('JellyfinSports');

/**
 * Boxing cards and results from Boxerbook's API (https://boxerbook.com/v1/openapi.json): the
 * schedule 30 days ahead and the results of the last two days, read on a budget, as its free use
 * allows 100 requests a day with a key and 50 without. Its terms ask that what it gives be credited
 * with a link to the page it came from: each card carries that credit (`credit`), which the apps show.
 * Its forecasts and betting markets are left out.
 */
export const BOXERBOOK_BASE = 'https://boxerbook.com/v1';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TIMEOUT_MS = 10 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;
// How often each is read: with a key (100 a day), and without (50).
const SCHEDULE_EVERY = { key: HOUR, none: 2 * HOUR };
const RESULTS_EVERY = { key: 2 * HOUR, none: 3 * HOUR };
// While a card is on or just over, its results are looked for more often.
const FIGHT_NIGHT_RESULTS_EVERY = { key: 15 * MINUTE, none: 30 * MINUTE };
const FAILED_RETRY_MS = 10 * MINUTE;
// A card goes on being shown this long after its day, with its results.
const KEPT_AFTER_MS = 3 * DAY;
// A card's day as a guide may list it, its time not known: the day, give or take half a day.
const UNTIMED_MARGIN_MS = 12 * HOUR;
// A card's own time is its start or its main event's, and guides differ by hours: this either way.
const TIMED_MARGIN_MS = 6 * HOUR;
const CARD_LENGTH_MS = 5 * HOUR;

const DIVISIONS: Record<string, string> = {
  hea: 'Heavyweight', cru: 'Cruiserweight', lhea: 'Light heavyweight', smid: 'Super middleweight', mid: 'Middleweight',
  swel: 'Super welterweight', wel: 'Welterweight', slig: 'Super lightweight', lig: 'Lightweight', sfea: 'Super featherweight',
  fea: 'Featherweight', sban: 'Super bantamweight', ban: 'Bantamweight', sfly: 'Super flyweight', fly: 'Flyweight',
  lfly: 'Light flyweight', min: 'Minimumweight', atom: 'Atomweight',
};

export function divisionName(code: unknown): string | undefined {
  if (typeof code !== 'string' || !code || code === 'other') return undefined;
  const women = code.startsWith('w_');
  const name = DIVISIONS[women ? code.slice(2) : code];
  return name ? `${women ? 'W ' : ''}${name}` : undefined;
}

const text = (value: unknown, max = 200): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

/** A boxer's surname, as a guide names a fight: "Vergil Ortiz Jr." is Ortiz. */
export function surnameOf(name: string): string {
  const words = name.split(/\s+/).filter((word) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(word));
  return words[words.length - 1] ?? name;
}

function sideOf(side: any): Team | null {
  const name = text(side?.name);
  const id = text(side?.id, 40) ?? text(side?.slug, 80);
  if (!name || !id) return null;
  const surname = surnameOf(name);
  const boxer: Team = { id, name, short: surname, home: false };
  if (surname !== name) boxer.nickname = surname;
  const record = text(side.record, 20);
  if (record) boxer.record = record;
  return boxer;
}

/** The two boxers of a bout in the order Boxerbook shows them, the better known first. */
function sidesOf(bout: any): [Team, Team] | null {
  const a = sideOf(bout?.a);
  const b = sideOf(bout?.b);
  if (!a || !b) return null;
  return Array.isArray(bout.display) && bout.display[0] === 'b' ? [b, a] : [a, b];
}

interface HeldCard {
  event: any;
  /** The day it's on, at midnight UTC. */
  day: number;
  start?: number;
}

interface HeldResult {
  bout: any;
  at: number;
}

export interface BoxingOptions {
  base?: string;
  fetch?: typeof fetch;
  now?: () => number;
  key?: () => string | undefined;
}

export class BoxingSource {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly key: () => string | undefined;
  private readonly cards = new Map<string, HeldCard>();
  private readonly results = new Map<string, HeldResult>();
  private scheduleAt = 0;
  private resultsAt = 0;
  private pausedUntil = 0;
  private failed?: string;
  private reading: Promise<void> | null = null;
  /** How many requests Boxerbook says are left today, and the day (UTC) it said so. */
  left?: number;
  private leftDay?: number;

  constructor(options: BoxingOptions = {}) {
    this.base = (options.base ?? BOXERBOOK_BASE).replace(/\/+$/, '');
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.key = options.key ?? (() => undefined);
  }

  private async read(path: string): Promise<any | null> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'AIOMetadata (self-hosted Live TV guide)' };
    const key = this.key();
    if (key) headers['x-api-key'] = key;
    try {
      const response = await this.fetcher(`${this.base}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const left = Number(response.headers.get('x-ratelimit-day-remaining'));
      if (response.headers.has('x-ratelimit-day-remaining') && Number.isFinite(left)) {
        this.left = left;
        this.leftDay = Math.floor(this.now() / DAY);
      }
      if (response.status === 429) {
        const wait = Number(response.headers.get('retry-after'));
        const midnight = Math.ceil(this.now() / DAY) * DAY;
        this.pausedUntil = Number.isFinite(wait) && wait > 0 ? this.now() + wait * 1000 : midnight;
        this.failed = 'over its daily limit';
        logger.warn(`Boxing: Boxerbook's daily limit is reached; read again at ${new Date(this.pausedUntil).toISOString()}`);
        return null;
      }
      if (response.status === 401 || response.status === 403) {
        this.pausedUntil = this.now() + HOUR;
        this.failed = key ? 'its key was refused' : 'it asks for a key';
        logger.warn(`Boxing: Boxerbook refused the request (${response.status}); its key is checked again in an hour`);
        return null;
      }
      if (!response.ok) {
        this.failed = `HTTP ${response.status}`;
        return null;
      }
      const body = await response.text();
      if (body.length > MAX_BYTES) {
        this.failed = 'too large';
        return null;
      }
      this.failed = undefined;
      return JSON.parse(body);
    } catch (error: any) {
      this.failed = error?.name === 'TimeoutError' ? 'timed out' : error instanceof SyntaxError ? 'not JSON' : 'unreachable';
      return null;
    }
  }

  /** A card on now, or over in the last few hours: its results are looked for more often. */
  private fightNight(now: number): boolean {
    for (const card of this.cards.values()) {
      const start = card.start ?? card.day;
      const end = card.start ? card.start + CARD_LENGTH_MS + 2 * HOUR : card.day + DAY + UNTIMED_MARGIN_MS;
      if (now >= start - HOUR && now <= end) return true;
    }
    return false;
  }

  private async refresh(): Promise<void> {
    const now = this.now();
    if (now < this.pausedUntil) return;
    const keyed = this.key() ? 'key' : 'none';
    // Close to the day's limit: only what's needed most, the results of a card on now. A new day
    // (UTC) starts afresh.
    const scarce = this.left !== undefined && this.leftDay === Math.floor(now / DAY) && this.left < 5;
    const scheduleDue = now - this.scheduleAt >= (this.failed && this.scheduleAt ? FAILED_RETRY_MS : SCHEDULE_EVERY[keyed]);
    if (scheduleDue && !scarce) {
      const schedule = await this.read('/schedule?when=30d');
      this.scheduleAt = now;
      if (schedule) this.keepSchedule(schedule, now);
    }
    const resultsEvery = this.fightNight(now) ? FIGHT_NIGHT_RESULTS_EVERY[keyed] : RESULTS_EVERY[keyed];
    if (now - this.resultsAt >= resultsEvery && (!scarce || this.fightNight(now))) {
      const results = await this.read('/results?days=2');
      this.resultsAt = now;
      if (results) this.keepResults(results, now);
    }
  }

  private keepSchedule(schedule: any, now: number): void {
    for (const event of Array.isArray(schedule?.events) ? schedule.events : []) {
      const day = Date.parse(`${text(event?.date, 10) ?? ''}T00:00:00Z`);
      if (!Number.isFinite(day) || !Array.isArray(event.bouts) || !event.bouts.length) continue;
      const id = text(event.id, 40) ?? text(event.url, 300);
      if (!id) continue;
      const start = Date.parse(text(event.start_utc, 30) ?? text(event.bouts[0]?.start_utc, 30) ?? '');
      this.cards.set(id, { event, day, ...(Number.isFinite(start) ? { start } : {}) });
    }
    for (const [id, card] of this.cards) if (card.day + DAY + KEPT_AFTER_MS < now) this.cards.delete(id);
  }

  private keepResults(results: any, now: number): void {
    for (const bout of Array.isArray(results?.bouts) ? results.bouts : []) {
      const id = text(bout?.id, 40);
      if (id) this.results.set(id, { bout, at: now });
    }
    for (const [id, held] of this.results) if (held.at + KEPT_AFTER_MS < now) this.results.delete(id);
  }

  private boutOf(raw: any, card: HeldCard, now: number): Bout | null {
    const sides = sidesOf(raw);
    if (!sides) return null;
    const result = this.results.get(text(raw.id, 40) ?? '')?.bout;
    const [first, second] = result ? (sidesOf(result) ?? sides) : sides;
    const bout: Bout = { start: card.start ?? card.day, state: 'pre', a: first, b: second };
    const weight = divisionName(raw.division ?? result?.division);
    if (weight) bout.weight = weight;
    const title = text(raw.title_text ?? result?.title_text);
    if (title) bout.title = title;
    if (result) {
      bout.state = 'post';
      const won = result.winner === 'a' ? sideOf(result.a)?.id : result.winner === 'b' ? sideOf(result.b)?.id : undefined;
      for (const boxer of [bout.a, bout.b]) if (won && boxer.id === won) boxer.winner = true;
      const method = text(result.method, 40) ?? (result.winner === 'draw' ? 'Draw' : result.winner === 'nc' ? 'No contest' : undefined);
      if (method) bout.method = method;
      const round = Number(result.round);
      if (Number.isInteger(round) && round > 0) bout.round = round;
      const time = text(result.time, 10);
      if (time) bout.time = time;
    } else if (card.start && now >= card.start && now < card.start + CARD_LENGTH_MS) {
      bout.state = 'in';
    }
    return bout;
  }

  private cardOf(league: League, id: string, card: HeldCard, now: number): Game | null {
    const bouts = (card.event.bouts as any[]).map((raw) => this.boutOf(raw, card, now)).filter((b): b is Bout => b !== null);
    if (!bouts.length) return null;
    // Boxerbook lists a card's main event first.
    const main = bouts[0];
    main.main = true;
    const over = bouts.every((b) => b.state === 'post') || now > (card.start ? card.start + CARD_LENGTH_MS + 6 * HOUR : card.day + DAY + UNTIMED_MARGIN_MS);
    const on = !over && (bouts.some((b) => b.state === 'post' || b.state === 'in') || (card.start !== undefined && now >= card.start && now < card.start + CARD_LENGTH_MS));
    const state: GameState = over ? 'post' : on ? 'in' : 'pre';
    const platforms = new Set<string>();
    for (const broadcast of Array.isArray(card.event.broadcasts) ? card.event.broadcasts : []) {
      const platform = text(broadcast?.platform, 60);
      if (platform) platforms.add(platform);
    }
    const start = card.start ?? card.day;
    const game: Game = {
      id: `${league.key}:${id}`,
      league: league.key,
      leagueName: league.name,
      name: `${main.a.name} vs ${main.b.name}`,
      shortName: `${main.a.short} vs ${main.b.short}`,
      start,
      state,
      detail: state === 'post' ? 'Final' : state === 'in' ? 'On now' : card.start ? '' : 'Time to be announced',
      completed: bouts.every((b) => b.state === 'post'),
      off: false,
      away: main.a,
      home: { ...main.b, home: true },
      broadcasts: [...platforms].slice(0, 10),
      kind: 'card',
      bouts,
      end: card.start ? card.start + CARD_LENGTH_MS : card.day + DAY,
      window: card.start
        ? { from: card.start - TIMED_MARGIN_MS, to: card.start + TIMED_MARGIN_MS }
        : { from: card.day - UNTIMED_MARGIN_MS, to: card.day + DAY + UNTIMED_MARGIN_MS },
    };
    if (!card.start) game.untimed = true;
    const venue = text(card.event.venue);
    if (venue) game.venue = venue;
    const city = [text(card.event.city), text(card.event.country, 10)].filter(Boolean).join(', ');
    if (city) game.city = city;
    const promoter = text(card.event.promoter);
    if (promoter) game.note = promoter;
    const url = text(card.event.url, 300);
    game.credit = { text: 'Data from Boxerbook', url: url && /^https:\/\/boxerbook\.com\//.test(url) ? url : 'https://boxerbook.com' };
    return game;
  }

  /** The cards whose day or time falls in a span, read again first where they're due. */
  async games(league: League, from: number, to: number): Promise<{ games: Game[]; failed?: string }> {
    this.reading ??= this.refresh().finally(() => {
      this.reading = null;
    });
    await this.reading;
    const now = this.now();
    const games: Game[] = [];
    for (const [id, card] of this.cards) {
      const start = card.start ?? card.day;
      const end = card.start ? card.start + CARD_LENGTH_MS : card.day + DAY;
      if (end < from || start > to) continue;
      const game = this.cardOf(league, id, card, now);
      if (game) games.push(game);
    }
    return { games: games.sort((a, b) => a.start - b.start), ...(this.failed ? { failed: this.failed } : {}) };
  }
}
