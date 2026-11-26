// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// Runs the local recorder against a fake channel server on localhost, with invented channels and guide.
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { AddressInfo } from 'net';
import type { Readable } from 'stream';
import { LocalRecorder, byteRange, safeName, type LocalDeps, type LocalTiming } from './local';
import type { ChannelRef, ProgrammeInfo, RecordingEntry } from './types';
import type { RecordingSettings } from './settings';

const USER_AGENT = 'RecorderTest/1.0';
const PACKET = 188;
const SEGMENTS = 6;
const FIRST_SEQUENCE = 40;

/** A transport stream packet carrying its number, so the order can be checked in the file. */
function packet(n: number): Buffer {
  const bytes = Buffer.alloc(PACKET, 0xff);
  bytes[0] = 0x47;
  bytes.writeUInt32BE(n, 1);
  return bytes;
}

function packetNumbers(file: Buffer): number[] {
  const numbers: number[] = [];
  for (let at = 0; at + PACKET <= file.length; at += PACKET) {
    assert.equal(file[at], 0x47, `a packet starts at ${at}`);
    numbers.push(file.readUInt32BE(at + 1));
  }
  return numbers;
}

let fake: http.Server;
let base = '';
const hits = new Map<string, number>();
const agents = new Set<string>();
let dropCounter = 0;
let stallConnections = 0;
let hlsStartedAt = 0;
let fmp4StartedAt = 0;

const available = (startedAt: number) => Math.min(SEGMENTS, 2 + Math.floor((Date.now() - startedAt) / 250));

