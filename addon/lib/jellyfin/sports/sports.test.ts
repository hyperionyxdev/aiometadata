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
import { sportsCheck, sportsFirst } from './check';
import { channelsByGame, GameFinder, gameInfo, ranked } from './guide';
import { forgetGames, gameTagger, teamLogo } from './serve';
import { programmesInParts } from './live';
import { BoxingSource, divisionName, surnameOf } from './boxing';
import { forgetGameChannels, gameChannels } from './channels';
import { sportsLeagues, sportsOn } from './settings';
import { programItem } from '../livetv/items';
import type { ListedChannel } from '../livetv/lineup';
import type { Programme } from '../livetv/programmes';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;
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
    asked.push(`${url.pathname}?${url.searchParams.get('dates')}${url.searchParams.get('groups') ? `|groups=${url.searchParams.get('groups')}` : ''}`);
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

test("a Spanish guide's names for countries are ESPN's", () => {
  assert.deepEqual(wordsOf('Estados Unidos vs. El Salvador'), ['united', 'states', 'vs', 'el', 'salvador']);
  assert.deepEqual(wordsOf('Inglaterra vs. Corea del Sur'), ['england', 'vs', 'south', 'korea']);
  assert.deepEqual(wordsOf('Trinidad y Tobago'), ['trinidad', 'and', 'tobago']);
  const country = (id: string, name: string) => ({ id, location: name, name, abbreviation: id, displayName: name, shortDisplayName: name });
  const concacaf = leagueByKey('concacafw')!;
  const games = gamesOf({ events: [
    event('w1', now, 'pre', country('SLV', 'El Salvador'), country('USA', 'United States')),
    event('w2', now + 3 * HOUR, 'pre', country('HAI', 'Haiti'), country('MEX', 'Mexico')),
  ] }, concacaf);
  const names = new TeamNames(games);
  assert.deepEqual(gamesNamed('Campeonato W de Concacaf 2026 · Cuartos de final: Estados Unidos vs. El Salvador', games, names).map((g) => g.id), ['concacafw:w1']);
  assert.deepEqual(gamesNamed('Cuartos de final: México vs. Haití', games, names).map((g) => g.id), ['concacafw:w2']);
  const gleague = gamesOf({ events: [event('g1', now, 'pre', team('1', 'Austin', 'Spurs', 'AUS'), team('2', 'Mexico City', 'Capitanes', 'MXC'))] }, leagueByKey('gleague')!);
  assert.deepEqual(gamesNamed('Baloncesto NBA G League · Capitanes CDMX vs. Austin Spurs', gleague, new TeamNames(gleague)).map((g) => g.id), ['gleague:g1']);
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
  assert.equal(showsGame({ start: now + HOUR, end: now + 4 * HOUR }, game), true, 'a guide an hour out');
  assert.equal(showsGame({ start: now + 2 * HOUR, end: now + 4 * HOUR }, game), false, 'two hours in');
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
  for (const name of ['FI: V Sport Ultra HD', 'Flying V Fights', '24/7 Men at Work', '24/7 Live at the Apollo']) {
    assert.equal(looksLikeGame(name), false, name);
  }
  assert.equal(looksLikeGame('NFL | 4k - SNF 8:20pm Raiders at Browns'), true);
  assert.equal(looksLikeGame('Cuartos de final: México vs. Haití'), true);
});

test("college basketball is read whole, not the scoreboard's featured games", async () => {
  asked = [];
  const board = new Scoreboard({ base, now: () => now });
  await board.day(leagueByKey('ncaam')!, espnDay(now));
  assert.deepEqual(asked, [`/basketball/mens-college-basketball/scoreboard?${espnDay(now)}|groups=50`]);
});

