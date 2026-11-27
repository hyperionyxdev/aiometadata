// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createHash } from 'crypto';
import consola from 'consola';
import { Readable } from 'stream';
import { profileUserId } from '../profiles';
import { configurationOf, recordingOwners, type OwnedKind } from './owners';
import { DAY_NAMES } from './repeats';
import { RecorderError, type ChannelRef, type MediaAnswer, type ProgrammeInfo, type Recorder, type RecordingEntry, type SeriesEntry, type SlotEntry } from './types';

const logger = consola.withTag('JellyfinRecordings');

const TICKS_PER_SECOND = 10_000_000;
// Ids of timers and recordings (one id for both), of series and of repeating schedules: two hex
// marks, a kind, then the recorder's own number, 32 hex digits in all like every other id here.
const MARK = 'd5';
const TIMER_KIND = '1';
const SERIES_KIND = '2';
const SLOT_KIND = '3';
const ID_DIGITS = 29;

const plain = (raw: unknown): string => String(raw ?? '').replace(/-/g, '').toLowerCase();

export function timerIdOf(id: number): string {
  return `${MARK}${TIMER_KIND}${id.toString(16).padStart(ID_DIGITS, '0')}`;
}

export function seriesTimerIdOf(id: number): string {
  return `${MARK}${SERIES_KIND}${id.toString(16).padStart(ID_DIGITS, '0')}`;
}

/** A repeating schedule's id: a series timer's to a client, of its own kind. */
export function slotIdOf(id: number): string {
  return `${MARK}${SLOT_KIND}${id.toString(16).padStart(ID_DIGITS, '0')}`;
}

function numberIn(raw: unknown, kind: string): number | null {
  const id = plain(raw);
  if (id.length !== 32 || !id.startsWith(MARK + kind) || !/^[0-9a-f]+$/.test(id)) return null;
  const n = parseInt(id.slice(3), 16);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The recorder's number for a timer's or recording's id, or null for any other id. */
export const recordingNumberOf = (raw: unknown): number | null => numberIn(raw, TIMER_KIND);
export const seriesNumberOf = (raw: unknown): number | null => numberIn(raw, SERIES_KIND);
export const slotNumberOf = (raw: unknown): number | null => numberIn(raw, SLOT_KIND);

/** The series timer that set a recording, a series or a repeating schedule, as its id; none for one set alone. */
function seriesTimerOf(entry: RecordingEntry): string | undefined {
  if (entry.seriesId !== undefined) return seriesTimerIdOf(entry.seriesId);
  return entry.slotId !== undefined ? slotIdOf(entry.slotId) : undefined;
}

export interface RecordingRouteDeps {
  /** The recorder for this request's configuration and profile, or null when it may not record. */
  recorderFor(req: any): Promise<Recorder | null>;
  /** A guide programme by its item id: its channel and what the guide says of it. */
  programmeOf(req: any, programId: string): Promise<{ channel: ChannelRef; programme: ProgrammeInfo } | null>;
  /** A channel by its item id. */
  channelOf(req: any, channelId: string): Promise<ChannelRef | null>;
  channelItemId(channel: Pick<ChannelRef, 'type' | 'id'>): string;
  programmeItemId(channel: Pick<ChannelRef, 'type' | 'id'>, start: number): string | null;
  serverIdFor(userUUID: string): string;
  itemList(items: any[], total: number, startIndex: number): any;
  emptyUserData: Record<string, unknown>;
}

const userOf = (req: any): string => req.jellyfin?.userUUID ?? req.params?.userUUID;
/** Who sets a recording: the configuration, and its profile where it's one of its others. */
const ownerOf = (req: any): string => (req.jellyfin?.profileId ? `${userOf(req)}/${req.jellyfin.profileId}` : userOf(req));
const iso = (ms: number) => new Date(ms).toISOString();
const field = (req: any, name: string): unknown => {
  const lower = name.toLowerCase();
  for (const source of [req.query ?? {}, req.body ?? {}]) {
    for (const key of Object.keys(source)) if (key.toLowerCase() === lower) return source[key];
  }
  return undefined;
};
const flag = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value).toLowerCase() === 'true';
};

/** The caller is its configuration's main profile: it manages its household's recordings. */
const isMain = (req: any): boolean => !req.jellyfin?.profileId;

/** Who set a recording: those who asked for it, and those of the series or repeating schedule that set it. */
function ownersOfRecording(recorder: Recorder, entry: RecordingEntry): string[] {
  const store = recordingOwners();
  const own = store.owners('recording', recorder.kind, entry.id);
  const bySeries = entry.seriesId !== undefined ? store.owners('series', recorder.kind, entry.seriesId) : [];
  const bySlot = entry.slotId !== undefined ? store.owners('slot', recorder.kind, entry.slotId) : [];
  return [...new Set([...own, ...bySeries, ...bySlot])];
}

