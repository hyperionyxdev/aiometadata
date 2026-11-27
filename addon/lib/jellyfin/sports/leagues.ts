// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE

/** A league whose games are read from ESPN's public scoreboard, by its sport and league in ESPN's paths. */
export interface League {
  /** This server's own name for it, kept stable for clients and settings. */
  key: string;
  /** `{sport}/{league}` as ESPN's scoreboard path has it. */
  path: string;
  /** How it's shown. */
  name: string;
  sport: 'basketball' | 'football' | 'hockey' | 'baseball' | 'soccer' | 'mma' | 'boxing';
  /** Where its games are read: ESPN's scoreboard, or for boxing, Boxerbook (boxing.ts). */
  source?: 'boxerbook';
  /** More of the scoreboard's query: college basketball lists a few featured games unless asked for all of Division I. */
  query?: string;
}

export const LEAGUES: League[] = [
  { key: 'nba', path: 'basketball/nba', name: 'NBA', sport: 'basketball' },
  { key: 'wnba', path: 'basketball/wnba', name: 'WNBA', sport: 'basketball' },
  { key: 'gleague', path: 'basketball/nba-development', name: 'NBA G League', sport: 'basketball' },
  { key: 'ncaam', path: 'basketball/mens-college-basketball', name: 'College Basketball', sport: 'basketball', query: 'groups=50&limit=500' },
  { key: 'ncaaw', path: 'basketball/womens-college-basketball', name: "Women's College Basketball", sport: 'basketball', query: 'groups=50&limit=500' },
  { key: 'nfl', path: 'football/nfl', name: 'NFL', sport: 'football' },
  { key: 'ncaaf', path: 'football/college-football', name: 'College Football', sport: 'football' },
  { key: 'nhl', path: 'hockey/nhl', name: 'NHL', sport: 'hockey' },
  { key: 'mlb', path: 'baseball/mlb', name: 'MLB', sport: 'baseball' },
  { key: 'mls', path: 'soccer/usa.1', name: 'MLS', sport: 'soccer' },
  { key: 'nwsl', path: 'soccer/usa.nwsl', name: 'NWSL', sport: 'soccer' },
  { key: 'epl', path: 'soccer/eng.1', name: 'Premier League', sport: 'soccer' },
  { key: 'efl', path: 'soccer/eng.2', name: 'EFL Championship', sport: 'soccer' },
  { key: 'facup', path: 'soccer/eng.fa', name: 'FA Cup', sport: 'soccer' },
  { key: 'laliga', path: 'soccer/esp.1', name: 'LaLiga', sport: 'soccer' },
  { key: 'bundesliga', path: 'soccer/ger.1', name: 'Bundesliga', sport: 'soccer' },
  { key: 'seriea', path: 'soccer/ita.1', name: 'Serie A', sport: 'soccer' },
  { key: 'ligue1', path: 'soccer/fra.1', name: 'Ligue 1', sport: 'soccer' },
  { key: 'ligamx', path: 'soccer/mex.1', name: 'Liga MX', sport: 'soccer' },
  { key: 'ligaexp', path: 'soccer/mex.2', name: 'Liga de Expansión MX', sport: 'soccer' },
  { key: 'ligamxf', path: 'soccer/mex.w.1', name: 'Liga MX Femenil', sport: 'soccer' },
  { key: 'copamx', path: 'soccer/mex.copa_mx', name: 'Copa MX', sport: 'soccer' },
  { key: 'concacaf', path: 'soccer/concacaf.champions', name: 'Concacaf Champions Cup', sport: 'soccer' },
  { key: 'leaguescup', path: 'soccer/concacaf.leagues.cup', name: 'Leagues Cup', sport: 'soccer' },
  { key: 'concacafw', path: 'soccer/concacaf.womens.championship', name: 'Concacaf W Championship', sport: 'soccer' },
  { key: 'wgoldcup', path: 'soccer/concacaf.w.gold', name: 'Concacaf W Gold Cup', sport: 'soccer' },
  { key: 'ucl', path: 'soccer/uefa.champions', name: 'Champions League', sport: 'soccer' },
  { key: 'uel', path: 'soccer/uefa.europa', name: 'Europa League', sport: 'soccer' },
  // Fight cards: the card is the game, its main event's fighters its two sides (espn.ts).
  { key: 'ufc', path: 'mma/ufc', name: 'UFC', sport: 'mma' },
  { key: 'pfl', path: 'mma/pfl', name: 'PFL', sport: 'mma' },
  // ESPN has no boxing: its cards come from Boxerbook.
  { key: 'boxing', path: '', name: 'Boxing', sport: 'boxing', source: 'boxerbook' },
];

export const leagueByKey = (key: string): League | undefined => LEAGUES.find((league) => league.key === key);
