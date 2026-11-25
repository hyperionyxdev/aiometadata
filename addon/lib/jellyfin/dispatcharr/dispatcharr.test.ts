// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// Runs the Dispatcharr Live TV code against a fake Dispatcharr, with invented channels and guide.
// How to run it: docs/live-tv-dispatcharr.md, "Tests".
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import zlib from 'zlib';
import { AddressInfo } from 'net';
import { DispatcharrLive, dispatcharrLive } from './index';
import { DispatcharrClient, hostHeaderFor } from './client';
import { shownSubtitle } from './guide';
import { allowedFor, dispatcharrSettings, type DispatcharrSettings } from './settings';
import { timeshiftStamp } from './playback';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const today = iso(now).slice(0, 10);

let fake: http.Server;
let base = '';
let seen: Array<{ method: string; path: string; query: string; auth?: string; key?: string; host?: string }> = [];
let running: Array<[string, number]> = [];
let switched: Array<[string, number]> = [];
let epgRows: any[] = [];
let down = false;
let switchDelayMs = 0;

const stream = (id: number, account: number, resolution: string | null) => ({
  id, name: `Feed ${id}`, m3u_account: account, stream_hash: `hash${id}`, is_custom: false,
  stream_stats: resolution ? { resolution, video_codec: 'h264', source_fps: 50, audio_codec: 'aac', audio_channels: '2.0' } : null,
});

const channels = [
  { id: 7, uuid: 'uuid-7', name: 'Old name', channel_number: 2, channel_group_id: 1, logo_id: 9, epg_data_id: 3,
    effective_name: 'News One', effective_channel_number: 2, effective_channel_group_id: 1, effective_logo_id: 9, effective_epg_data_id: 3, hidden_from_output: false },
  { id: 8, uuid: 'uuid-8', name: 'Match TV', channel_number: 1, channel_group_id: 2, hidden_from_output: false },
  { id: 9, uuid: 'uuid-9', name: 'Hidden', channel_number: 3, channel_group_id: 2, hidden_from_output: true },
  { id: 10, uuid: 'uuid-10', name: 'Film Loop', channel_number: 4, channel_group_id: 3, hidden_from_output: false },
];

const routes: Record<string, (body: any, query: URLSearchParams) => [number, any]> = {
  'POST /api/accounts/token/': (body) => (body?.username === 'reader' && body?.password === 'pw' ? [200, { access: 'A1', refresh: 'R1' }] : [401, {}]),
  'POST /api/accounts/token/refresh/': () => [200, { access: 'A2' }],
  'GET /api/channels/channels/': () => [200, channels],
  'GET /api/channels/channels/7/': () => [200, { ...channels[0], streams: [stream(11, 1, '1920x1080'), stream(12, 2, '1280x720'), stream(13, 2, null), stream(14, 3, '1920x1080')] }],
  'GET /api/channels/channels/8/': () => [200, { ...channels[1], streams: [] }],
  'GET /api/channels/channels/10/': () => [200, { ...channels[3], streams: [stream(21, 1, '1920x1080'), stream(22, 2, '1920x1080')] }],
  'GET /api/channels/groups/': () => [200, [{ id: 1, name: 'News' }, { id: 2, name: 'Sport' }, { id: 3, name: '24/7 Films' }]],
  'GET /api/m3u/accounts/': () => [200, [{ id: 1, name: 'Provider A', is_active: true }, { id: 2, name: 'Provider B', is_active: true }, { id: 3, name: 'Off', is_active: false }]],
  'GET /player_api.php': (_body, query) => (query.get('password') === 'x/c'
    ? [200, [{ stream_id: 7, tv_archive: 1, tv_archive_duration: 3 }, { stream_id: 10, tv_archive: 0 }]]
    : [200, { user_info: { auth: 0 } }]),
  'GET /proxy/ts/status': () => [200, { channels: running.map(([channel_id, stream_id]) => ({ channel_id, stream_id: String(stream_id) })) }],
  'POST /proxy/ts/change_stream/uuid-7': (body) => {
    switched.push(['uuid-7', body.stream_id]);
    return [200, { success: true }];
  },
  'GET /api/epg/epgdata/': () => [200, epgRows],
  'GET /api/epg/grid/': () => [200, { data: [
    { id: 1, tvg_id: 'news.example', title: 'Headlines', sub_title: 'Evening edition', description: 'The day\'s news', start_time: iso(now - 600000), end_time: iso(now + 600000).replace('Z', '+00:00'), season: null, episode: null, is_new: true, is_live: true, is_premiere: false, is_finale: false },
    { id: 2, tvg_id: 'news.example', title: 'Weather', sub_title: 'News', start_time: iso(now + 600000), end_time: iso(now + 1200000), season: 4, episode: 2, is_new: false, is_live: false, is_premiere: true, is_finale: true },
    { id: `dummy-standard-8-${today}`, tvg_id: 'uuid-8', title: 'Match TV', sub_title: '24/7 Channel', start_time: iso(now - 3600000), end_time: iso(now + 3 * 3600000), custom_properties: null, is_new: false, is_live: false, is_premiere: false, is_finale: false },
    { id: `dummy-custom-10-${today}`, tvg_id: 'uuid-10', title: 'Late Film', sub_title: 'Classic Cinema', description: null, start_time: iso(now - 600000), end_time: iso(now + 600000), custom_properties: { categories: ['Movie', 'Drama'], icon: 'https://images.example/poster.jpg' }, is_new: false, is_live: false, is_premiere: false, is_finale: false },
    { id: 5, tvg_id: 'other.example', title: 'Not ours', start_time: iso(now), end_time: iso(now + 60000) },
  ] }],
};

