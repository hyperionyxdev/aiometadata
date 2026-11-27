// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// Who set each recording: kept across a restart, shared by profiles that record the same programme,
// and given up as agreed (one of several owners only leaves it; who set it alone, or the household's
// main profile, removes it). Against an invented recorder, through the routes clients call.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerRecordings, slotIdOf, slotNumberOf, type RecordingRouteDeps } from './jellyfin';
import { RecordingOwners, recordingOwners, useRecordingOwners } from './owners';
import { profileUserId } from '../profiles';
import type { ChannelRef, ProgrammeInfo, RecordAsk, Recorder, RecordingEntry, SeriesAsk, SeriesEntry, SlotAsk, SlotEntry } from './types';

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const NEIGHBOURS = '22222222-2222-4222-8222-222222222222';
const CHANNEL: ChannelRef = { type: 'tv', id: 'news', name: 'News' };
const PROGRAMME: ProgrammeInfo = { title: 'Evening News', start: Date.now() + 3_600_000, end: Date.now() + 7_200_000 };

/** A recorder that keeps everything in memory, recording the same programme once, as both recorders do. */
class FakeRecorder implements Recorder {
  readonly kind = 'local' as const;
  entries = new Map<number, RecordingEntry>();
  rules = new Map<number, SeriesEntry>();
  slotList = new Map<number, SlotEntry>();
  removed: number[] = [];
  cancelled: number[] = [];
  private next = 1;

  canRecord(): boolean { return true; }
  async padding() { return { pre: 0, post: 0 }; }
  async list() { return [...this.entries.values()]; }
  async get(id: number) { return this.entries.get(id) ?? null; }
  async record(ask: RecordAsk): Promise<RecordingEntry> {
    const twin = [...this.entries.values()].find((entry) => entry.programme?.start === ask.programme?.start && entry.state === 'scheduled');
    if (twin) return twin;
    const entry: RecordingEntry = { id: this.next++, channel: ask.channel, programme: ask.programme, start: PROGRAMME.start, end: PROGRAMME.end, state: 'scheduled', playable: false };
    this.entries.set(entry.id, entry);
    return entry;
  }
  async cancel(id: number) { this.cancelled.push(id); this.entries.delete(id); }
  async remove(id: number) { this.removed.push(id); this.entries.delete(id); }
  async series() { return [...this.rules.values()]; }
  async addSeries(ask: SeriesAsk): Promise<SeriesEntry> {
    const rule: SeriesEntry = { id: this.next++, title: ask.programme.title, channel: ask.channel, anyChannel: false, newOnly: false };
    this.rules.set(rule.id, rule);
    return rule;
  }
  async removeSeries(id: number) { this.rules.delete(id); }
  async slots() { return [...this.slotList.values()]; }
  async addSlot(ask: SlotAsk): Promise<SlotEntry> {
    const slot: SlotEntry = {
      id: this.next++, name: ask.name || ask.channel.name, channel: ask.channel, days: ask.days, start: '20:00:00', end: '21:00:00',
      from: '2030-01-07', until: '2030-04-07', timeZone: 'UTC', next: { start: ask.start, end: ask.end }, last: null,
    };
    this.slotList.set(slot.id, slot);
    return slot;
  }
  async removeSlot(id: number) { this.slotList.delete(id); }
  async open() { return null; }
  async close() {}

  /** A recording with no owner: set before owners were kept, or in Dispatcharr's own web app. */
  unowned(): RecordingEntry {
    const entry: RecordingEntry = { id: this.next++, channel: CHANNEL, start: PROGRAMME.start - 86_400_000, end: PROGRAMME.end - 86_400_000, state: 'completed', playable: true };
    this.entries.set(entry.id, entry);
    return entry;
  }
}

