// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import fs from 'fs';
import path from 'path';

/** An ad break in a recording, in seconds from its start. */
export interface AdBreak {
  start: number;
  end: number;
}

/** Breaks shorter than this are left out: a flicker of a mark, not an ad. */
const SHORTEST_S = 1;

/**
 * The ad breaks in an edit list as a commercial detector writes it: one `start end [kind]` line
 * a break, in seconds. Kinds 0 (cut) and 3 (commercial break) are ads, as is a line with no kind;
 * 1 (mute) and 2 (scene marker) aren't. In order, with breaks that touch or overlap joined.
 */
export function parseEditList(text: string): AdBreak[] {
  const found: AdBreak[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const start = Number(parts[0]);
    const end = Number(parts[1]);
    const kind = parts.length > 2 ? Number(parts[2]) : 0;
    if (!Number.isFinite(start) || !Number.isFinite(end) || (kind !== 0 && kind !== 3)) continue;
    const from = Math.max(0, start);
    if (end - from < SHORTEST_S) continue;
    found.push({ start: from, end });
  }
  found.sort((a, b) => a.start - b.start);
  const joined: AdBreak[] = [];
  for (const brk of found) {
    const last = joined[joined.length - 1];
    if (last && brk.start <= last.end + 0.5) last.end = Math.max(last.end, brk.end);
    else joined.push({ ...brk });
  }
  return joined;
}

/** Shorter than this, a recording can't be told apart from its ads: a detector marks it all. */
const SHORTEST_RECORDING_S = 5 * 60;
/** More of a recording than this marked as ads, and the marks are wrong: even a channel heavy with them shows more programme than ads. */
const MOST_ADS = 0.5;

/**
 * The breaks, where they could be right for a recording this long (seconds; unknown, as marked):
 * none for a recording too short to tell, or where they take in most of it, as a detector's do on
 * a clip with nothing but itself to compare.
 */
export function believable(breaks: AdBreak[], length: number | undefined): AdBreak[] {
  if (!breaks.length || length === undefined || !Number.isFinite(length) || length <= 0) return breaks;
  if (length < SHORTEST_RECORDING_S) return [];
  const marked = breaks.reduce((sum, brk) => sum + Math.max(0, Math.min(brk.end, length) - Math.max(brk.start, 0)), 0);
  return marked > length * MOST_ADS ? [] : breaks;
}

/**
 * A file the recorder names by its own path (as its container sees it), found in `folder`, where
 * this server sees the recorder's recordings: the longest end of the path that's there, so the
 * folder may be the recorder's recordings folder or any one above it. Nothing outside `folder`.
 */
export function findIn(folder: string, recorderPath: string): string | null {
  const parts = recorderPath.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((part) => part === '..' || part === '.')) return null;
  const root = path.resolve(folder);
  for (let i = 0; i < parts.length; i++) {
    const candidate = path.join(root, ...parts.slice(i));
    if (!candidate.startsWith(root + path.sep)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here; a shorter end of the path next
    }
  }
  return null;
}

const read = new Map<string, { modified: number; breaks: AdBreak[] }>();

/** The ad breaks in an edit list on disk, read again only once it changes; null where there's none. */
export function readAdMarks(folder: string, recorderPath: string): AdBreak[] | null {
  const file = findIn(folder, recorderPath);
  if (!file) return null;
  try {
    const modified = fs.statSync(file).mtimeMs;
    const kept = read.get(file);
    if (kept && kept.modified === modified) return kept.breaks;
    const breaks = parseEditList(fs.readFileSync(file, 'utf8'));
    read.set(file, { modified, breaks });
    return breaks;
  } catch {
    return null;
  }
}
