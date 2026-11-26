// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import fs from 'fs';
import fsp, { type FileHandle } from 'fs/promises';
import http, { type IncomingMessage } from 'http';
import https from 'https';
import path from 'path';
import { Readable } from 'stream';
import { setTimeout as sleep } from 'timers/promises';
import consola from 'consola';
import type { RecordingSettings } from './settings';
import {
  RecorderError,
  type ChannelRef,
  type MediaAnswer,
  type ProgrammeInfo,
  type RecordAsk,
  type Recorder,
  type RecordingEntry,
  type RecordingState,
  type SeriesAsk,
  type SeriesEntry,
} from './types';

const logger = consola.withTag('JellyfinRecordings');

/**
 * This server's own recorder: it saves a channel's live stream (one long MPEG-TS stream, or HLS)
 * into files in the recordings folder, and keeps its schedule and series rules in
 * `recordings.json` there.
 */

/** What the recorder needs from the Live TV code. `owner` is the configuration a recording or rule belongs to. */
export interface LocalDeps {
  /** A URL that plays the channel live right now: one long MPEG-TS stream, or an HLS playlist. Null when it can't be played. */
  streamUrl(channel: ChannelRef, owner?: string): Promise<string | null>;
  /** Every Live TV channel there is (for a series rule on any channel). */
  channels(owner?: string): Promise<ChannelRef[]>;
  /** The guide's programmes on a channel overlapping [from, to) (epoch ms). */
  programmes(channel: ChannelRef, from: number, to: number, owner?: string): Promise<ProgrammeInfo[]>;
  now(): number;
  userAgent(): string;
}

/** How long the recorder waits for things (milliseconds). Tests shorten them. */
export interface LocalTiming {
  /** How often the schedule is looked at again, whatever the timers do. */
  recheckMs: number;
  /** How long one request may go without sending anything before it's dropped. */
  idleMs: number;
  /** How long a channel may send nothing, reconnects included, before the recording gives up. */
  noDataMs: number;
  /** How often the size of a recording in progress is saved. */
  saveEveryMs: number;
  /** The first wait before reconnecting, doubled each time up to `backoffMaxMs`. */
  backoffMs: number;
  backoffMaxMs: number;
  /** The shortest wait between two reads of an HLS playlist. */
  minPollMs: number;
  /** How often series rules are looked at again and old recordings swept away. */
  hourlyMs: number;
}

export const LOCAL_TIMING: LocalTiming = {
  recheckMs: 30_000,
  idleMs: 20_000,
  noDataMs: 60_000,
  saveEveryMs: 15_000,
  backoffMs: 1_000,
  backoffMaxMs: 10_000,
  minPollMs: 1_000,
  hourlyMs: 60 * 60_000,
};

const STATE_FILE = 'recordings.json';
const DAY_MS = 24 * 60 * 60_000;
const GUIDE_AHEAD_MS = 2 * DAY_MS;
// A timer is never set further ahead than this; the periodic re-check covers the rest.
const MAX_TIMER_MS = 6 * 60 * 60_000;
const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;
const MAX_NAME_CHARS = 120;
// Most file systems take 255 bytes in a name; room is left for " (2)" and the extension.
const MAX_NAME_BYTES = 230;
const STATES: RecordingState[] = ['scheduled', 'recording', 'completed', 'stopped', 'interrupted'];

const WASNT_RUNNING = "The server wasn't running at the time";
const STOPPED_WHILE_RECORDING = 'The server stopped while it was recording';
const STOPPED_SENDING = 'The channel stopped sending';
const COULDNT_PLAY = "The channel couldn't be played";
const tooMany = (most: number) => `Too many recordings at once (the most is ${most})`;

/** A recording as it's kept: the entry, and where its file is (relative to the folder). */
interface StoredRecording extends RecordingEntry {
  file?: string;
}

interface SavedState {
  version: 1;
  nextId: number;
  nextSeriesId: number;
  recordings: StoredRecording[];
  series: SeriesEntry[];
}

/** Why a capture ended: its window is over, someone stopped or deleted it, the server is closing, or the channel went quiet. */
type StopReason = 'end' | 'cancel' | 'remove' | 'close' | 'quiet';

/** A failure while capturing, in words that name no address. */
class CaptureError extends Error {}

// ---------- Names ----------

/** Text as a safe file or folder name: no path separators, no `..`, no control characters, at most 120 characters. */
export function safeName(text: string, fallback = 'Recording'): string {
  const cleaned = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ');
  const short = fitBytes(Array.from(cleaned.trim()).slice(0, MAX_NAME_CHARS).join(''), MAX_NAME_BYTES);
  const name = short.replace(/^[\s.]+|[\s.]+$/g, '');
  return name || fallback;
}

/** The text cut, at a whole character, to fit in `max` bytes of UTF-8. */
function fitBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char) > max) break;
    out += char;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-25 20.00" in the server's own time. */
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