before(async () => {
  fake = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: url.pathname, query: url.search, auth: req.headers.authorization, key: req.headers['x-api-key'] as string | undefined, host: req.headers.host });
      if (down) {
        res.writeHead(502).end('bad gateway');
        return;
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      const signedIn = url.pathname.startsWith('/api/accounts/') || url.pathname === '/player_api.php'
        || req.headers['x-api-key'] === 'KEY' || /^Bearer A[12]$/.test(String(req.headers.authorization ?? ''));
      const [status, body] = !handler ? [404, '<html>not here</html>'] : !signedIn ? [401, {}] : handler(text ? JSON.parse(text) : undefined, url.searchParams);
      const send = () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (url.pathname.startsWith('/proxy/ts/change_stream/') && switchDelayMs) setTimeout(send, switchDelayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

after(() => {
  fake.close();
});

beforeEach(() => {
  seen = [];
  running = [['uuid-7', 12]];
  switched = [];
  epgRows = [{ id: 3, tvg_id: 'news.example', name: 'News' }];
  down = false;
  switchDelayMs = 0;
});

function settings(overrides: Partial<DispatcharrSettings> = {}): DispatcharrSettings {
  return {
    url: base, streamUrl: 'https://tv.example', apiKey: 'KEY', users: [], groups: [], name: 'Dispatcharr',
    autoSource: true, switchStreams: false, timeoutMs: 5000, cacheMs: 300000, ...overrides,
  };
}

const live = (overrides: Partial<DispatcharrSettings> = {}) => new DispatcharrLive(settings(overrides));

// ---------- Settings ----------

const ENV_NAMES = ['URL', 'STREAM_URL', 'API_KEY', 'USERNAME', 'PASSWORD', 'XC_USERNAME', 'XC_PASSWORD', 'OUTPUT_FORMAT', 'USERS'].map((n) => `JELLYFIN_DISPATCHARR_${n}`);
function withEnv(values: Record<string, string>, run: () => void): void {
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    run();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test('without its address, or without a login, Dispatcharr Live TV is off', () => {
  withEnv({}, () => {
    assert.equal(dispatcharrSettings(), null);
    assert.equal(dispatcharrLive(), null);
  });
  withEnv({ JELLYFIN_DISPATCHARR_URL: 'http://dispatcharr.invalid:9191' }, () => assert.equal(dispatcharrSettings(), null));
  withEnv({ JELLYFIN_DISPATCHARR_URL: 'not an address', JELLYFIN_DISPATCHARR_API_KEY: 'k' }, () => assert.equal(dispatcharrSettings(), null));
});

test('settings come from the environment', () => {
  withEnv({
    JELLYFIN_DISPATCHARR_URL: 'http://dispatcharr.invalid:9191/', JELLYFIN_DISPATCHARR_STREAM_URL: 'https://tv.example/',
    JELLYFIN_DISPATCHARR_USERNAME: 'reader', JELLYFIN_DISPATCHARR_PASSWORD: 'pw', JELLYFIN_DISPATCHARR_XC_USERNAME: 'viewer',
    JELLYFIN_DISPATCHARR_XC_PASSWORD: 'x', JELLYFIN_DISPATCHARR_OUTPUT_FORMAT: 'HLS', JELLYFIN_DISPATCHARR_USERS: 'abc, def',
  }, () => {
    const s = dispatcharrSettings()!;
    assert.equal(s.url, 'http://dispatcharr.invalid:9191');
    assert.equal(s.streamUrl, 'https://tv.example');
    assert.equal(s.username, 'reader');
    assert.deepEqual(s.xc, { username: 'viewer', password: 'x' });
    assert.equal(s.outputFormat, 'hls');
    assert.deepEqual(s.users, ['abc', 'def']);
    assert.ok(dispatcharrLive());
  });
});

test('who may use it: everyone when no one is listed, else names the server makes', () => {
  assert.ok(allowedFor(settings(), { userUUID: 'anything' }));
  const kids = { id: 'kids-profile', userId: 'aaaa1111' };
  const listed = settings({ users: ['1111-2222', 'AAAA-1111', '3333-4444/Kids-Profile'] });
  // A configuration UUID admits all its profiles; a Jellyfin user id (made from the UUID) admits that profile.
  assert.ok(allowedFor(listed, { userUUID: '11112222', profiles: [{ id: null, userId: '11112222' }] }));
  assert.ok(allowedFor(listed, { userUUID: '99999999', profiles: [kids] }));
  // <configuration>/<profile> needs both parts.
  assert.ok(allowedFor(listed, { userUUID: '3333-4444', profiles: [{ id: 'kids-profile', userId: 'bbbb' }] }));
  assert.ok(!allowedFor(listed, { userUUID: '5555-6666', profiles: [{ id: 'kids-profile', userId: 'cccc' }] }));
  assert.ok(!allowedFor(listed, { userUUID: '3333-4444', profiles: [{ id: null, userId: '33334444x' }] }));
  // A bare profile id is any configuration's to choose, so it admits no one.
  assert.ok(!allowedFor(settings({ users: ['kids-profile'] }), { userUUID: 'other', profiles: [{ id: 'kids-profile', userId: 'dddd' }] }));
  assert.ok(!allowedFor(listed, {}));
});

// ---------- Answers cut off ----------

test('an answer cut off, gzipped or not, or one that never finishes, fails rather than hanging', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const drip = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(drip));
      return;
    }
    const gzip = req.url !== '/plain';
    res.writeHead(200, { 'content-type': 'application/json', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
    res.write(gzip ? zlib.gzipSync(Buffer.from(`[${'1,'.repeat(100000)}1]`)).subarray(0, 200) : '[1,2');
    setTimeout(() => req.socket.destroy(), 30);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new DispatcharrClient(settings({ url: at, timeoutMs: 600 }));
    for (const path of ['/gzip', '/plain']) await assert.rejects(client.get(path), /could not be read/);
    const started = Date.now();
    await assert.rejects(client.get('/slow'), /no answer within/);
    assert.ok(Date.now() - started < 2000);
    // A shared read made of such requests settles too, for everyone waiting on it.
    const cut = new DispatcharrLive(settings({ url: at, timeoutMs: 600 }));
    const results = await Promise.allSettled([cut.lineup(), cut.lineup(), cut.guideDay(today, ['dispatcharr:7'])]);
    assert.ok(results.every((r) => r.status === 'rejected'));
  } finally {
    server.close();
  }
});

// ---------- Channels ----------

test('channels: visible ones in number order, with effective values, groups and logos', async () => {
  const metas = await live().catalog({});
  assert.deepEqual(metas.map((m) => m.name), ['Match TV', 'News One', 'Film Loop']);
  const news = metas[1];
  assert.equal(news.id, 'dispatcharr:7');
  assert.equal(news.type, 'tv');
  assert.equal(news.channelNumber, '2');
  assert.deepEqual(news.genres, ['News']);
  assert.equal(news.logo, 'https://tv.example/api/channels/logos/9/cache/');
  assert.equal(metas[0].logo, undefined);
  assert.ok(seen.some((r) => r.path === '/api/channels/channels/' && r.key === 'KEY'));
});

test('groups come in channel-number order, or in the order set', async () => {
  const a = live();
  assert.deepEqual((await a.lineup()).groups, ['Sport', 'News', '24/7 Films']);
  const b = live({ groups: ['news', '24/7 films'] });
  assert.deepEqual((await b.lineup()).groups, ['News', '24/7 Films']);
  assert.deepEqual((await b.catalog({})).map((m) => m.name), ['News One', 'Film Loop']);
});

test('a group with a slash in its name, a search and ids all answer without a group in any path', async () => {
  const a = live();
  assert.deepEqual((await a.catalog({ genre: '24/7 Films' })).map((m) => m.name), ['Film Loop']);
  assert.deepEqual((await a.catalog({ search: 'news' })).map((m) => m.name), ['News One']);
  assert.deepEqual((await a.catalog({ search: '4' })).map((m) => m.name), ['Film Loop']);
  assert.deepEqual((await a.catalog({ ids: 'dispatcharr:10,dispatcharr:7,other:1' })).map((m) => m.name), ['News One', 'Film Loop']);
  assert.ok(seen.every((r) => !/Films/.test(r.path + r.query)));
});

test('with an XC login: only that user\'s channels, with their catch-up days', async () => {
  const a = live({ xc: { username: 'viewer', password: 'x/c' } });
  const metas = await a.catalog({});
  assert.deepEqual(metas.map((m) => m.name), ['News One', 'Film Loop']);
  assert.equal(metas[0].behaviorHints.catchupDays, 3);
  assert.equal(metas[1].behaviorHints.catchupDays, undefined);
});

test('a username and password sign in once for requests that arrive together', async () => {
  const a = live({ apiKey: undefined, username: 'reader', password: 'pw' });
  await Promise.all([a.catalog({}), a.client.get('/api/channels/groups/')]);
  assert.equal(seen.filter((r) => r.path === '/api/accounts/token/').length, 1);
  assert.ok(seen.some((r) => r.path === '/api/channels/channels/' && r.auth === 'Bearer A1'));
});

test('Dispatcharr unreachable: the read fails with a message naming no address or login', async () => {
  const a = new DispatcharrLive({ ...settings(), url: 'http://127.0.0.1:1', xc: { username: 'viewer', password: 'secret-pass' } });
  await assert.rejects(a.catalog({}), (error: any) => {
    assert.match(error.message, /could not be reached/);
    assert.doesNotMatch(error.message, /127\.0\.0\.1|secret-pass|viewer/);
    return true;
  });
  // Asked again at once: it fails without waiting on another read.
  const started = Date.now();
  await assert.rejects(a.catalog({}));
  assert.ok(Date.now() - started < 100);
});

test('a refused XC login says so without the password', async () => {
  const a = live({ xc: { username: 'viewer', password: 'wrong-pass' } });
  await assert.rejects(a.lineup(), (error: any) => /XC login/.test(error.message) && !/wrong-pass/.test(error.message));
});

test('a kept lineup answers while Dispatcharr is down', async () => {
  const a = live({ cacheMs: 1 });
  await a.lineup();
  down = true;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await a.catalog({})).length, 3);
});

