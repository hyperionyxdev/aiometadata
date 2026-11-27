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
import { channelsByGame, GameFinder, gameInfo, ranked } from './guide';
import { forgetGames, gameTagger, teamLogo } from './serve';
import { programmesInParts } from './live';
import { sportsLeagues, sportsOn } from './settings';
import { programItem } from '../livetv/items';
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
    ['tv|preview', [programme('Spartans Preview', now + 0.5 * HOUR, now + HOUR)]],
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
  // Penn State at Michigan State is on no channel; a programme near it names one of its teams.
  assert.deepEqual(check.nearMisses.map((m) => [m.game, m.programmes.map((p) => p.programme)]), [
    ['Penn State Nittany Lions at Michigan State Spartans', ['Spartans Preview']],
  ]);
  assert.deepEqual(check.failed, [{ league: 'NHL', why: 'HTTP 500' }]);
  const nbaRow = check.leagues.find((row) => row.league === 'NBA');
  assert.deepEqual(nbaRow, { league: 'NBA', games: 3, withChannels: 2 });
  assert.equal(check.channels, 7);
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