/** What a recording is called: its programme's title, or the channel's name for a window set by hand. */
function titleOf(entry: RecordingEntry): string {
  return entry.programme?.title?.trim() || entry.channel.name || 'Recording';
}

/** The recording's name as the log shows it: the guide's text with nothing that could break a log line. */
const logName = (entry: RecordingEntry) => safeName(titleOf(entry));

/** The folder a recording goes in and its file's name without the extension. */
function namesFor(entry: RecordingEntry): { folder: string; base: string } {
  const title = safeName(titleOf(entry));
  const channel = safeName(entry.channel.name, 'Channel');
  const base = fitBytes(`${title} - ${stamp(entry.programme?.start ?? entry.start)} - ${channel}`, MAX_NAME_BYTES).trim();
  return { folder: title, base };
}

/** The full path of a file within `dir`, or null if it would be outside it. */
function insideDir(dir: string, relative: string): string | null {
  if (typeof relative !== 'string' || !relative) return null;
  const full = path.resolve(dir, relative);
  const rel = path.relative(dir, full);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return full;
}

// ---------- Saved state ----------

function emptyState(): SavedState {
  return { version: 1, nextId: 1, nextSeriesId: 1, recordings: [], series: [] };
}

const isChannel = (c: any): c is ChannelRef => !!c && typeof c.type === 'string' && typeof c.id === 'string';
const sameChannel = (a: Pick<ChannelRef, 'type' | 'id'> | undefined, b: Pick<ChannelRef, 'type' | 'id'> | undefined) =>
  !!a && !!b && a.type === b.type && a.id === b.id;
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function validRecording(r: any): r is StoredRecording {
  return !!r && Number.isInteger(r.id) && r.id > 0 && isChannel(r.channel)
    && Number.isFinite(r.start) && Number.isFinite(r.end) && STATES.includes(r.state);
}

function validSeries(s: any): s is SeriesEntry {
  return !!s && Number.isInteger(s.id) && s.id > 0 && typeof s.title === 'string' && s.title.trim() !== ''
    && (s.anyChannel === true || isChannel(s.channel));
}

/** The saved state checked over; throws when it isn't a recordings list at all. */
function checkState(data: any): SavedState {
  if (!data || typeof data !== 'object' || !Array.isArray(data.recordings) || !Array.isArray(data.series)) {
    throw new Error('not a recordings list');
  }
  const recordings: StoredRecording[] = data.recordings.filter(validRecording).map((r: StoredRecording) => ({
    ...r,
    playable: r.playable === true,
    size: Number.isFinite(r.size) ? r.size : 0,
    file: typeof r.file === 'string' ? r.file : undefined,
  }));
  const series: SeriesEntry[] = data.series.filter(validSeries).map((s: SeriesEntry) => ({ ...s, anyChannel: s.anyChannel === true, newOnly: s.newOnly === true }));
  const highest = (list: Array<{ id: number }>) => list.reduce((most, item) => Math.max(most, item.id), 0);
  return {
    version: 1,
    nextId: Math.max(Number.isInteger(data.nextId) ? data.nextId : 1, highest(recordings) + 1),
    nextSeriesId: Math.max(Number.isInteger(data.nextSeriesId) ? data.nextSeriesId : 1, highest(series) + 1),
    recordings,
    series,
  };
}

/** The saved state, read once: none yet is an empty list; one that can't be read is set aside and the list starts empty. */
function readState(dir: string): SavedState {
  const file = path.join(dir, STATE_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return emptyState();
    return setAside(file, `couldn't be read (${error?.code || 'error'})`);
  }
  try {
    return checkState(JSON.parse(text));
  } catch {
    return setAside(file, "isn't readable");
  }
}

function setAside(file: string, why: string): SavedState {
  try {
    fs.renameSync(file, `${file}.broken-${Date.now()}`);
  } catch {
    // Left where it is; it is written over on the next save.
  }
  logger.warn(`The recordings list ${why}; it was set aside and the list starts empty`);
  return emptyState();
}

/** The entry as callers see it: a copy, without where its file is. */
function publicEntry(stored: StoredRecording): RecordingEntry {
  const { file: _file, ...entry } = stored;
  return JSON.parse(JSON.stringify(entry));
}

const copySeries = (rule: SeriesEntry): SeriesEntry => JSON.parse(JSON.stringify(rule));

function checkProgramme(programme: any): ProgrammeInfo {
  if (!programme || typeof programme.title !== 'string' || !Number.isFinite(programme.start) || !Number.isFinite(programme.end)) {
    throw new RecorderError('The programme needs a title, a start and an end');
  }
  return JSON.parse(JSON.stringify(programme));
}

function checkChannel(channel: any): ChannelRef {
  if (!isChannel(channel)) throw new RecorderError('A channel is needed');
  return { type: channel.type, id: channel.id, name: String(channel.name ?? ''), ...(channel.number !== undefined ? { number: String(channel.number) } : {}) };
}