test('a container name with an underscore is sent as a host name Dispatcharr takes', () => {
  assert.equal(hostHeaderFor(new URL('http://dispatcharr_vpn:9191/api/')), 'localhost:9191');
  assert.equal(hostHeaderFor(new URL('http://dispatcharr_vpn/api/')), 'localhost');
  assert.equal(hostHeaderFor(new URL('http://dispatcharr:9191/api/')), undefined);
  assert.equal(hostHeaderFor(new URL('http://dispatcharr_vpn:9191/'), 'tv.internal'), 'tv.internal');
});

// ---------- Guide ----------

test('the guide: by tvg id through the guide ids, placeholders by channel uuid, with what the grid adds', async () => {
  const a = live();
  const guide = (await a.guideDay(today, ['dispatcharr:7', 'dispatcharr:8', 'dispatcharr:10', 'dispatcharr:99']))!;
  assert.deepEqual([...guide.keys()], ['dispatcharr:7', 'dispatcharr:8', 'dispatcharr:10']);
  const [headlines, weather] = guide.get('dispatcharr:7')!;
  assert.match(headlines.id, /^dispatcharr:7:\d+:\d+$/);
  assert.equal(headlines.name, 'Headlines');
  assert.equal(headlines.episodeTitle, 'Evening edition');
  assert.equal(headlines.overview, 'The day\'s news');
  // Sent as +00:00 rather than Z, read the same.
  assert.equal(headlines.end, now + 600000);
  assert.deepEqual([headlines.live, headlines.isNew, headlines.premiere, headlines.placeholder], [true, true, false, undefined]);
  // A subtitle that is only the channel's group is left off; season, episode and the finale stay.
  assert.equal(weather.episodeTitle, undefined);
  assert.deepEqual([weather.season, weather.episode, weather.premiere, weather.finale], [4, 2, true, true]);

  const [block] = guide.get('dispatcharr:8')!;
  assert.equal(block.name, 'Match TV');
  assert.equal(block.episodeTitle, undefined);
  assert.equal(block.placeholder, true);

  const [film] = guide.get('dispatcharr:10')!;
  assert.equal(film.episodeTitle, 'Classic Cinema');
  assert.deepEqual(film.genres, ['Movie', 'Drama']);
  assert.equal(film.thumbnail, 'https://images.example/poster.jpg');
  assert.equal(film.placeholder, true);

  // The grid was asked for the whole UTC day.
  const grid = seen.find((r) => r.path === '/api/epg/grid/')!;
  const query = new URLSearchParams(grid.query);
  assert.equal(query.get('start'), `${today}T00:00:00.000Z`);
  assert.equal(Date.parse(query.get('end')!) - Date.parse(query.get('start')!), 86400000);
});