function mediaPlaylist(startedAt: number, extension: string, map: boolean): string {
  const count = available(startedAt);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${FIRST_SEQUENCE}`];
  if (map) lines.push('#EXT-X-MAP:URI="init.mp4"');
  for (let i = 0; i < count; i++) lines.push('#EXTINF:1.0,', `seg/${FIRST_SEQUENCE + i}.${extension}`);
  if (count === SEGMENTS) lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/** Sends packets every 50 ms; `limit` closes the connection after that many, `stall` goes silent instead. */
function sendPackets(res: http.ServerResponse, next: () => number, options: { limit?: number; stall?: boolean } = {}): void {
  res.writeHead(200, { 'content-type': 'video/mp2t' });
  let sent = 0;
  const timer = setInterval(() => {
    if (options.limit !== undefined && sent >= options.limit) {
      clearInterval(timer);
      if (!options.stall) res.socket?.destroy();
      return;
    }
    sent++;
    res.write(packet(next()));
  }, 50);
  res.on('close', () => clearInterval(timer));
}

before(async () => {
  fake = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    agents.add(String(req.headers['user-agent']));
    const segment = /^\/(hls|fmp4)\/seg\/(\d+)\.(ts|m4s)$/.exec(url.pathname);
    if (segment) {
      res.writeHead(200, { 'content-type': segment[1] === 'hls' ? 'video/mp2t' : 'video/iso.segment' });
      res.end(`${segment[1] === 'hls' ? 'HIGH' : 'FRAG'}-${segment[2]};`);
      return;
    }
    switch (url.pathname) {
      case '/redirect':
        res.writeHead(302, { location: '/ts' }).end();
        return;
      case '/ts': {
        let n = 0;
        sendPackets(res, () => n++);
        return;
      }
      case '/drop':
        sendPackets(res, () => dropCounter++, { limit: 5 });
        return;
      case '/stall': {
        // A few packets on the first connection, then nothing on any.
        let n = 0;
        sendPackets(res, () => n++, { limit: stallConnections++ === 0 ? 3 : 0, stall: true });
        return;
      }
      case '/silent':
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        res.flushHeaders();
        return;
      case '/hls/master.m3u8':
        // Sent as plain bytes: the recorder knows a playlist by how it begins.
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end([
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=9000000,RESOLUTION=640x360',
          'low.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080',
          'high.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720',
          'mid.m3u8',
        ].join('\n'));
        return;
      case '/hls/high.m3u8':
        hlsStartedAt ||= Date.now();
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(mediaPlaylist(hlsStartedAt, 'ts', false));
        return;
      case '/fmp4/media.m3u8':
        fmp4StartedAt ||= Date.now();
        res.writeHead(200, { 'content-type': 'application/x-mpegURL' });
        res.end(mediaPlaylist(fmp4StartedAt, 'm4s', true));
        return;
      case '/fmp4/init.mp4':
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end('INIT;');
        return;
      default:
        res.writeHead(404).end('not here');
    }
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

const temps: string[] = [];
const recorders: LocalRecorder[] = [];

afterEach(async () => {
  await Promise.all(recorders.splice(0).map((recorder) => recorder.close()));
});

after(async () => {
  fake.closeAllConnections();
  fake.close();
  for (const dir of temps) await fs.promises.rm(dir, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-recorder-'));
  temps.push(dir);
  return dir;
}

const channel = (id: string, name: string): ChannelRef => ({ type: 'tv', id, name });
// Channels whose id is a route on the fake server; `none` can't be played.
const ROUTES: Record<string, string> = {
  redirect: '/redirect', ts: '/ts', drop: '/drop', stall: '/stall', silent: '/silent', hls: '/hls/master.m3u8', fmp4: '/fmp4/media.m3u8',
};

const FAST: Partial<LocalTiming> = { recheckMs: 200, idleMs: 600, noDataMs: 1200, saveEveryMs: 200, backoffMs: 50, backoffMaxMs: 200, minPollMs: 100 };

interface Setup {
  settings?: Partial<RecordingSettings>;
  deps?: Partial<LocalDeps>;
  timing?: Partial<LocalTiming>;
}

function recorderIn(dir: string, setup: Setup = {}): LocalRecorder {
  const settings: RecordingSettings = { mode: 'local', dir, preMinutes: 0, postMinutes: 0, keepDays: 0, maxAtOnce: 4, users: [], ...setup.settings };
  const deps: LocalDeps = {
    streamUrl: async (c) => (ROUTES[c.id] ? base + ROUTES[c.id] : null),
    channels: async () => [],
    programmes: async () => [],
    now: () => Date.now(),
    userAgent: () => USER_AGENT,
    ...setup.deps,
  };
  const recorder = new LocalRecorder(settings, deps, { ...FAST, ...setup.timing });
  recorders.push(recorder);
  return recorder;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`waited too long; last seen ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

const finished = (recorder: LocalRecorder, id: number) =>
  until(() => recorder.get(id), (entry) => !!entry && entry.state !== 'scheduled' && entry.state !== 'recording') as Promise<RecordingEntry>;
const hasBytes = (recorder: LocalRecorder, id: number) => until(() => recorder.get(id), (entry) => (entry?.size ?? 0) > 0);

/** Every file under the folder but the recordings list. */
function mediaFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile() && !path.basename(full).startsWith('recordings.json')) found.push(full);
  }
  return found;
}

function onlyFile(dir: string): string {
  const files = mediaFiles(dir);
  assert.equal(files.length, 1, `one file in the folder: ${files.map((f) => path.relative(dir, f)).join(', ')}`);
  return files[0];
}

async function readBody(body: Readable | undefined): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of body ?? []) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

const savedState = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'recordings.json'), 'utf8'));

// ---------- Recording ----------

