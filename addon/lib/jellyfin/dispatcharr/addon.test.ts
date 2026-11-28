// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// Runs the Live TV code (`livetv/*`) over Dispatcharr as a live addon (`addon.ts`), against a fake
// Dispatcharr with invented channels and guide: the lineup, its groups, a day of the guide with
// Dispatcharr's own marks, and the items clients are sent. How to run it: docs/live-tv-dispatcharr.md.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import type { AddonDeps } from '../addonReader';
import { DispatcharrLive } from './index';
import type { DispatcharrSettings } from './settings';
import { DIRECT_BASE, catalogQuery, withDispatcharr } from './addon';
import { liveTvFor, liveTvReady, liveTvRecall, type GateDeps } from '../livetv/gate';
import { listChannels, listGroup } from '../livetv/lineup';
import { programmesFor } from '../livetv/guide';
import { channelItem, liveTvView, programItem, type ItemDeps } from '../livetv/items';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const today = iso(now).slice(0, 10);

let fake: http.Server;
let url = '';
let realAsked: string[] = [];

const channels = [
  { id: 7, uuid: 'uuid-7', name: 'News One', channel_number: 2, channel_group_id: 1, logo_id: 9, epg_data_id: 3, hidden_from_output: false },
  { id: 8, uuid: 'uuid-8', name: 'Match TV', channel_number: 1, channel_group_id: 2, hidden_from_output: false },
  { id: 10, uuid: 'uuid-10', name: 'Film Loop', channel_number: 4, channel_group_id: 3, hidden_from_output: false },
];

const routes: Record<string, () => [number, any]> = {
  'GET /api/channels/channels/': () => [200, channels],
  'GET /api/channels/groups/': () => [200, [{ id: 1, name: 'News' }, { id: 2, name: 'Sport' }, { id: 3, name: '24/7 Films' }]],
  'GET /api/m3u/accounts/': () => [200, [{ id: 1, name: 'Provider A', is_active: true }]],
  'GET /api/epg/epgdata/': () => [200, [{ id: 3, tvg_id: 'news.example', name: 'News' }]],
  'GET /api/epg/grid/': () => [200, { data: [
    { id: 1, tvg_id: 'news.example', title: 'Headlines', sub_title: 'Evening edition', description: "The day's news", start_time: iso(now - 600000), end_time: iso(now + 600000), season: null, episode: null, is_new: true, is_live: true, is_premiere: false, is_finale: false },
    { id: 2, tvg_id: 'news.example', title: 'Weather', sub_title: 'News', start_time: iso(now + 600000), end_time: iso(now + 1200000), season: 4, episode: 2, is_new: false, is_live: false, is_premiere: true, is_finale: true },
    { id: `dummy-standard-8-${today}`, tvg_id: 'uuid-8', title: 'Match TV', sub_title: '24/7 Channel', start_time: iso(now - 3600000), end_time: iso(now + 3 * 3600000), custom_properties: null, is_new: false, is_live: false, is_premiere: false, is_finale: false },
  ] }],
};

