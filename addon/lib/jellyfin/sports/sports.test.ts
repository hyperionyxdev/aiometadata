// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// The sports code against a fake scoreboard, with invented games, channels and guide: reading a
// league's day, keeping it, telling teams apart in a guide's words, and the check over a guide.
// How to run it: docs/live-tv-sports.md, "Tests".
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { espnDay, espnDays, gamesOf, keepFor, Scoreboard, type Game } from './espn';
import { leagueByKey } from './leagues';
import { gameOfChannel, gamesNamed, looksLikeGame, namesOf, showsGame, TeamNames, wordsOf } from './match';
import { sportsCheck } from './check';
import type { ListedChannel } from '../livetv/lineup';
import type { Programme } from '../livetv/programmes';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const now = Date.parse('2026-11-27T21:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
const nba = leagueByKey('nba')!;
const ncaaf = leagueByKey('ncaaf')!;
const epl = leagueByKey('epl')!;

const competitor = (homeAway: string, team: any, extra: any = {}) => ({ homeAway, team, records: [{ type: 'total', summary: '10-5' }], score: '0', ...extra });
const event = (id: string, at: number, state: string, home: any, away: any, extra: any = {}) => ({
  id,
  date: iso(at),
  name: `${away.displayName} at ${home.displayName}`,
  shortName: `${away.abbreviation} @ ${home.abbreviation}`,
  status: { period: state === 'in' ? 3 : 0, displayClock: state === 'in' ? '4:12' : '0.0', type: { state, completed: state === 'post', shortDetail: state === 'in' ? 'Q3 4:12' : state === 'post' ? 'Final' : 'Scheduled', name: extra.statusName ?? 'STATUS_SCHEDULED' } },
  competitions: [{ venue: { fullName: 'Arena', address: { city: 'Town', state: 'ST' } }, notes: [], broadcasts: [{ names: ['National TV'] }], competitors: [
    competitor('home', home, extra.home),
    competitor('away', away, extra.away),
  ] }],
});
const team = (id: string, location: string, name: string, abbreviation: string, short = name) => ({
  id, location, name, abbreviation, displayName: `${location} ${name}`, shortDisplayName: short,
  logo: `https://logos.example/${id}.png`, color: '1D428A', alternateColor: 'zzz',
});

const heat = team('14', 'Miami', 'Heat', 'MIA');
const knicks = team('18', 'New York', 'Knicks', 'NY');
const sixers = team('20', 'Philadelphia', '76ers', 'PHI');
const pacers = team('11', 'Indiana', 'Pacers', 'IND');
const lakers = team('13', 'Los Angeles', 'Lakers', 'LAL');
const clippers = team('12', 'LA', 'Clippers', 'LAC');
const michigan = team('130', 'Michigan', 'Wolverines', 'MICH', 'Michigan');
const michiganState = team('127', 'Michigan State', 'Spartans', 'MSU', 'Michigan St');
const ohioState = team('194', 'Ohio State', 'Buckeyes', 'OSU', 'Ohio State');
const penn = team('213', 'Penn State', 'Nittany Lions', 'PSU', 'Penn State');
const manUnited = { id: '360', location: 'Manchester United', name: 'Manchester United', abbreviation: 'MAN', displayName: 'Manchester United', shortDisplayName: 'Man United' };
const arsenal = { id: '359', location: 'Arsenal', name: 'Arsenal', abbreviation: 'ARS', displayName: 'Arsenal FC', shortDisplayName: 'Arsenal' };

const nbaDay = { events: [
  event('1', now + 2 * HOUR, 'pre', knicks, heat),
  event('2', now + 3.5 * HOUR, 'pre', pacers, sixers),
  event('3', now - HOUR, 'in', clippers, lakers, { home: { score: '54' }, away: { score: '49' } }),
] };
const footballDay = { events: [
  event('9', now + HOUR, 'pre', michigan, ohioState),
  event('10', now + HOUR, 'pre', michiganState, penn, { away: { curatedRank: { current: 99 } }, home: { curatedRank: { current: 12 } } }),
] };
const soccerDay = { events: [event('30', now + 5 * HOUR, 'pre', manUnited, arsenal)] };

let fake: http.Server;
let base = '';
let asked: string[] = [];

before(async () => {
  fake = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    asked.push(`${url.pathname}?${url.searchParams.get('dates')}`);
    const today = url.searchParams.get('dates') === espnDay(now);
    const bodies: Record<string, any> = {
      '/basketball/nba/scoreboard': nbaDay,
      '/football/college-football/scoreboard': footballDay,
      '/soccer/eng.1/scoreboard': soccerDay,
    };
    if (url.pathname === '/hockey/nhl/scoreboard') {
      res.writeHead(500);
      res.end('down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(today ? bodies[url.pathname] ?? { events: [] } : { events: [] }));
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

after(() => {
  fake.close();
});

const gamesOfNba = (): Game[] => gamesOf(nbaDay, nba);
const allGames = (): Game[] => [...gamesOf(nbaDay, nba), ...gamesOf(footballDay, ncaaf), ...gamesOf(soccerDay, epl)];

test('a scoreboard is read as games: teams, records, scores only once begun, ranks only in the poll', () => {
  const games = gamesOfNba();
  assert.equal(games.length, 3);
  const live = games.find((g) => g.state === 'in')!;
  assert.equal(live.id, 'nba:3');
  assert.equal(live.detail, 'Q3 4:12');
  assert.equal(live.period, 3);
  assert.equal(live.clock, '4:12');
  assert.equal(live.home.score, '54');
  assert.equal(live.away.name, 'Los Angeles Lakers');
  const upcoming = games.find((g) => g.id === 'nba:1')!;
  assert.equal(upcoming.home.score, undefined, 'a score before the game began');
  assert.equal(upcoming.home.record, '10-5');
  assert.equal(upcoming.home.color, '1d428a');
  assert.equal(upcoming.home.alternateColor, undefined, 'a colour that is no colour');
  assert.equal(upcoming.home.logo, 'https://logos.example/18.png');
  assert.equal(upcoming.venue, 'Arena');
  assert.equal(upcoming.city, 'Town, ST');
  assert.deepEqual(upcoming.broadcasts, ['National TV']);
  const ranked = gamesOf(footballDay, ncaaf).find((g) => g.id === 'ncaaf:10')!;
  assert.equal(ranked.home.rank, 12);
  assert.equal(ranked.away.rank, undefined, 'unranked (99) read as a rank');
  const off = gamesOf({ events: [event('5', now, 'post', knicks, heat, { statusName: 'STATUS_POSTPONED' })] }, nba)[0];
  assert.equal(off.off, true);
  assert.deepEqual(gamesOf({ events: [{ id: 'x' }, { id: 'y', date: 'soon', competitions: [{}] }] }, nba), []);
});

test("ESPN's days are US Eastern ones, the day before a span included", () => {
  assert.equal(espnDay(Date.parse('2026-11-28T03:00:00Z')), '20261127');
  assert.equal(espnDay(Date.parse('2026-11-28T06:00:00Z')), '20261128');
  assert.deepEqual(espnDays(Date.parse('2026-11-27T15:00:00Z'), Date.parse('2026-11-28T15:00:00Z')), ['20261126', '20261127', '20261128']);
});

test('a day is kept briefly while a game is on or about to be, and long once all are over', () => {
  const games = gamesOfNba();
  assert.equal(keepFor(games, now), 30 * 1000);
  const ahead = games.filter((g) => g.state === 'pre');
  assert.equal(keepFor(ahead, now), 60 * MINUTE);
  assert.equal(keepFor(ahead, now + 1.75 * HOUR), 2 * MINUTE);
  assert.equal(keepFor(gamesOf({ events: [event('7', now - 5 * HOUR, 'post', knicks, heat)] }, nba), now), 6 * HOUR);
});

test('words are compared plain: accents, stops and the ways of writing Saint, State and United', () => {
  assert.deepEqual(wordsOf('Atlético Madrid'), ['atletico', 'madrid']);
  assert.deepEqual(wordsOf('Ohio St. vs. St. John’s'), ['ohio', 'st', 'vs', 'st', 'johns']);
  assert.deepEqual(wordsOf('Man Utd'), wordsOf('Man United'));
  assert.deepEqual(wordsOf('Texas A&M'), ['texas', 'a', 'and', 'm']);
  const arsenalNames = namesOf(gamesOf(soccerDay, epl)[0].away).map((n) => n.join(' '));
  assert.ok(arsenalNames.includes('arsenal'), 'a club named without its FC');
});

test('a guide names a game in its own words; both teams must be named', () => {
  const games = allGames();
  const names = new TeamNames(games);
  const named = (text: string) => gamesNamed(text, games, names).map((g) => g.id);
  assert.deepEqual(named('NBA Basketball: Miami Heat at New York Knicks'), ['nba:1']);
  assert.deepEqual(named('Heat v Knicks'), ['nba:1']);
  assert.deepEqual(named('4K | NBA | 76ers v Pacers | 4:30 PM PST'), ['nba:2']);
  assert.deepEqual(named('Philadelphia at Indiana'), ['nba:2']);
  assert.deepEqual(named('Lakers vs. Clippers'), ['nba:3']);
  assert.deepEqual(named('Premier League: Man Utd v Arsenal'), ['epl:30']);
  assert.deepEqual(named('Miami Vice'), [], 'one team named');
  assert.deepEqual(named('Knicks Postgame'), []);
});

test('a name inside a longer one is the longer one: Michigan State is not Michigan', () => {
  const games = allGames();
  const names = new TeamNames(games);
  const named = (text: string) => gamesNamed(text, games, names).map((g) => g.id);
  assert.deepEqual(named('College Football: Penn State at Michigan State'), ['ncaaf:10']);
  assert.deepEqual(named('Ohio St. at Michigan'), ['ncaaf:9']);
  assert.deepEqual(named('Ohio State at Michigan St'), [], 'Michigan read in Michigan St');
});

test('a programme shows the game when it runs into it, not a preview or a replay', () => {
  const game = { start: now };
  assert.equal(showsGame({ start: now - 30 * MINUTE, end: now + 2.5 * HOUR }, game), true);
  assert.equal(showsGame({ start: now, end: now + 2 * HOUR }, game), true);
  assert.equal(showsGame({ start: now - HOUR, end: now }, game), false, 'a preview');
  assert.equal(showsGame({ start: now + 6 * HOUR, end: now + 8 * HOUR }, game), false, 'a replay');
  assert.equal(showsGame({ start: now - 3 * HOUR, end: now + HOUR }, game), false, 'a long build-up');
});

test("a channel named for a game is the one under way, else the next", () => {
  const games = gamesOf({ events: [
    event('a', now - 26 * HOUR, 'post', knicks, heat),
    event('b', now + 2 * HOUR, 'pre', knicks, heat),
    event('c', now + 26 * HOUR, 'pre', heat, knicks),
  ] }, nba);
  assert.equal(gameOfChannel(games, now)?.id, 'nba:b');
  assert.equal(looksLikeGame('NBA | Heat v Knicks'), true);
  assert.equal(looksLikeGame('Sports Center'), false);
  assert.equal(looksLikeGame('Coming up: NBA Basketball today at 4:30 PM PST'), false);
});

test('a league is read once while kept, and one that fails says so', async () => {
  asked = [];
  const board = new Scoreboard({ base, now: () => now });
  const first = await board.games(now - HOUR, now + 6 * HOUR, [nba, leagueByKey('nhl')!]);
  assert.deepEqual(first.games.map((g) => g.id), ['nba:3', 'nba:1', 'nba:2']);
  assert.deepEqual(first.failed, [{ league: 'nhl', why: 'HTTP 500' }]);
  const reads = asked.length;
  const again = await board.games(now - HOUR, now + 6 * HOUR, [nba]);
  assert.equal(again.games.length, 3);
  assert.equal(asked.length, reads, 'a day read again while kept');
  // One read for two asking at once.
  const fresh = new Scoreboard({ base, now: () => now });
  asked = [];
  await Promise.all([fresh.day(nba, espnDay(now)), fresh.day(nba, espnDay(now))]);
  assert.equal(asked.length, 1);
});

test('the check matches games to channels, by a programme or by the channel, and lists what it missed', async () => {
  const channel = (id: string, name: string, number: string): ListedChannel => ({ meta: { type: 'tv', id, name }, number });
  const channels = [
    channel('national', 'National Sports', '101'),
    channel('regional', 'Sports Philly', '102'),
    channel('game', '4K | NBA | 76ers v Pacers | 4:30 PM PST', '901'),
    channel('college', 'College Network', '103'),
    channel('other', 'Hockey Channel', '104'),
    channel('event', 'NHL | Bruins v Rangers', '902'),
  ];
  const programme = (title: string, start: number, end: number, extra: Partial<Programme> = {}): Programme => ({ id: `${title}-${start}`, title, start, end, ...extra });
  const guide = new Map<string, Programme[]>([
    ['tv|national', [
      programme('NBA Countdown', now + 1.5 * HOUR, now + 2 * HOUR),
      programme('NBA Basketball', now + 2 * HOUR, now + 4.5 * HOUR, { episodeTitle: 'Miami Heat at New York Knicks', live: true }),
      programme('NBA Basketball', now + 10 * HOUR, now + 12 * HOUR, { episodeTitle: 'Miami Heat at New York Knicks' }),
    ]],
    ['tv|regional', [programme('76ers at Pacers', now + 3.5 * HOUR, now + 6 * HOUR, { live: true })]],
    ['tv|game', [
      programme('Coming up: NBA Basketball today at 4:30 PM PST', now - HOUR, now + 3.5 * HOUR),
      programme('Philadelphia 76ers at Indiana Pacers', now + 3.5 * HOUR, now + 6.5 * HOUR, { live: true }),
    ]],
    ['tv|college', [programme('College Football: Ohio St. at Michigan', now + 0.5 * HOUR, now + 4.5 * HOUR, { live: true })]],
    ['tv|other', [programme('Bruins at Rangers', now + HOUR, now + 3.5 * HOUR, { live: true, genres: ['Sports'] })]],
  ]);
  const board = new Scoreboard({ base, now: () => now });
  const check = await sportsCheck({ channels: async () => channels, programmes: async () => guide }, board, now);
  const channelsOf = (game: string) => check.games.find((g) => g.game === game)?.channels.map((c) => `${c.number} ${c.by}`);
  assert.deepEqual(channelsOf('Miami Heat at New York Knicks'), ['101 programme']);
  assert.deepEqual(channelsOf('Philadelphia 76ers at Indiana Pacers'), ['102 programme', '901 channel']);
  assert.deepEqual(channelsOf('Ohio State Buckeyes at Michigan Wolverines'), ['103 programme']);
  assert.deepEqual(channelsOf('Penn State Nittany Lions at Michigan State Spartans'), []);
  assert.deepEqual(check.unmatchedProgrammes.map((p) => p.programme), ['Bruins at Rangers']);
  assert.deepEqual(check.unmatchedChannels.map((c) => c.channel), ['NHL | Bruins v Rangers']);
  assert.deepEqual(check.failed, [{ league: 'NHL', why: 'HTTP 500' }]);
  const nbaRow = check.leagues.find((row) => row.league === 'NBA');
  assert.deepEqual(nbaRow, { league: 'NBA', games: 3, withChannels: 2 });
  assert.equal(check.channels, 6);
  assert.equal(check.channelsWithGuide, 5);
});