/** Just enough of an express router to call the routes the way a client does. */
class FakeRouter {
  private routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: any }> = [];
  use() {}
  get(paths: any, handler: any) { this.add('GET', paths, handler); }
  post(paths: any, handler: any) { this.add('POST', paths, handler); }
  delete(paths: any, handler: any) { this.add('DELETE', paths, handler); }
  private add(method: string, paths: string | string[], handler: any) {
    for (const route of Array.isArray(paths) ? paths : [paths]) {
      const keys: string[] = [];
      const pattern = new RegExp(`^${route.replace(/:([a-zA-Z]+)/g, (_m, key) => { keys.push(key); return '([^/]+)'; })}$`);
      this.routes.push({ method, pattern, keys, handler });
    }
  }

  async call(method: string, url: string, who: string | null, query: Record<string, string> = {}, body: any = {}) {
    for (const route of this.routes) {
      const match = route.method === method ? route.pattern.exec(url) : null;
      if (!match) continue;
      const params: Record<string, string> = { userUUID: who?.split('/')[0] ?? HOUSEHOLD };
      route.keys.forEach((key, index) => { params[key] = match[index + 1]; });
      const [userUUID, profileId] = (who ?? HOUSEHOLD).split('/');
      const req = { method, path: url, params, query, body, headers: {}, jellyfin: { userUUID, profileId: profileId || null } };
      const res: any = { statusCode: 200, body: undefined, ended: false };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (value: any) => { res.body = value; res.ended = true; return res; };
      res.end = () => { res.ended = true; return res; };
      res.setHeader = () => res;
      let passed = false;
      await route.handler(req, res, () => { passed = true; });
      if (passed) continue;
      return res;
    }
    throw new Error(`No route for ${method} ${url}`);
  }
}

let file = '';
let recorder: FakeRecorder;
let router: FakeRouter;

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owners-')), 'recording-owners.json');
  useRecordingOwners(new RecordingOwners(file));
  recorder = new FakeRecorder();
  router = new FakeRouter();
  const deps: RecordingRouteDeps = {
    recorderFor: async () => recorder,
    programmeOf: async () => ({ channel: CHANNEL, programme: PROGRAMME }),
    channelOf: async () => CHANNEL,
    channelItemId: (channel) => `channel-${channel.id}`,
    programmeItemId: () => 'programme-1',
    serverIdFor: () => 'server',
    itemList: (items, total, startIndex) => ({ Items: items, TotalRecordCount: total, StartIndex: startIndex }),
    emptyUserData: {},
  };
  registerRecordings(router, deps);
});