test('subtitles that only say what kind of channel it is are left off', () => {
  assert.equal(shownSubtitle('24/7 Channel', 'Films'), undefined);
  assert.equal(shownSubtitle('24 / 7', 'Films'), undefined);
  assert.equal(shownSubtitle('soccer', 'Soccer'), undefined);
  assert.equal(shownSubtitle('  Part 2 ', 'Soccer'), 'Part 2');
  assert.equal(shownSubtitle('', 'Soccer'), undefined);
});

test('a channel\'s "Now:" line comes from a guide already read, never from a new read', async () => {
  const a = live();
  assert.equal((await a.catalog({ ids: 'dispatcharr:7' }))[0].description, undefined);
  await a.guideDay(today, ['dispatcharr:7']);
  assert.equal((await a.catalog({ ids: 'dispatcharr:7' }))[0].description, 'Now: Headlines – Evening edition');
});

test('guide requests that arrive together share one read', async () => {
  const a = live();
  await Promise.all([1, 2, 3, 4].map(() => a.guideDay(today, ['dispatcharr:7'])));
  assert.equal(seen.filter((r) => r.path === '/api/epg/grid/').length, 1);
  assert.equal(seen.filter((r) => r.path === '/api/epg/epgdata/').length, 1);
});

test('a day a little old answers at once while one new read is made; one kept for hours waits for it', async () => {
  const a = live();
  await a.guideDay(today, ['dispatcharr:7']);
  const days = (a.guide as any).days as Map<number, any>;
  for (const day of days.values()) day.at -= 20 * 60 * 1000;
  seen = [];
  const answers = await Promise.all([1, 2].map(() => a.guideDay(today, ['dispatcharr:7'])));
  assert.ok(answers.every((g) => g!.get('dispatcharr:7')!.length === 2));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.filter((r) => r.path === '/api/epg/grid/').length, 1);

  // Hours old, and holding nothing for the channel: the new read is waited for.
  for (const day of days.values()) {
    day.at -= 3 * 3600 * 1000;
    day.byKey = new Map();
    day.made = new Map();
  }
  assert.equal((await a.guideDay(today, ['dispatcharr:7']))!.get('dispatcharr:7')!.length, 2);
});