test('a guide is read a thousand channels at a time', async () => {
  const many = Array.from({ length: 2500 }, (_, n): ListedChannel => ({ meta: { type: 'tv', id: String(n), name: `Channel ${n}` } }));
  const sizes: number[] = [];
  const all = await programmesInParts(async (metas) => {
    sizes.push(metas.length);
    return new Map(metas.map((meta) => [`tv|${meta.id}`, []]));
  }, many);
  assert.deepEqual(sizes, [1000, 1000, 500]);
  assert.equal(all.size, 2500);
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
    channel('preview', 'Campus Channel', '105'),
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
    ['tv|preview', [
      programme('Spartans Preview', now + 0.5 * HOUR, now + HOUR, { genres: ['Sports'] }),
      programme('Spartans of the Galaxy', now + 1.5 * HOUR, now + 2 * HOUR),
    ]],
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
  // Penn State at Michigan State is on no channel; a sports programme near it names one of its teams
  // (a cartoon sharing the word doesn't count).
  assert.deepEqual(check.nearMisses.map((m) => [m.game, m.programmes.map((p) => p.programme)]), [
    ['Penn State Nittany Lions at Michigan State Spartans', ['Spartans Preview']],
  ]);
  assert.deepEqual(check.failed, [{ league: 'NHL', why: 'HTTP 500' }]);
  const nbaRow = check.leagues.find((row) => row.league === 'NBA');
  assert.deepEqual(nbaRow, { league: 'NBA', games: 3, withChannels: 2 });
  assert.equal(check.channels, 7);
  assert.equal(check.channelsRead, 7);
  assert.equal(check.channelsWithGuide, 6);
});

const listed = (id: string, name: string, number?: string): ListedChannel => ({ meta: { type: 'tv', id, name }, ...(number ? { number } : {}) });
const shown = (title: string, start: number, end: number, extra: Partial<Programme> = {}): Programme => ({ id: `${title}-${start}`, title, start, end, ...extra });

test("a channel made for a game carries it all through: its build-up, the game and its wrap-up", () => {
  const finder = new GameFinder(allGames(), now);
  const game = listed('game', '4K | NBA | 76ers v Pacers | 4:30 PM PST', '901');
  const start = now + 3.5 * HOUR;
  const part = (programme: Programme) => finder.showing(game, programme)?.part;
  assert.equal(part(shown('Coming up: NBA Basketball today at 4:30 PM PST', now - HOUR, start)), 'before');
  assert.equal(part(shown('Philadelphia 76ers at Indiana Pacers', start, start + 3 * HOUR, { live: true })), 'game');
  assert.equal(part(shown('NBA Basketball: Final', start + 3 * HOUR, start + 6 * HOUR)), 'after');
  assert.equal(part(shown('Off air', start + 30 * HOUR, start + 32 * HOUR)), undefined, 'a day and more from its game');
  // Any other channel: the game only, by its name and times.
  const national = listed('national', 'National Sports', '101');
  assert.equal(finder.showing(national, shown('NBA Basketball', now + 2 * HOUR, now + 4.5 * HOUR, { episodeTitle: 'Heat at Knicks' }))?.game.id, 'nba:1');
  assert.equal(finder.showing(national, shown('NBA Countdown', now + 1.5 * HOUR, now + 2 * HOUR)), undefined);
});

test("a game's channels, best first: its own channel in 4K, its own, a live programme, the rest", () => {
  const finder = new GameFinder(allGames(), now);
  const start = now + 3.5 * HOUR;
  const channels = [
    listed('replay', 'Sports Extra', '50'),
    listed('regional', 'Sports Philly', '102'),
    listed('hd', 'NBA | 76ers v Pacers', '902'),
    listed('uhd', '4K | NBA | 76ers v Pacers', '901'),
  ];
  const guide = new Map<string, Programme[]>([
    ['tv|replay', [shown('76ers at Pacers', start, start + 3 * HOUR)]],
    ['tv|regional', [shown('76ers at Pacers', start - 30 * MINUTE, start + 3 * HOUR, { live: true })]],
    ['tv|uhd', [shown('Philadelphia 76ers at Indiana Pacers', start, start + 3 * HOUR, { live: true })]],
  ]);
  const order = ranked(channelsByGame(finder, channels, guide).get('nba:2') ?? []).map((c) => c.channel.number);
  assert.deepEqual(order, ['901', '902', '102', '50']);
});

