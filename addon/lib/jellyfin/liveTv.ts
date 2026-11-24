// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { randomUUID } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { mapWithConcurrency } from '../../utils/concurrency';
import redis from '../redisClient';
import { clientInfo, loadConfig, serverIdFor } from './context';
import { decodeJellyfinId, encodeJellyfinId, hashJellyfinId, isHashedJellyfinId, normaliseJellyfinId, type Descriptor } from './ids';
import { EMPTY_USER_DATA, collectionFolder, itemList, namedItem } from './dto';
import { imageTag } from './imageTags';
import { recallImages, rememberImages } from './items';
import { listProfiles, profileKey } from './profiles';
import {
  coalesce,
  describeStatus,
  fetchStreams,
  mediaSourceFor,
  normaliseStreamBase,
  recallIssued,
  recallStreams,
  rememberIssued,
  rememberStreams,
  streamClient,
  streamUserAgent,
  toPlayable,
} from './streams';

const guard: typeof import('../../utils/outboundGuard') = require('../../utils/outboundGuard');
const database: any = require('../database');

const logger = consola.withTag('JellyfinLiveTv');

/**
 * Live TV from the stream addon's live catalogs (type `tv` or `channel`): each
 * catalog is a channel lineup, its genre options are the channel groups, a `date`
 * extra gives a day of each channel's programmes as its videos, and channels and
 * programmes play through the addon's stream resource. Nothing here is specific
 * to one addon; an aggregator passing a live addon's catalogs on works the same.
 */

type Channel = Extract<Descriptor, { k: 'channel' }>;
type ProgrammeId = Extract<Descriptor, { k: 'programme' }>;
type LiveDescriptor = Extract<Descriptor, { k: 'livetv' | 'channel' | 'channelgroup' | 'programme' }>;

interface LiveCatalog {
  type: string;
  id: string;
  name: string;
  /** The genre options, which are the channel groups. */
  groups: string[];
  groupRequired: boolean;
  pages: boolean;
  search: boolean;
  ids: boolean;
  guide: boolean;
}

interface LiveSource {
  base: string;
  catalogs: LiveCatalog[];
  /** The addon answers meta requests for its live types. */
  meta: boolean;
}

interface ChannelInfo {
  id: string;
  type: string;
  metaId: string;
  /** The catalog it was found in, by type and id, which its guide is asked of. */
  catalog: string;
  name: string;
  number: string | null;
  logo: string | null;
  groups: string[];
  overview: string | null;
  catchupDays: number;
}

interface Programme {
  id: string;
  name: string;
  overview: string | null;
  start: number;
  end: number;
  season: number | null;
  episode: number | null;
  thumbnail: string | null;
}

interface Segment {
  catalog: LiveCatalog;
  genre?: string;
  search?: string;
  /** A group kept to here, from the whole lineup, rather than asked of the addon (see `segmentsFor`). */
  only?: string;
}

interface Listed {
  meta: any;
  catalog: LiveCatalog;
}

const LIVE_TYPES = new Set(['tv', 'channel']);
const DAY_MS = 24 * 60 * 60 * 1000;
const TICKS_PER_MS = 10000;
// The most channels a lineup is walked to, which an addon ignoring skip would otherwise make endless.
const MAX_LINEUP = 5000;
const IDS_PER_REQUEST = 50;
const FAVOURITES_PREF = 'livetv-favourites';
const FAVOURITES_CLIENT = 'aiometadata';

export const LIVE_VIEW_ID = encodeJellyfinId({ k: 'livetv' });

function liveTvEnabled(): boolean {
  const { getSetting } = require('../settingsService');
  return String(getSetting('JELLYFIN_LIVE_TV') ?? 'true').trim().toLowerCase() !== 'false';
}

const channelsTtlMs = () => envInt('JELLYFIN_LIVE_CHANNELS_TTL', 600, 30) * 1000;
const guideTtlMs = () => envInt('JELLYFIN_LIVE_GUIDE_TTL', 900, 60) * 1000;
const timeoutMs = () => envInt('JELLYFIN_STREAM_TIMEOUT_MS', 15000, 1000);
const cacheMax = () => envInt('JELLYFIN_LIVE_CACHE_MAX', 5000, 1);

const sources = new LRUCache<string, LiveSource>({ max: 500, ttl: 60 * 1000 });
// The last manifest read, kept for when the addon cannot be reached: Live TV stays rather than coming and going.
const lastSources = new LRUCache<string, LiveSource>({ max: 500 });
// A manifest that could not be read is not asked for again for a minute, so the libraries never wait on it meanwhile.
const unreachable = new LRUCache<string, true>({ max: 500, ttl: 60 * 1000 });
const pages = new LRUCache<string, any[]>({ max: cacheMax(), ttl: 60 * 1000 });
const channels = new LRUCache<string, ChannelInfo>({ max: cacheMax() * 4, ttl: 60 * 1000 });
// The place of a channel in its lineup, as its number where the addon numbers none.
const positions = new LRUCache<string, number>({ max: cacheMax() * 4 });
const guides = new LRUCache<string, Programme[]>({ max: cacheMax() * 4, ttl: 60 * 1000 });
// Channels the addon no longer lists, left alone a minute rather than asked for again by every list naming them.
const gone = new LRUCache<string, true>({ max: 5000, ttl: 60 * 1000 });
const favouriteLists = new LRUCache<string, string[]>({ max: 2000, ttl: 5 * 60 * 1000 });
const programmeIds = new LRUCache<string, ProgrammeId>({ max: envInt('JELLYFIN_ID_CACHE_MAX', 100000, 1) });

const running = new Map<string, Promise<any>>();

/** One request at a time for the same thing: every caller waits on the first. */
function once<T>(key: string, work: () => Promise<T>): Promise<T> {
  const held = running.get(key);
  if (held) return held;
  const started = work().finally(() => running.delete(key));
  running.set(key, started);
  return started;
}

async function fetchAddon(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await guard.addonFetch(url, {
      headers: { accept: 'application/json', 'user-agent': streamUserAgent() },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(describeStatus(response.status));
    }
    return JSON.parse(await guard.readCappedResponse(response, guard.addonFetchMaxBytes()));
  } finally {
    clearTimeout(timer);
  }
}

// ---------- The addon's live catalogs ----------

function extrasOf(catalog: any): Array<{ name: string; isRequired: boolean; options: string[] }> {
  const listed = Array.isArray(catalog?.extra)
    ? catalog.extra.filter((e: any) => e && typeof e.name === 'string').map((e: any) => ({
        name: e.name,
        isRequired: e.isRequired === true,
        options: Array.isArray(e.options) ? e.options.filter((o: unknown) => typeof o === 'string' && o) : [],
      }))
    : [];
  // The older form: names supported and required, and the genres beside them.
  const supported: string[] = Array.isArray(catalog?.extraSupported) ? catalog.extraSupported : [];
  const required: string[] = Array.isArray(catalog?.extraRequired) ? catalog.extraRequired : [];
  for (const name of supported) {
    if (typeof name !== 'string' || listed.some((e: any) => e.name === name)) continue;
    const options = name === 'genre' && Array.isArray(catalog?.genres) ? catalog.genres.filter((g: unknown) => typeof g === 'string' && g) : [];
    listed.push({ name, isRequired: required.includes(name), options });
  }
  return listed;
}

