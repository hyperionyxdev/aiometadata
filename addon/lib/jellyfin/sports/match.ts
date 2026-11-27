// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { Game, Team } from './espn';

const MINUTE = 60 * 1000;

/**
 * Games told apart in a guide by the teams its words name. A guide names a game in many ways
 * ("Miami Heat at New York Knicks", "NBA Basketball: Heat at Knicks", "4K | NBA | Heat v Knicks"),
 * so each team is known by every name ESPN gives it (full, short, nickname, place), and a programme
 * or channel names a game when it names both of its teams.
 *
 * Where one name sits inside a longer one ("Michigan" in "Michigan State"), the longer one is the
 * team named: every team of the day is known, not only those playing at the time, so a name can't
 * be taken for a team it's only part of.
 */

// One spelling for words a guide writes in more than one way, Spanish guides' names of countries included.
const SAME: Record<string, string> = {
  st: 'st',
  saint: 'st',
  state: 'st',
  utd: 'united',
  '&': 'and',
  y: 'and',
  usa: 'united states',
  usmnt: 'united states',
  uswnt: 'united states',
  eeuu: 'united states',
  inglaterra: 'england',
  escocia: 'scotland',
  gales: 'wales',
  irlanda: 'ireland',
  alemania: 'germany',
  espana: 'spain',
  francia: 'france',
  italia: 'italy',
  holanda: 'netherlands',
  belgica: 'belgium',
  suiza: 'switzerland',
  suecia: 'sweden',
  noruega: 'norway',
  dinamarca: 'denmark',
  polonia: 'poland',
  croacia: 'croatia',
  grecia: 'greece',
  turquia: 'turkiye',
  turkey: 'turkiye',
  ucrania: 'ukraine',
  hungria: 'hungary',
  rumania: 'romania',
  brasil: 'brazil',
  japon: 'japan',
  marruecos: 'morocco',
  egipto: 'egypt',
  camerun: 'cameroon',
  sudafrica: 'south africa',
};

// Names of more than one word, read as the name ESPN gives.
const SAME_PHRASES: Array<[string[], string[]]> = [
  [['estados', 'unidos'], ['united', 'states']],
  [['ee', 'uu'], ['united', 'states']],
  [['paises', 'bajos'], ['netherlands']],
  [['corea', 'del', 'sur'], ['south', 'korea']],
  [['nueva', 'zelanda'], ['new', 'zealand']],
  [['costa', 'de', 'marfil'], ['ivory', 'coast']],
  [['arabia', 'saudita'], ['saudi', 'arabia']],
  [['arabia', 'saudi'], ['saudi', 'arabia']],
  [['republica', 'checa'], ['czechia']],
  [['czech', 'republic'], ['czechia']],
];

function samePhrases(words: string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < words.length; ) {
    const found = SAME_PHRASES.find(([from]) => from.every((word, n) => words[at + n] === word));
    if (found) {
      out.push(...found[1]);
      at += found[0].length;
    } else {
      out.push(words[at]);
      at += 1;
    }
  }
  return out;
}

// What a club's name may carry at either end, and be named without.
const CLUB_MARKS = new Set(['fc', 'afc', 'cf', 'sc', 'ac', 'cd', 'ss', 'ssc', 'as', 'us', 'rc', 'vfb', 'vfl', 'tsg', 'sv', '1']);