test("a game as the apps get it: logos through this server, scores once begun", () => {
  const live = gameInfo(gamesOfNba().find((g) => g.state === 'in')!, 'game');
  assert.equal(live.part, 'game');
  assert.equal(live.home.score, '54');
  assert.equal(live.home.logo, '/AIOStreams/Sports/Logo/nba/12');
  assert.equal(live.clock, '4:12');
  assert.equal(JSON.stringify(live).includes('logos.example'), false, "ESPN's own address sent to the apps");
  const upcoming = gameInfo(gamesOfNba().find((g) => g.id === 'nba:1')!);
  assert.equal(upcoming.part, undefined);
  assert.equal(upcoming.home.score, undefined);
  assert.equal(upcoming.start, iso(now + 2 * HOUR).replace('Z', ':00.000Z'));
});

test('a programme showing a game is sent with it', () => {
  const deps: any = { encodeProgramId: () => 'programme-id', encodeId: () => 'channel-id', rememberImages: () => {}, imageTag: () => 'tag' };
  const game = gameInfo(gamesOfNba()[0], 'game');
  const item = programItem(deps, 'server', listed('national', 'National Sports'), shown('NBA Basketball', now, now + HOUR), { game });
  assert.deepEqual(item.aiostreams?.game, game);
  const plain = programItem(deps, 'server', listed('national', 'National Sports'), shown('News', now, now + HOUR));
  assert.equal(plain.aiostreams, undefined);
});

