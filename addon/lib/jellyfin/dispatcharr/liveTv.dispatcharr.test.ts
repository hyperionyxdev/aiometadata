// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// The Live TV routes with Dispatcharr read straight for one configuration and the stream addon for
// another, both naming the same channel, against a fake Dispatcharr and a fake addon (invented
// data). Storage is stubbed. How to run it: docs/live-tv-dispatcharr.md, "Tests".
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';

const Module = require('module');
// The backend imports some files by their built name (`./config.js`); here they are still .ts.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: any[]) {
  try {
    return resolve.call(this, request, ...rest);
  } catch (error: any) {
    if (error?.code === 'MODULE_NOT_FOUND' && request.startsWith('.') && request.endsWith('.js')) return resolve.call(this, request.slice(0, -3), ...rest);
    throw error;
  }
};
const configs = new Map<string, any>();
const load = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (/(^|\/)redisClient$/.test(request)) return { __esModule: true, default: { get: async () => null, set: async () => 'OK', del: async () => 0, mget: async (keys: string[]) => keys.map(() => null), on() {} } };
  if (/(^|\/)database$/.test(request)) return { getPreferences: async () => null, savePreferences: async () => undefined };
  if (/(^|\/)configApi$/.test(request)) return { loadSharedConfig: async (uuid: string) => configs.get(uuid) ?? null };
  return load.call(this, request, ...rest);
};

const DIRECT = '00000000-0000-4000-8000-00000000000a';
const ADDON = '00000000-0000-4000-8000-00000000000b';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
let dispatcharr: http.Server;
let addon: http.Server;
let live: any;
const table: Record<string, any[]> = {};

const json = (res: http.ServerResponse, body: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

before(async () => {
  dispatcharr = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    if (path === '/api/channels/channels/') return json(res, [{ id: 7, uuid: 'uuid-7', name: 'News Direct', channel_number: 2, channel_group_id: 1, logo_id: 9, hidden_from_output: false }]);
    if (path === '/api/channels/groups/') return json(res, [{ id: 1, name: 'News' }]);
    if (path === '/api/m3u/accounts/' || path === '/api/epg/epgdata/') return json(res, []);
    if (path === '/api/epg/grid/') return json(res, { data: [{ id: 'dummy-standard-7-x', tvg_id: 'uuid-7', title: 'Direct show', start_time: iso(now - 600000), end_time: iso(now + 600000) }] });
    res.writeHead(404).end('{}');
  });
  addon = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://fake').pathname);
    if (path === '/manifest.json') {
      return json(res, { id: 'fake.live', types: ['tv'], resources: ['catalog', 'stream'], catalogs: [{ type: 'tv', id: 'live', name: 'Live', extra: [{ name: 'genre', options: ['News'] }, { name: 'ids' }, { name: 'date' }] }] });
    }
    const meta = { id: 'dispatcharr:7', type: 'tv', name: 'News via addon', logo: 'https://addon.example/logo.png', genres: ['News'] };
    if (path.startsWith('/catalog/tv/live')) {
      if (!path.includes('date=')) return json(res, { metas: [meta] });
      const s = Math.floor((now - 600000) / 1000);
      return json(res, { metasDetailed: [{ ...meta, videos: [{ id: `dispatcharr:7:${s}:${s + 1200}`, title: 'Addon show', startTime: iso(s * 1000), endTime: iso((s + 1200) * 1000) }] }] });
    }
    res.writeHead(404).end('{}');
  });
  await Promise.all([dispatcharr, addon].map((server) => new Promise<void>((r) => server.listen(0, '127.0.0.1', r))));
  const port = (server: http.Server) => (server.address() as AddressInfo).port;
  setEnv('OUTBOUND_ALLOWED_PRIVATE_HOSTS', '127.0.0.1');
  setEnv('JELLYFIN_DISPATCHARR_URL', `http://127.0.0.1:${port(dispatcharr)}`);
  setEnv('JELLYFIN_DISPATCHARR_STREAM_URL', 'https://tv.example');
  setEnv('JELLYFIN_DISPATCHARR_API_KEY', 'KEY');
  setEnv('JELLYFIN_DISPATCHARR_USERS', DIRECT);
  const stream = `http://127.0.0.1:${port(addon)}/manifest.json`;
  configs.set(DIRECT, { jellyfinStreamUrl: stream });
  configs.set(ADDON, { jellyfinStreamUrl: stream });
  live = require('../liveTv');
  const add = (method: string) => (paths: string | string[], ...handlers: any[]) => {
    for (const p of ([] as string[]).concat(paths)) (table[`${method} ${p}`] ??= []).push(...handlers);
  };
  live.registerLiveTv({ get: add('GET'), post: add('POST'), delete: add('DELETE') }, { outsideViewingHours: async () => false });
});

