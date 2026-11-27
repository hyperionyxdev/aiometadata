// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// Runs recording with Dispatcharr's DVR, and Jellyfin's recording routes over it, against a fake
// Dispatcharr that answers as Dispatcharr's own code does, with invented channels and programmes.
// How to run it: docs/live-tv-recordings.md, "Tests".
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import express from 'express';
import { AddressInfo } from 'net';
import { DispatcharrLive } from '../dispatcharr';
import type { DispatcharrSettings } from '../dispatcharr/settings';
import { DispatcharrRecorder, interruptedWords, seriesIdOf, stateOf } from './dispatcharr';
import { recordingNumberOf, registerRecordings, seriesTimerIdOf, slotIdOf, slotNumberOf, timerIdOf } from './jellyfin';
import { LocalRecorder } from './local';
import { RecordingOwners, recordingOwners, useRecordingOwners } from './owners';
import { recordingSettings } from './settings';
import type { ChannelRef, ProgrammeInfo, Recorder } from './types';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
/** A time as Dispatcharr's own code writes one it made (Python's isoformat, in UTC). */
const pythonIso = (ms: number) => iso(ms).replace('.000Z', '+00:00');

let fake: http.Server;
let base = '';
let rows: any[] = [];
let rules: any[] = [];
let slotRules: any[] = [];
let nextId = 1;
let nextRuleId = 1;
let seen: Array<{ method: string; path: string; query: string; body?: any; range?: string }> = [];
let dvrAccess = true;
let ownersDir = '';
const PAD = { pre: 2, post: 10 };
// Dispatcharr's time zone here; the fake sets a repeating schedule's recordings in UTC only.
const DISPATCHARR_ZONE = 'UTC';
const FILE = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

const channels = [
  { id: 7, uuid: 'uuid-7', name: 'News One', channel_number: 2, channel_group_id: 1, epg_data_id: 3, hidden_from_output: false },
  { id: 8, uuid: 'uuid-8', name: 'Match TV', channel_number: 1, channel_group_id: 1, hidden_from_output: false },
];

/** A recording row as Dispatcharr's serializer saves it: a programme's times padded by the DVR's padding. */
function created(body: any): [number, any] {
  let start = Date.parse(body.start_time);
  let end = Date.parse(body.end_time);
  if (end < now) return [400, { end_time: ['End time must be in the future.'] }];
  const program = body.custom_properties?.program;
  if (program && typeof program === 'object') {
    start -= PAD.pre * MIN;
    end += PAD.post * MIN;
  }
  const row = { id: nextId++, channel: Number(body.channel), start_time: iso(Math.max(start, now)), end_time: iso(end), task_id: null, custom_properties: body.custom_properties ?? {} };
  rows.push(row);
  return [201, row];
}

/**
 * A recurring rule as Dispatcharr's serializer takes it, then every recording it makes up to its last
 * day still to start, as Dispatcharr's own sync sets them when the rule is made.
 */
function createdRule(body: any): [number, any] {
  const days = Array.isArray(body.days_of_week) ? [...new Set<number>(body.days_of_week.map(Number))].sort((a, b) => a - b) : [];
  if (!days.length) return [400, { days_of_week: ['Select at least one day of the week'] }];
  if (!body.start_date) return [400, { non_field_errors: ['Start date is required'] }];
  if (!body.end_date) return [400, { non_field_errors: ['End date is required'] }];
  if (body.end_date < body.start_date) return [400, { non_field_errors: ['End date must be on or after start date'] }];
  if (Date.parse(`${body.end_date}T${body.end_time}Z`) <= Date.parse(`${body.start_date}T${body.start_time}Z`)) return [400, { non_field_errors: ['End datetime must be after start datetime'] }];
  const rule = {
    id: nextRuleId++, channel: Number(body.channel), days_of_week: days, start_time: body.start_time, end_time: body.end_time, enabled: body.enabled !== false,
    name: body.name ?? '', start_date: body.start_date, end_date: body.end_date, created_at: iso(now), updated_at: iso(now),
  };
  slotRules.push(rule);
  const channelName = channels.find((c) => c.id === rule.channel)?.name ?? '';
  for (let day = Date.parse(`${rule.start_date}T00:00:00Z`); day <= Date.parse(`${rule.end_date}T00:00:00Z`); day += DAY) {
    if (!days.includes((new Date(day).getUTCDay() + 6) % 7)) continue;
    const date = iso(day).slice(0, 10);
    const start = Date.parse(`${date}T${rule.start_time}Z`);
    let end = Date.parse(`${date}T${rule.end_time}Z`);
    if (end <= start) end += DAY;
    if (start <= now) continue;
    const description = rule.name || `Recurring recording for ${channelName}`;
    rows.push({
      id: nextId++, channel: rule.channel, start_time: pythonIso(start), end_time: pythonIso(end), task_id: null,
      custom_properties: {
        rule: { type: 'recurring', id: rule.id, days_of_week: days, name: rule.name },
        status: 'scheduled',
        description,
        program: { title: rule.name || channelName, description, start_time: pythonIso(start), end_time: pythonIso(end) },
      },
    });
  }
  return [201, rule];
}

function json(res: http.ServerResponse, status: number, body: any): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