test('a channel given a guide the kept list lacks reads the list again', async () => {
  const a = live();
  epgRows = [];
  assert.equal((await a.guideDay(today, ['dispatcharr:7']))!.get('dispatcharr:7')!.length, 0);
  epgRows = [{ id: 3, tvg_id: 'news.example' }];
  const g = a.guide as any;
  g.epgIds.at -= 5 * 60 * 1000;
  for (const day of g.days.values()) day.at -= 3600 * 1000;
  seen = [];
  assert.equal((await a.guideDay(today, ['dispatcharr:7']))!.get('dispatcharr:7')!.length, 2);
  assert.equal(seen.filter((r) => r.path === '/api/epg/epgdata/').length, 1);
});

test('a day outside the guide\'s window is never read, and failures are kept within the window', async () => {
  const a = live();
  await a.lineup();
  const far = iso(now + 30 * 86400000).slice(0, 10);
  const past = iso(now - 30 * 86400000).slice(0, 10);
  for (const day of [far, past]) {
    const answer = (await a.guideDay(day, ['dispatcharr:7']))!;
    assert.deepEqual(answer.get('dispatcharr:7'), []);
  }
  assert.equal(seen.filter((r) => r.path === '/api/epg/grid/').length, 0);
  // A week ahead is still read.
  await a.guideDay(iso(now + 7 * 86400000).slice(0, 10), ['dispatcharr:7']);
  assert.equal(seen.filter((r) => r.path === '/api/epg/grid/').length, 1);

  const g = a.guide as any;
  g.failedAt.set(Date.parse(`${past}T00:00:00Z`), Date.now());
  down = true;
  for (let d = -8; d <= 7; d++) await a.guideDay(iso(now + d * 86400000).slice(0, 10), ['dispatcharr:7']);
  assert.ok(g.failedAt.size <= 16);
  assert.ok(!g.failedAt.has(Date.parse(`${past}T00:00:00Z`)));
});