function every(ms: number, run: () => void): NodeJS.Timeout {
  const timer = setInterval(run, ms);
  timer.unref();
  return timer;
}

// ---------- HTTP ranges ----------

/**
 * A single `Range: bytes=...` header against a file of `size` bytes: the bytes asked for, `unsatisfiable`
 * when they lie past its end, or null to send the whole file (no header, several ranges, or one that
 * doesn't parse).
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (match[2] && Number(match[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: match[2] ? Math.min(Number(match[2]), size - 1) : size - 1 };
}

// ---------- HLS playlists ----------

interface MediaPlaylist {
  targetDuration: number;
  map?: string;
  ended: boolean;
  segments: Array<{ sequence: number; uri: string }>;
}

function looksLikePlaylist(head: Buffer): boolean {
  return head.toString('utf8', 0, Math.min(head.length, 64)).replace(/^﻿/, '').trimStart().startsWith('#EXTM3U');
}

const isMasterPlaylist = (text: string) => /^#EXT-X-STREAM-INF/m.test(text);

function resolveUri(uri: string, base: string): string | null {
  try {
    return new URL(uri, base).toString();
  } catch {
    return null;
  }
}

/** The variant of a master playlist with the highest BANDWIDTH, as a full URL. */
function bestVariant(text: string, base: string): string | null {
  let best: { bandwidth: number; uri: string } | null = null;
  let bandwidth: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const found = /(?:^|,)BANDWIDTH=(\d+)/.exec(line.slice(line.indexOf(':') + 1));
      bandwidth = found ? Number(found[1]) : 0;
    } else if (!line.startsWith('#') && bandwidth !== null) {
      const uri = resolveUri(line, base);
      if (uri && (!best || bandwidth > best.bandwidth)) best = { bandwidth, uri };
      bandwidth = null;
    }
  }
  return best?.uri ?? null;
}

function parseMediaPlaylist(text: string, base: string): MediaPlaylist {
  const playlist: MediaPlaylist = { targetDuration: 0, ended: false, segments: [] };
  let sequence = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number.parseInt(line.slice(22), 10) || 0;
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) playlist.targetDuration = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri && !playlist.map) playlist.map = resolveUri(uri, base) ?? undefined;
    } else if (line.startsWith('#EXT-X-ENDLIST')) playlist.ended = true;
    else if (!line.startsWith('#')) {
      const uri = resolveUri(line, base);
      if (uri) playlist.segments.push({ sequence: sequence + playlist.segments.length, uri });
    }
  }
  return playlist;
}

/** Reads the rest of a body (after `head`) into one buffer, up to `cap` bytes. */
async function collect(chunks: AsyncIterator<Buffer>, head: Buffer[], cap: number): Promise<Buffer> {
  const parts = [...head];
  let total = head.reduce((sum, part) => sum + part.length, 0);
  for (;;) {
    const next = await chunks.next();
    if (next.done) break;
    total += next.value.length;
    if (total > cap) throw new CaptureError('the channel sent more than a playlist or part can hold');
    parts.push(next.value);
  }
  return Buffer.concat(parts);
}

// ---------- Capturing ----------

interface CaptureContext {
  dir: string;
  deps: LocalDeps;
  timing: LocalTiming;
  /** Bytes were written. */
  progress(): void;
  /** The entry changed in a way worth saving at once. */
  changed(): void;
}

/** The file a recording is written to, opened when its first bytes arrive (or appended to, on a resume). */
class FileSink {
  private handle: FileHandle | null = null;

  constructor(private readonly entry: StoredRecording, private readonly ctx: CaptureContext) {}