after(() => {
  dispatcharr.close();
  addon.close();
  for (const name of ['OUTBOUND_ALLOWED_PRIVATE_HOSTS', 'JELLYFIN_DISPATCHARR_URL', 'JELLYFIN_DISPATCHARR_STREAM_URL', 'JELLYFIN_DISPATCHARR_API_KEY', 'JELLYFIN_DISPATCHARR_USERS']) setEnv(name, undefined);
});

function call(route: string, userUUID: string, query: Record<string, string> = {}, profileId: string | null = null): Promise<{ status: number; body: any }> {
  const req = { query, params: { userUUID }, headers: {}, get: () => undefined, jellyfin: { userUUID, profileId } };
  return new Promise((done) => {
    const res = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { done({ status: this.statusCode, body }); },
    };
    const handlers = table[route];
    const run = (i: number) => handlers[i](req, res, () => (i + 1 < handlers.length ? run(i + 1) : done({ status: 404, body: null })));
    run(0);
  });
}

test('two configurations naming the same channel each keep their own source\'s channel and guide', async () => {
  // In turn, so each one's listing would overwrite what the other left if they shared a cache.
  for (const round of [1, 2]) {
    const direct = (await call('GET /LiveTv/Channels', DIRECT)).body.Items[0];
    const viaAddon = (await call('GET /LiveTv/Channels', ADDON)).body.Items[0];
    // The same Jellyfin id, as the Dispatcharr addon's channel had, so favourites carry over.
    assert.equal(direct.Id, viaAddon.Id, `round ${round}`);
    assert.equal(direct.Name, 'News Direct');
    assert.equal(direct.CurrentProgram?.Name, 'Direct show');
    assert.equal(viaAddon.Name, 'News via addon');
    assert.equal(viaAddon.CurrentProgram?.Name, 'Addon show');
  }
  // A channel looked up by id comes from the asker's own source too, logo included.
  const id = (await call('GET /LiveTv/Channels', DIRECT)).body.Items[0].Id;
  const one = (await call('GET /Items', ADDON, { Ids: id })).body.Items[0];
  assert.equal(one.Name, 'News via addon');
  const theirs = (await call('GET /Items', DIRECT, { Ids: id })).body.Items[0];
  assert.equal(theirs.Name, 'News Direct');
});

test('a configuration listed by its UUID is told it may use Live TV, from its stored configuration', () => {
  // Stored configurations carry no UUID; the owner's is passed in.
  const stored = {};
  assert.equal(live.liveTvOffered(stored, DIRECT), true);
  assert.equal(live.liveTvOffered(stored, ADDON), false);
  assert.equal(live.liveTvOffered(stored), false);
});

test('a profile id another configuration also uses is not enough to get Dispatcharr', async () => {
  // Configuration B gives one of its profiles an id listed for A's profile: it still gets the addon.
  setEnv('JELLYFIN_DISPATCHARR_USERS', `${DIRECT}/kids`);
  const kids = [{ id: 'kids', name: 'Kids' }];
  configs.set(DIRECT, { jellyfinStreamUrl: configs.get(DIRECT).jellyfinStreamUrl, jellyfinUsers: kids });
  configs.set(ADDON, { jellyfinStreamUrl: configs.get(ADDON).jellyfinStreamUrl, jellyfinUsers: kids });
  try {
    const service = async (userUUID: string, profileId: string | null) => (await call('GET /LiveTv/Info', userUUID, {}, profileId)).body.Services[0].Name;
    assert.equal(await service(ADDON, 'kids'), 'Stream addon');
    assert.equal(await service(DIRECT, 'kids'), 'Dispatcharr');
    // Listed as one profile of the configuration: its main user isn't.
    assert.equal(await service(DIRECT, null), 'Stream addon');
    assert.equal(live.liveTvOffered({ jellyfinUsers: [{ id: 'kids', name: 'Kids' }] }, ADDON), false);
    assert.equal(live.liveTvOffered({ jellyfinUsers: [{ id: 'kids', name: 'Kids' }] }, DIRECT), true);
  } finally {
    setEnv('JELLYFIN_DISPATCHARR_USERS', DIRECT);
  }
});
