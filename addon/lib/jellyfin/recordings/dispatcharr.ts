// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createHash } from 'crypto';
import { Readable } from 'stream';
import type { DispatcharrLive } from '../dispatcharr';
import { DispatcharrError } from '../dispatcharr/client';
import { CHANNEL_TYPE, ID_PREFIX, type DispatcharrChannel, type Lineup } from '../dispatcharr/lineup';
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

// The recordings list is read at most this often: a guide page asks for its marks, and a timer
// list for its rows, often together.
const LIST_MS = 5 * 1000;
const PADDING_MS = 5 * 60 * 1000;
// Media answers passed on to the player as Dispatcharr gives them.
const MEDIA_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'last-modified', 'etag'];
const PART = /^[A-Za-z0-9_.-]{1,80}$/;

const iso = (ms: number) => new Date(ms).toISOString();
const timeOf = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : NaN);
const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const numberOf = (value: unknown): number | undefined => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? n : undefined;
};

/** What Dispatcharr says of a recording cut short, in plain words. */
export function interruptedWords(reason: unknown): string {
  const why = textOf(reason);
  if (/^server_(shutdown|restarted)/.test(why)) return 'Dispatcharr restarted while it was recording';
  if (why === 'recording_deleted') return 'It was deleted while it recorded';
  if (why === 'hls_directory_removed') return 'Its files were removed while it recorded';
  if (why.startsWith('no_stream_data')) return "The channel couldn't be played (no stream, or no free connection)";
  if (why.startsWith('ffmpeg_outage_window_exhausted')) return 'The channel stopped sending';
  return 'It was cut short';
}

/** A series rule's id: the same for the same rule, since Dispatcharr keeps its rules without one. */
export function seriesIdOf(rule: { tvg_id?: unknown; title?: unknown; epg_source_id?: unknown }): number {
  const key = `${textOf(rule.tvg_id)}|${textOf(rule.title)}|${numberOf(rule.epg_source_id) ?? ''}`;
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 12), 16);
}

/** Whether a series rule would have set a recording of this programme (title and guide). */
function ruleSets(rule: any, program: any, channelId: number): boolean {
  const title = textOf(rule.title);
  if (!title || textOf(rule.title_mode || 'exact') !== 'exact') return false;
  if (textOf(program?.title).toLowerCase() !== title.toLowerCase()) return false;
  if (numberOf(rule.channel_id) !== undefined && numberOf(rule.channel_id) !== channelId) return false;
  const tvg = textOf(rule.tvg_id);
  return !tvg || tvg === textOf(program?.tvg_id);
}

/** Where a recording is, read the way Dispatcharr's own DVR page reads it. */
export function stateOf(row: any, now: number): RecordingState {
  const status = textOf(row?.custom_properties?.status);
  if (status === 'completed') return 'completed';
  if (status === 'stopped') return 'stopped';
  if (status === 'interrupted' || status === 'failed') return 'interrupted';
  if (status === 'recording') return 'recording';
  const start = timeOf(row?.start_time);
  const end = timeOf(row?.end_time);
  if (now < start) return 'scheduled';
  if (now < end) return 'recording';
  return 'interrupted';
}

/**
 * Recording with Dispatcharr's own DVR, through the same calls its web app makes: a programme is
 * set with its guide details and Dispatcharr pads it, a series is a series rule then evaluated,
 * a recording cancelled before it starts is deleted, one under way is stopped, and its file is
 * read from Dispatcharr with the range the player asks for. Its recordings, rules and files are
 * Dispatcharr's: what is set here shows in Dispatcharr, and what is set there shows here.
 */
export class DispatcharrRecorder implements Recorder {
  readonly kind = 'dispatcharr' as const;
  private rows: { at: number; rows: any[] } | null = null;
  private rowsLoading: Promise<any[]> | null = null;
  private pad: { at: number; pre: number; post: number } | null = null;
  private ruleRows: { at: number; rules: any[] } | null = null;

  constructor(private readonly live: DispatcharrLive, private readonly now: () => number = Date.now) {}

  canRecord(channel: Pick<ChannelRef, 'type' | 'id'>): boolean {
    return channel.type === CHANNEL_TYPE && channel.id.startsWith(ID_PREFIX) && /^\d+$/.test(channel.id.slice(ID_PREFIX.length));
  }