test('sports can be turned off, and narrowed to some leagues', async () => {
  const saved = { on: process.env.JELLYFIN_SPORTS, leagues: process.env.JELLYFIN_SPORTS_LEAGUES };
  try {
    delete process.env.JELLYFIN_SPORTS;
    delete process.env.JELLYFIN_SPORTS_LEAGUES;
    assert.equal(sportsOn(), true);
    assert.equal(sportsLeagues().length > 20, true);
    process.env.JELLYFIN_SPORTS_LEAGUES = 'nba, ligamx';
    assert.deepEqual(sportsLeagues().map((l) => l.key), ['nba', 'ligamx']);
    process.env.JELLYFIN_SPORTS = 'off';
    assert.equal(sportsOn(), false);
    forgetGames();
    assert.equal(await gameTagger(new Scoreboard({ base, now: () => now })), undefined, 'games found with sports off');
  } finally {
    for (const [name, value] of [['JELLYFIN_SPORTS', saved.on], ['JELLYFIN_SPORTS_LEAGUES', saved.leagues]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    forgetGames();
  }
});

test("a logo comes from ESPN's image host only, and is kept", async () => {
  const board = new Scoreboard({ base, now: () => now });
  await board.games(now - HOUR, now + 6 * HOUR, [nba]);
  let fetched: string[] = [];
  const fetcher: any = async (url: string) => {
    fetched.push(url);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  };
  // The test games' logos are on another host: refused.
  assert.equal(await teamLogo('nba', '18', board, fetcher), null);
  assert.deepEqual(fetched, []);
  const espn = new Scoreboard({ now: () => now, fetch: (async () => new Response(JSON.stringify({ events: [
    event('1', now + 2 * HOUR, 'pre', { ...knicks, logo: 'https://a.espncdn.com/i/teamlogos/nba/500/ny.png' }, heat),
  ] }), { headers: { 'content-type': 'application/json' } })) as any });
  await espn.games(now - HOUR, now + 6 * HOUR, [nba]);
  const logo = await teamLogo('nba', '18', espn, fetcher);
  assert.equal(logo?.type, 'image/png');
  assert.deepEqual([...logo!.bytes], [1, 2, 3]);
  await teamLogo('nba', '18', espn, fetcher);
  assert.deepEqual(fetched, ['https://a.espncdn.com/i/teamlogos/nba/500/ny.png'], 'a logo fetched again while kept');
  assert.equal(await teamLogo('nba', 'nobody', espn, fetcher), null);
});

// A fight card as ESPN lists it: bouts with athletes, the main event last, results once over.
const fighter = (id: string, name: string, short: string, order: number, winner = false) => ({
  id, order, winner, athlete: { displayName: name, shortName: short, flag: { href: `https://a.espncdn.com/i/teamlogos/countries/500/${id}.png` } },
  records: [{ type: 'total', summary: '20-5-0' }],
});
const bout = (at: number, state: string, weight: string, a: any, b: any, extra: any = {}) => ({
  date: iso(at), endDate: iso(at + 30 * MINUTE), type: { abbreviation: weight }, competitors: [a, b],
  status: { period: state === 'pre' ? 0 : extra.round ?? 1, displayClock: state === 'pre' ? '-' : extra.time ?? '2:10', type: { state } },
  details: extra.method ? [{ type: { text: 'Results' } }, { type: { text: `Unofficial Winner ${extra.method}` } }] : [],
  broadcasts: [{ names: ['Streaming'] }],
  venue: { fullName: 'Arena', address: { city: 'Riyadh', country: 'Saudi Arabia' } },
});
const cardDay = (state: string) => ({ events: [{
  id: '600', date: iso(now), name: 'UFC Fight Night: Adesanya vs Magomedov', shortName: 'Adesanya vs Magomedov',
  status: { type: { state, shortDetail: state === 'post' ? 'Final' : 'Scheduled', completed: state === 'post' } },
  competitions: [
    bout(now, 'post', 'Bantamweight', fighter('a1', 'Prelim One', 'P. One', 1, true), fighter('a2', 'Prelim Two', 'P. Two', 2), { method: 'KO/TKO', round: 2, time: '3:15' }),
    bout(now + 3 * HOUR, state === 'post' ? 'post' : 'in', 'Welterweight', fighter('b1', 'Yaroslav Amosov', 'Y. Amosov', 1), fighter('b2', 'Ian Machado Garry', 'I. Machado Garry', 2, true), { round: 2 }),
    bout(now + 4 * HOUR, state === 'post' ? 'post' : 'pre', 'Middleweight', fighter('c1', 'Israel Adesanya', 'I. Adesanya', 1), fighter('c2', 'Shara Magomedov', 'S. Magomedov', 2)),
  ],
}] });

test('a fight card is read as one game: its main event the two sides, its fights in order, results once over', () => {
  const [card] = gamesOf(cardDay('in'), leagueByKey('ufc')!);
  assert.equal(card.kind, 'card');
  assert.equal(card.title, 'UFC Fight Night');
  assert.equal(card.away.name, 'Israel Adesanya');
  assert.equal(card.home.name, 'Shara Magomedov');
  assert.equal(card.away.nickname, 'Adesanya');
  assert.equal(card.bouts?.length, 3);
  assert.deepEqual(card.bouts?.map((b) => b.main ?? false), [false, false, true]);
  assert.equal(card.bouts?.[0].method, 'KO/TKO');
  assert.equal(card.bouts?.[0].round, 2);
  assert.equal(card.bouts?.[0].a.winner, true);
  assert.equal(card.bouts?.[1].b.nickname, 'Machado Garry');
  assert.equal(card.detail, 'Amosov vs Machado Garry · R2 · 1 to go');
  // The fight over ended at its end; the main card, still to come, runs up to three hours.
  assert.equal(card.end, now + 7 * HOUR);
  assert.equal(card.city, 'Riyadh, Saudi Arabia');
  assert.equal(keepFor([card], now), 30 * 1000);
  const shown = gameInfo(card, 'game');
  assert.equal(shown.kind, 'card');
  assert.equal(shown.bouts[2].a.logo, '/AIOStreams/Sports/Logo/ufc/c1');
  assert.equal(shown.bouts[0].method, 'KO/TKO');
});

test("a card is found by its name or its main event's fighters, over its prelims and its main card", () => {
  const games = gamesOf(cardDay('pre'), leagueByKey('ufc')!);
  const names = new TeamNames(games);
  const named = (text: string) => gamesNamed(text, games, names).map((g) => g.id);
  assert.deepEqual(named('UFC Fight Night: Adesanya vs. Magomedov'), ['ufc:600']);
  assert.deepEqual(named('UFC Fight Night Prelims'), ['ufc:600']);
  assert.deepEqual(named('Adesanya v Magomedov'), ['ufc:600']);
  assert.deepEqual(named('UFC Embedded'), []);
  const card = games[0];
  assert.equal(showsGame({ start: now, end: now + 3 * HOUR }, card), true, 'the prelims');
  assert.equal(showsGame({ start: now + 3 * HOUR, end: now + 6 * HOUR }, card), true, 'the main card');
  assert.equal(showsGame({ start: now + 26 * HOUR, end: now + 29 * HOUR }, card), false, 'a replay the next day');
});

// Boxing as Boxerbook gives it: cards with their bouts, the main event first, results apart.
const boxingDay = Date.parse('2026-12-05T00:00:00Z');
const boxerbookSchedule = { events: [
  { id: 900, date: '2026-12-05', start_utc: '2026-12-06T01:00Z', venue: 'Arena', city: 'Glendale', country: 'US', promoter: 'PBC',
    broadcasts: [{ platform: 'DAZN PPV', region: 'worldwide' }, { platform: 'Prime Video', region: 'worldwide' }, { platform: 'DAZN PPV', region: 'US' }],
    url: 'https://boxerbook.com/events/900/2026-12-05-glendale',
    bouts: [
      { id: 1, status: 'scheduled', a: { id: 11, name: 'David Benavidez', record: '30-0-0' }, b: { id: 12, name: 'Michał Cieślak', record: '24-2-0' }, display: ['a', 'b'], division: 'cru', scheduled_rounds: 12, title_text: 'WBA and WBO cruiserweight titles', forecast: { p_a: 0.8 }, market: { favourite: 'a' } },
      { id: 2, status: 'scheduled', a: { id: 13, name: 'Brian Mendoza' }, b: { id: 14, name: 'Vergil Ortiz Jr.' }, display: ['b', 'a'], division: 'mid', scheduled_rounds: 10 },
    ] },
  { id: 901, date: '2026-12-04', venue: 'Hall', city: 'Riyadh', country: 'SA', broadcasts: [], url: 'https://boxerbook.com/events/901/2026-12-04-riyadh',
    bouts: [{ id: 3, status: 'scheduled', a: { id: 15, name: 'Jevgenijs Aleksejevs' }, b: { id: 16, name: 'Aaron McKenna' }, display: ['b', 'a'], division: 'w_fea' }] },
] };
const boxerbookResults = { bouts: [
  { id: 2, date: '2026-12-05', a: { id: 13, name: 'Brian Mendoza' }, b: { id: 14, name: 'Vergil Ortiz Jr.' }, display: ['b', 'a'], winner: 'b', method: 'TKO', round: 7, time: '1:42' },
] };

function boxerbook(handler: (path: string, key?: string) => [number, any, Record<string, string>?]) {
  const asked: Array<{ path: string; key?: string }> = [];
  const fetcher: any = async (url: string, init: any) => {
    const path = url.replace('https://boxerbook.test/v1', '');
    const key = init?.headers?.['x-api-key'];
    asked.push({ path, key });
    const [status, body, headers] = handler(path, key);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(headers ?? {}) } });
  };
  return { asked, fetcher };
}