test('a day that cannot be read answers null, and is not asked for again at once', async () => {
  const a = live();
  await a.lineup();
  down = true;
  assert.equal(await a.guideDay(today, ['dispatcharr:7']), null);
  seen = [];
  assert.equal(await a.guideDay(today, ['dispatcharr:7']), null);
  assert.equal(seen.length, 0);
});

// ---------- Sources ----------

test('a channel\'s sources: Auto named with the stream it plays, then each stream', async () => {
  const streams = await live().streams('tv', 'dispatcharr:7');
  assert.deepEqual(streams.map((s) => s.name), ['Dispatcharr · Auto · Provider B', 'Provider A · 1080p', 'Provider B · 720p', 'Provider B']);
  assert.equal(streams[0].url, 'https://tv.example/proxy/ts/stream/uuid-7');
  assert.equal(streams[0].description, 'Playing Provider B (Feed 12)\nDispatcharr switches stream if it fails');
  assert.equal(streams[0].behaviorHints.filename, 'Dispatcharr Auto Provider B 1080p');
  assert.equal(streams[1].url, 'https://tv.example/proxy/ts/stream/hash11');
  assert.equal(streams[1].description, 'Feed 11\nH264 · 50fps · AAC 2.0');
  assert.deepEqual(streams[1].streamData, { addon: { name: 'Dispatcharr' }, filename: 'Provider A 1080p Feed 11 #1', parsedFile: { resolution: '1080p' } });
  // The switched-off provider's stream isn't offered.
  assert.ok(!streams.some((s) => s.url.endsWith('hash14')));
  assert.equal(new Set(streams.map((s) => s.behaviorHints.filename)).size, streams.length);
});

test('the format asked for, Auto left out, and a channel nobody watches', async () => {
  const streams = await live({ autoSource: false, outputFormat: 'hls' }).streams('tv', 'dispatcharr:7');
  assert.equal(streams.length, 3);
  assert.equal(streams[0].url, 'https://tv.example/proxy/ts/stream/hash11?output_format=hls');
  running = [];
  assert.equal((await live().streams('tv', 'dispatcharr:7'))[0].name, 'Dispatcharr · Auto · Provider A');
  assert.deepEqual((await live().streams('tv', 'dispatcharr:8')).map((s) => s.name), ['Dispatcharr · Auto']);
  assert.deepEqual(await live().streams('tv', 'other:7'), []);
  assert.deepEqual(await live().streams('movie', 'dispatcharr:7'), []);
});