test('records a channel from now until its window ends, through a redirect', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir);
  const start = Date.now();
  const entry = await recorder.record({ channel: channel('redirect', 'News One'), start, end: start + 1200, owner: 'config-1' });
  assert.equal(entry.state, 'recording');
  assert.equal(entry.owner, 'config-1');
  const done = await finished(recorder, entry.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.playable, true);
  const file = onlyFile(dir);
  assert.match(path.relative(dir, file), /^News One[/\\]News One - \d{4}-\d\d-\d\d \d\d\.\d\d - News One\.ts$/);
  const bytes = fs.readFileSync(file);
  assert.equal(done.size, bytes.length);
  const numbers = packetNumbers(bytes);
  assert.ok(numbers.length >= 10, `${numbers.length} packets`);
  assert.deepEqual(numbers, numbers.map((_, i) => i), 'every packet once, in order');
  assert.ok(hits.get('/redirect'));
  assert.ok(agents.has(USER_AGENT));
  assert.equal(savedState(dir).recordings[0].state, 'completed');
});

test('HLS: the highest variant is followed and each segment written once, in order', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir, { timing: { noDataMs: 4000 } });
  hlsStartedAt = 0;
  const start = Date.now();
  const entry = await recorder.record({ channel: channel('hls', 'Film Loop'), start, end: start + 2500 });
  const done = await finished(recorder, entry.id);
  assert.equal(done.state, 'completed');
  const file = onlyFile(dir);
  assert.ok(file.endsWith('.ts'));
  const expected = Array.from({ length: SEGMENTS }, (_, i) => `HIGH-${FIRST_SEQUENCE + i};`).join('');
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
  for (let i = 0; i < SEGMENTS; i++) assert.equal(hits.get(`/hls/seg/${FIRST_SEQUENCE + i}.ts`), 1, `segment ${i} fetched once`);
  assert.equal(hits.get('/hls/low.m3u8'), undefined);
  assert.equal(hits.get('/hls/mid.m3u8'), undefined);
  assert.ok((hits.get('/hls/high.m3u8') ?? 0) >= 3, 'the playlist was polled as it grew');
});

test('HLS with fMP4 segments: the init segment is written once at the start and the file is .mp4', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir, { timing: { noDataMs: 4000 } });
  fmp4StartedAt = 0;
  const start = Date.now();
  const entry = await recorder.record({ channel: channel('fmp4', 'Sport Two'), start, end: start + 2500 });
  const done = await finished(recorder, entry.id);
  assert.equal(done.state, 'completed');
  const file = onlyFile(dir);
  assert.ok(file.endsWith('.mp4'));
  const expected = `INIT;${Array.from({ length: SEGMENTS }, (_, i) => `FRAG-${FIRST_SEQUENCE + i};`).join('')}`;
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
  assert.equal(hits.get('/fmp4/init.mp4'), 1);
  const media = await recorder.open(entry.id, {});
  assert.equal(media?.headers['Content-Type'], 'video/mp4');
  media?.body?.destroy();
});

test('a stream that drops is reconnected and appended to the same file', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir);
  const connectionsBefore = hits.get('/drop') ?? 0;
  const start = Date.now();
  const entry = await recorder.record({ channel: channel('drop', 'Flaky'), start, end: start + 1600 });
  const done = await finished(recorder, entry.id);
  assert.equal(done.state, 'completed');
  assert.ok((hits.get('/drop') ?? 0) - connectionsBefore >= 3, 'it reconnected');
  const numbers = packetNumbers(fs.readFileSync(onlyFile(dir)));
  assert.ok(numbers.length > 5, `${numbers.length} packets, more than one connection sends`);
  for (let i = 1; i < numbers.length; i++) assert.ok(numbers[i] > numbers[i - 1], 'packets in order');
});

test('a channel that sends nothing is interrupted with the reason', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir);
  stallConnections = 0;
  const start = Date.now();
  const silent = await recorder.record({ channel: channel('silent', 'Quiet'), start, end: start + 10_000 });
  const stall = await recorder.record({ channel: channel('stall', 'Stalls'), start, end: start + 10_000 });
  const none = await recorder.record({ channel: channel('none', 'Gone'), start, end: start + 10_000 });
  const [a, b, c] = await Promise.all([finished(recorder, silent.id), finished(recorder, stall.id), finished(recorder, none.id)]);
  assert.equal(a.state, 'interrupted');
  assert.equal(a.error, "The channel couldn't be played");
  assert.equal(a.playable, false);
  assert.equal(b.state, 'interrupted');
  assert.equal(b.error, 'The channel stopped sending');
  assert.equal(b.playable, true);
  assert.equal(c.error, "The channel couldn't be played");
  assert.ok(Date.now() - start < 5000, 'it gave up after the quiet time, not at the window end');
});