  /** Its size as it is on disk, for a recording that resumes. */
  async prepare(): Promise<void> {
    const full = this.entry.file ? insideDir(this.ctx.dir, this.entry.file) : null;
    let size = 0;
    if (full) {
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        size = 0;
      }
    }
    this.entry.size = size;
    if (size > 0) this.entry.playable = true;
  }

  /** Nothing has been written to its file yet, so an fMP4 init segment goes first. */
  get fresh(): boolean {
    return !this.entry.size;
  }

  async write(bytes: Buffer, extension: 'ts' | 'mp4'): Promise<void> {
    if (!bytes.length) return;
    this.handle ??= await this.open(extension);
    await this.handle.appendFile(bytes);
    this.entry.size = (this.entry.size ?? 0) + bytes.length;
    if (!this.entry.playable) {
      this.entry.playable = true;
      this.ctx.changed();
    }
    this.ctx.progress();
  }

  private async open(extension: 'ts' | 'mp4'): Promise<FileHandle> {
    const existing = this.entry.file ? insideDir(this.ctx.dir, this.entry.file) : null;
    if (existing) {
      await fsp.mkdir(path.dirname(existing), { recursive: true });
      return fsp.open(existing, 'a');
    }
    const { folder, base } = namesFor(this.entry);
    for (let n = 1; ; n++) {
      const relative = path.join(folder, `${n === 1 ? base : `${base} (${n})`}.${extension}`);
      const full = insideDir(this.ctx.dir, relative);
      if (!full) throw new CaptureError('the recording has no safe name');
      await fsp.mkdir(path.dirname(full), { recursive: true });
      try {
        const handle = await fsp.open(full, 'wx');
        this.entry.file = relative;
        this.ctx.changed();
        return handle;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.close().catch(() => undefined);
  }
}

/**
 * One recording being made: it asks for the channel's stream, writes what comes, and reconnects
 * when the stream drops, until it's stopped or the channel has sent nothing for too long.
 */
class Capture {
  reason: StopReason | null = null;
  done: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  private readonly sink: FileSink;
  private lastData = performance.now();
  // The media playlist followed, and the newest segment of it written.
  private seen: { url: string; last: number } | null = null;

  constructor(readonly entry: StoredRecording, private readonly ctx: CaptureContext) {
    this.sink = new FileSink(entry, {
      ...ctx,
      progress: () => {
        this.lastData = performance.now();
        ctx.progress();
      },
    });
  }

  get stopping(): boolean {
    return this.reason !== null;
  }

  stop(reason: StopReason): void {
    if (this.reason) return;
    this.reason = reason;
    this.abort.abort();
  }

  async run(): Promise<void> {
    const timing = this.ctx.timing;
    let backoff = timing.backoffMs;
    try {
      await this.sink.prepare();
      this.lastData = performance.now();
      while (!this.stopping) {
        const before = this.entry.size ?? 0;
        const url = await this.streamUrl();
        if (url && !this.stopping) {
          try {
            await this.pull(url);
          } catch (error) {
            if (!this.stopping) logger.debug(`"${logName(this.entry)}": ${describe(error)}`);
          }
        }
        if (this.stopping) break;
        const gotData = (this.entry.size ?? 0) > before;
        if (gotData) backoff = timing.backoffMs;
        const quiet = this.quietFor();
        if (quiet >= timing.noDataMs) {
          this.reason = 'quiet';
          break;
        }
        if (gotData) logger.info(`"${logName(this.entry)}": the channel dropped; reconnecting`);
        await this.pause(Math.min(backoff, timing.noDataMs - quiet));
        backoff = Math.min(backoff * 2, timing.backoffMaxMs);
      }
    } finally {
      await this.sink.close();
    }
  }

  private quietFor(): number {
    return performance.now() - this.lastData;
  }

  private pause(ms: number): Promise<void> {
    return sleep(Math.max(0, ms), undefined, { signal: this.abort.signal, ref: false }).catch(() => undefined);
  }

  private async streamUrl(): Promise<string | null> {
    try {
      return await this.ctx.deps.streamUrl(this.entry.channel, this.entry.owner);
    } catch (error) {
      logger.debug(`"${logName(this.entry)}": the channel's stream couldn't be looked up (${describe(error)})`);
      return null;
    }
  }

  /** A GET that follows redirects; it gives up when nothing arrives for a while, never on a long healthy stream. */
  private request(url: string, redirects = MAX_REDIRECTS): Promise<{ res: IncomingMessage; url: string }> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return Promise.reject(new CaptureError('the link to the channel is not valid'));
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return Promise.reject(new CaptureError('the link to the channel is not http'));
    const { idleMs, noDataMs } = this.ctx.timing;
    const idle = Math.max(100, Math.min(idleMs, noDataMs - this.quietFor()));
    return new Promise((resolve, reject) => {
      const client = target.protocol === 'https:' ? https : http;
      const headers = { 'user-agent': this.ctx.deps.userAgent(), accept: '*/*' };
      const req = client.request(target, { headers, signal: this.abort.signal }, (res) => {
        res.on('error', () => undefined);
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          const next = resolveUri(location, target.toString());
          if (redirects <= 0 || !next) reject(new CaptureError('the channel redirected too many times'));
          else resolve(this.request(next, redirects - 1));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new CaptureError(`the channel answered ${status}`));
          return;
        }
        resolve({ res, url: target.toString() });
      });
      req.setTimeout(idle, () => req.destroy(new CaptureError('the channel sent nothing for a while')));
      req.on('error', reject);
      req.end();
    });
  }

  /** A whole answer (a playlist or a segment), and the URL it came from after redirects. */
  private async fetchBody(url: string, cap: number): Promise<{ bytes: Buffer; url: string }> {
    const { res, url: at } = await this.request(url);
    try {
      const bytes = await collect(res[Symbol.asyncIterator](), [], cap);
      if (!res.complete) throw new CaptureError('the answer was cut off');
      return { bytes, url: at };
    } finally {
      res.destroy();
    }
  }

  /** One connection to the channel: a stream written as it comes, or a playlist followed. */
  private async pull(url: string): Promise<void> {
    const { res, url: at } = await this.request(url);
    try {
      const chunks: AsyncIterator<Buffer> = res[Symbol.asyncIterator]();
      const head: Buffer[] = [];
      let headLength = 0;
      let ended = false;
      while (headLength < 16) {
        const next = await chunks.next();
        if (next.done) {
          ended = true;
          break;
        }
        head.push(next.value);
        headLength += next.value.length;
      }
      const type = String(res.headers['content-type'] ?? '').toLowerCase();
      const first = Buffer.concat(head);
      if (type.includes('mpegurl') || looksLikePlaylist(first)) {
        const text = (ended ? first : await collect(chunks, [first], MAX_PLAYLIST_BYTES)).toString('utf8');
        await this.followPlaylist(text, at);
        return;
      }
      await this.sink.write(first, 'ts');
      while (!ended && !this.stopping) {
        const next = await chunks.next();
        if (next.done) break;
        await this.sink.write(next.value, 'ts');
      }
    } finally {
      res.destroy();
    }
  }

  /** HLS: the best variant's segments, each written once in order, polled until the playlist ends. */
  private async followPlaylist(text: string, at: string): Promise<void> {
    const timing = this.ctx.timing;
    let media = at;
    let body: string | null = text;
    if (isMasterPlaylist(text)) {
      const best = bestVariant(text, at);
      if (!best) throw new CaptureError('the playlist names no stream');
      media = best;
      body = null;
    }
    if (!this.seen || this.seen.url !== media) this.seen = { url: media, last: -Infinity };
    const seen = this.seen;
    for (;;) {
      if (this.stopping) return;
      let base = media;
      if (body === null) {
        const got = await this.fetchBody(media, MAX_PLAYLIST_BYTES);
        body = got.bytes.toString('utf8');
        base = got.url;
      }
      const playlist = parseMediaPlaylist(body, base);
      body = null;
      const newest = playlist.segments.at(-1)?.sequence;
      // A playlist that has gone well back from where it was has started again.
      if (newest !== undefined && newest + playlist.segments.length < seen.last) seen.last = -Infinity;
      const extension = playlist.map ? 'mp4' : 'ts';
      if (playlist.map && this.sink.fresh) {
        const init = await this.fetchBody(playlist.map, MAX_SEGMENT_BYTES);
        if (this.stopping) return;
        await this.sink.write(init.bytes, extension);
      }
      for (const segment of playlist.segments) {
        if (segment.sequence <= seen.last) continue;
        const got = await this.fetchBody(segment.uri, MAX_SEGMENT_BYTES);
        if (this.stopping) return;
        await this.sink.write(got.bytes, extension);
        seen.last = segment.sequence;
      }
      if (playlist.ended || this.quietFor() >= timing.noDataMs) return;
      await this.pause(Math.max(timing.minPollMs, playlist.targetDuration * 500));
    }
  }
}