before(async () => {
  fake = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ method: req.method ?? '', path: url.pathname, query: url.search, body, range: req.headers.range });
      if (req.headers['x-api-key'] !== 'KEY') return json(res, 401, {});
      const route = `${req.method} ${url.pathname}`;
      const manage = req.method !== 'GET';
      if (/recordings|series-rules|recurring-rules/.test(url.pathname) && manage && !dvrAccess) return json(res, 403, { detail: 'no' });
      if (route === 'GET /api/channels/channels/') return json(res, 200, channels);
      if (route === 'GET /api/channels/groups/') return json(res, 200, [{ id: 1, name: 'News' }]);
      if (route === 'GET /api/m3u/accounts/') return json(res, 200, []);
      if (route === 'GET /api/epg/epgdata/') return json(res, 200, [{ id: 3, tvg_id: 'news.example', epg_source: 5 }]);
      if (route === 'GET /api/core/settings/') {
        return json(res, 200, [
          { id: 1, key: 'dvr_settings', value: { pre_offset_minutes: PAD.pre, post_offset_minutes: PAD.post } },
          { id: 2, key: 'system_settings', value: { time_zone: DISPATCHARR_ZONE, max_system_events: 100 } },
        ]);
      }
      if (route === 'GET /api/channels/recurring-rules/') return json(res, 200, slotRules);
      if (route === 'POST /api/channels/recurring-rules/') return json(res, ...createdRule(body));
      const recurring = /^\/api\/channels\/recurring-rules\/(\d+)\/$/.exec(url.pathname);
      if (recurring && req.method === 'DELETE') {
        const id = Number(recurring[1]);
        if (!slotRules.some((r) => r.id === id)) return json(res, 404, { detail: 'Not found.' });
        // Its recordings still to start go with it.
        slotRules = slotRules.filter((r) => r.id !== id);
        rows = rows.filter((r) => !(r.custom_properties?.rule?.id === id && Date.parse(r.start_time) >= now));
        res.writeHead(204).end();
        return;
      }
      if (route === 'GET /api/channels/recordings/') return json(res, 200, rows);
      if (route === 'POST /api/channels/recordings/') return json(res, ...created(body));
      if (route === 'GET /api/channels/series-rules/') return json(res, 200, { rules });
      if (route === 'POST /api/channels/series-rules/') {
        const rule = { tvg_id: body.tvg_id ?? '', mode: body.mode ?? 'all', title: body.title, title_mode: 'exact', description: '', description_mode: 'contains',
          ...(body.channel_id ? { channel_id: body.channel_id } : {}), ...(body.epg_source_id ? { epg_source_id: body.epg_source_id } : {}) };
        rules = rules.filter((r) => !(r.tvg_id === rule.tvg_id && r.title === rule.title && (r.epg_source_id ?? null) === (rule.epg_source_id ?? null)));
        rules.push(rule);
        return json(res, 200, { success: true, rules });
      }
      if (route === 'POST /api/channels/series-rules/evaluate/') {
        // Two airings of the series' title on its guide: set as Dispatcharr's evaluation sets them.
        for (const at of [now + 60 * MIN, now + 120 * MIN]) {
          created({ channel: 7, start_time: iso(at), end_time: iso(at + 30 * MIN), custom_properties: { program: { tvg_id: 'news.example', title: 'Weather', start_time: iso(at), end_time: iso(at + 30 * MIN) } } });
        }
        return json(res, 200, { success: true, scheduled: 2, details: [] });
      }
      if (route === 'DELETE /api/channels/series-rules/') {
        const tvg = url.searchParams.get('tvg_id') ?? '';
        const title = url.searchParams.get('title') ?? '';
        const before = rules.length;
        rules = rules.filter((r) => !(r.tvg_id === tvg && r.title === title));
        rows = rows.filter((r) => !(r.custom_properties?.program?.title === title && Date.parse(r.start_time) > now));
        return json(res, 200, { success: true, rules, removed: before - rules.length });
      }
      const one = /^\/api\/channels\/recordings\/(\d+)\/(stop\/|file\/|hls\/([^/]+))?$/.exec(url.pathname);
      const row = one ? rows.find((r) => r.id === Number(one[1])) : undefined;
      if (one && !row) return json(res, 404, { detail: 'Not found.' });
      if (one && req.method === 'DELETE' && !one[2]) {
        rows = rows.filter((r) => r !== row);
        res.writeHead(204).end();
        return;
      }
      if (one && one[2] === 'stop/' && req.method === 'POST') {
        if (['completed', 'interrupted', 'stopped'].includes(row.custom_properties.status)) return json(res, 409, { success: false, error: `Recording is already ${row.custom_properties.status}` });
        row.custom_properties.status = 'stopped';
        return json(res, 200, { success: true, status: 'stopped' });
      }
      if (one && one[2] === 'file/') {
        if (row.custom_properties.status === 'recording') {
          res.writeHead(302, { location: `/api/channels/recordings/${row.id}/hls/index.m3u8` }).end();
          return;
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Number(range[2]) : FILE.length - 1;
          res.writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': `bytes ${start}-${end}/${FILE.length}`, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1) });
          res.end(FILE.subarray(start, end + 1));
          return;
        }
        res.writeHead(200, { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', 'content-length': String(FILE.length) });
        res.end(FILE);
        return;
      }
      if (one && one[3] === 'index.m3u8') {
        res.writeHead(200, { 'content-type': 'application/x-mpegURL' });
        res.end(`#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\n${base}/api/channels/recordings/${row.id}/hls/seg_00000.ts\n#EXTINF:4.0,\n${base}/api/channels/recordings/${row.id}/hls/seg_00001.ts?token=abc\n`);
        return;
      }
      if (one && one[3]) {
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        res.end(Buffer.from(`segment ${one[3]}`));
        return;
      }
      json(res, 404, '<html>not here</html>');
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

after(() => {
  fake.close();
  useRecordingOwners(null);
  if (ownersDir) fs.rmSync(ownersDir, { recursive: true, force: true });
});

beforeEach(() => {
  rows = [];
  rules = [];
  slotRules = [];
  nextId = 1;
  nextRuleId = 1;
  seen = [];
  dvrAccess = true;
  // Who set each recording, kept in a folder of the test's own.
  ownersDir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcharr-owners-'));
  useRecordingOwners(new RecordingOwners(path.join(ownersDir, `owners-${Date.now()}-${Math.random()}.json`)));
});

function settings(): DispatcharrSettings {
  return { url: base, streamUrl: base, apiKey: 'KEY', users: [], groups: [], name: 'Dispatcharr', autoSource: true, switchStreams: false, timeoutMs: 5000, cacheMs: 300000 };
}

const news: ChannelRef = { type: 'tv', id: 'dispatcharr:7', name: 'News One' };
const weather: ProgrammeInfo = { title: 'Weather', start: now + 30 * MIN, end: now + 60 * MIN, episodeTitle: 'Storm watch', overview: 'The forecast', season: 4, episode: 2, isNew: true };
const recorder = () => new DispatcharrRecorder(new DispatcharrLive(settings()));

// ---------- Settings ----------

test('recording is with Dispatcharr where Live TV is, off elsewhere, and as asked', () => {
  const saved = { ...process.env };
  try {
    delete process.env.JELLYFIN_RECORDINGS;
    assert.equal(recordingSettings(true).mode, 'dispatcharr');
    assert.equal(recordingSettings(false).mode, 'off');
    process.env.JELLYFIN_RECORDINGS = 'local';
    assert.equal(recordingSettings(false).mode, 'local');
    process.env.JELLYFIN_RECORDINGS = 'dispatcharr';
    assert.equal(recordingSettings(false).mode, 'off', "Dispatcharr's DVR needs Live TV from Dispatcharr");
    process.env.JELLYFIN_RECORDINGS = 'sideways';
    assert.equal(recordingSettings(true).mode, 'dispatcharr');
    process.env.JELLYFIN_RECORDINGS_PRE_MINUTES = '999';
    assert.equal(recordingSettings(true).preMinutes, 120);
  } finally {
    process.env = saved;
  }
});

// ---------- Dispatcharr's DVR ----------

test('a programme is set as Dispatcharr\'s own Record button sets it, and Dispatcharr pads it', async () => {
  const entry = await recorder().record({ channel: news, programme: weather });
  const post = seen.find((s) => s.method === 'POST' && s.path === '/api/channels/recordings/');
  assert.ok(post);
  assert.equal(post.body.channel, 7);
  assert.equal(post.body.start_time, iso(weather.start), 'the programme\'s own times go, unpadded');
  assert.equal(post.body.end_time, iso(weather.end));
  assert.deepEqual(post.body.custom_properties.program, {
    tvg_id: 'news.example', title: 'Weather', sub_title: 'Storm watch', description: 'The forecast',
    start_time: iso(weather.start), end_time: iso(weather.end), season: 4, episode: 2, is_new: true, epg_source_id: 5,
  });
  assert.equal(entry.state, 'scheduled');
  assert.equal(entry.start, weather.start - PAD.pre * MIN);
  assert.equal(entry.end, weather.end + PAD.post * MIN);
  assert.equal(entry.programme?.start, weather.start, 'the programme keeps its own times');
  assert.equal(entry.channel.name, 'News One');
  assert.equal(entry.playable, false);
});

test('setting a programme already set returns the one there', async () => {
  const r = recorder();
  const first = await r.record({ channel: news, programme: weather });
  const again = await r.record({ channel: news, programme: weather });
  assert.equal(again.id, first.id);
  assert.equal(rows.length, 1);
});

test('setting a programme whose recording failed records it afresh', async () => {
  const r = recorder();
  const first = await r.record({ channel: news, programme: weather });
  rows[0].custom_properties.status = 'interrupted';
  rows[0].custom_properties.interrupted_reason = 'no_stream_data: 503';
  const again = await r.record({ channel: news, programme: weather });
  assert.notEqual(again.id, first.id, 'the failed one was handed back');
  assert.equal(again.state, 'scheduled');
  assert.equal(rows.length, 2);
});

test('a window by hand goes without a programme and without padding', async () => {
  const entry = await recorder().record({ channel: news, start: now + 10 * MIN, end: now + 20 * MIN });
  const post = seen.find((s) => s.method === 'POST' && s.path === '/api/channels/recordings/');
  assert.equal(post?.body.custom_properties, undefined);
  assert.equal(entry.start, now + 10 * MIN);
  assert.equal(entry.end, now + 20 * MIN);
});

test('a channel not Dispatcharr\'s, a window over, and a login without DVR access are turned down in plain words', async () => {
  await assert.rejects(recorder().record({ channel: { type: 'tv', id: 'addon:1', name: 'Other' }, programme: weather }), /isn't one of Dispatcharr's/);
  await assert.rejects(recorder().record({ channel: news, start: now - 20 * MIN, end: now - 10 * MIN }), /End time must be in the future/);
  dvrAccess = false;
  await assert.rejects(recorder().record({ channel: news, programme: weather }), (error: any) => error.status === 403 && /DVR access/.test(error.message));
});

test('the state is read as Dispatcharr\'s DVR page reads it', () => {
  const row = (status?: string, start = now - MIN, end = now + MIN) => ({ start_time: iso(start), end_time: iso(end), custom_properties: status ? { status } : {} });
  assert.equal(stateOf(row(undefined, now + MIN, now + 2 * MIN), now), 'scheduled');
  assert.equal(stateOf(row(), now), 'recording');
  assert.equal(stateOf(row('recording'), now), 'recording');
  assert.equal(stateOf(row('completed'), now), 'completed');
  assert.equal(stateOf(row('stopped'), now), 'stopped');
  assert.equal(stateOf(row('failed'), now), 'interrupted');
  assert.equal(stateOf(row(undefined, now - 2 * MIN, now - MIN), now), 'interrupted');
  assert.equal(interruptedWords('no_stream_data: 503'), "The channel couldn't be played (no stream, or no free connection)");
  assert.equal(interruptedWords('server_restarted_after_end'), 'Dispatcharr restarted while it was recording');
});

test('cancelling one still to start deletes it; one recording is stopped and kept; delete removes it', async () => {
  const r = recorder();
  const later = await r.record({ channel: news, programme: weather });
  await r.cancel(later.id);
  assert.ok(seen.some((s) => s.method === 'DELETE' && s.path === `/api/channels/recordings/${later.id}/`));
  assert.equal(rows.length, 0);

  rows.push({ id: 50, channel: 7, start_time: iso(now - 5 * MIN), end_time: iso(now + 25 * MIN), custom_properties: { status: 'recording', file_url: '/api/channels/recordings/50/hls/index.m3u8' } });
  await r.cancel(50);
  assert.ok(seen.some((s) => s.method === 'POST' && s.path === '/api/channels/recordings/50/stop/'));
  assert.equal(rows[0].custom_properties.status, 'stopped', 'what was recorded is kept');
  await r.remove(50);
  assert.equal(rows.length, 0);
  await assert.rejects(r.remove(50), (error: any) => error.status === 404);
});

test('a series is a series rule on the programme\'s guide, then evaluated, as Dispatcharr\'s Record Series does', async () => {
  const r = recorder();
  const rule = await r.addSeries({ channel: news, programme: weather, anyChannel: false, newOnly: true });
  const post = seen.find((s) => s.method === 'POST' && s.path === '/api/channels/series-rules/');
  assert.deepEqual(post?.body, { tvg_id: 'news.example', mode: 'new', title: 'Weather', epg_source_id: 5 });
  const evaluated = seen.find((s) => s.path === '/api/channels/series-rules/evaluate/');
  assert.deepEqual(evaluated?.body, { tvg_id: 'news.example' });
  assert.equal(rule.title, 'Weather');
  assert.equal(rule.newOnly, true);
  assert.equal(rule.anyChannel, false);
  assert.equal(rule.channel?.id, 'dispatcharr:7');
  assert.equal(rule.id, seriesIdOf({ tvg_id: 'news.example', title: 'Weather', epg_source_id: 5 }));

  const list = await r.list();
  assert.equal(list.length, 2);
  assert.ok(list.every((entry) => entry.seriesId === rule.id), 'recordings the rule set are known as its own');

  await r.removeSeries(rule.id);
  const removed = seen.find((s) => s.method === 'DELETE' && s.path === '/api/channels/series-rules/');
  assert.equal(new URLSearchParams(removed?.query).get('tvg_id'), 'news.example');
  assert.equal(new URLSearchParams(removed?.query).get('epg_source_id'), '5');
  assert.equal(rules.length, 0);
  assert.equal((await r.list()).length, 0, 'its recordings still to start go with it');
});

test('a series on any channel is the title alone', async () => {
  const rule = await recorder().addSeries({ channel: news, programme: weather, anyChannel: true, newOnly: false });
  const post = seen.find((s) => s.method === 'POST' && s.path === '/api/channels/series-rules/');
  assert.deepEqual(post?.body, { tvg_id: '', mode: 'all', title: 'Weather' });
  assert.deepEqual(seen.find((s) => s.path === '/api/channels/series-rules/evaluate/')?.body, {});
  assert.equal(rule.anyChannel, true);
});

test('a finished recording plays from Dispatcharr with the range asked for; one under way plays its playlist through here', async () => {
  rows.push({ id: 60, channel: 7, start_time: iso(now - 60 * MIN), end_time: iso(now - 30 * MIN), custom_properties: { status: 'completed', file_url: '/api/channels/recordings/60/file/', bytes_written: 1000 } });
  rows.push({ id: 61, channel: 7, start_time: iso(now - 5 * MIN), end_time: iso(now + 25 * MIN), custom_properties: { status: 'recording', file_url: '/api/channels/recordings/61/hls/index.m3u8' } });
  const r = recorder();
  const whole = await r.open(60, {});
  assert.equal(whole?.status, 200);
  assert.equal(whole?.headers['content-type'], 'video/x-matroska');
  const part = await r.open(60, { range: 'bytes=10-19' });
  assert.equal(part?.status, 206);
  assert.equal(part?.headers['content-range'], 'bytes 10-19/1000');
  const chunks: Buffer[] = [];
  for await (const chunk of part!.body!) chunks.push(chunk as Buffer);
  assert.deepEqual(Buffer.concat(chunks), FILE.subarray(10, 20));

  const growing = await r.open(61, {});
  assert.deepEqual(growing, { status: 302, headers: {}, redirect: 'hls/index.m3u8' });
  const playlist = await r.open(61, { path: 'hls/index.m3u8' });
  let text = '';
  for await (const chunk of playlist!.body!) text += chunk;
  assert.match(text, /^seg_00000\.ts$/m, "parts are named here, not by Dispatcharr's address");
  assert.match(text, /^seg_00001\.ts$/m);
  assert.doesNotMatch(text, /127\.0\.0\.1|token=/);
  assert.equal(await r.open(61, { path: 'hls/../../etc' }), null);
  assert.equal((await r.list()).find((e) => e.id === 60)?.size, 1000);
});

// ---------- Jellyfin's recording routes ----------

async function jellyfin(r: Recorder): Promise<{ url: string; close: () => void }> {
  const app = express();
  const router = express.Router({ mergeParams: true });
  router.use(express.json());
  router.use((req: any, _res, next) => {
    req.jellyfin = { userUUID: 'config-1', token: 'TOKEN', profileId: null };
    next();
  });
  registerRecordings(router, {
    recorderFor: async () => r,
    programmeOf: async (_req, id) => (id === 'prog-weather' ? { channel: news, programme: weather } : null),
    channelOf: async (_req, id) => (id === 'chan-7' ? news : null),
    channelItemId: (channel) => (channel.id === 'dispatcharr:7' ? 'chan-7' : 'chan-x'),
    programmeItemId: (_channel, start) => (start === weather.start ? 'prog-weather' : 'prog-other'),
    serverIdFor: () => 'server',
    itemList: (items, total, startIndex) => ({ Items: items, TotalRecordCount: total, StartIndex: startIndex }),
    emptyUserData: { Played: false },
  });
  router.get('/LiveTv/Programs', (_req, res) => res.json({ Items: [{ Type: 'Program', Name: 'Weather', ChannelId: 'chan-7', StartDate: iso(weather.start) }, { Type: 'Program', Name: 'Other', ChannelId: 'chan-7', StartDate: iso(now) }] }));
  router.use((_req, res) => res.status(404).json({ Message: 'passed on' }));
  app.use('/jellyfin/:userUUID', router);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/jellyfin/config-1`, close: () => server.close() };
}

async function call(url: string, init: { method?: string; body?: any } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, { method: init.method ?? 'GET', redirect: 'manual', ...(init.body ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : {}) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, headers: res.headers };
}

test('ids for timers and series are 32 hex digits and read back', () => {
  assert.match(timerIdOf(7), /^[0-9a-f]{32}$/);
  assert.equal(recordingNumberOf(timerIdOf(7)), 7);
  assert.equal(recordingNumberOf(seriesTimerIdOf(7)), null);
  assert.equal(recordingNumberOf('f00dfeed'), null);
});

test('a timer set from a programme lists, marks its programme, and is cancelled', async () => {
  const server = await jellyfin(recorder());
  try {
    const set = await call(`${server.url}/LiveTv/Timers`, { method: 'POST', body: { ProgramId: 'prog-weather' } });
    assert.equal(set.status, 200);
    assert.equal(set.body.Status, 'New');
    assert.equal(set.body.ProgramId, 'prog-weather');
    assert.equal(set.body.StartDate, iso(weather.start));
    assert.equal(set.body.PrePaddingSeconds, PAD.pre * 60);
    assert.equal(set.body.PostPaddingSeconds, PAD.post * 60);
    assert.equal(set.body.ServiceName, 'Dispatcharr');

    const timers = await call(`${server.url}/LiveTv/Timers`);
    assert.equal(timers.body.TotalRecordCount, 1);
    assert.equal(timers.body.Items[0].Id, set.body.Id);

    const programmes = await call(`${server.url}/LiveTv/Programs`);
    assert.equal(programmes.body.Items[0].TimerId, set.body.Id, 'the programme set to record says so');
    assert.equal(programmes.body.Items[1].TimerId, undefined);

    const defaults = await call(`${server.url}/LiveTv/Timers/Defaults?programId=prog-weather`);
    assert.equal(defaults.body.PrePaddingSeconds, PAD.pre * 60);
    assert.equal(defaults.body.Name, 'Weather');

    assert.equal((await call(`${server.url}/LiveTv/Timers/${set.body.Id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await call(`${server.url}/LiveTv/Timers`)).body.TotalRecordCount, 0);
  } finally {
    server.close();
  }
});