test('cancel: a recording stops and keeps its file; a scheduled one goes; an unknown one is 404', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir);
  const now = Date.now();
  const live = await recorder.record({ channel: channel('ts', 'News One'), start: now, end: now + 20_000 });
  await hasBytes(recorder, live.id);
  await recorder.cancel(live.id);
  const stopped = await recorder.get(live.id);
  assert.equal(stopped?.state, 'stopped');
  assert.equal(stopped?.playable, true);
  assert.equal(fs.statSync(onlyFile(dir)).size, stopped?.size);
  await recorder.cancel(live.id);
  assert.equal((await recorder.get(live.id))?.state, 'stopped', 'cancelling one that is over changes nothing');

  const later = await recorder.record({ channel: channel('ts', 'News One'), start: now + 3600_000, end: now + 7200_000 });
  assert.equal(later.state, 'scheduled');
  await recorder.cancel(later.id);
  assert.equal(await recorder.get(later.id), null);
  assert.deepEqual((await recorder.list()).map((e) => e.id), [live.id]);
  await assert.rejects(recorder.cancel(999), (error: any) => error.status === 404);
});

test('remove deletes the file and its empty folder, and ids are never used again', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir);
  const now = Date.now();
  const programme: ProgrammeInfo = { title: 'Quiz Night', start: now, end: now + 20_000 };
  const entry = await recorder.record({ channel: channel('ts', 'News One'), programme });
  await hasBytes(recorder, entry.id);
  const file = onlyFile(dir);
  assert.equal(path.basename(path.dirname(file)), 'Quiz Night');
  await recorder.remove(entry.id);
  assert.equal(await recorder.get(entry.id), null);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.ok(fs.existsSync(dir));
  await assert.rejects(recorder.remove(entry.id), (error: any) => error.status === 404);
  const next = await recorder.record({ channel: channel('ts', 'News One'), start: now + 3600_000, end: now + 7200_000 });
  assert.ok(next.id > entry.id);
});

test('a programme is padded, asked twice gives the same recording, and bad windows are refused', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir, { settings: { preMinutes: 2, postMinutes: 3 } });
  assert.deepEqual(await recorder.padding(), { pre: 120, post: 180 });
  assert.equal(recorder.canRecord(channel('anything', 'Any')), true);
  const now = Date.now();
  const programme: ProgrammeInfo = { title: 'Evening News', start: now + 3600_000, end: now + 5400_000, isNew: true };
  const first = await recorder.record({ channel: channel('ts', 'News One'), programme, owner: 'config-1' });
  assert.equal(first.state, 'scheduled');
  assert.equal(first.start, programme.start - 120_000);
  assert.equal(first.end, programme.end + 180_000);
  const again = await recorder.record({ channel: channel('ts', 'News One'), programme: { ...programme }, owner: 'config-2' });
  assert.equal(again.id, first.id);
  assert.equal((await recorder.list()).length, 1);

  await assert.rejects(recorder.record({ channel: channel('ts', 'News One'), start: now - 7200_000, end: now - 3600_000 }), (error: any) => error.status === 400);
  await assert.rejects(recorder.record({ channel: channel('ts', 'News One'), start: now + 5000, end: now + 5000 }), (error: any) => error.status === 400);
  const past = await recorder.record({ channel: channel('none', 'Gone'), start: now - 60_000, end: now + 3600_000 });
  assert.ok(past.start >= now, 'a start in the past starts now');
  assert.equal(past.state, 'recording');
});