test("boxing's weight classes and surnames read the way a guide writes them", () => {
  assert.equal(divisionName('cru'), 'Cruiserweight');
  assert.equal(divisionName('w_fea'), 'W Featherweight');
  assert.equal(divisionName('other'), undefined);
  assert.equal(surnameOf('Vergil Ortiz Jr.'), 'Ortiz');
  assert.equal(surnameOf('Michał Cieślak'), 'Cieślak');
  assert.deepEqual(wordsOf('Benavidez vs. Cieślak'), ['benavidez', 'vs', 'cieslak']);
});

test('a boxing card from Boxerbook: its main event first, results merged in, its credit, no odds', async () => {
  let key: string | undefined = 'MY-KEY';
  const { asked, fetcher } = boxerbook((path) => (path.startsWith('/schedule') ? [200, boxerbookSchedule] : [200, boxerbookResults]));
  const boxing = new BoxingSource({ base: 'https://boxerbook.test/v1', fetch: fetcher, now: () => boxingDay + 26 * HOUR, key: () => key });
  const read = await boxing.games(leagueByKey('boxing')!, boxingDay - DAY_MS, boxingDay + 3 * DAY_MS);
  assert.deepEqual(asked.map((a) => a.path), ['/schedule?when=30d', '/results?days=2']);
  assert.equal(asked[0].key, 'MY-KEY', 'the key not sent');
  assert.deepEqual(read.games.map((g) => g.name), ['Aaron McKenna vs Jevgenijs Aleksejevs', 'David Benavidez vs Michał Cieślak']);
  const card = read.games[1];
  assert.equal(card.kind, 'card');
  assert.equal(card.start, Date.parse('2026-12-06T01:00Z'));
  assert.equal(card.state, 'in', 'a card under way, a result in');
  assert.deepEqual(card.broadcasts, ['DAZN PPV', 'Prime Video']);
  assert.equal(card.bouts?.[0].main, true);
  assert.equal(card.bouts?.[0].title, 'WBA and WBO cruiserweight titles');
  assert.equal(card.bouts?.[0].weight, 'Cruiserweight');
  const done = card.bouts?.[1];
  assert.equal(done?.a.name, 'Vergil Ortiz Jr.', 'shown in the order Boxerbook shows them');
  assert.equal(done?.a.winner, true);
  assert.equal(done?.method, 'TKO');
  assert.equal(done?.round, 7);
  assert.deepEqual(card.credit, { text: 'Data from Boxerbook', url: 'https://boxerbook.com/events/900/2026-12-05-glendale' });
  const shown = gameInfo(card, 'game');
  assert.deepEqual(shown.credit, card.credit);
  assert.equal(JSON.stringify(shown).includes('favourite'), false, 'betting markets sent to the apps');
  assert.equal(JSON.stringify(shown).includes('MY-KEY'), false, 'the key sent to the apps');
  const untimed = read.games[0];
  assert.equal(untimed.untimed, true);
  assert.equal(untimed.detail, 'Final', 'a card days gone shown as still to come');
  // Read again before it's due: nothing asked.
  await boxing.games(leagueByKey('boxing')!, boxingDay - DAY_MS, boxingDay + 3 * DAY_MS);
  assert.equal(asked.length, 2);
  key = undefined;
});