function liveCatalogOf(catalog: any): LiveCatalog | null {
  if (!catalog || typeof catalog.id !== 'string' || !LIVE_TYPES.has(String(catalog.type))) return null;
  const extras = extrasOf(catalog);
  const genre = extras.find((e) => e.name === 'genre');
  const groupRequired = genre?.isRequired === true;
  // A catalog that answers only a search, or needs anything else first, is no lineup.
  if (extras.some((e) => e.isRequired && e.name !== 'genre')) return null;
  if (groupRequired && !genre?.options.length) return null;
  const has = (name: string) => extras.some((e) => e.name === name);
  return {
    type: String(catalog.type),
    id: catalog.id,
    name: typeof catalog.name === 'string' && catalog.name ? catalog.name : 'Live TV',
    groups: genre?.options ?? [],
    groupRequired,
    pages: has('skip'),
    search: has('search'),
    ids: has('ids'),
    guide: has('date'),
  };
}

function servesMeta(manifest: any): boolean {
  const resources: any[] = Array.isArray(manifest?.resources) ? manifest.resources : [];
  const types: string[] = Array.isArray(manifest?.types) ? manifest.types : [];
  return resources.some((resource) => {
    if (resource === 'meta') return types.some((type) => LIVE_TYPES.has(type));
    return resource?.name === 'meta' && (Array.isArray(resource.types) ? resource.types : types).some((type: string) => LIVE_TYPES.has(type));
  });
}

async function readSource(base: string): Promise<LiveSource | null> {
  const fresh = sources.get(base);
  if (fresh) return fresh;
  if (unreachable.has(base)) return lastSources.get(base) ?? null;
  return once(`manifest|${base}`, async () => {
    try {
      const manifest = await fetchAddon(`${base}/manifest.json`);
      const catalogs = (Array.isArray(manifest?.catalogs) ? manifest.catalogs : [])
        .map(liveCatalogOf)
        .filter((catalog: LiveCatalog | null): catalog is LiveCatalog => catalog !== null);
      const source: LiveSource = { base, catalogs, meta: servesMeta(manifest) };
      sources.set(base, source, { ttl: channelsTtlMs() });
      lastSources.set(base, source);
      return source;
    } catch (error: any) {
      logger.debug(`The stream addon's manifest could not be read: ${error?.message || error}`);
      unreachable.set(base, true);
      return lastSources.get(base) ?? null;
    }
  });
}

/**
 * Live TV is set up for this configuration (a stream addon is named and Live TV is on), told to
 * clients in each user's policy: many show Live TV only to a user it says may use it.
 */
export function liveTvOffered(config: any): boolean {
  return liveTvEnabled() && !!normaliseStreamBase(config?.jellyfinStreamUrl || '');
}

/** The stream addon's live catalogs for this configuration, or null when it has none. */
async function liveSourceFor(config: any): Promise<LiveSource | null> {
  if (!liveTvEnabled()) return null;
  const base = normaliseStreamBase(config?.jellyfinStreamUrl || '');
  if (!base) return null;
  const source = await readSource(base);
  return source && source.catalogs.length ? source : null;
}

function catalogKey(catalog: LiveCatalog): string {
  return `${catalog.type}/${catalog.id}`;
}

function catalogUrl(base: string, catalog: LiveCatalog, extra: Record<string, string | undefined>): string {
  const parts = Object.entries(extra)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
  return `${base}/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}${parts.length ? `/${parts.join('&')}` : ''}.json`;
}

/** One catalog answer's metas; a guide request answers with them detailed, under its own name. */
async function catalogMetas(url: string): Promise<any[]> {
  const body = await fetchAddon(url);
  const metas = Array.isArray(body?.metasDetailed) ? body.metasDetailed : Array.isArray(body?.metas) ? body.metas : [];
  return metas.filter((meta: any) => meta && typeof meta.id === 'string' && meta.id);
}

async function catalogPage(source: LiveSource, catalog: LiveCatalog, extra: Record<string, string | undefined>): Promise<any[]> {
  const url = catalogUrl(source.base, catalog, extra);
  const held = pages.get(url);
  if (held) return held;
  return once(url, async () => {
    const metas = await catalogMetas(url);
    pages.set(url, metas, { ttl: channelsTtlMs() });
    for (const meta of metas) rememberChannel(meta, catalog);
    return metas;
  });
}

// ---------- Channels ----------