test('one recording past the most at once is interrupted', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir, { settings: { maxAtOnce: 1 } });
  const now = Date.now();
  const first = await recorder.record({ channel: channel('ts', 'News One'), start: now, end: now + 10_000 });
  const second = await recorder.record({ channel: channel('redirect', 'News Two'), start: now, end: now + 10_000 });
  assert.equal(first.state, 'recording');
  assert.equal(second.state, 'interrupted');
  assert.equal(second.error, 'Too many recordings at once (the most is 1)');
  assert.equal(second.playable, false);
});

// ---------- Restarting ----------

test('after a restart, a recording whose window is open resumes into the same file', async () => {
  const dir = await freshDir();
  const first = recorderIn(dir);
  const now = Date.now();
  const entry = await first.record({ channel: channel('ts', 'News One'), start: now, end: now + 2500 });
  await hasBytes(first, entry.id);
  await first.close();
  assert.equal(savedState(dir).recordings[0].state, 'recording', 'closing leaves it to resume');
  const file = onlyFile(dir);
  const before = fs.readFileSync(file);

  const second = recorderIn(dir);
  assert.equal((await second.get(entry.id))?.state, 'recording');
  const done = await finished(second, entry.id);
  assert.equal(done.state, 'completed');
  assert.equal(onlyFile(dir), file);
  const after = fs.readFileSync(file);
  assert.ok(after.length > before.length);
  assert.ok(after.subarray(0, before.length).equals(before), 'appended after what was there');
  assert.equal(done.size, after.length);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), [], 'no temporary files left');
});

test('after a restart, what was missed or cut short while the server was down is interrupted', async () => {
  const dir = await freshDir();
  let offset = 0;
  const now = () => Date.now() + offset;
  const first = recorderIn(dir, { deps: { now } });
  const start = Date.now();
  const missed = await first.record({ channel: channel('ts', 'News One'), start: start + 60_000, end: start + 120_000 });
  const cut = await first.record({ channel: channel('ts', 'News One'), start, end: start + 30_000 });
  await hasBytes(first, cut.id);
  await first.close();

  offset = 10 * 60_000;
  const second = recorderIn(dir, { deps: { now } });
  const a = await second.get(missed.id);
  assert.equal(a?.state, 'interrupted');
  assert.equal(a?.error, "The server wasn't running at the time");
  assert.equal(a?.playable, false);
  const b = await second.get(cut.id);
  assert.equal(b?.state, 'interrupted');
  assert.equal(b?.error, 'The server stopped while it was recording');
  assert.equal(b?.playable, true);
});

test('an unreadable recordings list is set aside and the list starts empty', async () => {
  const dir = await freshDir();
  fs.writeFileSync(path.join(dir, 'recordings.json'), '{ not json');
  const recorder = recorderIn(dir);
  assert.deepEqual(await recorder.list(), []);
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith('recordings.json.broken-')).length, 1);
  const now = Date.now();
  const entry = await recorder.record({ channel: channel('ts', 'News One'), start: now + 3600_000, end: now + 7200_000 });
  assert.equal(entry.id, 1);
});

// ---------- Series ----------