test("a boxing card is found by any of its fights' boxers, over its day when its time isn't known", () => {
  const boxing = new BoxingSource();
  (boxing as any).keepSchedule(boxerbookSchedule, boxingDay);
  const games: Game[] = [...(boxing as any).cards].map(([id, card]: [string, any]) => (boxing as any).cardOf(leagueByKey('boxing')!, id, card, boxingDay));
  const names = new TeamNames(games);
  const named = (text: string) => gamesNamed(text, games, names).map((g) => g.id);
  assert.deepEqual(named('Boxeo: Benavidez vs. Cieslak'), ['boxing:900']);
  assert.deepEqual(named('PBC on Prime Video: Benavidez vs. Cieślak'), ['boxing:900']);
  assert.deepEqual(named('LIVE EVENT 03 - 6pm Ortiz v Mendoza'), ['boxing:900'], 'a fight lower on the card');
  assert.deepEqual(named('Benavidez Countdown'), []);
  const timed = games.find((g) => g.id === 'boxing:900')!;
  assert.equal(showsGame({ start: Date.parse('2026-12-05T22:00Z'), end: Date.parse('2026-12-06T04:00Z') }, timed), true, 'a guide hours before its time');
  assert.equal(showsGame({ start: Date.parse('2026-12-07T22:00Z'), end: Date.parse('2026-12-08T01:00Z') }, timed), false, 'a replay days later');
  const untimed = games.find((g) => g.id === 'boxing:901')!;
  assert.equal(showsGame({ start: Date.parse('2026-12-04T19:00Z'), end: Date.parse('2026-12-04T23:00Z') }, untimed), true);
  assert.equal(showsGame({ start: Date.parse('2026-12-06T19:00Z'), end: Date.parse('2026-12-06T23:00Z') }, untimed), false);
});