/** An error in words that name no address. */
function describe(error: any): string {
  if (error instanceof CaptureError) return error.message;
  if (error?.name === 'AbortError') return 'stopped';
  return error?.code ? `connection failed (${error.code})` : 'connection failed';
}

// ---------- The recorder ----------

export class LocalRecorder implements Recorder {
  readonly kind = 'local' as const;
  private readonly dir: string;
  private readonly timing: LocalTiming;
  private readonly state: SavedState;
  private readonly captures = new Map<number, Capture>();
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly loops: NodeJS.Timeout[] = [];
  private readonly context: CaptureContext;
  private writing: Promise<void> | null = null;
  private dirty = false;
  private lastSavedAt = 0;
  private tempCount = 0;
  private closed = false;

  constructor(private readonly settings: RecordingSettings, private readonly deps: LocalDeps, timing: Partial<LocalTiming> = {}) {
    this.dir = path.resolve(settings.dir);
    this.timing = { ...LOCAL_TIMING, ...timing };
    this.state = readState(this.dir);
    this.context = {
      dir: this.dir,
      deps,
      timing: this.timing,
      progress: () => this.progress(),
      changed: () => this.save(),
    };
    this.recover();
    this.loops.push(every(this.timing.recheckMs, () => this.tick()), every(this.timing.hourlyMs, () => void this.hourly()));
    this.tick();
    void this.hourly();
  }

  /** Any channel: the recorder records whatever stream the Live TV code gives it. */
  canRecord(_channel: Pick<ChannelRef, 'type' | 'id'>): boolean {
    return true;
  }

  async padding(): Promise<{ pre: number; post: number }> {
    return { pre: this.settings.preMinutes * 60, post: this.settings.postMinutes * 60 };
  }

  async list(): Promise<RecordingEntry[]> {
    return [...this.state.recordings].sort((a, b) => a.start - b.start || a.id - b.id).map(publicEntry);
  }

  async get(id: number): Promise<RecordingEntry | null> {
    const entry = this.state.recordings.find((e) => e.id === id);
    return entry ? publicEntry(entry) : null;
  }