test('series rules schedule matching airings, new ones only when asked, and removing a rule clears its upcoming ones', async () => {
  const dir = await freshDir();
  const t = Date.now();
  const news = channel('news', 'News One');
  const films = channel('films', 'Film Loop');
  const broken = channel('broken', 'Broken');
  const guide: Record<string, ProgrammeInfo[]> = {
    news: [
      { title: 'Quiz Night', start: t + 1 * 3600_000, end: t + 2 * 3600_000, isNew: true },
      { title: 'Quiz Night', start: t + 3 * 3600_000, end: t + 4 * 3600_000, isNew: false },
      { title: 'Other Show', start: t + 2 * 3600_000, end: t + 3 * 3600_000, isNew: true },
    ],
    films: [
      { title: '  quiz night ', start: t + 5 * 3600_000, end: t + 6 * 3600_000, isNew: true },
      { title: 'Quiz Night', start: t + 7 * 3600_000, end: t + 8 * 3600_000 },
    ],
  };
  const owners: Array<string | undefined> = [];
  const recorder = recorderIn(dir, {
    settings: { preMinutes: 1, postMinutes: 2 },
    deps: {
      channels: async (owner) => {
        owners.push(owner);
        return [news, films, broken];
      },
      programmes: async (c, _from, _to, owner) => {
        owners.push(owner);
        if (c.id === 'broken') throw new Error('guide down');
        return guide[c.id] ?? [];
      },
    },
  });
  owners.length = 0;

  const rule = await recorder.addSeries({ channel: news, programme: guide.news[0], anyChannel: false, newOnly: true, owner: 'config-1' });
  assert.equal(rule.title, 'Quiz Night');
  assert.equal(rule.owner, 'config-1');
  let list = await recorder.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].start, guide.news[0].start - 60_000);
  assert.equal(list[0].end, guide.news[0].end + 120_000);
  assert.equal(list[0].seriesId, rule.id);
  assert.equal(list[0].owner, 'config-1');
  assert.equal(list[0].state, 'scheduled');

  const same = await recorder.addSeries({ channel: news, programme: guide.news[1], anyChannel: false, newOnly: true });
  assert.equal(same.id, rule.id);

  const every = await recorder.addSeries({ channel: news, programme: guide.news[0], anyChannel: true, newOnly: false, owner: 'config-2' });
  assert.notEqual(every.id, rule.id);
  list = await recorder.list();
  assert.deepEqual(list.map((e) => [e.channel.id, e.programme?.start, e.seriesId]), [
    ['news', guide.news[0].start, rule.id],
    ['news', guide.news[1].start, every.id],
    ['films', guide.films[0].start, every.id],
    ['films', guide.films[1].start, every.id],
  ]);
  assert.ok(owners.includes('config-2') && owners.includes('config-1'), 'each rule asks with its own configuration');

  await recorder.refreshSeries();
  assert.equal((await recorder.list()).length, 4, 'looking again adds nothing twice');

  await recorder.removeSeries(rule.id);
  assert.deepEqual((await recorder.series()).map((r) => r.id), [every.id]);
  assert.deepEqual((await recorder.list()).map((e) => e.seriesId), [every.id, every.id, every.id]);
  await assert.rejects(recorder.removeSeries(rule.id), (error: any) => error.status === 404);
});

// ---------- Keeping ----------

test('the sweep removes finished recordings older than keepDays', async () => {
  const dir = await freshDir();
  let offset = 0;
  const recorder = recorderIn(dir, { settings: { keepDays: 1 }, deps: { now: () => Date.now() + offset } });
  const now = Date.now();
  const entry = await recorder.record({ channel: channel('ts', 'News One'), programme: { title: 'Short', start: now, end: now + 500 } });
  await finished(recorder, entry.id);
  const file = onlyFile(dir);
  await recorder.sweep();
  assert.ok(await recorder.get(entry.id), 'kept while it is new');
  offset = 2 * 24 * 3600_000;
  await recorder.sweep();
  assert.equal(await recorder.get(entry.id), null);
  assert.equal(fs.existsSync(file), false);
});

// ---------- Playing ----------