afterEach(() => {
  useRecordingOwners(null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

const MAIN = HOUSEHOLD;
const KID = `${HOUSEHOLD}/kid`;
const PARTNER = `${HOUSEHOLD}/partner`;

async function record(who: string): Promise<any> {
  const res = await router.call('POST', '/LiveTv/Timers', who, {}, { ProgramId: 'programme-1' });
  assert.equal(res.statusCode, 200);
  return res.body;
}

async function recordingFor(who: string, id: string): Promise<any> {
  const res = await router.call('GET', '/LiveTv/Timers', who);
  return res.body.Items.find((item: any) => item.Id === id);
}

test('who set a recording is kept, and survives a restart', () => {
  const first = new RecordingOwners(file);
  first.add('recording', 'local', 7, KID);
  first.add('recording', 'local', 7, MAIN);
  first.add('recording', 'local', 7, KID);
  const later = new RecordingOwners(file);
  assert.deepEqual(later.owners('recording', 'local', 7), [KID, MAIN]);
  assert.deepEqual(later.remove('recording', 'local', 7, KID), [MAIN]);
  later.forget('recording', 'local', 7);
  assert.deepEqual(new RecordingOwners(file).owners('recording', 'local', 7), []);
});

test('two profiles recording the same programme share the one recording', async () => {
  const mine = await record(KID);
  const theirs = await record(PARTNER);
  assert.equal(mine.Id, theirs.Id);
  assert.equal(recorder.entries.size, 1);
  const seen = await recordingFor(KID, mine.Id);
  assert.deepEqual(seen.aiostreams.owners, [profileUserId(HOUSEHOLD, 'kid'), profileUserId(HOUSEHOLD, 'partner')]);
  assert.equal(seen.aiostreams.mine, true);
  // Shared, neither one may act on it for the other.
  assert.equal(seen.aiostreams.manage, false);
  assert.equal((await recordingFor(MAIN, mine.Id)).aiostreams.mine, false);
  assert.equal((await recordingFor(MAIN, mine.Id)).aiostreams.manage, true);
});

test('one of several owners only leaves it; the last one cancels it', async () => {
  const timer = await record(KID);
  await record(PARTNER);
  const left = await router.call('DELETE', `/LiveTv/Timers/${timer.Id}`, KID);
  assert.equal(left.statusCode, 204);
  assert.deepEqual(recorder.cancelled, [], 'cancelled for everyone by one of its owners');
  assert.equal((await recordingFor(KID, timer.Id)).aiostreams.mine, false);
  assert.equal((await recordingFor(PARTNER, timer.Id)).aiostreams.manage, true);
  const gone = await router.call('DELETE', `/LiveTv/Timers/${timer.Id}`, PARTNER);
  assert.equal(gone.statusCode, 204);
  assert.equal(recorder.cancelled.length, 1);
});

test("another profile's recording can't be given up by someone who didn't set it", async () => {
  const timer = await record(PARTNER);
  const refused = await router.call('DELETE', `/LiveTv/Timers/${timer.Id}`, KID);
  assert.equal(refused.statusCode, 403);
  assert.equal(recorder.entries.size, 1);
});

test('the main profile deletes for everyone only when it asks to', async () => {
  const timer = await record(MAIN);
  await record(KID);
  // Its own, shared: it only leaves it.
  await router.call('DELETE', `/LiveTv/Timers/${timer.Id}`, MAIN);
  assert.equal(recorder.entries.size, 1);
  // Asked for everyone: gone.
  await record(MAIN);
  await router.call('DELETE', `/LiveTv/Timers/${timer.Id}`, MAIN, { ForEveryone: 'true' });
  assert.equal(recorder.entries.size, 0);
});

test("a recording with no owner is the household's: only a main profile deletes it", async () => {
  const entry = recorder.unowned();
  const id = (await router.call('GET', '/LiveTv/Recordings', KID)).body.Items[0].Id;
  const shown = (await router.call('GET', '/LiveTv/Recordings', KID)).body.Items[0];
  assert.deepEqual(shown.aiostreams.owners, []);
  assert.equal(shown.aiostreams.mine, false);
  assert.equal(shown.aiostreams.manage, false);
  assert.equal((await router.call('DELETE', `/LiveTv/Recordings/${id}`, KID)).statusCode, 403);
  // Another household's main profile can't reach into this one's owned recordings, but a recording
  // nobody owns is any main profile's to tidy.
  assert.equal((await router.call('DELETE', `/LiveTv/Recordings/${id}`, MAIN)).statusCode, 204);
  assert.deepEqual(recorder.removed, [entry.id]);
});

test("one household's main profile can't delete another household's recording", async () => {
  const timer = await record(KID);
  const refused = await router.call('DELETE', `/LiveTv/Timers/${timer.Id}`, NEIGHBOURS);
  assert.equal(refused.statusCode, 403);
});

test('a series shared by two profiles is only left by one of them', async () => {
  const set = async (who: string) => (await router.call('POST', '/LiveTv/SeriesTimers', who, {}, { ProgramId: 'programme-1' })).body;
  const rule = await set(KID);
  recorder.rules.clear();
  recorder.rules.set(Number.parseInt(rule.Id.slice(3), 16), { id: Number.parseInt(rule.Id.slice(3), 16), title: 'Evening News', channel: CHANNEL, anyChannel: false, newOnly: false });
  // The same rule asked for again by another profile.
  const store = new RecordingOwners(file);
  store.add('series', 'local', Number.parseInt(rule.Id.slice(3), 16), PARTNER);
  useRecordingOwners(store);
  await router.call('DELETE', `/LiveTv/SeriesTimers/${rule.Id}`, KID);
  assert.equal(recorder.rules.size, 1, 'removed for everyone by one of its owners');
  const listed = (await router.call('GET', '/LiveTv/SeriesTimers', PARTNER)).body.Items[0];
  assert.equal(listed.aiostreams.mine, true);
  assert.equal(listed.aiostreams.manage, true);
  await router.call('DELETE', `/LiveTv/SeriesTimers/${rule.Id}`, PARTNER);
  assert.equal(recorder.rules.size, 0);
});

async function setSlot(who: string): Promise<any> {
  const res = await router.call('POST', '/LiveTv/SeriesTimers', who, {}, {
    ChannelId: 'channel-news', Name: 'Evening News', StartDate: new Date(PROGRAMME.start).toISOString(), EndDate: new Date(PROGRAMME.end).toISOString(), Days: ['Monday'], TimeZone: 'UTC',
  });
  assert.equal(res.statusCode, 200);
  return res.body;
}

test('a repeating schedule shared by two profiles is only left by one of them', async () => {
  const slot = await setSlot(KID);
  assert.match(slot.Id, /^d53[0-9a-f]{29}$/);
  const id = slotNumberOf(slot.Id) as number;
  // The same schedule wanted by another profile.
  recordingOwners().add('slot', 'local', id, PARTNER);
  assert.equal((await router.call('DELETE', `/LiveTv/SeriesTimers/${slot.Id}`, NEIGHBOURS)).statusCode, 403);
  assert.equal((await router.call('DELETE', `/LiveTv/SeriesTimers/${slot.Id}`, KID)).statusCode, 204);
  assert.equal(recorder.slotList.size, 1, 'removed for everyone by one of its owners');
  const listed = (await router.call('GET', '/LiveTv/SeriesTimers', PARTNER)).body.Items[0];
  assert.equal(listed.Id, slot.Id);
  assert.equal(listed.aiostreams.mine, true);
  assert.equal(listed.aiostreams.manage, true);
  assert.equal((await router.call('GET', `/LiveTv/SeriesTimers/${slot.Id}`, KID)).body.aiostreams.mine, false);
  await router.call('DELETE', `/LiveTv/SeriesTimers/${slot.Id}`, PARTNER);
  assert.equal(recorder.slotList.size, 0);
  assert.deepEqual(new RecordingOwners(file).owners('slot', 'local', id), [], 'who set it is forgotten with it');
});

test('who set a repeating schedule owns the recordings it sets', async () => {
  const slot = await setSlot(KID);
  const id = slotNumberOf(slot.Id) as number;
  const entry: RecordingEntry = { id: 900, channel: CHANNEL, start: PROGRAMME.start, end: PROGRAMME.end, state: 'scheduled', playable: false, slotId: id };
  recorder.entries.set(entry.id, entry);
  const timer = (await router.call('GET', '/LiveTv/Timers', KID)).body.Items.find((item: any) => item.SeriesTimerId === slotIdOf(id));
  assert.ok(timer, 'the recording carries its schedule');
  assert.deepEqual(timer.aiostreams.owners, [profileUserId(HOUSEHOLD, 'kid')]);
  assert.equal(timer.aiostreams.mine, true);
  assert.equal((await router.call('GET', '/LiveTv/Timers', PARTNER, { SeriesTimerId: slot.Id })).body.Items[0].aiostreams.mine, false);
  assert.equal((await router.call('DELETE', `/LiveTv/Timers/${timer.Id}`, PARTNER)).statusCode, 403);
});

test('owners kept before repeating schedules were read as none', () => {
  fs.writeFileSync(file, JSON.stringify({ recordings: { 'local:1': [KID] }, series: {} }));
  const store = new RecordingOwners(file);
  assert.deepEqual(store.owners('slot', 'local', 1), []);
  assert.deepEqual(store.owners('recording', 'local', 1), [KID]);
  store.add('slot', 'local', 2, KID);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).slots, { 'local:2': [KID] });
});