/** Words, lowercase and plain: accents, apostrophes and full stops gone, the rest split on. */
export function wordsOf(text: string): string[] {
  const words = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' & ')
    .replace(/['’`.]/g, '')
    .split(/[^a-z0-9&]+/)
    .filter(Boolean);
  return samePhrases(words).flatMap((word) => (SAME[word] ?? word).split(' '));
}

/** A team, known apart from the same id in another league. */
export const teamKey = (game: Pick<Game, 'league'>, team: Pick<Team, 'id'>): string => `${game.league}:${team.id}`;

/** Every name a team goes by, as words. */
export function namesOf(team: Team): string[][] {
  const names = new Map<string, string[]>();
  const add = (words: string[]) => {
    if (words.join('').length < 3) return;
    names.set(words.join(' '), words);
  };
  for (const name of [team.name, team.short, team.nickname, team.location]) {
    if (!name) continue;
    const words = wordsOf(name);
    add(words);
    // "Arsenal FC", "FC Barcelona": also without the mark.
    if (words.length > 1 && CLUB_MARKS.has(words[words.length - 1])) add(words.slice(0, -1));
    if (words.length > 1 && CLUB_MARKS.has(words[0])) add(words.slice(1));
  }
  return [...names.values()];
}

interface Name {
  words: string[];
  teams: Set<string>;
}

export class TeamNames {
  /** By a name's first word. */
  private readonly byFirst = new Map<string, Name[]>();

  constructor(games: Game[]) {
    const all = new Map<string, Name>();
    for (const game of games) {
      for (const team of [game.home, game.away]) {
        for (const words of namesOf(team)) {
          const joined = words.join(' ');
          const name = all.get(joined) ?? { words, teams: new Set<string>() };
          name.teams.add(teamKey(game, team));
          all.set(joined, name);
        }
      }
    }
    for (const name of all.values()) {
      const list = this.byFirst.get(name.words[0]) ?? [];
      list.push(name);
      this.byFirst.set(name.words[0], list);
    }
  }

  /** The teams a text names: the longest name wherever names overlap. */
  teamsIn(text: string): Set<string> {
    const words = wordsOf(text);
    const found: Array<{ at: number; length: number; teams: Set<string> }> = [];
    words.forEach((word, at) => {
      for (const name of this.byFirst.get(word) ?? []) {
        if (name.words.every((w, n) => words[at + n] === w)) found.push({ at, length: name.words.length, teams: name.teams });
      }
    });
    found.sort((a, b) => b.length - a.length || a.at - b.at);
    const taken = new Array<boolean>(words.length).fill(false);
    const teams = new Set<string>();
    for (const { at, length, teams: named } of found) {
      if (taken.slice(at, at + length).some(Boolean)) continue;
      taken.fill(true, at, at + length);
      for (const team of named) teams.add(team);
    }
    return teams;
  }
}

/** The games a text names both teams of. */
export function gamesNamed(text: string, games: Game[], names: TeamNames): Game[] {
  const teams = names.teamsIn(text);
  if (teams.size < 2) return [];
  return games.filter((game) => teams.has(teamKey(game, game.home)) && teams.has(teamKey(game, game.away)));
}

/**
 * A programme that is the game being shown, by its times: it begins up to 75 minutes before the
 * game (a broadcast with its build-up) or up to 90 after (joined late, or a guide an hour out, as
 * some guides for Mexico's channels are), and runs at least half an hour into it. A preview that
 * ends as the game begins isn't it, nor is a replay hours later.
 */
export function showsGame(programme: { start: number; end: number }, game: Pick<Game, 'start'>): boolean {
  return programme.start >= game.start - 75 * MINUTE && programme.start <= game.start + 90 * MINUTE && programme.end >= game.start + 30 * MINUTE;
}

/** Of the games a channel's name names, the one it's for: the one under way, else the next, else the last. */
export function gameOfChannel(named: Game[], now: number): Game | undefined {
  const sorted = [...named].sort((a, b) => a.start - b.start);
  return sorted.find((g) => g.state === 'in') ?? sorted.find((g) => g.state === 'pre' && !g.off && g.start >= now - 6 * 60 * MINUTE) ?? sorted[sorted.length - 1];
}

/**
 * Named like a game: two sides with "v", "vs", "at" or "@" between them. Not "at 4:30 PM", a
 * capital V as in "V Sport", or a channel showing one show all day ("24/7 Men at Work").
 */
export const looksLikeGame = (text: string): boolean =>
  !/^\s*24\s*\/\s*7\b/.test(text) && /\S\s+(?:v|[vV][sS]\.?|[aA][tT]|@)\s+(?!\d{1,2}(?::\d{2})?\s*[aApP]\.?[mM]\b)\S/.test(text);