  async padding(): Promise<{ pre: number; post: number }> {
    if (this.pad && this.now() - this.pad.at < PADDING_MS) return { pre: this.pad.pre, post: this.pad.post };
    try {
      const settings = await this.live.client.list('/api/core/settings/');
      const dvr = settings.find((row) => row?.key === 'dvr_settings')?.value;
      const value = typeof dvr === 'string' ? JSON.parse(dvr) : dvr;
      this.pad = { at: this.now(), pre: (numberOf(value?.pre_offset_minutes) ?? 0) * 60, post: (numberOf(value?.post_offset_minutes) ?? 0) * 60 };
    } catch {
      // Dispatcharr's settings need a login that may read them; without it, no padding is shown.
      this.pad = { at: this.now(), pre: 0, post: 0 };
    }
    return { pre: this.pad.pre, post: this.pad.post };
  }

  private async readRows(fresh = false): Promise<any[]> {
    if (!fresh && this.rows && this.now() - this.rows.at < LIST_MS) return this.rows.rows;
    this.rowsLoading ??= this.live.client.list('/api/channels/recordings/')
      .then((rows) => {
        this.rows = { at: this.now(), rows };
        return rows;
      })
      .catch((error: any) => {
        throw this.refused(error, 'read');
      })
      .finally(() => (this.rowsLoading = null));
    return this.rowsLoading;
  }

  private forget(): void {
    this.rows = null;
    this.ruleRows = null;
  }

  private refused(error: any, doing: 'read' | 'record' | 'change'): Error {
    const status = error instanceof DispatcharrError ? error.status : undefined;
    if (status === 401 || status === 403) {
      return new RecorderError(doing === 'read' ? "Dispatcharr's login may not see its recordings" : "Dispatcharr's login may not record (it needs DVR access to manage recordings)", 403);
    }
    return error instanceof RecorderError ? error : new RecorderError(`Dispatcharr could not be reached for its recordings: ${error?.message || error}`, 502);
  }

  private channelRef(lineup: Lineup, id: number): ChannelRef | null {
    const channel = lineup.byMetaId.get(`${ID_PREFIX}${id}`);
    if (!channel) return null;
    return { type: CHANNEL_TYPE, id: channel.metaId, name: channel.name, ...(channel.number !== null ? { number: String(channel.number) } : {}) };
  }

  private entryOf(row: any, lineup: Lineup, rules: any[]): RecordingEntry | null {
    const id = numberOf(row?.id);
    const channelId = numberOf(row?.channel);
    if (id === undefined || channelId === undefined) return null;
    // Only the channels this server's Live TV shows (its groups, its XC login's channels).
    const channel = this.channelRef(lineup, channelId);
    const start = timeOf(row.start_time);
    const end = timeOf(row.end_time);
    if (!channel || !(start < end)) return null;
    const props = row.custom_properties && typeof row.custom_properties === 'object' ? row.custom_properties : {};
    const state = stateOf(row, this.now());
    const program = props.program && typeof props.program === 'object' ? props.program : null;
    const programme = programmeOf(program, props);
    const rule = program ? rules.find((r) => ruleSets(r, program, channelId)) : undefined;
    const size = numberOf(props.bytes_written);
    return {
      id,
      channel,
      ...(programme ? { programme } : {}),
      start,
      end,
      state,
      ...(rule ? { seriesId: seriesIdOf(rule) } : {}),
      playable: state !== 'scheduled' && (typeof props.file_url === 'string' || typeof props.output_file_url === 'string'),
      ...(size !== undefined ? { size } : {}),
      ...(state === 'interrupted' ? { error: props.interrupted_reason ? interruptedWords(props.interrupted_reason) : "It didn't record" } : {}),
    };
  }

  private async rules(): Promise<any[]> {
    if (this.ruleRows && this.now() - this.ruleRows.at < LIST_MS) return this.ruleRows.rules;
    try {
      const data = await this.live.client.get('/api/channels/series-rules/');
      const rules = Array.isArray(data?.rules) ? data.rules.filter((r: unknown) => r && typeof r === 'object') : [];
      this.ruleRows = { at: this.now(), rules };
      return rules;
    } catch (error: any) {
      throw this.refused(error, 'read');
    }
  }