  async record(ask: RecordAsk): Promise<RecordingEntry> {
    const channel = checkChannel(ask?.channel);
    const programme = ask.programme ? checkProgramme(ask.programme) : undefined;
    const now = this.deps.now();
    let start: number;
    let end: number;
    if (programme) {
      const twin = this.state.recordings.find((e) => (e.state === 'scheduled' || e.state === 'recording')
        && e.programme && sameChannel(e.channel, channel) && e.programme.start === programme.start);
      if (twin) return publicEntry(twin);
      ({ start, end } = this.paddedWindow(programme));
    } else {
      if (!Number.isFinite(ask.start) || !Number.isFinite(ask.end)) throw new RecorderError('A programme, or a start and an end, is needed');
      start = ask.start as number;
      end = ask.end as number;
    }
    if (end <= start) throw new RecorderError('A recording has to end after it starts');
    if (end <= now) throw new RecorderError('That time is already over');
    const entry = this.add({ channel, programme, start: Math.max(start, now), end, owner: ask.owner });
    this.save();
    this.tick();
    return publicEntry(entry);
  }

  async cancel(id: number): Promise<void> {
    const entry = this.find(id);
    if (entry.state === 'scheduled') {
      this.forget(entry);
      this.save();
      return;
    }
    if (entry.state !== 'recording') return;
    const capture = this.captures.get(id);
    if (capture) {
      capture.stop('cancel');
      await capture.done;
    } else {
      entry.state = 'stopped';
      this.save();
    }
  }

  async remove(id: number): Promise<void> {
    const entry = this.find(id);
    const capture = this.captures.get(id);
    if (capture) {
      capture.stop('remove');
      await capture.done;
    }
    await this.discard(entry);
    this.save();
  }

  async series(): Promise<SeriesEntry[]> {
    return this.state.series.map(copySeries);
  }

  async addSeries(ask: SeriesAsk): Promise<SeriesEntry> {
    const programme = checkProgramme(ask?.programme);
    const channel = checkChannel(ask.channel);
    const title = programme.title.trim();
    if (!title) throw new RecorderError('The programme needs a title');
    const anyChannel = ask.anyChannel === true;
    const existing = this.state.series.find((r) => sameTitle(r.title, title) && r.anyChannel === anyChannel && (anyChannel || sameChannel(r.channel, channel)));
    if (existing) return copySeries(existing);
    const rule: SeriesEntry = { id: this.state.nextSeriesId++, title, channel, anyChannel, newOnly: ask.newOnly === true };
    if (ask.owner !== undefined) rule.owner = ask.owner;
    this.state.series.push(rule);
    this.save();
    await this.refreshSeries([rule]);
    return copySeries(rule);
  }

  async removeSeries(id: number): Promise<void> {
    const index = this.state.series.findIndex((r) => r.id === id);
    if (index < 0) throw new RecorderError('There is no such series', 404);
    this.state.series.splice(index, 1);
    for (const entry of this.state.recordings.filter((e) => e.seriesId === id && e.state === 'scheduled')) this.forget(entry);
    this.save();
  }