test('a series timer marks its programmes and goes', async () => {
  const server = await jellyfin(recorder());
  try {
    const set = await call(`${server.url}/LiveTv/SeriesTimers`, { method: 'POST', body: { ProgramId: 'prog-weather', RecordNewOnly: true } });
    assert.equal(set.status, 200);
    assert.equal(set.body.RecordNewOnly, true);
    const list = await call(`${server.url}/LiveTv/SeriesTimers`);
    assert.equal(list.body.Items[0].Id, set.body.Id);
    const programmes = await call(`${server.url}/LiveTv/Programs`);
    assert.equal(programmes.body.Items[0].SeriesTimerId, set.body.Id);
    const timers = await call(`${server.url}/LiveTv/Timers?seriesTimerId=${set.body.Id}`);
    assert.equal(timers.body.TotalRecordCount, 2);
    assert.equal((await call(`${server.url}/LiveTv/SeriesTimers/${set.body.Id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await call(`${server.url}/LiveTv/SeriesTimers`)).body.TotalRecordCount, 0);
  } finally {
    server.close();
  }
});

test('recordings list newest first, open as items, play through here and delete; other ids pass on', async () => {
  rows.push({ id: 60, channel: 7, start_time: iso(now - 60 * MIN), end_time: iso(now - 30 * MIN), custom_properties: { status: 'completed', file_url: '/x', program: { title: 'Headlines', start_time: iso(now - 58 * MIN), end_time: iso(now - 32 * MIN) } } });
  rows.push({ id: 61, channel: 7, start_time: iso(now - 5 * MIN), end_time: iso(now + 25 * MIN), custom_properties: { status: 'recording', file_url: '/y' } });
  rows.push({ id: 62, channel: 7, start_time: iso(now + 50 * MIN), end_time: iso(now + 80 * MIN), custom_properties: {} });
  const server = await jellyfin(recorder());
  try {
    const list = await call(`${server.url}/LiveTv/Recordings`);
    assert.equal(list.body.TotalRecordCount, 2, 'only those begun');
    assert.equal(list.body.Items[0].Id, timerIdOf(61));
    assert.equal(list.body.Items[0].Status, 'InProgress');
    assert.equal(list.body.Items[1].Name, 'Headlines');
    assert.equal(list.body.Items[1].Type, 'Recording');
    assert.equal(list.body.Items[1].MediaSources[0].Container, 'mkv');
    assert.equal((await call(`${server.url}/LiveTv/Recordings?isInProgress=true`)).body.TotalRecordCount, 1);

    const item = await call(`${server.url}/Items/${timerIdOf(60)}`);
    assert.equal(item.body.Name, 'Headlines');
    const info = await call(`${server.url}/Items/${timerIdOf(60)}/PlaybackInfo`, { method: 'POST', body: {} });
    assert.equal(info.body.MediaSources[0].Id, timerIdOf(60));

    const file = await fetch(`${server.url}/Videos/${timerIdOf(60)}/stream?static=true`, { headers: { range: 'bytes=0-9' } });
    assert.equal(file.status, 206);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), FILE.subarray(0, 10));

    const growing = await call(`${server.url}/Videos/${timerIdOf(61)}/stream?static=true`);
    assert.equal(growing.status, 302);
    assert.match(growing.headers.get('location') ?? '', new RegExp(`/jellyfin/config-1/LiveTv/Recordings/${timerIdOf(61)}/hls/index\\.m3u8\\?api_key=TOKEN$`));
    const playlist = await call(`${server.url}/LiveTv/Recordings/${timerIdOf(61)}/hls/index.m3u8`);
    assert.match(playlist.body, /^seg_00000\.ts\?api_key=TOKEN$/m, 'parts carry the token, so a player can read them');
    const segment = await call(`${server.url}/LiveTv/Recordings/${timerIdOf(61)}/hls/seg_00000.ts`);
    assert.equal(segment.body, 'segment seg_00000.ts');

    assert.equal((await call(`${server.url}/LiveTv/Recordings/${timerIdOf(60)}`, { method: 'DELETE' })).status, 204);
    assert.equal(rows.some((r) => r.id === 60), false);

    assert.equal((await call(`${server.url}/Items/00112233445566778899aabbccddeeff`)).body.Message, 'passed on');
    assert.equal((await call(`${server.url}/LiveTv/Recordings/Folders`)).body.Message, 'passed on');
  } finally {
    server.close();
  }
});

test('a refusal comes back with its own status and plain words', async () => {
  dvrAccess = false;
  const server = await jellyfin(recorder());
  try {
    const set = await call(`${server.url}/LiveTv/Timers`, { method: 'POST', body: { ProgramId: 'prog-weather' } });
    assert.equal(set.status, 403);
    assert.match(set.body.Message, /DVR access/);
    assert.equal((await call(`${server.url}/LiveTv/Timers`, { method: 'POST', body: { ProgramId: 'nope' } })).status, 404);
  } finally {
    server.close();
  }
});

// ---------- Ads marked by Dispatcharr's commercial detection ----------

test("the ads Dispatcharr marks in its Mark mode are a recording's commercial segments", async () => {
  const saved = { ...process.env };
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcharr-recordings-'));
  try {
    fs.mkdirSync(path.join(shared, 'Weather'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'Weather', 'Weather S04E02.edl'), '0.00\t30.50\t0\n610.00\t790.00\t0\n');
    const ended = { status: 'completed', file_path: '/data/recordings/Weather/Weather S04E02.mkv', file_url: '/api/channels/recordings/70/file/' };
    const window = { channel: 7, start_time: iso(now - 120 * MIN), end_time: iso(now - 60 * MIN) };
    rows.push({ id: 70, ...window, custom_properties: { ...ended, comskip: { status: 'completed', mode: 'mark', edl: 'Weather S04E02.edl', commercials: 2 } } });
    // Cut: the ads are gone from the file; the list it left, if any, no longer fits it.
    rows.push({ id: 71, ...window, custom_properties: { ...ended, comskip: { status: 'completed', edl: 'Weather S04E02.edl', segments_kept: 3, commercials: 2 } } });
    rows.push({ id: 72, ...window, custom_properties: { ...ended } });
    const r = recorder();
    delete process.env.JELLYFIN_RECORDINGS_DISPATCHARR_DIR;
    assert.deepEqual(await r.adBreaks(70), [], 'marks read with no folder shared');
    process.env.JELLYFIN_RECORDINGS_DISPATCHARR_DIR = shared;
    assert.deepEqual(await r.adBreaks(70), [{ start: 0, end: 30.5 }, { start: 610, end: 790 }]);
    assert.deepEqual(await r.adBreaks(71), [], 'marks read for a recording whose ads were cut out');
    assert.deepEqual(await r.adBreaks(72), [], 'marks read for a recording never checked for ads');

    const server = await jellyfin(r);
    try {
      const answer = await call(`${server.url}/MediaSegments/${timerIdOf(70)}`);
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body.Items.map((s: any) => [s.Type, s.StartTicks, s.EndTicks]), [
        ['Commercial', 0, 305_000_000],
        ['Commercial', 6_100_000_000, 7_900_000_000],
      ]);
      assert.equal(answer.body.Items[0].ItemId, timerIdOf(70));
      assert.match(answer.body.Items[0].Id, /^[0-9a-f]{32}$/);
      assert.deepEqual((await call(`${server.url}/MediaSegments/${timerIdOf(70)}?includeSegmentTypes=Intro`)).body.Items, []);
      assert.equal((await call(`${server.url}/MediaSegments/${timerIdOf(70)}?includeSegmentTypes=Intro,Commercial`)).body.Items.length, 2);
      assert.deepEqual((await call(`${server.url}/MediaSegments/${timerIdOf(72)}`)).body.Items, []);
      // Not a recording: the server's own segments answer.
      assert.equal((await call(`${server.url}/MediaSegments/0123456789abcdef0123456789abcdef`)).body.Message, 'passed on');
    } finally {
      server.close();
    }
  } finally {
    process.env = saved;
    fs.rmSync(shared, { recursive: true, force: true });
  }
});

// ---------- Windows set by hand with a name, and repeating recordings ----------

test("a window set by hand with a name goes as a programme of that name, drawn in by the padding, and records the window asked for", async () => {
  const server = await jellyfin(recorder());
  try {
    const start = now + 35 * MIN;
    const end = now + 95 * MIN;
    const set = await call(`${server.url}/LiveTv/Timers`, { method: 'POST', body: { ChannelId: 'chan-7', StartDate: iso(start), EndDate: iso(end), Name: 'Late Film' } });
    assert.equal(set.status, 200);
    const post = seen.find((s) => s.method === 'POST' && s.path === '/api/channels/recordings/');
    assert.equal(post?.body.start_time, iso(start + PAD.pre * MIN), 'Dispatcharr takes its padding off again');
    assert.equal(post?.body.end_time, iso(end - PAD.post * MIN));
    assert.deepEqual(post?.body.custom_properties, { program: { title: 'Late Film', description: '', start_time: iso(start), end_time: iso(end) } });
    assert.equal(Date.parse(rows[0].start_time), start, 'the window recorded is the one asked for');
    assert.equal(Date.parse(rows[0].end_time), end);
    assert.equal(set.body.Name, 'Late Film');
    assert.equal(set.body.StartDate, iso(start));
    assert.equal(set.body.EndDate, iso(end));
    assert.equal(set.body.PrePaddingSeconds, 0);
    assert.equal(set.body.PostPaddingSeconds, 0);
    assert.equal(set.body.aiostreams.mine, true);
    assert.equal((await call(`${server.url}/LiveTv/Timers`)).body.Items[0].Name, 'Late Film');

    // No longer than the padding: it goes as before, without its name.
    seen = [];
    const short = await call(`${server.url}/LiveTv/Timers`, { method: 'POST', body: { ChannelId: 'chan-7', StartDate: iso(now + 200 * MIN), EndDate: iso(now + 210 * MIN), Name: 'Quick' } });
    assert.equal(short.status, 200);
    const sent = seen.find((s) => s.method === 'POST' && s.path === '/api/channels/recordings/');
    assert.deepEqual(sent?.body, { channel: 7, start_time: iso(now + 200 * MIN), end_time: iso(now + 210 * MIN) });
    assert.notEqual(short.body.Name, 'Quick');
    assert.equal(short.body.EndDate, iso(now + 210 * MIN));
  } finally {
    server.close();
  }
});

test("a guide programme isn't taken for a named window that starts at the same time", async () => {
  const r = recorder();
  const window = await r.record({ channel: news, start: weather.start, end: weather.start + 20 * MIN, name: 'Late Film' });
  const programme = await r.record({ channel: news, programme: weather });
  assert.notEqual(programme.id, window.id);
  assert.equal(programme.programme?.title, 'Weather');
});

test("a repeating schedule is set in Dispatcharr's time zone, lists with its next recording, sets its recordings and goes", async () => {
  // Monday 22:30 in Los Angeles is Tuesday 06:30 in Dispatcharr's zone (UTC): its days move on by one.
  const first = Date.parse('2030-01-08T06:30:00Z');
  const ask = { ChannelId: 'chan-7', Name: 'Late Show', StartDate: iso(first), EndDate: iso(first + 60 * MIN), Days: ['Monday', 'Friday'], TimeZone: 'America/Los_Angeles', RepeatUntil: '2030-02-01' };
  const server = await jellyfin(recorder());
  // The same Dispatcharr, read after the first one has ended.
  const later = await jellyfin(new DispatcharrRecorder(new DispatcharrLive(settings()), () => Date.parse('2030-01-08T08:00:00Z') + (Date.now() - now)));
  try {
    const set = await call(`${server.url}/LiveTv/SeriesTimers`, { method: 'POST', body: ask });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const post = seen.find((s) => s.method === 'POST' && s.path === '/api/channels/recurring-rules/');
    // Friday 22:30 there is Saturday here; the last day there, the 1st of February, ends on the 2nd here.
    assert.deepEqual(post?.body, {
      channel: 7, name: 'Late Show', days_of_week: [1, 5], start_time: '06:30:00', end_time: '07:30:00', start_date: '2030-01-08', end_date: '2030-02-02', enabled: true,
    });
    const id = set.body.Id;
    assert.match(id, /^d53[0-9a-f]{29}$/);
    assert.equal(slotNumberOf(id), 1);
    assert.equal(slotIdOf(1), id);
    assert.equal(set.body.Type, 'SeriesTimer');
    assert.equal(set.body.Name, 'Late Show');
    assert.equal(set.body.ChannelId, 'chan-7');
    assert.equal(set.body.ChannelName, 'News One');
    assert.deepEqual(set.body.Days, ['Tuesday', 'Saturday']);
    assert.equal(set.body.DayPattern, undefined);
    assert.equal(set.body.RecordAnyTime, false);
    assert.equal(set.body.StartDate, iso(first));
    assert.equal(set.body.EndDate, iso(first + 60 * MIN));
    assert.equal(set.body.PrePaddingSeconds, 0);
    assert.equal(set.body.aiostreams.mine, true);
    assert.equal(set.body.aiostreams.manage, true);
    assert.deepEqual(set.body.aiostreams.repeats, {
      days: [1, 5], start: '06:30', end: '07:30', from: '2030-01-08', until: '2030-02-02', timeZone: 'UTC', next: iso(first), nextEnd: iso(first + 60 * MIN),
    });
    // Every Tuesday and Saturday from the 8th of January to the 2nd of February.
    assert.equal(rows.length, 8);

    // Off, or on a channel this server doesn't show: not listed.
    slotRules.push({ ...slotRules[0], id: 50, enabled: false }, { ...slotRules[0], id: 51, channel: 99 });
    const listed = await call(`${later.url}/LiveTv/SeriesTimers`);
    assert.deepEqual(listed.body.Items.map((item: any) => item.Id), [id]);
    const slot = listed.body.Items[0];
    assert.equal(slot.StartDate, '2030-01-12T06:30:00.000Z', 'the next one that has not ended');
    assert.equal(slot.aiostreams.repeats.next, '2030-01-12T06:30:00.000Z');
    assert.equal(slot.aiostreams.repeats.nextEnd, '2030-01-12T07:30:00.000Z');
    assert.equal((await call(`${later.url}/LiveTv/SeriesTimers/${id}`)).body.aiostreams.repeats.next, '2030-01-12T06:30:00.000Z');

    // Its recordings are the schedule's, and so its owner's.
    const timers = await call(`${server.url}/LiveTv/Timers?seriesTimerId=${id}`);
    assert.equal(timers.body.TotalRecordCount, 8);
    assert.ok(timers.body.Items.every((item: any) => item.SeriesTimerId === id && item.Name === 'Late Show' && item.aiostreams.mine === true));
    assert.equal(timers.body.Items[0].StartDate, iso(first));
    assert.equal(timers.body.Items[0].PrePaddingSeconds, 0);

    assert.equal((await call(`${server.url}/LiveTv/SeriesTimers/${id}`, { method: 'DELETE' })).status, 204);
    assert.ok(seen.some((s) => s.method === 'DELETE' && s.path === '/api/channels/recurring-rules/1/'));
    assert.equal(rows.length, 0, 'its recordings still to start go with it');
    assert.deepEqual(recordingOwners().owners('slot', 'dispatcharr', 1), []);
    assert.equal((await call(`${server.url}/LiveTv/SeriesTimers`)).body.TotalRecordCount, 0);
    assert.equal((await call(`${server.url}/LiveTv/SeriesTimers/${id}`)).status, 404);
  } finally {
    server.close();
    later.close();
  }
});

test('a repeating schedule with no last day repeats 90 days; one that cannot be one is turned down in plain words', async () => {
  const server = await jellyfin(recorder());
  try {
    const first = Date.parse('2030-01-07T09:00:00Z');
    const ask = { ChannelId: 'chan-7', StartDate: iso(first), EndDate: iso(first + 30 * MIN), Days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], TimeZone: 'UTC' };
    const set = await call(`${server.url}/LiveTv/SeriesTimers`, { method: 'POST', body: ask });
    assert.equal(set.status, 200);
    assert.equal(set.body.Name, 'News One', "with no name, the channel's");
    assert.equal(set.body.DayPattern, 'Weekdays');
    assert.equal(set.body.aiostreams.repeats.until, '2030-04-07');
    const refused = async (body: any) => (await call(`${server.url}/LiveTv/SeriesTimers`, { method: 'POST', body: { ...ask, ...body } }));
    assert.match((await refused({ Days: [] })).body.Message, /at least one day/);
    assert.match((await refused({ Days: ['Funday'] })).body.Message, /isn't a day of the week/);
    assert.match((await refused({ EndDate: iso(first + 25 * 60 * MIN) })).body.Message, /24 hours/);
    assert.match((await refused({ EndDate: iso(first) })).body.Message, /end after it starts/);
    assert.match((await refused({ TimeZone: 'Nowhere/Special' })).body.Message, /isn't a time zone/);
    assert.match((await refused({ RepeatUntil: '2030-01-01' })).body.Message, /before the first/);
    assert.match((await refused({ StartDate: iso(now - 3 * DAY), EndDate: iso(now - 3 * DAY + MIN), RepeatUntil: iso(now - DAY).slice(0, 10) })).body.Message, /already over/);
    assert.equal((await refused({ ChannelId: 'nope' })).status, 404);
    assert.equal(slotRules.length, 1);
  } finally {
    server.close();
  }
});

test('the record form without a programme gives the padding, and says the recorder repeats', async () => {
  const server = await jellyfin(recorder());
  try {
    const defaults = await call(`${server.url}/LiveTv/Timers/Defaults`);
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.PrePaddingSeconds, PAD.pre * 60);
    assert.equal(defaults.body.PostPaddingSeconds, PAD.post * 60);
    assert.equal(defaults.body.ProgramId, undefined);
    assert.equal(defaults.body.Name, undefined);
    assert.equal(defaults.body.StartDate, undefined);
    assert.deepEqual(defaults.body.aiostreams, { repeats: true });
    assert.deepEqual((await call(`${server.url}/LiveTv/Timers/Defaults?channelId=chan-7`)).body.aiostreams, { repeats: true, canRecord: true });
    assert.deepEqual((await call(`${server.url}/LiveTv/Timers/Defaults?programId=prog-weather`)).body.aiostreams, { repeats: true, canRecord: true });
  } finally {
    server.close();
  }
});

test("this server's own recorder makes no repeating recordings, and says so", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-repeats-'));
  const local = new LocalRecorder(
    { mode: 'local', dir, preMinutes: 1, postMinutes: 5, keepDays: 0, maxAtOnce: 4, users: [] },
    { streamUrl: async () => null, channels: async () => [], programmes: async () => [], now: Date.now, userAgent: () => 'RecorderTest/1.0' },
  );
  const server = await jellyfin(local);
  try {
    const refused = await call(`${server.url}/LiveTv/SeriesTimers`, { method: 'POST', body: { ChannelId: 'chan-7', StartDate: iso(now + DAY), EndDate: iso(now + DAY + 30 * MIN), Days: ['Monday'], TimeZone: 'UTC' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.Message, "Repeating recordings need Dispatcharr's DVR");
    assert.deepEqual((await call(`${server.url}/LiveTv/Timers/Defaults`)).body.aiostreams, { repeats: false });
    // A window's name is kept as its title.
    const named = await call(`${server.url}/LiveTv/Timers`, { method: 'POST', body: { ChannelId: 'chan-7', StartDate: iso(now + DAY), EndDate: iso(now + DAY + 30 * MIN), Name: 'Late Film' } });
    assert.equal(named.body.Name, 'Late Film');
    assert.equal(named.body.PrePaddingSeconds, 0);
  } finally {
    server.close();
    await local.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