  async list(): Promise<RecordingEntry[]> {
    const [rows, lineup, rules] = await Promise.all([this.readRows(), this.live.lineup(), this.rules().catch(() => [])]);
    return rows
      .map((row) => this.entryOf(row, lineup, rules))
      .filter((entry): entry is RecordingEntry => entry !== null)
      .sort((a, b) => a.start - b.start || a.id - b.id);
  }

  async get(id: number): Promise<RecordingEntry | null> {
    return (await this.list()).find((entry) => entry.id === id) ?? null;
  }

  private dispatcharrChannel(lineup: Lineup, channel: Pick<ChannelRef, 'type' | 'id'>): DispatcharrChannel {
    const found = this.canRecord(channel) ? lineup.byMetaId.get(channel.id) : undefined;
    if (!found) throw new RecorderError("This channel isn't one of Dispatcharr's channels here", 400);
    return found;
  }

  async record(ask: RecordAsk): Promise<RecordingEntry> {
    const lineup = await this.live.lineup();
    const channel = this.dispatcharrChannel(lineup, ask.channel);
    const programme = ask.programme;
    let body: any;
    if (programme) {
      // Set already (here, in Dispatcharr's web app, or by a series rule) and still to come or under
      // way: that one is the answer. One that failed, or is over, isn't: recorded afresh.
      const same = (await this.readRows(true)).find((row) => numberOf(row?.channel) === channel.id
        && timeOf(row?.custom_properties?.program?.start_time) === programme.start);
      if (same) {
        const entry = this.entryOf(same, lineup, await this.rules().catch(() => []));
        if (entry && (entry.state === 'scheduled' || entry.state === 'recording')) return entry;
      }
      const guide = await this.live.guide.guideOf(channel, lineup).catch(() => null);
      // The programme as Dispatcharr's guide gives it to its own Record button, with its own times
      // (Dispatcharr adds its padding and keeps these as the programme's).
      body = {
        channel: channel.id,
        start_time: iso(programme.start),
        end_time: iso(programme.end),
        custom_properties: {
          program: {
            tvg_id: guide?.tvgId ?? '',
            title: programme.title,
            sub_title: programme.episodeTitle ?? '',
            description: programme.overview ?? '',
            start_time: iso(programme.start),
            end_time: iso(programme.end),
            ...(programme.season !== undefined ? { season: programme.season } : {}),
            ...(programme.episode !== undefined ? { episode: programme.episode } : {}),
            ...(programme.isNew !== undefined ? { is_new: programme.isNew } : {}),
            ...(programme.live !== undefined ? { is_live: programme.live } : {}),
            ...(guide?.sourceId !== null && guide?.sourceId !== undefined ? { epg_source_id: guide.sourceId } : {}),
          },
        },
      };
    } else {
      const start = Number(ask.start);
      const end = Number(ask.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new RecorderError('A recording needs a start before its end', 400);
      // A window set by hand, as Dispatcharr's own form sets one: no programme, no padding.
      body = { channel: channel.id, start_time: iso(start), end_time: iso(end) };
    }
    let answer;
    try {
      answer = await this.live.client.request('/api/channels/recordings/', { method: 'POST', json: body });
    } catch (error: any) {
      throw this.refused(error, 'record');
    }
    if (answer.status === 401 || answer.status === 403) throw this.refused(new DispatcharrError('refused', answer.status), 'record');
    if (answer.status < 200 || answer.status >= 300) throw new RecorderError(`Dispatcharr turned the recording down: ${reasonOf(answer.text)}`, 400);
    this.forget();
    const made = parseJson(answer.text);
    const entry = made ? this.entryOf(made, lineup, await this.rules().catch(() => [])) : null;
    if (!entry) throw new RecorderError("Dispatcharr's answer to the recording couldn't be read", 502);
    return entry;
  }

  private async change(path: string, method: 'POST' | 'DELETE', json?: unknown): Promise<{ status: number; text: string }> {
    let answer;
    try {
      answer = await this.live.client.request(path, { method, ...(json !== undefined ? { json } : {}) });
    } catch (error: any) {
      throw this.refused(error, 'change');
    }
    if (answer.status === 401 || answer.status === 403) throw this.refused(new DispatcharrError('refused', answer.status), 'change');
    this.forget();
    return answer;
  }

  async cancel(id: number): Promise<void> {
    const entry = await this.get(id);
    if (!entry) throw new RecorderError('No such recording', 404);
    if (entry.state === 'scheduled') {
      const answer = await this.change(`/api/channels/recordings/${id}/`, 'DELETE');
      if (answer.status >= 300 && answer.status !== 404) throw new RecorderError(`Dispatcharr didn't take the recording off: ${reasonOf(answer.text)}`, 502);
    } else if (entry.state === 'recording') {
      // Stopped as Dispatcharr's own Stop does: what has been recorded is kept and finished.
      const answer = await this.change(`/api/channels/recordings/${id}/stop/`, 'POST');
      if (answer.status >= 300 && answer.status !== 409) throw new RecorderError(`Dispatcharr didn't stop the recording: ${reasonOf(answer.text)}`, 502);
    }
  }

  async remove(id: number): Promise<void> {
    const entry = await this.get(id);
    if (!entry) throw new RecorderError('No such recording', 404);
    // Dispatcharr's own Delete: the recording and its files.
    const answer = await this.change(`/api/channels/recordings/${id}/`, 'DELETE');
    if (answer.status >= 300 && answer.status !== 404) throw new RecorderError(`Dispatcharr didn't delete the recording: ${reasonOf(answer.text)}`, 502);
  }

  private seriesOf(rule: any, lineup: Lineup): SeriesEntry | null {
    const title = textOf(rule.title);
    if (!title) return null;
    const pinned = numberOf(rule.channel_id);
    const tvg = textOf(rule.tvg_id);
    let channel: ChannelRef | null = pinned !== undefined ? this.channelRef(lineup, pinned) : null;
    // A rule on a guide (tvg id) rather than a channel: the first channel showing that guide.
    if (!channel && tvg) {
      const known = this.live.guide.knownTvgIds();
      const shown = lineup.channels.find((c) => c.epgDataId !== null && known.get(c.epgDataId) === tvg);
      if (shown) channel = this.channelRef(lineup, shown.id);
    }
    return {
      id: seriesIdOf(rule),
      title,
      ...(channel ? { channel } : {}),
      anyChannel: !tvg && pinned === undefined,
      newOnly: textOf(rule.mode) === 'new',
    };
  }

  async series(): Promise<SeriesEntry[]> {
    const [rules, lineup] = await Promise.all([this.rules(), this.live.lineup()]);
    return rules.map((rule) => this.seriesOf(rule, lineup)).filter((entry): entry is SeriesEntry => entry !== null);
  }

  async addSeries(ask: SeriesAsk): Promise<SeriesEntry> {
    const lineup = await this.live.lineup();
    const channel = this.dispatcharrChannel(lineup, ask.channel);
    const guide = ask.anyChannel ? null : await this.live.guide.guideOf(channel, lineup).catch(() => null);
    // As Dispatcharr's own Record Series sends it: the programme's guide and title, then the rules
    // for that guide evaluated, which sets the recordings. On any channel, the title alone.
    const body: any = { tvg_id: guide?.tvgId ?? '', mode: ask.newOnly ? 'new' : 'all', title: ask.programme.title };
    if (!ask.anyChannel && !guide) body.channel_id = channel.id;
    if (guide?.sourceId !== null && guide?.sourceId !== undefined) body.epg_source_id = guide.sourceId;
    const answer = await this.change('/api/channels/series-rules/', 'POST', body);
    if (answer.status < 200 || answer.status >= 300) throw new RecorderError(`Dispatcharr turned the series down: ${reasonOf(answer.text)}`, 400);
    const evaluated = await this.change('/api/channels/series-rules/evaluate/', 'POST', body.tvg_id ? { tvg_id: body.tvg_id } : {});
    if (evaluated.status >= 300) throw new RecorderError(`Dispatcharr kept the series but didn't set its recordings: ${reasonOf(evaluated.text)}`, 502);
    const rules: any[] = parseJson(answer.text)?.rules ?? (await this.rules());
    const id = seriesIdOf(body);
    const rule = rules.find((r) => seriesIdOf(r) === id) ?? body;
    return this.seriesOf(rule, lineup) as SeriesEntry;
  }

  async removeSeries(id: number): Promise<void> {
    const rule = (await this.rules()).find((r) => seriesIdOf(r) === id);
    if (!rule) throw new RecorderError('No such series', 404);
    const query = new URLSearchParams({ tvg_id: textOf(rule.tvg_id), title: textOf(rule.title) });
    const source = numberOf(rule.epg_source_id);
    if (source !== undefined) query.set('epg_source_id', String(source));
    // Dispatcharr's own Delete: the rule, and its recordings that haven't started.
    const answer = await this.change(`/api/channels/series-rules/?${query}`, 'DELETE');
    if (answer.status >= 300 && answer.status !== 404) throw new RecorderError(`Dispatcharr didn't delete the series: ${reasonOf(answer.text)}`, 502);
  }

  async open(id: number, { range, path }: { range?: string; path?: string }): Promise<MediaAnswer | null> {
    if (path !== undefined) return this.openPart(id, path);
    const res = await this.live.client.open(`/api/channels/recordings/${id}/file/`, range ? { range } : {});
    const status = res.statusCode ?? 502;
    // Still recording: Dispatcharr points at the playlist that plays it as it grows.
    if (status >= 300 && status < 400) {
      res.resume();
      return /\/hls\//.test(String(res.headers.location ?? '')) ? { status: 302, headers: {}, redirect: 'hls/index.m3u8' } : null;
    }
    if (status === 404 || status === 403 || status === 401) {
      res.resume();
      return null;
    }
    return { status, headers: pickHeaders(res.headers), body: res };
  }

  private async openPart(id: number, path: string): Promise<MediaAnswer | null> {
    const name = path.replace(/^hls\//, '');
    if (!PART.test(name) || name.startsWith('.')) return null;
    const res = await this.live.client.open(`/api/channels/recordings/${id}/hls/${name}`);
    const status = res.statusCode ?? 502;
    if (status >= 300 && status < 400) {
      res.resume();
      // Finished meanwhile: the file plays instead.
      return /\/file\/?/.test(String(res.headers.location ?? '')) ? { status: 302, headers: {}, redirect: '' } : null;
    }
    if (status >= 400) {
      res.resume();
      return null;
    }
    if (!name.endsWith('.m3u8')) return { status, headers: pickHeaders(res.headers), body: res };
    // The playlist names its parts by Dispatcharr's own address; here they are read through this server.
    const text = await readText(res);
    const lines = text.split(/\r?\n/).map((line) => {
      if (!line || line.startsWith('#')) return line;
      const file = line.split('?')[0].split('/').pop() ?? '';
      return PART.test(file) ? file : '';
    });
    const body = lines.join('\n');
    return {
      status: 200,
      headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache', 'content-length': String(Buffer.byteLength(body)) },
      body: Readable.from([body]),
    };
  }

  async close(): Promise<void> {
    this.forget();
  }
}

function programmeOf(program: any, props: any): ProgrammeInfo | undefined {
  if (!program) return undefined;
  const title = textOf(program.title);
  const start = timeOf(program.start_time);
  const end = timeOf(program.end_time);
  if (!title || !(start < end)) return undefined;
  const season = numberOf(program.season ?? props.season);
  const episode = numberOf(program.episode ?? props.episode);
  return {
    title,
    start,
    end,
    ...(textOf(program.sub_title) ? { episodeTitle: textOf(program.sub_title) } : {}),
    ...(textOf(program.description) ? { overview: textOf(program.description) } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(episode !== undefined ? { episode } : {}),
    ...(typeof program.is_new === 'boolean' ? { isNew: program.is_new } : {}),
    ...(typeof program.is_live === 'boolean' ? { live: program.is_live } : {}),
  };
}

function pickHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of MEDIA_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

function readText(res: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      // A playlist of a very long recording is still small; past this it isn't one.
      if (total > 8 * 1024 * 1024) res.destroy(new Error('the playlist is too large'));
      else chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Dispatcharr's own words for a refusal (`{"error": …}` or a field's errors), short. */
function reasonOf(text: string): string {
  const data = parseJson(text);
  const said = data?.error ?? data?.detail ?? (data && typeof data === 'object' ? Object.values(data).flat().find((v) => typeof v === 'string') : undefined);
  return typeof said === 'string' && said.trim() ? said.trim().slice(0, 200) : 'no reason given';
}