test('with an XC login, Auto plays as that user and a programme that has ended plays from catch-up', async () => {
  const a = live({ xc: { username: 'viewer', password: 'x/c' } });
  const streams = await a.streams('tv', 'dispatcharr:7');
  assert.equal(streams[0].url, 'https://tv.example/live/viewer/x%2Fc/7.ts');
  const s = Math.floor(now / 1000);
  // On now: live. Not started: nothing. Ended an hour ago: catch-up, for its length.
  assert.equal((await a.streams('tv', `dispatcharr:7:${s - 60}:${s + 60}`)).length, 4);
  assert.deepEqual(await a.streams('tv', `dispatcharr:7:${s + 600}:${s + 1200}`), []);
  const start = s - 5400;
  const [past] = await a.streams('tv', `dispatcharr:7:${start}:${start + 1800}`);
  assert.equal(past.url, `https://tv.example/timeshift/viewer/x%2Fc/30/${timeshiftStamp(start)}/7.ts`);
  assert.equal(past.behaviorHints.bingeGroup, 'dispatcharr-catchup');
  // Older than its catch-up days, or a channel without catch-up: nothing.
  assert.deepEqual(await a.streams('tv', `dispatcharr:7:${s - 5 * 86400}:${s - 5 * 86400 + 1800}`), []);
  assert.deepEqual(await a.streams('tv', `dispatcharr:10:${start}:${start + 1800}`), []);
  assert.equal(timeshiftStamp(Date.UTC(2030, 0, 1, 10, 5) / 1000), '2030-01-01:10-05');
});

test('without an XC login a programme that has ended has nothing to play', async () => {
  const s = Math.floor(now / 1000);
  assert.deepEqual(await live().streams('tv', `dispatcharr:7:${s - 7200}:${s - 3600}`), []);
});

test('switching: a stream chosen switches its running channel; Auto and catch-up switch nothing', async () => {
  const a = live({ switchStreams: true });
  const streams = await a.streams('tv', 'dispatcharr:7');
  // Every source plays the channel itself; the one it's on is marked.
  assert.ok(streams.every((s) => s.url === 'https://tv.example/proxy/ts/stream/uuid-7'));
  assert.match(streams[2].description, /Playing now$/);
  await a.chosen('dispatcharr:7', streams[0].behaviorHints.bingeGroup);
  await a.chosen('dispatcharr:7', 'dispatcharr-catchup');
  assert.deepEqual(switched, []);
  await a.chosen('dispatcharr:7', streams[1].behaviorHints.bingeGroup);
  assert.deepEqual(switched, [['uuid-7', 11]]);
  // Already on that stream: nothing to switch. Switching off: nothing either.
  running = [['uuid-7', 11]];
  switched = [];
  await a.chosen('dispatcharr:7', streams[1].behaviorHints.bingeGroup);
  await live().chosen('dispatcharr:7', streams[2].behaviorHints.bingeGroup);
  assert.deepEqual(switched, []);
});

test('a slow switch doesn\'t hold up the answer, and still happens', async () => {
  const a = live({ switchStreams: true });
  const streams = await a.streams('tv', 'dispatcharr:7');
  switchDelayMs = 500;
  const started = Date.now();
  // Dispatcharr answers the switch after half a second; the answer waits a tenth at most.
  await a.chosen('dispatcharr:7', streams[1].behaviorHints.bingeGroup, 100);
  assert.ok(Date.now() - started < 400);
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(switched, [['uuid-7', 11]]);
});

test('a channel whose streams cannot be read still plays as itself', async () => {
  const a = live();
  await a.lineup();
  down = true;
  const streams = await a.streams('tv', 'dispatcharr:7');
  assert.deepEqual(streams.map((s) => s.name), ['Dispatcharr · Auto']);
});