  async open(id: number, options: { range?: string; path?: string } = {}): Promise<MediaAnswer | null> {
    if (options?.path) return null;
    const entry = this.state.recordings.find((e) => e.id === id);
    const full = entry?.file ? insideDir(this.dir, entry.file) : null;
    if (!full) return null;
    let size: number;
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile()) return null;
      size = stat.size;
    } catch {
      return null;
    }
    const headers: Record<string, string> = { 'Content-Type': full.endsWith('.mp4') ? 'video/mp4' : 'video/mp2t', 'Accept-Ranges': 'bytes' };
    const range = byteRange(options?.range, size);
    if (range === 'unsatisfiable') return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } };
    if (!range) {
      const body = size ? fs.createReadStream(full, { start: 0, end: size - 1 }) : Readable.from([]);
      return { status: 200, headers: { ...headers, 'Content-Length': String(size) }, body };
    }
    return {
      status: 206,
      headers: { ...headers, 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` },
      body: fs.createReadStream(full, { start: range.start, end: range.end }),
    };
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const loop of this.loops) clearInterval(loop);
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      const running = [...this.captures.values()];
      for (const capture of running) capture.stop('close');
      await Promise.all(running.map((capture) => capture.done));
      this.save();
    }
    await this.settle();
  }

  /**
   * Looks at the guide for the next 48 hours and schedules what the series rules match (every rule,
   * or the ones given). Runs hourly and when a rule is added.
   */
  async refreshSeries(rules: SeriesEntry[] = this.state.series): Promise<void> {
    const now = this.deps.now();
    const until = now + GUIDE_AHEAD_MS;
    const everyChannel = new Map<string, ChannelRef[] | null>();
    let added = false;
    for (const rule of [...rules]) {
      if (this.closed) return;
      let channels: ChannelRef[] | null;
      if (rule.anyChannel) {
        const key = rule.owner ?? '';
        if (!everyChannel.has(key)) everyChannel.set(key, await this.channelList(rule.owner));
        channels = everyChannel.get(key) ?? null;
      } else {
        channels = rule.channel ? [rule.channel] : [];
      }
      for (const channel of channels ?? []) {
        let programmes: ProgrammeInfo[];
        try {
          programmes = await this.deps.programmes(channel, now, until, rule.owner);
        } catch (error) {
          logger.warn(`The guide for ${safeName(channel.name, 'a channel')} couldn't be read for the series "${safeName(rule.title)}" (${describe(error)})`);
          continue;
        }
        if (this.closed || !this.state.series.some((r) => r.id === rule.id)) break;
        for (const programme of Array.isArray(programmes) ? programmes : []) {
          if (this.matches(rule, programme) && this.scheduleFor(rule, channel, programme)) added = true;
        }
      }
    }
    if (added) {
      this.save();
      this.tick();
    }
  }

  /** With keepDays set, removes finished recordings whose window ended longer ago than that. */
  async sweep(): Promise<void> {
    if (!(this.settings.keepDays > 0)) return;
    const cutoff = this.deps.now() - this.settings.keepDays * DAY_MS;
    const old = this.state.recordings.filter((e) => (e.state === 'completed' || e.state === 'stopped' || e.state === 'interrupted') && e.end < cutoff);
    for (const entry of old) await this.discard(entry);
    if (old.length) {
      logger.info(`Removed ${old.length} recording(s) older than ${this.settings.keepDays} day(s)`);
      this.save();
    }
  }

  // ----- Inside -----

  private find(id: number): StoredRecording {
    const entry = this.state.recordings.find((e) => e.id === id);
    if (!entry) throw new RecorderError('There is no such recording', 404);
    return entry;
  }

  private paddedWindow(programme: ProgrammeInfo): { start: number; end: number } {
    return { start: programme.start - this.settings.preMinutes * 60_000, end: programme.end + this.settings.postMinutes * 60_000 };
  }

  private add(fields: { channel: ChannelRef; programme?: ProgrammeInfo; start: number; end: number; seriesId?: number; owner?: string }): StoredRecording {
    const entry: StoredRecording = { id: this.state.nextId++, channel: fields.channel, start: fields.start, end: fields.end, state: 'scheduled', playable: false, size: 0 };
    if (fields.programme) entry.programme = fields.programme;
    if (fields.seriesId !== undefined) entry.seriesId = fields.seriesId;
    if (fields.owner !== undefined) entry.owner = fields.owner;
    this.state.recordings.push(entry);
    return entry;
  }

  private async channelList(owner: string | undefined): Promise<ChannelRef[] | null> {
    try {
      const list = await this.deps.channels(owner);
      return Array.isArray(list) ? list.filter(isChannel) : [];
    } catch (error) {
      logger.warn(`The channel list couldn't be read for the series rules (${describe(error)})`);
      return null;
    }
  }

  private matches(rule: SeriesEntry, programme: ProgrammeInfo): boolean {
    if (!programme || typeof programme.title !== 'string' || !Number.isFinite(programme.start) || !Number.isFinite(programme.end)) return false;
    if (!sameTitle(programme.title, rule.title)) return false;
    return !rule.newOnly || programme.isNew === true;
  }

  /** Schedules a programme a rule matched, unless it's over or already recorded on that channel. */
  private scheduleFor(rule: SeriesEntry, channel: ChannelRef, programme: ProgrammeInfo): boolean {
    const now = this.deps.now();
    const { start, end } = this.paddedWindow(programme);
    if (end <= now) return false;
    if (this.state.recordings.some((e) => e.programme && sameChannel(e.channel, channel) && e.programme.start === programme.start)) return false;
    this.add({ channel: checkChannel(channel), programme: checkProgramme(programme), start: Math.max(start, now), end, seriesId: rule.id, owner: rule.owner });
    return true;
  }

  /** At start: what was missed or cut short while the server was down. Open windows resume on the first tick. */
  private recover(): void {
    const now = this.deps.now();
    let changed = false;
    for (const entry of this.state.recordings) {
      if (entry.end > now) continue;
      if (entry.state === 'scheduled') this.interrupt(entry, WASNT_RUNNING);
      else if (entry.state === 'recording') this.interrupt(entry, STOPPED_WHILE_RECORDING);
      else continue;
      changed = true;
    }
    if (changed) this.save();
  }

  /** Starts what's due, ends what's over, and sets the timers for what's next. */
  private tick(): void {
    if (this.closed) return;
    const now = this.deps.now();
    let changed = false;
    for (const capture of this.captures.values()) {
      if (!capture.stopping && capture.entry.end <= now) capture.stop('end');
    }
    const rank = (e: StoredRecording) => (e.state === 'recording' ? 0 : 1);
    const due = this.state.recordings
      .filter((e) => (e.state === 'scheduled' && e.start <= now) || (e.state === 'recording' && !this.captures.has(e.id)))
      .sort((a, b) => rank(a) - rank(b) || a.start - b.start || a.id - b.id);
    const most = Math.max(1, this.settings.maxAtOnce);
    for (const entry of due) {
      if (entry.end <= now) this.interrupt(entry, entry.state === 'recording' ? STOPPED_WHILE_RECORDING : WASNT_RUNNING);
      else if (this.running() >= most) {
        this.interrupt(entry, tooMany(most));
        logger.warn(`"${logName(entry)}" wasn't recorded: ${tooMany(most).toLowerCase()}`);
      } else this.begin(entry);
      changed = true;
    }
    this.arm(now);
    if (changed) this.save();
  }

  private running(): number {
    let count = 0;
    for (const capture of this.captures.values()) if (!capture.stopping) count++;
    return count;
  }

  /** One timer per upcoming recording at its start, and per running one at its end. */
  private arm(now: number): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.state.recordings) {
      const capture = this.captures.get(entry.id);
      const at = entry.state === 'scheduled' ? entry.start : capture && !capture.stopping ? entry.end : null;
      if (at === null) continue;
      const timer = setTimeout(() => this.tick(), Math.min(MAX_TIMER_MS, Math.max(0, at - now)));
      timer.unref();
      this.timers.set(entry.id, timer);
    }
  }

  private begin(entry: StoredRecording): void {
    entry.state = 'recording';
    delete entry.error;
    const capture = new Capture(entry, this.context);
    this.captures.set(entry.id, capture);
    logger.info(`Recording "${logName(entry)}" on ${safeName(entry.channel.name, 'a channel')}`);
    capture.done = capture
      .run()
      .catch((error) => logger.warn(`"${logName(entry)}": the recording failed (${describe(error)})`))
      .then(() => this.finish(capture));
  }

  private finish(capture: Capture): void {
    const entry = capture.entry;
    if (this.captures.get(entry.id) === capture) this.captures.delete(entry.id);
    const size = entry.size ?? 0;
    switch (capture.reason) {
      case 'remove':
        return;
      case 'close':
        break;
      case 'cancel':
        entry.state = 'stopped';
        logger.info(`"${logName(entry)}" was stopped`);
        break;
      case 'end':
        if (size > 0) {
          entry.state = 'completed';
          logger.info(`"${logName(entry)}" is recorded`);
        } else this.interrupt(entry, COULDNT_PLAY);
        break;
      default:
        this.interrupt(entry, size > 0 ? STOPPED_SENDING : COULDNT_PLAY);
    }
    if (entry.state === 'interrupted') logger.warn(`"${logName(entry)}" was cut short: ${entry.error}`);
    this.save();
  }

  private interrupt(entry: StoredRecording, error: string): void {
    entry.state = 'interrupted';
    entry.error = error;
    entry.playable = (entry.size ?? 0) > 0;
  }

  /** Off the list, without touching its file (a recording that never started has none). */
  private forget(entry: StoredRecording): void {
    const index = this.state.recordings.indexOf(entry);
    if (index >= 0) this.state.recordings.splice(index, 1);
    const timer = this.timers.get(entry.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(entry.id);
  }

  /** Off the list, its file deleted and the folders it leaves empty removed. */
  private async discard(entry: StoredRecording): Promise<void> {
    this.forget(entry);
    const full = entry.file ? insideDir(this.dir, entry.file) : null;
    if (!full) return;
    try {
      await fsp.rm(full, { force: true });
    } catch (error) {
      logger.warn(`"${logName(entry)}" couldn't be deleted (${describe(error)})`);
      return;
    }
    let folder = path.dirname(full);
    while (folder !== this.dir && insideDir(this.dir, folder)) {
      try {
        await fsp.rmdir(folder);
      } catch {
        break;
      }
      folder = path.dirname(folder);
    }
  }

  private async hourly(): Promise<void> {
    try {
      await this.refreshSeries();
    } catch (error) {
      logger.warn(`The series rules couldn't be looked at (${describe(error)})`);
    }
    try {
      await this.sweep();
    } catch (error) {
      logger.warn(`Old recordings couldn't be swept away (${describe(error)})`);
    }
  }

  // ----- Saving -----

  /** A recording's size is saved now and then while it grows. */
  private progress(): void {
    if (Date.now() - this.lastSavedAt >= this.timing.saveEveryMs) this.save();
  }

  /** Saves soon; saves asked for while one is being written are folded into the next. */
  private save(): void {
    this.dirty = true;
    this.lastSavedAt = Date.now();
    this.writing ??= this.flush();
  }

  private async flush(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        try {
          await this.writeState();
        } catch (error) {
          logger.warn(`The recordings list couldn't be saved (${describe(error)})`);
        }
      }
    } finally {
      this.writing = null;
    }
  }

  private async settle(): Promise<void> {
    while (this.writing) await this.writing;
  }

  /** Written to a temporary file and renamed over the list, so a crash never leaves half a list. */
  private async writeState(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, STATE_FILE);
    const temp = `${file}.tmp-${process.pid}-${++this.tempCount}`;
    try {
      await fsp.writeFile(temp, JSON.stringify(this.state, null, 2));
      await fsp.rename(temp, file);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