/**
 * Whether the caller may stop, cancel or delete one for everyone: who set it, alone, or the main
 * profile of the household that set it (any main profile, for one with no owner: the household's).
 */
function managesAll(req: any, owners: string[]): boolean {
  if (owners.length === 1 && owners[0] === ownerOf(req)) return true;
  return isMain(req) && owners.every((owner) => configurationOf(owner) === userOf(req));
}

/**
 * Who set it, as a client reads it: their Jellyfin user ids (for their pictures), whether the
 * caller is one of them (its own recordings), and whether it may act on it for everyone.
 */
function ownershipOf(req: any, owners: string[]): { owners: string[]; mine: boolean; manage: boolean } {
  return {
    owners: owners.map((owner) => {
      const [uuid, profile] = owner.split('/');
      return profileUserId(uuid, profile || null);
    }),
    mine: owners.includes(ownerOf(req)),
    manage: managesAll(req, owners),
  };
}

/**
 * Given up by the caller: only it let go where others want it too (one of its owners), else
 * stopped, cancelled or deleted for everyone where the caller may (who set it alone, or its
 * household's main profile; among other owners, the main profile only when it asks ForEveryone).
 * Says whether it was let go or acted on.
 */
async function giveUp(req: any, recorder: Recorder, entry: RecordingEntry, how: 'cancel' | 'remove'): Promise<'left' | 'done'> {
  const store = recordingOwners();
  const owners = ownersOfRecording(recorder, entry);
  const me = ownerOf(req);
  const mine = owners.includes(me);
  const others = owners.some((owner) => owner !== me);
  if (mine && others && flag(field(req, 'ForEveryone')) !== true) {
    store.remove('recording', recorder.kind, entry.id, me);
    if (ownersOfRecording(recorder, entry).includes(me)) throw new RecorderError('A series you share sets it: cancel the series to stop it', 409);
    return 'left';
  }
  if (!managesAll(req, owners)) {
    throw new RecorderError(owners.length ? 'Only who set it, or the main profile, can do that' : 'Only the main profile can do that', 403);
  }
  if (how === 'cancel') await recorder.cancel(entry.id);
  else await recorder.remove(entry.id);
  // Taken off before it started, or deleted: so is who set it. Stopped, it's kept, and still theirs.
  if (how === 'remove' || entry.state === 'scheduled') store.forget('recording', recorder.kind, entry.id);
  return 'done';
}

/** Jellyfin's word for where a timer or recording is. */
function statusOf(entry: RecordingEntry): string {
  switch (entry.state) {
    case 'scheduled': return 'New';
    case 'recording': return 'InProgress';
    case 'completed':
    case 'stopped': return 'Completed';
    default: return 'Error';
  }
}

function serviceName(recorder: Recorder): string {
  return recorder.kind === 'dispatcharr' ? 'Dispatcharr' : 'AIOMetadata';
}