test("Boxerbook's limits are kept to: a day's limit reached waits, a refused key is said", async () => {
  let status = 429;
  const { asked, fetcher } = boxerbook(() => [status, { title: 'limit' }, { 'retry-after': '3600', 'x-ratelimit-day-remaining': '0' }]);
  let clock = boxingDay;
  const boxing = new BoxingSource({ base: 'https://boxerbook.test/v1', fetch: fetcher, now: () => clock, key: () => 'KEY' });
  const first = await boxing.games(leagueByKey('boxing')!, boxingDay, boxingDay + DAY_MS);
  assert.equal(first.failed, 'over its daily limit');
  const reads = asked.length;
  clock += 30 * MINUTE;
  await boxing.games(leagueByKey('boxing')!, boxingDay, boxingDay + DAY_MS);
  assert.equal(asked.length, reads, 'asked again while told to wait');
  // Later the same day, nothing left: still nothing asked. The next day, asked again.
  clock += 2 * HOUR;
  await boxing.games(leagueByKey('boxing')!, boxingDay, boxingDay + DAY_MS);
  assert.equal(asked.length, reads, 'asked with none left today');
  status = 401;
  clock = boxingDay + DAY_MS + HOUR;
  const refused = await boxing.games(leagueByKey('boxing')!, boxingDay, boxingDay + DAY_MS);
  assert.equal(refused.failed, 'its key was refused');
  assert.equal(asked.length > reads, true);
});

test('the check reads sports channels first, a share at a time, and answers with what it has when time is up', async () => {
  const lineup: ListedChannel[] = [
    ...Array.from({ length: 5 }, (_, n): ListedChannel => ({ meta: { type: 'tv', id: `film${n}`, name: `Films ${n}`, groups: ['Movies'] } })),
    { meta: { type: 'tv', id: 'espn', name: 'ESPN' } },
    { meta: { type: 'tv', id: 'tudn', name: 'TUDN', groups: ['MX: Deportes'] } },
    { meta: { type: 'tv', id: 'news', name: 'News 24' } },
  ];
  assert.deepEqual(sportsFirst(lineup).slice(0, 2).map((c) => c.meta.id), ['espn', 'tudn']);
  let clock = 0;
  const asked: string[][] = [];
  const board = new Scoreboard({ base, now: () => now });
  const check = await sportsCheck({
    channels: async () => lineup,
    programmes: async (part) => {
      asked.push(part.map((c) => c.meta.id));
      clock += 60 * 1000;
      return new Map();
    },
  }, board, now, { chunk: 3, budgetMs: 90 * 1000, clock: () => clock });
  assert.deepEqual(asked[0], ['espn', 'tudn', 'film0'], 'sports channels not read first');
  assert.equal(asked.length, 2, 'read on past the time given');
  assert.equal(check.channelsRead, 6);
  assert.equal(check.channels, 8);
});