function catchupDaysOf(meta: any): number {
  const days = Number(meta?.behaviorHints?.catchupDays);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

function channelIdFor(type: string, metaId: string): string {
  return encodeJellyfinId({ k: 'channel', t: type, i: metaId });
}

function rememberChannel(meta: any, catalog: LiveCatalog): ChannelInfo {
  const type = typeof meta.type === 'string' && LIVE_TYPES.has(meta.type) ? meta.type : catalog.type;
  const id = channelIdFor(type, meta.id);
  const number = meta.channelNumber ?? meta.number;
  const logo = [meta.logo, meta.poster].find((value) => typeof value === 'string' && /^https?:\/\//i.test(value)) ?? null;
  const info: ChannelInfo = {
    id,
    type,
    metaId: meta.id,
    catalog: catalogKey(catalog),
    name: typeof meta.name === 'string' && meta.name ? meta.name : meta.id,
    number: number !== undefined && number !== null && String(number).trim() ? String(number).trim() : null,
    logo,
    groups: Array.isArray(meta.genres) ? meta.genres.filter((g: unknown) => typeof g === 'string' && g) : [],
    overview: typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : null,
    catchupDays: catchupDaysOf(meta),
  };
  channels.set(id, info, { ttl: channelsTtlMs() });
  return info;
}

/** The lineups a listing walks, in order: all channels, one group, or a search. */
function segmentsFor(source: LiveSource, want: { group?: string; search?: string }): Segment[] {
  const out: Segment[] = [];
  for (const catalog of source.catalogs) {
    if (want.search !== undefined) {
      if (catalog.search) out.push({ catalog, search: want.search });
    } else if (want.group !== undefined) {
      if (!catalog.groups.includes(want.group)) continue;
      // A group name with a slash goes in the request's path, and a proxy decoding %2F on the way
      // split it there: the addon read another group and answered nothing. Where the lineup can
      // be read whole, its channels are kept to the group here instead.
      if (want.group.includes('/') && !catalog.groupRequired) out.push({ catalog, only: want.group });
      else out.push({ catalog, genre: want.group });
    } else if (catalog.groupRequired) {
      for (const group of catalog.groups) out.push({ catalog, genre: group });
    } else {
      out.push({ catalog });
    }
  }
  return out;
}

/** A lineup's channels from `start`, `count` of them, and whether it was walked to its end. */
async function lineupSlice(source: LiveSource, segment: Segment, start: number, count: number): Promise<{ metas: any[]; done: boolean; known: number }> {
  const metas: any[] = [];
  const inGroup = (meta: any) => segment.only === undefined || (Array.isArray(meta?.genres) && meta.genres.includes(segment.only));
  // Skip counts the addon's own channels, which a group kept here has fewer of.
  let walked = 0;
  let first: string | undefined;
  let longest = 0;
  let done = false;
  while (metas.length < start + count) {
    const skip = walked;
    const page = await catalogPage(source, segment.catalog, { genre: segment.genre, search: segment.search, skip: skip ? String(skip) : undefined });
    // An addon that ignores skip answers its first page again.
    if (skip && page.length && page[0]?.id === first) {
      done = true;
      break;
    }
    if (!skip) first = page[0]?.id;
    walked += page.length;
    metas.push(...page.filter(inGroup));
    longest = Math.max(longest, page.length);
    if (!segment.catalog.pages || page.length === 0 || page.length < longest || walked >= MAX_LINEUP) {
      done = true;
      break;
    }
  }
  return { metas: metas.slice(start, start + count), done, known: metas.length };
}

/** A page of channels across the lineups, with a total that is exact once every lineup was walked to its end. */
async function listChannels(source: LiveSource, segments: Segment[], start: number, count: number): Promise<{ listed: Listed[]; total: number }> {
  const listed: Listed[] = [];
  let offset = 0;
  for (const [at, segment] of segments.entries()) {
    const from = Math.max(0, start + listed.length - offset);
    const slice = await lineupSlice(source, segment, from, start + count - offset - from);
    for (const meta of slice.metas) listed.push({ meta, catalog: segment.catalog });
    if (!slice.done) return { listed, total: offset + slice.known + 1 };
    offset += slice.known;
    // Full, with lineups still to walk: there are more, how many is not known yet.
    if (listed.length >= count && at < segments.length - 1) return { listed, total: offset + 1 };
  }
  return { listed, total: offset };
}

/** Channels by id, from what was listed, else asked of the addon by their ids, else by their meta. */
async function channelsById(source: LiveSource, wanted: Channel[]): Promise<Map<string, ChannelInfo>> {
  const found = new Map<string, ChannelInfo>();
  let missing: Channel[] = [];
  for (const descriptor of wanted) {
    const id = channelIdFor(descriptor.t, descriptor.i);
    const held = channels.get(id);
    if (held) found.set(id, held);
    else if (!gone.has(id)) missing.push(descriptor);
  }
  for (const catalog of source.catalogs) {
    if (!missing.length) break;
    if (!catalog.ids) continue;
    const ofType = missing.filter((d) => d.t === catalog.type);
    for (let at = 0; at < ofType.length; at += IDS_PER_REQUEST) {
      const chunk = ofType.slice(at, at + IDS_PER_REQUEST);
      const metas = await catalogPage(source, catalog, { ids: chunk.map((d) => d.i).join(',') }).catch((error: any) => {
        logger.debug(`Channels by id from ${catalog.id} failed: ${error?.message || error}`);
        return [];
      });
      for (const meta of metas) {
        const info = rememberChannel(meta, catalog);
        found.set(info.id, info);
      }
    }
    missing = missing.filter((d) => !found.has(channelIdFor(d.t, d.i)));
  }
  if (missing.length && source.meta) {
    await mapWithConcurrency(missing, 4, async (descriptor) => {
      const catalog = source.catalogs.find((c) => c.type === descriptor.t) ?? source.catalogs[0];
      try {
        const body = await fetchAddon(`${source.base}/meta/${encodeURIComponent(descriptor.t)}/${encodeURIComponent(descriptor.i)}.json`);
        if (body?.meta?.id) {
          const info = rememberChannel({ ...body.meta, type: descriptor.t }, catalog);
          found.set(info.id, info);
        }
      } catch (error: any) {
        logger.debug(`A channel's meta could not be read: ${error?.message || error}`);
      }
    });
  }
  for (const descriptor of missing) {
    const id = channelIdFor(descriptor.t, descriptor.i);
    if (!found.has(id)) gone.set(id, true);
  }
  return found;
}

function catalogOf(source: LiveSource, channel: ChannelInfo): LiveCatalog | undefined {
  return source.catalogs.find((catalog) => catalogKey(catalog) === channel.catalog);
}

// ---------- The guide ----------

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// A day's guide may list a programme under the day it started, so a window opening
// soon after midnight asks the day before too.
function daysCovering(from: number, to: number): string[] {
  const first = Math.floor((from - 4 * 60 * 60 * 1000) / DAY_MS);
  const last = Math.floor(Math.max(from, to) / DAY_MS);
  const days: string[] = [];
  for (let day = first; day <= last && days.length < 10; day++) days.push(dayOf(day * DAY_MS));
  return days;
}

function guideKey(base: string, channel: ChannelInfo, day: string): string {
  return `${base}|${channel.catalog}|${day}|${channel.metaId}`;
}

function finiteOrNull(value: unknown): number | null {
  const n = Number(value);
  return value !== undefined && value !== null && value !== '' && Number.isFinite(n) ? n : null;
}

/** A channel's videos as programmes, in time order; one without an end runs until the next begins. */
function programmesOf(videos: unknown): Programme[] {
  if (!Array.isArray(videos)) return [];
  const list = videos
    .filter((video: any) => video && (typeof video.id === 'string' || typeof video.id === 'number'))
    .map((video: any) => ({
      id: String(video.id),
      name: String(video.title ?? video.name ?? '').trim(),
      overview: typeof (video.overview ?? video.description) === 'string' && String(video.overview ?? video.description).trim() ? String(video.overview ?? video.description).trim() : null,
      start: Date.parse(String(video.startTime ?? video.released ?? '')),
      end: Date.parse(String(video.endTime ?? '')),
      season: finiteOrNull(video.season),
      episode: finiteOrNull(video.episode),
      thumbnail: typeof video.thumbnail === 'string' && /^https?:\/\//i.test(video.thumbnail) ? video.thumbnail : null,
    }))
    .filter((p) => Number.isFinite(p.start))
    .sort((a, b) => a.start - b.start);
  return list
    .map((p, i) => ({ ...p, end: Number.isFinite(p.end) ? p.end : list.slice(i + 1).find((next) => next.start > p.start)?.start ?? NaN }))
    .filter((p) => Number.isFinite(p.end) && p.end > p.start);
}

/** One day of a catalog's guide for these channels: by their ids where the catalog takes them, else the whole lineup's. */
async function fetchGuideDay(source: LiveSource, catalog: LiveCatalog, wanted: ChannelInfo[], day: string): Promise<boolean> {
  const store = (metas: any[]) => {
    for (const meta of metas) {
      const info = rememberChannel(meta, catalog);
      guides.set(guideKey(source.base, info, day), programmesOf(meta.videos), { ttl: guideTtlMs() });
    }
  };
  if (catalog.ids) {
    let answered = true;
    for (let at = 0; at < wanted.length; at += IDS_PER_REQUEST) {
      const chunk = wanted.slice(at, at + IDS_PER_REQUEST);
      const url = catalogUrl(source.base, catalog, { ids: chunk.map((c) => c.metaId).join(','), date: day });
      try {
        await once(url, async () => store(await catalogMetas(url)));
        // A channel the answer left out has nothing on that day.
        for (const channel of chunk) {
          const key = guideKey(source.base, channel, day);
          if (!guides.has(key)) guides.set(key, [], { ttl: guideTtlMs() });
        }
      } catch (error: any) {
        logger.debug(`The guide for ${day} from ${catalog.id} failed: ${error?.message || error}`);
        answered = false;
      }
    }
    return answered;
  }
  const walked = `${source.base}|${catalogKey(catalog)}|${day}|*`;
  if (guides.has(walked)) return true;
  try {
    await once(walked, async () => {
      for (const segment of segmentsFor(source, {}).filter((s) => s.catalog === catalog)) {
        let skip = 0;
        let longest = 0;
        for (;;) {
          const metas = await catalogMetas(catalogUrl(source.base, catalog, { genre: segment.genre, skip: skip ? String(skip) : undefined, date: day }));
          store(metas);
          longest = Math.max(longest, metas.length);
          skip += metas.length;
          if (!catalog.pages || !metas.length || metas.length < longest || skip >= MAX_LINEUP) break;
        }
      }
      guides.set(walked, [], { ttl: guideTtlMs() });
    });
    for (const channel of wanted) {
      const key = guideKey(source.base, channel, day);
      if (!guides.has(key)) guides.set(key, [], { ttl: guideTtlMs() });
    }
    return true;
  } catch (error: any) {
    logger.debug(`The guide for ${day} from ${catalog.id} failed: ${error?.message || error}`);
    return false;
  }
}

/**
 * A channel's programmes in time order, one at a time. Each day of the guide is asked for on its
 * own, and an addon that makes up programmes for a channel without a guide makes them again for
 * each day, a little apart, under other ids: one starting over a minute before the last one kept
 * has ended is that slot again, and is left out.
 */
function oneAtATime(programmes: Programme[]): Programme[] {
  const kept: Programme[] = [];
  for (const programme of [...programmes].sort((a, b) => a.start - b.start)) {
    const last = kept[kept.length - 1];
    if (last && programme.start < last.end - 60_000) continue;
    kept.push(programme);
  }
  return kept;
}

/** Each channel's programmes overlapping a window; `failed` when the addon answered none of what was asked. */
async function guideFor(source: LiveSource, list: ChannelInfo[], from: number, to: number): Promise<{ byChannel: Map<string, Programme[]>; failed: boolean }> {
  const days = daysCovering(from, to);
  const asks: Array<{ catalog: LiveCatalog; day: string; wanted: ChannelInfo[] }> = [];
  for (const day of days) {
    const byCatalog = new Map<LiveCatalog, ChannelInfo[]>();
    for (const channel of list) {
      const catalog = catalogOf(source, channel);
      if (!catalog?.guide || guides.has(guideKey(source.base, channel, day))) continue;
      byCatalog.set(catalog, [...(byCatalog.get(catalog) ?? []), channel]);
    }
    for (const [catalog, wanted] of byCatalog) asks.push({ catalog, day, wanted });
  }
  const answers = await mapWithConcurrency(asks, 4, (ask) => fetchGuideDay(source, ask.catalog, ask.wanted, ask.day));
  const byChannel = new Map<string, Programme[]>();
  for (const channel of list) {
    const seen = new Set<string>();
    const programmes: Programme[] = [];
    for (const day of days) {
      for (const programme of guides.get(guideKey(source.base, channel, day)) ?? []) {
        if (seen.has(programme.id) || programme.end <= from || programme.start > to) continue;
        seen.add(programme.id);
        programmes.push(programme);
      }
    }
    byChannel.set(channel.id, oneAtATime(programmes));
  }
  return { byChannel, failed: asks.length > 0 && answers.every((answered) => !answered) };
}

// ---------- Programme ids ----------

/**
 * A guide names thousands of programmes a day, so their ids are not kept for good
 * as other ids are: in memory, and in Redis until the programme's catch-up ends.
 */
function programmeIdFor(channel: ChannelInfo, programme: Programme): string {
  const descriptor: ProgrammeId = {
    k: 'programme',
    t: channel.type,
    c: channel.metaId,
    i: programme.id,
    s: Math.floor(programme.start / 1000),
    e: Math.floor(programme.end / 1000),
  };
  const id = hashJellyfinId(descriptor);
  if (!programmeIds.has(id)) {
    programmeIds.set(id, descriptor);
    const until = descriptor.e + Math.max(channel.catchupDays, 1) * 86400 + 86400;
    const ttl = Math.max(3600, until - Math.floor(Date.now() / 1000));
    redis.set(`jf:live:prog:${id}`, JSON.stringify(descriptor), 'EX', ttl).catch(() => undefined);
  }
  return id;
}

async function recallProgramme(id: string): Promise<ProgrammeId | null> {
  try {
    const stored = await redis.get(`jf:live:prog:${id}`);
    const parsed = stored ? JSON.parse(stored) : null;
    if (parsed?.k !== 'programme') return null;
    programmeIds.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** The Live TV descriptor an id names, or null for anything else. */
export async function liveDescriptor(raw: unknown): Promise<LiveDescriptor | null> {
  const id = normaliseJellyfinId(String(raw ?? ''));
  if (!/^[0-9a-f]{32}$/.test(id) || !isHashedJellyfinId(id)) return null;
  const held = programmeIds.get(id);
  if (held) return held;
  const descriptor = await decodeJellyfinId(id);
  if (descriptor) {
    return descriptor.k === 'livetv' || descriptor.k === 'channel' || descriptor.k === 'channelgroup' ? descriptor : null;
  }
  return recallProgramme(id);
}

function groupIdFor(name: string): string {
  return encodeJellyfinId({ k: 'channelgroup', g: name });
}

// ---------- Favourites ----------

/** Favourite channels are kept with the profile's other server-side preferences, newest last. */
async function favouriteChannels(userUUID: string, config: any): Promise<string[]> {
  const key = `${userUUID}|${profileKey(config)}`;
  const held = favouriteLists.get(key);
  if (held) return held;
  const stored = await database.getPreferences(userUUID, profileKey(config), FAVOURITES_PREF, FAVOURITES_CLIENT).catch(() => null);
  const list: string[] = Array.isArray(stored?.Channels) ? stored.Channels.map((id: unknown) => normaliseJellyfinId(String(id))) : [];
  favouriteLists.set(key, list);
  return list;
}

async function setFavouriteChannel(userUUID: string, config: any, id: string, favourite: boolean): Promise<void> {
  const current = await favouriteChannels(userUUID, config);
  const list = current.filter((entry) => entry !== id);
  if (favourite) list.push(id);
  await database.savePreferences(userUUID, profileKey(config), FAVOURITES_PREF, FAVOURITES_CLIENT, { Channels: list });
  favouriteLists.set(`${userUUID}|${profileKey(config)}`, list);
}

// ---------- DTOs ----------

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function catchesUp(channel: ChannelInfo, programme: Programme, now: number): boolean {
  return channel.catchupDays > 0 && programme.end <= now && now - programme.start <= channel.catchupDays * DAY_MS;
}

function numberOf(channel: ChannelInfo): string | null {
  if (channel.number) return channel.number;
  const place = positions.get(channel.id);
  return place ? String(place) : null;
}

function programmeDto(channel: ChannelInfo, programme: Programme, serverId: string, now: number): any {
  const id = programmeIdFor(channel, programme);
  if (programme.thumbnail) rememberImages(serverId, id, { primary: programme.thumbnail });
  const number = numberOf(channel);
  return {
    Name: programme.name || channel.name,
    ServerId: serverId,
    Id: id,
    Type: 'Program',
    MediaType: 'Video',
    IsFolder: false,
    ChannelId: channel.id,
    ChannelName: channel.name,
    ...(number ? { ChannelNumber: number } : {}),
    ...(channel.logo ? { ChannelPrimaryImageTag: imageTag(channel.logo) } : {}),
    StartDate: iso(programme.start),
    EndDate: iso(programme.end),
    RunTimeTicks: (programme.end - programme.start) * TICKS_PER_MS,
    ...(programme.overview ? { Overview: programme.overview } : {}),
    ...(programme.season !== null ? { ParentIndexNumber: programme.season } : {}),
    ...(programme.episode !== null ? { IndexNumber: programme.episode } : {}),
    IsSeries: programme.season !== null || programme.episode !== null,
    ImageTags: programme.thumbnail ? { Primary: imageTag(programme.thumbnail) } : {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
    LocationType: 'Remote',
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    ...(catchesUp(channel, programme, now) ? { aiostreams: { catchup: true } } : {}),
  };
}

function channelDto(id: string, channel: ChannelInfo | undefined, serverId: string, favourite: boolean, current: any): any {
  const userData = { ...EMPTY_USER_DATA, IsFavorite: favourite, Key: id, ItemId: id };
  // Gone from the addon's lineup: listed by its id alone, which a client leaves out of its lists.
  if (!channel) {
    return { Id: id, ServerId: serverId, Type: 'TvChannel', IsFolder: false, MediaType: 'Video', ImageTags: {}, UserData: userData, aiostreams: { noMeta: true } };
  }
  if (channel.logo) rememberImages(serverId, id, { primary: channel.logo, logo: channel.logo });
  const number = numberOf(channel);
  return {
    Name: channel.name,
    ServerId: serverId,
    Id: id,
    Type: 'TvChannel',
    ChannelType: 'TV',
    MediaType: 'Video',
    IsFolder: false,
    ParentId: LIVE_VIEW_ID,
    SortName: channel.name,
    ...(number ? { Number: number, ChannelNumber: number } : {}),
    ...(channel.overview ? { Overview: channel.overview } : {}),
    Genres: channel.groups,
    GenreItems: channel.groups.map((group) => ({ Name: group, Id: groupIdFor(group) })),
    ImageTags: channel.logo ? { Primary: imageTag(channel.logo) } : {},
    PrimaryImageAspectRatio: 1,
    BackdropImageTags: [],
    ImageBlurHashes: {},
    LocationType: 'Remote',
    UserData: userData,
    ...(current ? { CurrentProgram: current } : {}),
  };
}

/** The Live TV view, said to have groups and a guide only where the addon's catalogs do. */
function viewDto(source: LiveSource, serverId: string): any {
  return {
    ...collectionFolder(LIVE_VIEW_ID, serverId, 'Live TV', 'livetv', null),
    Type: 'UserView',
    aiostreams: {
      groups: source.catalogs.some((catalog) => catalog.groups.length > 0),
      guide: source.catalogs.some((catalog) => catalog.guide),
    },
  };
}

/** The Live TV view for the user's libraries, once its addon has answered; null without live catalogs. */
export async function liveTvView(config: any, serverId: string): Promise<any | null> {
  if (!liveTvEnabled()) return null;
  const base = normaliseStreamBase(config?.jellyfinStreamUrl || '');
  if (!base) return null;
  // The request that starts reading the manifest waits a moment for it, never the addon's full timeout;
  // any other while it is read answers with what was known.
  const reading = running.has(`manifest|${base}`);
  const known = lastSources.get(base) ?? null;
  const source = sources.get(base) ?? (reading ? known : await Promise.race([
    readSource(base),
    new Promise<LiveSource | null>((resolve) => setTimeout(() => resolve(lastSources.get(base) ?? null), 2000).unref?.()),
  ]));
  return source?.catalogs.length ? viewDto(source, serverId) : null;
}

/** The channels as items, each with what is on now where the addon has a guide. */
async function channelItems(source: LiveSource, ids: string[], found: Map<string, ChannelInfo>, serverId: string, favourites: Set<string>, withCurrent: boolean): Promise<any[]> {
  const now = Date.now();
  const known = ids.map((id) => found.get(id)).filter((c): c is ChannelInfo => !!c);
  const guide = withCurrent && known.length ? (await guideFor(source, known, now, now)).byChannel : new Map<string, Programme[]>();
  return ids.map((id) => {
    const channel = found.get(id);
    const airing = channel ? guide.get(id)?.find((p) => p.start <= now && now < p.end) : undefined;
    return channelDto(id, channel, serverId, favourites.has(id), channel && airing ? programmeDto(channel, airing, serverId, now) : null);
  });
}

// ---------- Requests ----------

/** A parameter from the query or a JSON body, whatever its case. */
function param(req: any, name: string): any {
  const lower = name.toLowerCase();
  for (const source of [req.body, req.query]) {
    if (!source || typeof source !== 'object') continue;
    const key = Object.keys(source).find((k) => k.toLowerCase() === lower);
    if (key !== undefined && source[key] !== undefined && source[key] !== '') return source[key];
  }
  return undefined;
}

function listParam(req: any, name: string): string[] {
  const value = param(req, name);
  return (Array.isArray(value) ? value : String(value ?? '').split(',')).map((v) => String(v).trim()).filter(Boolean);
}

function intParam(req: any, name: string, fallback: number): number {
  const parsed = parseInt(String(param(req, name)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolParam(req: any, name: string): boolean | undefined {
  const value = param(req, name);
  if (value === undefined) return undefined;
  return String(value).toLowerCase() === 'true';
}

function dateParam(req: any, name: string): number | undefined {
  const value = param(req, name);
  const ms = value === undefined ? NaN : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : undefined;
}

const CHANNEL_TYPES = new Set(['tvchannel', 'livetvchannel']);

function asksForChannels(req: any): boolean {
  const types = listParam(req, 'IncludeItemTypes').map((t) => t.toLowerCase());
  return types.length > 0 && types.every((t) => CHANNEL_TYPES.has(t));
}

function asksForFavourites(req: any): boolean {
  return boolParam(req, 'IsFavorite') === true || listParam(req, 'Filters').some((f) => f.toLowerCase() === 'isfavorite');
}

interface Scope {
  userUUID: string;
  config: any;
  source: LiveSource | null;
  serverId: string;
}

async function scopeOf(req: any): Promise<Scope | null> {
  const config = await loadConfig(req);
  if (!config) return null;
  const userUUID = req.params.userUUID;
  return { userUUID, config, source: await liveSourceFor(config), serverId: serverIdFor(userUUID) };
}

/** A page of channels: the favourites, a group, a search, or all of them. */
async function channelPage(
  scope: Scope,
  want: { favourites?: boolean; group?: string; search?: string },
  start: number,
  limit: number,
  withCurrent: boolean
): Promise<{ items: any[]; total: number }> {
  const source = scope.source;
  if (!source) return { items: [], total: 0 };
  const favourites = await favouriteChannels(scope.userUUID, scope.config);
  const favouriteSet = new Set(favourites);

  if (want.favourites) {
    const decoded = await Promise.all(favourites.map((id) => liveDescriptor(id)));
    const listed = decoded.filter((d): d is Channel => d?.k === 'channel');
    const page = listed.slice(start, start + limit);
    const found = await channelsById(source, page);
    const ids = page.map((d) => channelIdFor(d.t, d.i));
    return { items: await channelItems(source, ids, found, scope.serverId, favouriteSet, withCurrent), total: listed.length };
  }

  const search = want.search?.trim();
  let listed: Listed[];
  let total: number;
  if (search) {
    // Each catalog that searches is asked; the others' lineups are matched here, by name and number.
    const asked = await listChannels(source, segmentsFor(source, { search }), 0, start + limit);
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const local: Listed[] = [];
    for (const catalog of source.catalogs.filter((c) => !c.search)) {
      const all = await listChannels(source, segmentsFor({ ...source, catalogs: [catalog] }, {}), 0, MAX_LINEUP);
      for (const entry of all.listed) {
        const text = `${entry.meta.channelNumber ?? ''} ${entry.meta.name ?? ''}`.toLowerCase();
        if (words.every((word) => text.includes(word))) local.push(entry);
      }
    }
    // A channel whose number is the search goes first.
    const all = [...asked.listed, ...local];
    const exact = all.filter((entry) => String(entry.meta.channelNumber ?? '').trim() === search);
    const ordered = [...exact, ...all.filter((entry) => !exact.includes(entry))];
    listed = ordered.slice(start, start + limit);
    total = ordered.length;
  } else {
    const segments = segmentsFor(source, { group: want.group });
    const page = await listChannels(source, segments, start, limit);
    listed = page.listed;
    total = page.total;
    if (want.group === undefined) listed.forEach((entry, i) => positions.set(rememberChannel(entry.meta, entry.catalog).id, start + i + 1));
  }

  const found = new Map<string, ChannelInfo>();
  const ids: string[] = [];
  for (const entry of listed) {
    const info = rememberChannel(entry.meta, entry.catalog);
    if (found.has(info.id)) continue;
    found.set(info.id, info);
    ids.push(info.id);
  }
  return { items: await channelItems(source, ids, found, scope.serverId, favouriteSet, withCurrent), total };
}

/** The group a channel list asks for: by its id (`GenreIds`), else by its name (`Genres`, pipe-delimited as clients send them). */
async function groupOf(req: any, scope: Scope): Promise<string | undefined> {
  for (const id of String(param(req, 'GenreIds') ?? '').split(',').map((v) => v.trim()).filter(Boolean)) {
    const descriptor = await liveDescriptor(id);
    if (descriptor?.k === 'channelgroup') return descriptor.g;
  }
  const names = String(param(req, 'Genres') ?? '').split('|').map((v) => v.trim()).filter(Boolean);
  const groups = new Set((scope.source?.catalogs ?? []).flatMap((catalog) => catalog.groups));
  return names.find((name) => groups.has(name));
}

async function answerChannels(req: any, res: any, scope: Scope, group: string | undefined): Promise<void> {
  const start = Math.max(0, intParam(req, 'StartIndex', 0));
  const limit = Math.min(Math.max(1, intParam(req, 'Limit', 100)), 500);
  const search = param(req, 'SearchTerm') ?? param(req, 'NameStartsWith');
  try {
    const page = await channelPage(
      scope,
      { favourites: asksForFavourites(req), group, search: search !== undefined ? String(search) : undefined },
      start,
      limit,
      boolParam(req, 'AddCurrentProgram') !== false
    );
    res.json(itemList(page.items, page.total, start));
  } catch (error: any) {
    logger.warn(`Channels could not be listed: ${error?.message || error}`);
    res.status(503).json({ Message: 'The stream addon could not be reached' });
  }
}

/** The channels a programme request names, else the first page of all of them. */
async function channelsAsked(req: any, scope: Scope, source: LiveSource): Promise<ChannelInfo[]> {
  const named = (await Promise.all(listParam(req, 'ChannelIds').map((id) => liveDescriptor(id)))).filter((d): d is Channel => d?.k === 'channel');
  if (named.length) {
    const found = await channelsById(source, named);
    return named.map((d) => found.get(channelIdFor(d.t, d.i))).filter((c): c is ChannelInfo => !!c);
  }
  const page = await listChannels(source, segmentsFor(source, {}), 0, 100);
  return page.listed.map((entry) => rememberChannel(entry.meta, entry.catalog));
}

async function answerProgrammes(req: any, res: any, recommended: boolean): Promise<void> {
  const scope = await scopeOf(req);
  const start = Math.max(0, intParam(req, 'StartIndex', 0));
  const source = scope?.source;
  if (!scope || !source) {
    res.json(itemList([], 0, start));
    return;
  }
  const now = Date.now();
  const airing = boolParam(req, 'IsAiring');
  const aired = boolParam(req, 'HasAired');
  const minStart = dateParam(req, 'MinStartDate');
  const maxStart = dateParam(req, 'MaxStartDate');
  const minEnd = dateParam(req, 'MinEndDate');
  const maxEnd = dateParam(req, 'MaxEndDate');
  const limit = Math.min(Math.max(1, intParam(req, 'Limit', recommended ? 24 : 1000)), 5000);

  let list: ChannelInfo[];
  try {
    if (recommended) {
      // The favourites first, then the lineup's first channels.
      const favourites = (await Promise.all((await favouriteChannels(scope.userUUID, scope.config)).map((id) => liveDescriptor(id))))
        .filter((d): d is Channel => d?.k === 'channel');
      const found = await channelsById(source, favourites);
      const page = await listChannels(source, segmentsFor(source, {}), 0, Math.max(limit * 2, 60));
      const seen = new Set<string>();
      list = [...favourites.map((d) => found.get(channelIdFor(d.t, d.i))), ...page.listed.map((e) => rememberChannel(e.meta, e.catalog))]
        .filter((c): c is ChannelInfo => !!c && !seen.has(c.id) && !!seen.add(c.id));
    } else {
      list = await channelsAsked(req, scope, source);
    }
  } catch (error: any) {
    logger.warn(`Channels for the guide could not be read: ${error?.message || error}`);
    res.status(503).json({ Message: 'The stream addon could not be reached' });
    return;
  }

  const from = airing ? now : minEnd ?? minStart ?? now;
  const to = airing ? now : maxStart ?? maxEnd ?? (recommended ? now + 6 * 60 * 60 * 1000 : now + DAY_MS);
  const { byChannel, failed } = await guideFor(source, list, from, to);
  if (failed) {
    res.status(503).json({ Message: 'The stream addon did not answer for the guide' });
    return;
  }
  const order = new Map(list.map((channel, i) => [channel.id, i]));
  const entries: Array<{ channel: ChannelInfo; programme: Programme }> = [];
  for (const channel of list) {
    for (const programme of byChannel.get(channel.id) ?? []) {
      if (minStart !== undefined && programme.start < minStart) continue;
      if (maxStart !== undefined && programme.start > maxStart) continue;
      if (minEnd !== undefined && programme.end < minEnd) continue;
      if (maxEnd !== undefined && programme.end > maxEnd) continue;
      if (airing !== undefined && (programme.start <= now && now < programme.end) !== airing) continue;
      if (aired !== undefined && (programme.end <= now) !== aired) continue;
      entries.push({ channel, programme });
    }
  }
  entries.sort((a, b) => a.programme.start - b.programme.start || (order.get(a.channel.id) ?? 0) - (order.get(b.channel.id) ?? 0));
  const page = entries.slice(start, start + limit);
  res.json(itemList(page.map((e) => programmeDto(e.channel, e.programme, scope.serverId, now)), entries.length, start));
}

/** A programme by its id, from its channel's guide for the day it started. */
async function programmeById(source: LiveSource, descriptor: ProgrammeId): Promise<{ channel: ChannelInfo; programme: Programme } | null> {
  const found = await channelsById(source, [{ k: 'channel', t: descriptor.t, i: descriptor.c }]);
  const channel = found.get(channelIdFor(descriptor.t, descriptor.c));
  if (!channel) return null;
  const at = descriptor.s * 1000;
  const { byChannel } = await guideFor(source, [channel], at, at);
  const programme = byChannel.get(channel.id)?.find((p) => p.id === descriptor.i)
    // Gone from the guide since: what its id says of it is enough to play it.
    ?? { id: descriptor.i, name: channel.name, overview: null, start: at, end: descriptor.e * 1000, season: null, episode: null, thumbnail: null };
  return { channel, programme };
}

/** A Live TV item by its id, for the single-item and list routes. */
async function itemFor(scope: Scope, descriptor: LiveDescriptor, id: string): Promise<any | null> {
  const source = scope.source;
  if (!source) return null;
  if (descriptor.k === 'livetv') return viewDto(source, scope.serverId);
  if (descriptor.k === 'channelgroup') return namedItem('Genre', descriptor.g, id, scope.serverId);
  if (descriptor.k === 'channel') {
    const found = await channelsById(source, [descriptor]);
    const favourites = new Set(await favouriteChannels(scope.userUUID, scope.config));
    return (await channelItems(source, [id], found, scope.serverId, favourites, true))[0];
  }
  const entry = await programmeById(source, descriptor);
  return entry ? programmeDto(entry.channel, entry.programme, scope.serverId, Date.now()) : null;
}

// ---------- Playback ----------

/**
 * Dispatcharr's channel link sends one long MPEG-TS stream, which Apple's player (and a browser)
 * can't open. Asked with `output_format=hls` (Dispatcharr 0.33 and later), the same link sends HLS
 * instead, which they can. Hyperion reads MPEG-TS itself and starts sooner on it, so it keeps the
 * link as it is; every other client gets HLS. Links that aren't Dispatcharr's channel links, and
 * catch-up, are left alone.
 */
const loggedShapes = new Set<string>();

function wantsHls(req: any): boolean {
  return !/^hyperion\b/i.test(clientInfo(req).client);
}

function liveUrlFor(req: any, url: string): { url: string; hls: boolean } {
  if (!wantsHls(req)) return { url, hls: false };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, hls: false };
  }
  if (!/\/proxy\/ts\/stream\/[^/]+\/?$/.test(parsed.pathname)) {
    // Its shape only, every name and id hidden, once: enough to see what form an addon's links take.
    const shape = parsed.pathname.split('/').map((part) => (/^(proxy|ts|stream|live|hls|play)$/i.test(part) || !part ? part : part.replace(/^[^.]*/, '*'))).join('/');
    if (!loggedShapes.has(shape)) {
      loggedShapes.add(shape);
      logger.info(`A live link sent as it is to a client that wants HLS (its shape: ${shape})`);
    }
    return { url, hls: false };
  }
  parsed.searchParams.delete('output');
  parsed.searchParams.set('output_format', 'hls');
  return { url: parsed.toString(), hls: true };
}

async function liveMediaSources(req: any, scope: Scope, descriptor: Channel | ProgrammeId, allowHeaders: boolean): Promise<any[]> {
  const source = scope.source;
  if (!source) return [];
  const itemId = descriptor.k === 'channel' ? channelIdFor(descriptor.t, descriptor.i) : hashJellyfinId(descriptor);
  const owner = `${scope.userUUID}:${profileKey(scope.config)}`;
  const client = streamClient(owner, clientInfo(req), req.get?.('user-agent'));
  const key = `live|${owner}|${descriptor.t}|${descriptor.i}|${client?.tag ?? ''}`;
  const streams = recallStreams(key) ?? await coalesce(key, async () => {
    const fetched = await fetchStreams(source.base, descriptor.t, descriptor.i, client);
    if (fetched.streams.length) rememberStreams(key, fetched.streams);
    return fetched.streams;
  });
  // A channel runs on without an end; a programme played from its start lasts as the guide says.
  const live = descriptor.k === 'channel';
  const runtime = live ? null : (descriptor.e - descriptor.s) * 1000 * TICKS_PER_MS;
  const seen = new Set<string>();
  const out: any[] = [];
  for (const stream of streams) {
    const playable = toPlayable(stream, allowHeaders);
    if (!playable || seen.has(playable.id)) continue;
    seen.add(playable.id);
    rememberIssued(playable.id, playable.url);
    // A live stream names no file, so its container is read off its URL: MPEG-TS, HLS or a file type.
    const extension = /\.([a-z0-9]{2,4})$/i.exec(playable.url.split('?')[0])?.[1]?.toLowerCase();
    const sent = live ? liveUrlFor(req, playable.url) : { url: playable.url, hls: false };
    const container = sent.hls ? 'hls' : playable.container ?? (extension === 'm3u8' ? 'hls' : extension ?? null);
    out.push({
      ...mediaSourceFor(sent.hls ? { ...playable, url: sent.url } : playable, runtime),
      Container: container,
      ...(live ? { IsInfiniteStream: true, RunTimeTicks: null } : { RunTimeTicks: runtime }),
    });
  }
  // A client picks the version whose id is the item's own, so the first carries it.
  return out.map((s, i) => (i === 0 ? { ...s, Id: itemId, ETag: itemId } : s));
}

// ---------- Routes ----------

export interface LiveTvDeps {
  outsideViewingHours: (req: any) => Promise<boolean>;
}

export function registerLiveTv(router: any, deps: LiveTvDeps): void {
  router.get('/LiveTv/Info', async (req: any, res: any, next: any) => {
    const scope = await scopeOf(req);
    if (!scope?.source) return next();
    res.json({
      Services: [{ Name: 'Stream addon', HomePageUrl: '', Status: 'Ok', StatusMessage: '', Version: '', HasUpdateAvailable: false, IsVisible: true, Tuners: [] }],
      IsEnabled: true,
      // Every profile may use it; some clients look for their user here before showing Live TV.
      EnabledUsers: listProfiles(scope.config, scope.userUUID).map((profile) => profile.userId),
    });
  });

  router.get('/LiveTv/GuideInfo', (_req: any, res: any) => {
    const now = Date.now();
    res.json({ StartDate: iso(now - 7 * DAY_MS), EndDate: iso(now + 7 * DAY_MS) });
  });

  router.get('/LiveTv/Channels', async (req: any, res: any) => {
    const scope = await scopeOf(req);
    if (!scope?.source) {
      res.json(itemList([], 0, 0));
      return;
    }
    await answerChannels(req, res, scope, await groupOf(req, scope));
  });

  router.get('/LiveTv/Channels/:channelId', async (req: any, res: any) => {
    const descriptor = await liveDescriptor(req.params.channelId);
    const scope = descriptor?.k === 'channel' ? await scopeOf(req) : null;
    const item = scope && descriptor ? await itemFor(scope, descriptor, normaliseJellyfinId(req.params.channelId)).catch(() => null) : null;
    if (!item || item.aiostreams?.noMeta) {
      res.status(404).json({ Message: 'Channel not found' });
      return;
    }
    res.json(item);
  });

  router.get('/LiveTv/Programs', (req: any, res: any) => answerProgrammes(req, res, false));
  router.post('/LiveTv/Programs', (req: any, res: any) => answerProgrammes(req, res, false));
  router.get('/LiveTv/Programs/Recommended', (req: any, res: any) => answerProgrammes(req, res, true));

  router.get('/LiveTv/Programs/:programId', async (req: any, res: any) => {
    const descriptor = await liveDescriptor(req.params.programId);
    const scope = descriptor?.k === 'programme' ? await scopeOf(req) : null;
    const item = scope && descriptor ? await itemFor(scope, descriptor, normaliseJellyfinId(req.params.programId)).catch(() => null) : null;
    if (!item) {
      res.status(404).json({ Message: 'Program not found' });
      return;
    }
    res.json(item);
  });

  // The general item routes, for the channels: by id, under the Live TV view or a
  // group, or asked for by their item type, as clients search them.
  router.get(['/Items', '/Users/:userId/Items'], async (req: any, res: any, next: any) => {
    const ids = listParam(req, 'Ids');
    const parent = param(req, 'ParentId');
    const parentDescriptor = parent ? await liveDescriptor(parent) : null;
    const listing = asksForChannels(req) || parentDescriptor?.k === 'livetv' || parentDescriptor?.k === 'channelgroup';
    let named: Array<LiveDescriptor | null> = [];
    if (ids.length) {
      named = await Promise.all(ids.map((id) => liveDescriptor(id)));
      if (named.some((d) => !d)) return next();
    } else if (!listing) {
      return next();
    }
    const scope = await scopeOf(req);
    if (!scope) return next();
    if (ids.length) {
      // The channels are looked up together, as one request to the addon where it takes ids.
      const asked = named.filter((d): d is Channel => d?.k === 'channel');
      const channelItemsById = new Map<string, any>();
      if (asked.length && scope.source) {
        const found = await channelsById(scope.source, asked).catch(() => new Map<string, ChannelInfo>());
        const favourites = new Set(await favouriteChannels(scope.userUUID, scope.config));
        const channelIds = asked.map((d) => channelIdFor(d.t, d.i));
        const built = await channelItems(scope.source, channelIds, found, scope.serverId, favourites, true).catch(() => []);
        for (const item of built) channelItemsById.set(item.Id, item);
      }
      const items = await Promise.all(named.map((d, i) =>
        d!.k === 'channel' ? channelItemsById.get(channelIdFor(d!.t, d!.i)) ?? null : itemFor(scope, d!, normaliseJellyfinId(ids[i])).catch(() => null)));
      const kept = items.filter(Boolean);
      res.json(itemList(kept, kept.length, 0));
      return;
    }
    const group = parentDescriptor?.k === 'channelgroup' ? parentDescriptor.g : await groupOf(req, scope);
    await answerChannels(req, res, scope, group);
  });

  router.get(['/Items/:itemId', '/Users/:userId/Items/:itemId'], async (req: any, res: any, next: any) => {
    const descriptor = await liveDescriptor(req.params.itemId);
    if (!descriptor) return next();
    const scope = await scopeOf(req);
    const item = scope ? await itemFor(scope, descriptor, normaliseJellyfinId(req.params.itemId)).catch(() => null) : null;
    if (!item) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    res.json(item);
  });

  // The channel groups, as the Live TV view's genres.
  router.get('/Genres', async (req: any, res: any, next: any) => {
    const parent = param(req, 'ParentId');
    const descriptor = parent ? await liveDescriptor(parent) : null;
    if (descriptor?.k !== 'livetv' && !(asksForChannels(req) && !parent)) return next();
    const scope = await scopeOf(req);
    const groups = [...new Set((scope?.source?.catalogs ?? []).flatMap((catalog) => catalog.groups))];
    const items = groups.map((group) => namedItem('Genre', group, groupIdFor(group), scope!.serverId));
    res.json(itemList(items, items.length, 0));
  });

  const playbackHandler = async (req: any, res: any, next: any) => {
    const descriptor = await liveDescriptor(req.params.itemId);
    if (!descriptor) return next();
    if (descriptor.k !== 'channel' && descriptor.k !== 'programme') {
      res.status(404).json({ MediaSources: [], PlaySessionId: '', ErrorCode: 'NotAllowed' });
      return;
    }
    if (await deps.outsideViewingHours(req)) {
      res.json({ MediaSources: [], PlaySessionId: randomUUID(), ErrorCode: 'NotAllowed' });
      return;
    }
    const scope = await scopeOf(req);
    const all = scope ? await liveMediaSources(req, scope, descriptor, param(req, 'EnableRequiredHttpHeaders') === true || boolParam(req, 'EnableRequiredHttpHeaders') === true) : [];
    const requested = param(req, 'MediaSourceId') ? normaliseJellyfinId(String(param(req, 'MediaSourceId'))) : null;
    // Named by the id a version was listed with, or by the addon's own one it carries.
    const picked = requested ? all.filter((s) => normaliseJellyfinId(s.Id) === requested || s.aiostreams?.id === requested) : [];
    const sources = picked.length ? picked : all;
    if (!sources.length) {
      res.json({ MediaSources: [], PlaySessionId: randomUUID(), ErrorCode: 'NoCompatibleStream' });
      return;
    }
    res.json({ MediaSources: sources, PlaySessionId: randomUUID() });
  };
  router.get('/Items/:itemId/PlaybackInfo', playbackHandler);
  router.post('/Items/:itemId/PlaybackInfo', playbackHandler);

  // A client that asks the server for the video is sent to the addon's own URL.
  router.get(['/Videos/:itemId/stream', '/Videos/:itemId/stream.:ext', '/Videos/:itemId/stream/:filename'], async (req: any, res: any, next: any) => {
    const descriptor = await liveDescriptor(req.params.itemId);
    if (!descriptor) return next();
    if (descriptor.k !== 'channel' && descriptor.k !== 'programme') {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    const itemId = normaliseJellyfinId(req.params.itemId);
    const wanted = param(req, 'MediaSourceId') ? normaliseJellyfinId(String(param(req, 'MediaSourceId'))) : null;
    const pinned = wanted && wanted !== itemId ? await recallIssued(wanted) : undefined;
    if (pinned) {
      res.redirect(302, descriptor.k === 'channel' ? liveUrlFor(req, pinned).url : pinned);
      return;
    }
    const scope = await scopeOf(req);
    const all = scope ? await liveMediaSources(req, scope, descriptor, false) : [];
    const chosen = wanted ? all.find((s) => normaliseJellyfinId(s.Id) === wanted) : all[0];
    if (!chosen?.Path) {
      res.status(404).json({ Message: 'No playable stream' });
      return;
    }
    res.redirect(302, chosen.Path);
  });

  // A channel's logo, and a programme's picture where its guide has one, sent on as they are.
  router.get(['/Items/:itemId/Images/:imageType', '/Items/:itemId/Images/:imageType/:index'], async (req: any, res: any, next: any) => {
    const descriptor = await liveDescriptor(req.params.itemId);
    if (!descriptor) return next();
    const itemId = normaliseJellyfinId(req.params.itemId);
    const serverId = serverIdFor(req.params.userUUID);
    const type = String(req.params.imageType).toLowerCase();
    let url = ['primary', 'logo', 'thumb'].includes(type) ? (await recallImages(serverId, itemId))?.primary : undefined;
    if (!url && descriptor.k === 'channel' && ['primary', 'logo', 'thumb'].includes(type)) {
      const scope = await scopeOf(req);
      const found = scope?.source ? await channelsById(scope.source, [descriptor]).catch(() => null) : null;
      url = found?.get(itemId)?.logo ?? undefined;
    }
    if (!url) {
      res.status(404).end();
      return;
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.redirect(302, url);
  });

  const favouriteHandler = (favourite: boolean) => async (req: any, res: any, next: any) => {
    const descriptor = await liveDescriptor(req.params.itemId);
    if (descriptor?.k !== 'channel') return next();
    const config = await loadConfig(req);
    if (!config) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }
    const id = channelIdFor(descriptor.t, descriptor.i);
    await setFavouriteChannel(req.params.userUUID, config, id, favourite);
    res.json({ ...EMPTY_USER_DATA, Key: id, ItemId: id, IsFavorite: favourite });
  };
  router.post(['/Users/:userId/FavoriteItems/:itemId', '/UserFavoriteItems/:itemId'], favouriteHandler(true));
  router.delete(['/Users/:userId/FavoriteItems/:itemId', '/UserFavoriteItems/:itemId'], favouriteHandler(false));
}