/** What a client reads beyond Jellyfin's own fields: why one failed, how much is recorded, which recorder. */
function extrasOf(recorder: Recorder, entry: RecordingEntry): any {
  return {
    recorder: recorder.kind,
    state: entry.state,
    playable: entry.playable,
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function nameOf(entry: RecordingEntry): string {
  return entry.programme?.title ?? `${entry.channel.name} ${new Date(entry.start).toLocaleString('en-GB', { timeZone: 'UTC' })}`;
}

function timerDto(deps: RecordingRouteDeps, req: any, recorder: Recorder, entry: RecordingEntry): any {
  const channelId = deps.channelItemId(entry.channel);
  const programme = entry.programme;
  // A programme's own times, with the padding apart, as Jellyfin's timers give them.
  const start = programme?.start ?? entry.start;
  const end = programme?.end ?? entry.end;
  const programId = programme ? deps.programmeItemId(entry.channel, programme.start) : null;
  const dto: any = {
    Id: timerIdOf(entry.id),
    Type: 'Timer',
    ServerId: deps.serverIdFor(userOf(req)),
    ExternalId: String(entry.id),
    ChannelId: channelId,
    ExternalChannelId: entry.channel.id,
    ChannelName: entry.channel.name,
    Name: nameOf(entry),
    StartDate: iso(start),
    EndDate: iso(end),
    ServiceName: serviceName(recorder),
    Priority: 0,
    PrePaddingSeconds: Math.max(0, Math.round((start - entry.start) / 1000)),
    PostPaddingSeconds: Math.max(0, Math.round((entry.end - end) / 1000)),
    IsPrePaddingRequired: false,
    IsPostPaddingRequired: false,
    KeepUntil: 'UntilDeleted',
    Status: statusOf(entry),
    RunTimeTicks: Math.round(((end - start) / 1000) * TICKS_PER_SECOND),
    aiostreams: { ...extrasOf(recorder, entry), ...ownershipOf(req, ownersOfRecording(recorder, entry)) },
  };
  if (programId) {
    dto.ProgramId = programId;
    dto.ExternalProgramId = programId;
  }
  if (programme?.overview) dto.Overview = programme.overview;
  const seriesTimer = seriesTimerOf(entry);
  if (seriesTimer) dto.SeriesTimerId = seriesTimer;
  return dto;
}

function seriesDto(deps: RecordingRouteDeps, req: any, recorder: Recorder, rule: SeriesEntry, padding: { pre: number; post: number }): any {
  const dto: any = {
    Id: seriesTimerIdOf(rule.id),
    Type: 'SeriesTimer',
    ServerId: deps.serverIdFor(userOf(req)),
    ExternalId: String(rule.id),
    Name: rule.title,
    ServiceName: serviceName(recorder),
    Priority: 0,
    PrePaddingSeconds: padding.pre,
    PostPaddingSeconds: padding.post,
    IsPrePaddingRequired: false,
    IsPostPaddingRequired: false,
    KeepUntil: 'UntilDeleted',
    RecordAnyTime: true,
    RecordAnyChannel: rule.anyChannel,
    RecordNewOnly: rule.newOnly,
    SkipEpisodesInLibrary: false,
    KeepUpTo: 0,
    Days: [],
    DayPattern: 'Daily',
    ImageTags: {},
    aiostreams: ownershipOf(req, recordingOwners().owners('series', recorder.kind, rule.id)),
  };
  if (rule.channel) {
    dto.ChannelId = deps.channelItemId(rule.channel);
    dto.ExternalChannelId = rule.channel.id;
    dto.ChannelName = rule.channel.name;
  }
  return dto;
}

/** Jellyfin's word for a set of weekdays (0 for Monday), where there is one. */
function dayPatternOf(days: number[]): 'Daily' | 'Weekdays' | 'Weekends' | undefined {
  const set = [...new Set(days)].sort((a, b) => a - b).join(',');
  if (set === '0,1,2,3,4,5,6') return 'Daily';
  if (set === '0,1,2,3,4') return 'Weekdays';
  return set === '5,6' ? 'Weekends' : undefined;
}

/**
 * A repeating schedule as a series timer: its weekdays and the next time it records (the last, once
 * none is left), with its days, times and dates as the recorder keeps them, in its time zone.
 */
function slotDto(deps: RecordingRouteDeps, req: any, recorder: Recorder, slot: SlotEntry): any {
  const shown = slot.next ?? slot.last;
  const dto: any = {
    Id: slotIdOf(slot.id),
    Type: 'SeriesTimer',
    ServerId: deps.serverIdFor(userOf(req)),
    ExternalId: String(slot.id),
    Name: slot.name,
    ServiceName: serviceName(recorder),
    ChannelId: deps.channelItemId(slot.channel),
    ExternalChannelId: slot.channel.id,
    ChannelName: slot.channel.name,
    Priority: 0,
    PrePaddingSeconds: 0,
    PostPaddingSeconds: 0,
    IsPrePaddingRequired: false,
    IsPostPaddingRequired: false,
    KeepUntil: 'UntilDeleted',
    RecordAnyTime: false,
    RecordAnyChannel: false,
    RecordNewOnly: false,
    SkipEpisodesInLibrary: false,
    KeepUpTo: 0,
    Days: slot.days.map((day) => DAY_NAMES[day]),
    ImageTags: {},
    aiostreams: {
      ...ownershipOf(req, recordingOwners().owners('slot', recorder.kind, slot.id)),
      repeats: {
        days: slot.days,
        start: slot.start.slice(0, 5),
        end: slot.end.slice(0, 5),
        from: slot.from,
        until: slot.until,
        timeZone: slot.timeZone,
        next: slot.next ? iso(slot.next.start) : null,
        nextEnd: slot.next ? iso(slot.next.end) : null,
      },
    },
  };
  const pattern = dayPatternOf(slot.days);
  if (pattern) dto.DayPattern = pattern;
  if (shown) {
    dto.StartDate = iso(shown.start);
    dto.EndDate = iso(shown.end);
  }
  return dto;
}

/** Weekdays as a client names them (Jellyfin's `Days`: "Monday" to "Sunday"), 0 for Monday; refused where one isn't a day. */
function daysOf(raw: unknown): number[] {
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? raw.split(',') : [];
  return list.map((value) => {
    const name = String(value ?? '').trim().toLowerCase();
    const day = DAY_NAMES.findIndex((known) => known.toLowerCase() === name);
    if (day < 0) throw new RecorderError(`"${String(value ?? '').trim().slice(0, 40)}" isn't a day of the week`);
    return day;
  });
}

/** The recorder's repeating schedules, none where it makes none or they can't be read (its title series still list). */
async function slotsOf(recorder: Recorder): Promise<SlotEntry[]> {
  if (!recorder.slots) return [];
  return recorder.slots().catch((error: any) => {
    logger.debug(`Repeating recordings couldn't be listed: ${error?.message || error}`);
    return [];
  });
}

function recordingDto(deps: RecordingRouteDeps, req: any, recorder: Recorder, entry: RecordingEntry): any {
  const id = timerIdOf(entry.id);
  const programme = entry.programme;
  const seconds = (entry.end - entry.start) / 1000;
  const item: any = {
    Name: nameOf(entry),
    ServerId: deps.serverIdFor(userOf(req)),
    Id: id,
    Type: 'Recording',
    MediaType: 'Video',
    IsFolder: false,
    LocationType: 'FileSystem',
    ChannelId: deps.channelItemId(entry.channel),
    ChannelName: entry.channel.name,
    StartDate: iso(entry.start),
    EndDate: iso(entry.end),
    DateCreated: iso(entry.start),
    PremiereDate: iso(programme?.start ?? entry.start),
    RunTimeTicks: Math.round(seconds * TICKS_PER_SECOND),
    Status: statusOf(entry),
    TimerId: id,
    CanDelete: true,
    CanDownload: false,
    ImageTags: {},
    BackdropImageTags: [],
    UserData: { ...deps.emptyUserData, Key: id, ItemId: id },
    MediaSources: entry.playable ? [mediaSourceOf(recorder, entry)] : [],
    aiostreams: { ...extrasOf(recorder, entry), ...ownershipOf(req, ownersOfRecording(recorder, entry)) },
  };
  if (entry.channel.number) item.ChannelNumber = entry.channel.number;
  const seriesTimer = seriesTimerOf(entry);
  if (seriesTimer) item.SeriesTimerId = seriesTimer;
  if (programme) {
    if (programme.overview) item.Overview = programme.overview;
    if (programme.episodeTitle) item.EpisodeTitle = programme.episodeTitle;
    if (programme.season !== undefined) item.ParentIndexNumber = programme.season;
    if (programme.episode !== undefined) item.IndexNumber = programme.episode;
    if (programme.genres) item.Genres = programme.genres;
    const programId = deps.programmeItemId(entry.channel, programme.start);
    if (programId) item.ProgramId = programId;
  }
  return item;
}

/** The recording as a version to play: read through this server, from its start, with seeking. */
function mediaSourceOf(recorder: Recorder, entry: RecordingEntry): any {
  const id = timerIdOf(entry.id);
  const container = recorder.kind === 'dispatcharr' && entry.state !== 'recording' ? 'mkv' : 'ts';
  return {
    Protocol: 'File',
    Id: id,
    Path: `${nameOf(entry)}.${container}`,
    Type: 'Default',
    Container: container,
    Name: nameOf(entry),
    IsRemote: false,
    ETag: id,
    RunTimeTicks: Math.round(((entry.end - entry.start) / 1000) * TICKS_PER_SECOND),
    ...(entry.size !== undefined ? { Size: entry.size } : {}),
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    // Still recording, it grows: a player reads to where it has got to.
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: true,
    VideoType: 'VideoFile',
    MediaStreams: [],
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    HasSegments: false,
    aiostreams: { recording: true, inProgress: entry.state === 'recording' },
  };
}

function sendError(res: any, error: any): void {
  if (error instanceof RecorderError) {
    res.status(error.status).json({ Message: error.message });
    return;
  }
  logger.warn(`A recording request failed: ${error?.message || error}`);
  res.status(500).json({ Message: 'The recording could not be reached' });
}

/** Sends a recording's bytes, ending the read from the recorder if the player goes away. */
export function sendMedia(res: any, answer: MediaAnswer): void {
  res.status(answer.status);
  for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
  if (!answer.body) {
    res.end();
    return;
  }
  const body = answer.body;
  res.on('close', () => body.destroy());
  body.on('error', (error: any) => {
    logger.debug(`A recording stopped being sent: ${error?.message || error}`);
    if (!res.headersSent) res.status(502);
    res.end();
  });
  body.pipe(res);
}

/** The text of a playlist answer, with this request's token after each part so a player may read them. */
async function withToken(answer: MediaAnswer, token: string | undefined): Promise<MediaAnswer> {
  if (!answer.body || !/mpegurl/i.test(answer.headers['content-type'] ?? '') || !token) return answer;
  const chunks: Buffer[] = [];
  for await (const chunk of answer.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8')
    .split('\n')
    .map((line) => (line && !line.startsWith('#') ? `${line}?api_key=${encodeURIComponent(token)}` : line))
    .join('\n');
  return { ...answer, headers: { ...answer.headers, 'content-length': String(Buffer.byteLength(text)) }, body: Readable.from([text]) };
}

/** Whether a guide programme item is set to record, and by which timer or series. */
interface Marks {
  timers: Map<string, number>;
  series: SeriesEntry[];
}

async function marksOf(deps: RecordingRouteDeps, recorder: Recorder): Promise<Marks> {
  const [entries, series] = await Promise.all([recorder.list(), recorder.series().catch(() => [] as SeriesEntry[])]);
  const timers = new Map<string, number>();
  for (const entry of entries) {
    if (entry.programme && (entry.state === 'scheduled' || entry.state === 'recording')) {
      timers.set(`${plain(deps.channelItemId(entry.channel))}|${entry.programme.start}`, entry.id);
    }
  }
  return { timers, series };
}

function mark(deps: RecordingRouteDeps, item: any, marks: Marks): void {
  const channelId = plain(item.ChannelId);
  const start = Date.parse(item.StartDate);
  const timer = marks.timers.get(`${channelId}|${start}`);
  if (timer !== undefined) item.TimerId = timerIdOf(timer);
  const title = String(item.Name ?? '').trim().toLowerCase();
  const rule = marks.series.find((s) => s.title.trim().toLowerCase() === title && (s.anyChannel || (s.channel && plain(deps.channelItemId(s.channel)) === channelId)));
  if (rule) {
    item.SeriesTimerId = seriesTimerIdOf(rule.id);
    // Jellyfin's own word for a programme that is part of a series set to record.
    item.IsSeries = item.IsSeries ?? true;
  }
}

/** Every guide programme in an answer, in a list or as a channel's current one. */
function programmesIn(body: any): any[] {
  const found: any[] = [];
  const visit = (item: any) => {
    if (!item || typeof item !== 'object') return;
    if (item.Type === 'Program' && item.ChannelId && item.StartDate) found.push(item);
    if (item.CurrentProgram) visit(item.CurrentProgram);
  };
  if (Array.isArray(body?.Items)) body.Items.forEach(visit);
  else if (Array.isArray(body)) body.forEach(visit);
  else visit(body);
  return found;
}

/**
 * Jellyfin's recording surface over the recorder: timers (one programme or a window), series
 * timers (a programme's title, or a repeating schedule where the recorder makes them), recordings
 * and their playback, and marks on guide programmes set to record. Ids that aren't a recording's
 * pass on to the routes after these.
 */
export function registerRecordings(router: any, deps: RecordingRouteDeps): void {
  const withRecorder = (handler: (req: any, res: any, recorder: Recorder) => Promise<void>) => async (req: any, res: any, next: any) => {
    try {
      const recorder = await deps.recorderFor(req);
      if (!recorder) {
        next();
        return;
      }
      await handler(req, res, recorder);
    } catch (error) {
      sendError(res, error);
    }
  };

  // Programmes in any answer get their marks: a timer, a series.
  router.use(async (req: any, res: any, next: any) => {
    // The guide is also asked for with a POST (/LiveTv/Programs with its filters in the body).
    const reads = req.method === 'GET' || (req.method === 'POST' && /\/livetv\/programs\/?$/i.test(req.path));
    if (!reads || !/livetv|items|channels|programs/i.test(req.path)) {
      next();
      return;
    }
    const json = res.json.bind(res);
    res.json = (body: any) => {
      const programmes = res.statusCode < 300 ? programmesIn(body) : [];
      if (!programmes.length) return json(body);
      deps.recorderFor(req)
        .then(async (recorder) => {
          if (!recorder) return;
          const marks = await marksOf(deps, recorder);
          for (const item of programmes) mark(deps, item, marks);
        })
        .catch((error: any) => logger.debug(`Programmes went out without their recording marks: ${error?.message || error}`))
        .finally(() => json(body));
      return res;
    };
    next();
  });

  // Asked with a programme, its details for its record form; without one (a channel's form for a
  // window or a repeating schedule), the padding alone. Either way, whether the recorder repeats.
  router.get('/LiveTv/Timers/Defaults', withRecorder(async (req, res, recorder) => {
    const padding = await recorder.padding();
    const programId = field(req, 'ProgramId');
    const found = programId ? await deps.programmeOf(req, String(programId)) : null;
    const extras: any = { repeats: typeof recorder.addSlot === 'function' };
    const channelId = field(req, 'ChannelId');
    if (found) extras.canRecord = recorder.canRecord(found.channel);
    else if (!programId && channelId) {
      const channel = await deps.channelOf(req, String(channelId)).catch((): ChannelRef | null => null);
      if (channel) extras.canRecord = recorder.canRecord(channel);
    }
    const dto: any = {
      Type: 'SeriesTimer',
      ServerId: deps.serverIdFor(userOf(req)),
      ServiceName: serviceName(recorder),
      Priority: 0,
      PrePaddingSeconds: padding.pre,
      PostPaddingSeconds: padding.post,
      IsPrePaddingRequired: false,
      IsPostPaddingRequired: false,
      KeepUntil: 'UntilDeleted',
      RecordAnyTime: true,
      RecordAnyChannel: false,
      RecordNewOnly: false,
      SkipEpisodesInLibrary: false,
      KeepUpTo: 0,
      Days: [],
      DayPattern: 'Daily',
      ImageTags: {},
      aiostreams: extras,
    };
    if (found) {
      Object.assign(dto, {
        ProgramId: String(programId),
        ChannelId: deps.channelItemId(found.channel),
        ChannelName: found.channel.name,
        Name: found.programme.title,
        StartDate: iso(found.programme.start),
        EndDate: iso(found.programme.end),
      });
    }
    res.json(dto);
  }));

  router.get('/LiveTv/Timers', withRecorder(async (req, res, recorder) => {
    const channelId = field(req, 'ChannelId');
    const seriesId = field(req, 'SeriesTimerId');
    const isActive = flag(field(req, 'IsActive'));
    const isScheduled = flag(field(req, 'IsScheduled'));
    const entries = (await recorder.list()).filter((entry) => {
      if (entry.state !== 'scheduled' && entry.state !== 'recording') return false;
      if (isActive !== undefined && (entry.state === 'recording') !== isActive) return false;
      if (isScheduled !== undefined && (entry.state === 'scheduled') !== isScheduled) return false;
      if (channelId && plain(deps.channelItemId(entry.channel)) !== plain(channelId)) return false;
      if (seriesId && seriesTimerOf(entry) !== plain(seriesId)) return false;
      return true;
    });
    const items = entries.map((entry) => timerDto(deps, req, recorder, entry));
    res.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
  }));

  router.post('/LiveTv/Timers', withRecorder(async (req, res, recorder) => {
    const programId = field(req, 'ProgramId');
    let entry: RecordingEntry;
    if (programId) {
      const found = await deps.programmeOf(req, String(programId));
      if (!found) throw new RecorderError('No such programme in the guide', 404);
      if (!recorder.canRecord(found.channel)) throw new RecorderError("This channel can't be recorded here", 400);
      entry = await recorder.record({ channel: found.channel, programme: found.programme, owner: ownerOf(req) });
    } else {
      const channel = await deps.channelOf(req, String(field(req, 'ChannelId') ?? ''));
      if (!channel) throw new RecorderError('No such channel', 404);
      if (!recorder.canRecord(channel)) throw new RecorderError("This channel can't be recorded here", 400);
      const start = Date.parse(String(field(req, 'StartDate') ?? ''));
      const end = Date.parse(String(field(req, 'EndDate') ?? ''));
      // A window may be named, for the recorder to keep where it can.
      const name = String(field(req, 'Name') ?? '').trim();
      entry = await recorder.record({ channel, start, end, ...(name ? { name } : {}), owner: ownerOf(req) });
    }
    // Whoever asks is one of its owners, the one set by someone else for the same programme too.
    recordingOwners().add('recording', recorder.kind, entry.id, ownerOf(req));
    logger.info(`A recording was set on ${recorder.kind === 'dispatcharr' ? "Dispatcharr's DVR" : 'this server'}`);
    // Jellyfin answers with nothing; the timer goes along for a client that reads it.
    res.status(200).json(timerDto(deps, req, recorder, entry));
  }));

  router.get('/LiveTv/Timers/:timerId', withRecorder(async (req, res, recorder) => {
    const id = recordingNumberOf(req.params.timerId);
    const entry = id ? await recorder.get(id) : null;
    if (!entry) throw new RecorderError('No such timer', 404);
    res.json(timerDto(deps, req, recorder, entry));
  }));

  // A timer's padding can't be changed on its own (Dispatcharr's padding is one for all).
  router.post('/LiveTv/Timers/:timerId', withRecorder(async (_req, res) => {
    res.status(204).end();
  }));

  router.delete('/LiveTv/Timers/:timerId', withRecorder(async (req, res, recorder) => {
    const id = recordingNumberOf(req.params.timerId);
    const entry = id ? await recorder.get(id) : null;
    if (!entry) throw new RecorderError('No such timer', 404);
    await giveUp(req, recorder, entry, 'cancel');
    res.status(204).end();
  }));

  // Series by title first, then repeating schedules.
  router.get('/LiveTv/SeriesTimers', withRecorder(async (req, res, recorder) => {
    const [rules, padding, slots] = await Promise.all([recorder.series(), recorder.padding(), slotsOf(recorder)]);
    const items = [...rules.map((rule) => seriesDto(deps, req, recorder, rule, padding)), ...slots.map((slot) => slotDto(deps, req, recorder, slot))];
    res.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
  }));

  /**
   * A repeating schedule: a channel's window (the first time it records) on weekdays, until a last
   * day, the weekdays and day in the asker's time zone. Only a recorder that repeats makes one.
   */
  const addSlot = async (req: any, res: any, recorder: Recorder, channelId: string) => {
    if (!recorder.addSlot) throw new RecorderError("Repeating recordings need Dispatcharr's DVR", 400);
    const channel = await deps.channelOf(req, channelId);
    if (!channel) throw new RecorderError('No such channel', 404);
    if (!recorder.canRecord(channel)) throw new RecorderError("This channel can't be recorded here", 400);
    const zone = String(field(req, 'TimeZone') ?? '').trim();
    const until = String(field(req, 'RepeatUntil') ?? '').trim();
    const slot = await recorder.addSlot({
      channel,
      name: String(field(req, 'Name') ?? '').trim(),
      start: Date.parse(String(field(req, 'StartDate') ?? '')),
      end: Date.parse(String(field(req, 'EndDate') ?? '')),
      days: daysOf(field(req, 'Days')),
      ...(zone ? { timeZone: zone } : {}),
      ...(until ? { until } : {}),
      owner: ownerOf(req),
    });
    recordingOwners().add('slot', recorder.kind, slot.id, ownerOf(req));
    logger.info("A repeating recording was set on Dispatcharr's DVR");
    res.status(200).json(slotDto(deps, req, recorder, slot));
  };

  router.post('/LiveTv/SeriesTimers', withRecorder(async (req, res, recorder) => {
    const programId = field(req, 'ProgramId');
    const channelId = field(req, 'ChannelId');
    if (!programId && channelId) {
      await addSlot(req, res, recorder, String(channelId));
      return;
    }
    const found = programId ? await deps.programmeOf(req, String(programId)) : null;
    if (!found) throw new RecorderError('A series is set from one of its programmes in the guide', 400);
    if (!recorder.canRecord(found.channel)) throw new RecorderError("This channel can't be recorded here", 400);
    const rule = await recorder.addSeries({
      channel: found.channel,
      programme: found.programme,
      anyChannel: flag(field(req, 'RecordAnyChannel')) === true,
      newOnly: flag(field(req, 'RecordNewOnly')) === true,
      owner: ownerOf(req),
    });
    recordingOwners().add('series', recorder.kind, rule.id, ownerOf(req));
    logger.info(`A series was set to record on ${recorder.kind === 'dispatcharr' ? "Dispatcharr's DVR" : 'this server'}`);
    res.status(200).json(seriesDto(deps, req, recorder, rule, await recorder.padding()));
  }));

  router.get('/LiveTv/SeriesTimers/:timerId', withRecorder(async (req, res, recorder) => {
    const slotId = slotNumberOf(req.params.timerId);
    if (slotId) {
      const slot = recorder.slots ? (await recorder.slots()).find((s) => s.id === slotId) : undefined;
      if (!slot) throw new RecorderError('No such series', 404);
      res.json(slotDto(deps, req, recorder, slot));
      return;
    }
    const id = seriesNumberOf(req.params.timerId);
    const rule = id ? (await recorder.series()).find((r) => r.id === id) : undefined;
    if (!rule) throw new RecorderError('No such series', 404);
    res.json(seriesDto(deps, req, recorder, rule, await recorder.padding()));
  }));

  router.post('/LiveTv/SeriesTimers/:timerId', withRecorder(async (_req, res) => {
    res.status(204).end();
  }));

  router.delete('/LiveTv/SeriesTimers/:timerId', withRecorder(async (req, res, recorder) => {
    // A series by title, or a repeating schedule: given up the same way.
    const slotId = slotNumberOf(req.params.timerId);
    const kind: OwnedKind = slotId ? 'slot' : 'series';
    const id = slotId ?? seriesNumberOf(req.params.timerId);
    if (!id || (kind === 'slot' && !recorder.removeSlot)) throw new RecorderError('No such series', 404);
    // As a recording is given up (`giveUp`): let go by one of several owners, else removed by its
    // owner alone or its household's main profile.
    const store = recordingOwners();
    const owners = store.owners(kind, recorder.kind, id);
    const me = ownerOf(req);
    if (owners.includes(me) && owners.some((owner) => owner !== me) && flag(field(req, 'ForEveryone')) !== true) {
      store.remove(kind, recorder.kind, id, me);
      res.status(204).end();
      return;
    }
    if (!managesAll(req, owners)) {
      throw new RecorderError(owners.length ? 'Only who set it, or the main profile, can do that' : 'Only the main profile can do that', 403);
    }
    if (kind === 'slot') await recorder.removeSlot(id);
    else await recorder.removeSeries(id);
    store.forget(kind, recorder.kind, id);
    res.status(204).end();
  }));

  router.get('/LiveTv/Recordings', withRecorder(async (req, res, recorder) => {
    const channelId = field(req, 'ChannelId');
    const seriesId = field(req, 'SeriesTimerId');
    const inProgress = flag(field(req, 'IsInProgress'));
    const startIndex = Math.max(0, Number(field(req, 'StartIndex')) || 0);
    const limit = Number(field(req, 'Limit')) || 0;
    // Newest first, as Jellyfin lists them; only those begun.
    const entries = (await recorder.list())
      .filter((entry) => entry.state !== 'scheduled')
      .filter((entry) => inProgress === undefined || (entry.state === 'recording') === inProgress)
      .filter((entry) => !channelId || plain(deps.channelItemId(entry.channel)) === plain(channelId))
      .filter((entry) => !seriesId || seriesTimerOf(entry) === plain(seriesId))
      .sort((a, b) => b.start - a.start);
    const page = entries.slice(startIndex, limit > 0 ? startIndex + limit : undefined);
    res.json(deps.itemList(page.map((entry) => recordingDto(deps, req, recorder, entry)), entries.length, startIndex));
  }));

  const oneRecording = (handler: (req: any, res: any, recorder: Recorder, id: number) => Promise<void>) => async (req: any, res: any, next: any) => {
    const id = recordingNumberOf(req.params.recordingId ?? req.params.itemId);
    if (!id) {
      next();
      return;
    }
    return withRecorder((r, s, recorder) => handler(r, s, recorder, id))(req, res, next);
  };

  router.get(['/LiveTv/Recordings/:recordingId', '/Items/:itemId', '/Users/:userId/Items/:itemId'], oneRecording(async (req, res, recorder, id) => {
    const entry = await recorder.get(id);
    if (!entry) throw new RecorderError('No such recording', 404);
    res.json(recordingDto(deps, req, recorder, entry));
  }));

  // A recording's ads, where its recorder marks them, as Jellyfin's own commercial segments: a
  // player's Skip button and seek bar take them as they take an intro. Any other item goes on to
  // the server's own segments.
  router.get('/MediaSegments/:itemId', oneRecording(async (req, res, recorder, id) => {
    const wanted = String(field(req, 'includeSegmentTypes') ?? '').split(',').map((type) => type.trim()).filter(Boolean);
    const breaks = wanted.length && !wanted.includes('Commercial') ? [] : ((await recorder.adBreaks?.(id).catch(() => [])) ?? []);
    const itemId = timerIdOf(id);
    const items = breaks.map((brk, index) => ({
      Id: createHash('sha256').update(`${itemId}:Commercial:${index}`).digest('hex').slice(0, 32),
      ItemId: itemId,
      Type: 'Commercial',
      StartTicks: Math.round(brk.start * TICKS_PER_SECOND),
      EndTicks: Math.round(brk.end * TICKS_PER_SECOND),
    }));
    res.json(deps.itemList(items, items.length, 0));
  }));

  router.delete(['/LiveTv/Recordings/:recordingId', '/Items/:itemId'], oneRecording(async (req, res, recorder, id) => {
    const entry = await recorder.get(id);
    if (!entry) throw new RecorderError('No such recording', 404);
    await giveUp(req, recorder, entry, 'remove');
    res.status(204).end();
  }));

  const playback = oneRecording(async (req, res, recorder, id) => {
    const entry = await recorder.get(id);
    if (!entry) throw new RecorderError('No such recording', 404);
    const sources = entry.playable ? [mediaSourceOf(recorder, entry)] : [];
    res.json({ MediaSources: sources, PlaySessionId: `${timerIdOf(id)}${Date.now().toString(16)}`, ...(sources.length ? {} : { ErrorCode: 'NoCompatibleStream' }) });
  });
  router.get('/Items/:itemId/PlaybackInfo', playback);
  router.post('/Items/:itemId/PlaybackInfo', playback);

  router.get(
    ['/Videos/:itemId/stream', '/Videos/:itemId/stream.:ext', '/Videos/:itemId/stream/:filename', '/Videos/:itemId/original', '/Videos/:itemId/original.:ext', '/Items/:itemId/Download'],
    oneRecording(async (req, res, recorder, id) => {
      const answer = await recorder.open(id, { range: typeof req.headers.range === 'string' ? req.headers.range : undefined });
      if (!answer) throw new RecorderError('Nothing has been recorded yet', 404);
      if (answer.redirect !== undefined) {
        const token = req.jellyfin?.token;
        res.redirect(302, `${req.baseUrl}/LiveTv/Recordings/${timerIdOf(id)}/hls/index.m3u8${token ? `?api_key=${encodeURIComponent(token)}` : ''}`);
        return;
      }
      sendMedia(res, answer);
    })
  );

  // A recording under way, as the playlist that plays it as it grows, and its parts.
  router.get('/LiveTv/Recordings/:recordingId/hls/:part', oneRecording(async (req, res, recorder, id) => {
    const answer = await recorder.open(id, { path: `hls/${req.params.part}` });
    if (!answer) throw new RecorderError('No such part of the recording', 404);
    if (answer.redirect !== undefined) {
      const token = req.jellyfin?.token;
      res.redirect(302, `${req.baseUrl}/Videos/${timerIdOf(id)}/stream?static=true${token ? `&api_key=${encodeURIComponent(token)}` : ''}`);
      return;
    }
    sendMedia(res, await withToken(answer, req.jellyfin?.token));
  }));
}