test('the other names guides give teams: a club in full or in Spanish, a college by letters or in full', () => {
  const soccer = (key: string, id: string, home: any, away: any, at = now) => gamesOf({ events: [event(id, at, 'pre', home, away)] }, leagueByKey(key)!);
  const club = (id: string, name: string, short = name) => ({ id, location: name, name, abbreviation: id, displayName: name, shortDisplayName: short });
  const games = [
    ...soccer('ligue1', 'l1', club('B', 'Brest'), club('P', 'Paris FC')),
    ...soccer('bundesliga', 'b1', club('H', 'Hamburg SV', 'Hamburg'), club('M', 'Bayern Munich', 'Bayern')),
    ...soccer('seriea', 's1', club('I', 'Internazionale'), club('G', 'Genoa')),
    ...gamesOf({ events: [event('c1', now, 'pre', team('U', 'UNLV', 'Rebels', 'UNLV'), team('R', 'UT Rio Grande Valley', 'Vaqueros', 'UTRGV'))] }, ncaaf),
    ...gamesOf({ events: [event('c2', now, 'pre', team('O', 'Ole Miss', 'Rebels', 'MISS'), team('S', 'Mississippi State', 'Bulldogs', 'MSST', 'Mississippi St'))] }, ncaaf),
  ];
  const names = new TeamNames(games);
  const named = (text: string) => gamesNamed(text, games, names).map((g) => g.id);
  assert.deepEqual(named('French Ligue 1 Soccer : Stade Brestois vs. Paris FC'), ['ligue1:l1']);
  assert.deepEqual(named('Fútbol Bundesliga : Hamburgo SV vs. Bayern Munich'), ['bundesliga:b1']);
  assert.deepEqual(named('BL : Hamburger SV - FC Bayern München'), ['bundesliga:b1']);
  assert.deepEqual(named('Fútbol Serie A : Inter de Milán vs. Genoa'), ['seriea:s1']);
  assert.deepEqual(named('INTER - GENOA (Z)'), ['seriea:s1']);
  assert.deepEqual(named('College Basketball : Texas-Rio Grande Valley at UNLV'), ['ncaaf:c1']);
  assert.deepEqual(named('College Football : Mississippi State at Mississippi'), ['ncaaf:c2']);
});

test("a soccer game is found by its league where a guide names one side a way that isn't known", () => {
  const club = (id: string, name: string) => ({ id, location: name, name, abbreviation: id, displayName: name, shortDisplayName: name });
  const games = gamesOf({ events: [event('x1', now, 'pre', club('Z', 'Zulte Town'), club('Y', 'York City'))] }, leagueByKey('epl')!);
  const finder = new GameFinder(games, now);
  const on = (title: string, start: number, extra: Partial<Programme> = {}) => finder.programmeGames(shown(title, start, start + 2 * HOUR, extra)).map((g) => g.id);
  assert.deepEqual(on('Premier League : Zulte Towners vs. York City ᴸᶦᵛᵉ', now - 5 * MINUTE), ['epl:x1']);
  assert.deepEqual(on('Premier League : Zulte Towners vs. York City', now - 5 * MINUTE, { live: true }), ['epl:x1']);
  assert.deepEqual(on('Premier League : Zulte Towners vs. York City', now - 5 * MINUTE), [], 'not marked live: a replay or a preview');
  assert.deepEqual(on('Premier League : Zulte Towners vs. York City ᴸᶦᵛᵉ', now + HOUR), [], 'an hour off its time');
  assert.deepEqual(on('Highlights : York City ᴸᶦᵛᵉ', now - 5 * MINUTE), [], 'no league named');
});

test('which channel shows which game is read once whole, then only the sports channels every few minutes', async () => {
  forgetGameChannels();
  const lineup: ListedChannel[] = [
    { meta: { type: 'tv', id: 'films', name: 'Films' } },
    { meta: { type: 'tv', id: 'philly', name: 'Philly Local' } },
    { meta: { type: 'tv', id: 'espn', name: 'ESPN' } },
  ];
  const start = now + 3.5 * HOUR;
  const guide = new Map<string, Programme[]>([['tv|philly', [shown('76ers at Pacers', start, start + 3 * HOUR, { live: true })]]]);
  const asked: string[][] = [];
  let clock = now;
  const source = {
    channels: async () => lineup,
    programmes: async (part: ListedChannel[]) => {
      asked.push(part.map((c) => c.meta.id));
      return guide;
    },
    games: async () => allGames(),
  };
  const first = await gameChannels('guide-a', source, () => clock);
  assert.equal(first.complete, true);
  assert.deepEqual(first.byGame.get('nba:2')?.map((c) => c.channel.meta.id), ['philly']);
  assert.deepEqual(asked, [['espn', 'films', 'philly']], 'the whole guide, sports channels first');
  asked.length = 0;
  clock += 60 * 1000;
  await gameChannels('guide-a', source, () => clock);
  assert.deepEqual(asked, [], 'read again within minutes');
  clock += 6 * MINUTE;
  await gameChannels('guide-a', source, () => clock);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(asked, [['philly', 'espn']], 'not only the channels found showing sport, and the sports channels');
  forgetGameChannels();
});
