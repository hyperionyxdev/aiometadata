// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { bytesOf, clipped, idOf, MAX_NAME, MAX_TEXT, shortOf, urlOf } from './bounds';
import { timeOf } from './query';

const MAX_LISTED = 30;

export interface Programme {
  id: string;
  title: string;
  start: number;
  end: number;
  overview?: string;
  image?: string;
  background?: string;
  genres?: string[];
  cast?: string[];
  directors?: string[];
  season?: number;
  episode?: number;
  imdbId?: string;
  /** The episode's own name, or the line a guide shows under the programme's. */
  episodeTitle?: string;
  /** Marked by the guide as live (a game, a broadcast as it happens) or not; unset where it doesn't say. */
  live?: boolean;
  isNew?: boolean;
  premiere?: boolean;
  finale?: boolean;
  /** Made up by the guide for a channel with no real listings. */
  placeholder?: boolean;
}

const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

// Sliced, as a filtered list keeps spare room.
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.slice(0, MAX_LISTED).map((v) => clipped(v, MAX_NAME)).filter((v): v is string => v !== undefined).slice() : [];

function wholeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function programmesOf(entry: any): Programme[] {
  const parsed: Programme[] = [];
  for (const video of Array.isArray(entry?.videos) ? entry.videos : []) {
    const id = idOf(video?.id);
    const start = timeOf(video?.startTime);
    const end = timeOf(video?.endTime);
    if (!id || start === null || end === null || end <= start) continue;
    const programme: Programme = { id, title: clipped(video.title, MAX_NAME) ?? clipped(video.name, MAX_NAME) ?? '', start, end };
    const overview = clipped(video.description, MAX_TEXT) ?? clipped(video.overview, MAX_TEXT);
    if (overview) programme.overview = overview;
    const image = urlOf(video.thumbnail);
    const background = urlOf(video.background);
    if (image) programme.image = image;
    if (background) programme.background = background;
    for (const key of ['genres', 'cast', 'directors'] as const) {
      const list = strings(video[key]);
      if (list.length) programme[key] = list;
    }
    const season = wholeNumber(video.season);
    const episode = wholeNumber(video.episode);
    if (season !== undefined) programme.season = season;
    if (episode !== undefined) programme.episode = episode;
    const imdbId = shortOf(video.imdbId);
    if (imdbId) programme.imdbId = imdbId;
    const episodeTitle = clipped(video.episodeTitle, MAX_NAME);
    if (episodeTitle) programme.episodeTitle = episodeTitle;
    const live = flag(video.isLive);
    if (live !== undefined) programme.live = live;
    for (const key of ['isNew', 'premiere', 'finale', 'placeholder'] as const) {
      if (flag(video[key]) === true) programme[key] = true;
    }
    parsed.push(programme);
  }
  parsed.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Programme[] = [];
  for (const programme of parsed) {
    const last = kept[kept.length - 1];
    if (last && last.start === programme.start) continue;
    if (last && last.end > programme.start) last.end = programme.start;
    kept.push(programme);
  }
  return kept;
}

export function airingAt(programmes: Programme[] | undefined, atMs: number): Programme | undefined {
  return programmes?.find((p) => p.start <= atMs && atMs < p.end);
}

export function listSize(programmes: Programme[]): number {
  let size = 200;
  for (const programme of programmes) {
    size += 200;
    for (const value of Object.values(programme)) {
      if (typeof value === 'string') size += bytesOf(value);
      else if (Array.isArray(value)) for (const part of value) size += bytesOf(part);
    }
  }
  return size;
}

export function pageSize(programmes: Map<string, Programme[]>): number {
  let size = 200;
  for (const [key, list] of programmes) size += bytesOf(key) + listSize(list);
  return size;
}