test('open() sends the file whole or in ranges', async () => {
  const dir = await freshDir();
  const recorder = recorderIn(dir);
  const now = Date.now();
  const entry = await recorder.record({ channel: channel('ts', 'News One'), start: now, end: now + 2000 });
  await hasBytes(recorder, entry.id);
  const growing = await recorder.open(entry.id, {});
  assert.equal(growing?.status, 200);
  const growingBytes = await readBody(growing?.body);
  assert.equal(growingBytes.length, Number(growing?.headers['Content-Length']), 'while it records, the size so far');

  await finished(recorder, entry.id);
  const bytes = fs.readFileSync(onlyFile(dir));
  const size = bytes.length;

  const whole = await recorder.open(entry.id, {});
  assert.equal(whole?.status, 200);
  assert.equal(whole?.headers['Content-Type'], 'video/mp2t');
  assert.equal(whole?.headers['Accept-Ranges'], 'bytes');
  assert.equal(whole?.headers['Content-Length'], String(size));
  assert.ok((await readBody(whole?.body)).equals(bytes));

  const part = await recorder.open(entry.id, { range: 'bytes=0-99' });
  assert.equal(part?.status, 206);
  assert.equal(part?.headers['Content-Range'], `bytes 0-99/${size}`);
  assert.equal(part?.headers['Content-Length'], '100');
  assert.ok((await readBody(part?.body)).equals(bytes.subarray(0, 100)));

  const rest = await recorder.open(entry.id, { range: 'bytes=100-' });
  assert.equal(rest?.headers['Content-Range'], `bytes 100-${size - 1}/${size}`);
  assert.ok((await readBody(rest?.body)).equals(bytes.subarray(100)));

  const tail = await recorder.open(entry.id, { range: 'bytes=-50' });
  assert.equal(tail?.status, 206);
  assert.equal(tail?.headers['Content-Range'], `bytes ${size - 50}-${size - 1}/${size}`);
  assert.ok((await readBody(tail?.body)).equals(bytes.subarray(size - 50)));

  const past = await recorder.open(entry.id, { range: `bytes=${size}-` });
  assert.equal(past?.status, 416);
  assert.equal(past?.headers['Content-Range'], `bytes */${size}`);
  assert.equal(past?.body, undefined);

  assert.equal(await recorder.open(entry.id, { path: 'hls/seg_00001.ts' }), null);
  assert.equal(await recorder.open(999, {}), null);
  const later = await recorder.record({ channel: channel('ts', 'News One'), start: now + 3600_000, end: now + 7200_000 });
  assert.equal(await recorder.open(later.id, {}), null, 'nothing recorded yet');
});

test('byteRange reads single ranges and leaves the rest to a whole answer', () => {
  assert.deepEqual(byteRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(byteRange('bytes=90-200', 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange('bytes=-200', 100), { start: 0, end: 99 });
  assert.equal(byteRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(byteRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(byteRange('bytes=0-1,5-9', 100), null);
  assert.equal(byteRange('items=0-1', 100), null);
  assert.equal(byteRange(undefined, 100), null);
});

// ---------- Names ----------

test('unsafe titles and channel names stay inside the recordings folder', async () => {
  const parent = await freshDir();
  const dir = path.join(parent, 'recordings');
  const recorder = recorderIn(dir);
  const now = Date.now();
  const programme: ProgrammeInfo = { title: '../../escape\u0000/..\\evil: name\u0007', start: now, end: now + 500 };
  const entry = await recorder.record({ channel: channel('ts', '../a/b\\c..'), programme });
  await finished(recorder, entry.id);
  const file = onlyFile(dir);
  const relative = path.relative(dir, file);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(relative.split(path.sep).length, 2, 'one folder, one file');
  assert.ok(!relative.includes('..'));
  assert.ok(!/[\u0000-\u001f]/.test(relative));
  assert.deepEqual(fs.readdirSync(parent), ['recordings'], 'nothing written beside the folder');

  assert.equal(safeName('..'), 'Recording');
  assert.equal(safeName('  ./.. / \\ '), 'Recording');
  assert.equal(safeName('Line\nbreak\ttab'), 'Linebreaktab');
  assert.equal(safeName('a'.repeat(300)).length, 120);
  assert.ok(Buffer.byteLength(safeName('語'.repeat(200))) <= 230);
  assert.equal(safeName('Star Trek: Discovery'), 'Star Trek Discovery');
});