before(async () => {
  fake = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    const handler = routes[`${req.method} ${path}`];
    const signedIn = req.headers['x-api-key'] === 'KEY';
    const [status, body] = !handler ? [404, {}] : !signedIn ? [401, {}] : handler();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

after(() => {
  fake.close();
});

const settings = (): DispatcharrSettings => ({
  url, streamUrl: 'https://tv.example', apiKey: 'KEY', users: [], groups: [], name: 'Dispatcharr',
  autoSource: true, switchStreams: false, timeoutMs: 5000, cacheMs: 300000,
});

// A stream addon that is never Dispatcharr: what reaches it is noted.
const realAddon: AddonDeps = {
  manifest: async (base) => (realAsked.push(`manifest ${base}`), null),
  peek: () => undefined,
  recall: async () => undefined,
  fetchJson: async (base, path) => (realAsked.push(`${base}${path}`), null),
  now: () => Date.now(),
};

function setUp() {
  realAsked = [];
  const direct = new DispatcharrLive(settings());
  const addon = withDispatcharr(realAddon, () => direct);
  const gate: GateDeps = {
    enabled: () => true,
    capped: () => false,
    baseFor: (config: any) => (config?.direct ? DIRECT_BASE : config?.jellyfinStreamUrl ?? null),
    addon,
  };
  return { direct, addon, gate };
}

const itemDeps: ItemDeps = {
  encodeId: (d: any) => `id:${JSON.stringify(d)}`,
  encodeProgramId: (ref: any) => `prog:${ref.i}:${ref.at}`,
  rememberImages: () => undefined,
  imageTag: (image: string) => `tag:${image}`,
  placeholderMediaSource: (id: string, name: string) => ({ Id: id, Name: name }),
  collectionFolder: (id: string, serverId: string, name: string, collectionType: string | null) => ({ Id: id, ServerId: serverId, Name: name, CollectionType: collectionType }),
  emptyUserData: {},
};

test('a catalog path is read back into its parts', () => {
  assert.deepEqual(catalogQuery('/catalog/tv/dispatcharr.json'), { type: 'tv', id: 'dispatcharr', extra: {} });
  assert.deepEqual(catalogQuery('/catalog/tv/dispatcharr/genre=24%2F7%20Films&date=2026-11-25.json'), {
    type: 'tv', id: 'dispatcharr', extra: { genre: '24/7 Films', date: '2026-11-25' },
  });
  assert.equal(catalogQuery('/meta/tv/x.json'), null);
});

test('Live TV for a configuration on Dispatcharr has its catalog and groups, and asks no stream addon', async () => {
  const { gate } = setUp();
  await liveTvRecall(gate, { direct: true });
  const live = await liveTvReady(gate, { direct: true });
  assert.ok(live);
  assert.equal(live!.base, DIRECT_BASE);
  assert.equal(live!.catalogs.length, 1);
  const [catalog] = live!.catalogs;
  assert.equal(catalog.guide, true);
  assert.equal(catalog.ids, true);
  assert.deepEqual(catalog.groups, ['Sport', 'News', '24/7 Films']);
  // Nothing went to a stream addon.
  assert.deepEqual(realAsked, []);
  // Held from then on, without asking again.
  assert.ok(liveTvFor(gate, { direct: true }));
});

test('channels list in number order, each with its group, and a group with a slash lists its own', async () => {
  const { gate } = setUp();
  const live = (await liveTvReady(gate, { direct: true }))!;
  const all = await listChannels(gate.addon, live.base, live.catalogs, { startIndex: 0, limit: 50 });
  assert.deepEqual(all.channels.map((c) => c.meta.name), ['Match TV', 'News One', 'Film Loop']);
  assert.deepEqual(all.channels.map((c) => c.number), ['1', '2', '4']);
  const item = channelItem(itemDeps, 'server', all.channels[1], { favourite: false });
  assert.deepEqual(item.Genres, ['News']);
  assert.equal(item.ChannelNumber, '2');
  assert.equal(item.ImageTags.Primary, 'tag:https://tv.example/api/channels/logos/9/cache/');
  const films = await listGroup(gate.addon, live.base, live.catalogs, '24/7 Films', { startIndex: 0, limit: 50 });
  assert.deepEqual(films.channels.map((c) => c.meta.name), ['Film Loop']);
});

test("a day of the guide carries Dispatcharr's own marks through to the items clients get", async () => {
  const { gate } = setUp();
  const live = (await liveTvReady(gate, { direct: true }))!;
  const all = await listChannels(gate.addon, live.base, live.catalogs, { startIndex: 0, limit: 50 });
  const refs = all.channels.map((c) => ({ type: c.meta.type, id: c.meta.id }));
  const guide = await programmesFor(gate.addon, live.base, live.catalogs, refs, now - 3600000, now + 3600000);
  const news = guide.get('tv|dispatcharr:7') ?? [];
  assert.deepEqual(news.map((p) => p.title), ['Headlines', 'Weather']);
  const newsChannel = all.channels.find((c) => c.meta.id === 'dispatcharr:7')!;
  const headlines = programItem(itemDeps, 'server', newsChannel, news[0]);
  assert.equal(headlines.EpisodeTitle, 'Evening edition');
  assert.equal(headlines.IsLive, true);
  assert.equal(headlines.IsNew, true);
  const weather = programItem(itemDeps, 'server', newsChannel, news[1]);
  // A subtitle that only names the channel's group isn't shown.
  assert.equal(weather.EpisodeTitle, undefined);
  assert.equal(weather.IsPremiere, true);
  assert.deepEqual(weather.aiostreams, { finale: true });
  assert.equal(weather.ParentIndexNumber, 4);
  // Dispatcharr's own placeholder for a channel without a guide is marked as one.
  const match = guide.get('tv|dispatcharr:8') ?? [];
  assert.equal(match.length, 1);
  const matchItem = programItem(itemDeps, 'server', all.channels[0], match[0]);
  assert.deepEqual(matchItem.aiostreams, { placeholder: true });
  assert.equal(matchItem.EpisodeTitle, undefined);
});

test('the Live TV view says it has groups and a guide', () => {
  const view = liveTvView(itemDeps, 'server', { guide: true, groups: true });
  assert.deepEqual(view.aiostreams, { guide: true, groups: true });
  assert.deepEqual(liveTvView(itemDeps, 'server').aiostreams, { guide: false, groups: false });
});

test('a configuration on a stream addon still reads the stream addon', async () => {
  const { gate } = setUp();
  await liveTvReady(gate, { jellyfinStreamUrl: 'https://addon.example/abc' });
  assert.deepEqual(realAsked, ['manifest https://addon.example/abc']);
});

test("the Live TV view's source mark tells Dispatcharr from the stream addon, without the addon's address", async () => {
  const { sourceMark } = await import('../livetv/handlers');
  const catalog = (id: string) => ({ type: 'tv', id, name: id, guide: true, skip: true, search: true, ids: true, groups: [] });
  const direct = sourceMark({ base: DIRECT_BASE, catalogs: [catalog('dispatcharr')] });
  const addonBase = 'https://addon.example/secret-config/manifest.json';
  const viaAddon = sourceMark({ base: addonBase, catalogs: [catalog('abc.xtream')] });
  assert.match(direct, /^[0-9a-f]{12}$/);
  assert.notEqual(direct, viaAddon);
  assert.equal(viaAddon, sourceMark({ base: addonBase, catalogs: [catalog('abc.xtream')] }));
  assert.ok(!viaAddon.includes('secret'));
});
