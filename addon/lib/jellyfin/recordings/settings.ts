// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import path from 'path';
import consola from 'consola';

const logger = consola.withTag('JellyfinRecordings');

/**
 * Recording Live TV, set up by environment variables only (see docs/live-tv-recordings.md).
 *
 * - `JELLYFIN_RECORDINGS=dispatcharr`: Dispatcharr's own DVR records, keeps and plays them; they
 *   show in Dispatcharr's web app as if set there. Its padding, folders and file names apply.
 *   The default where Live TV comes from Dispatcharr.
 * - `JELLYFIN_RECORDINGS=local`: this server records a channel's stream itself, into
 *   `JELLYFIN_RECORDINGS_DIR`, from any Live TV source.
 * - `JELLYFIN_RECORDINGS=off`: no recording; the default otherwise.
 */
export type RecordingMode = 'dispatcharr' | 'local' | 'off';

export interface RecordingSettings {
  mode: RecordingMode;
  /** The folder a local recording goes in (and its schedule is kept in). */
  dir: string;
  /** Minutes a local recording begins before its programme and runs on after it. */
  preMinutes: number;
  postMinutes: number;
  /** Days a finished local recording is kept; 0 keeps it until it's deleted. */
  keepDays: number;
  /** The most local recordings made at once; one past it is turned down. */
  maxAtOnce: number;
  /** Configurations, profiles or Jellyfin user ids that may record (as JELLYFIN_DISPATCHARR_USERS); empty for all who have Live TV. */
  users: string[];
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  logger.warn(message);
}

/** The settings from the environment; `dispatcharr` says whether Live TV comes from Dispatcharr here. */
export function recordingSettings(dispatcharr: boolean): RecordingSettings {
  const asked = readEnv('JELLYFIN_RECORDINGS')?.toLowerCase();
  let mode: RecordingMode = dispatcharr ? 'dispatcharr' : 'off';
  if (asked === 'dispatcharr' || asked === 'local' || asked === 'off') mode = asked;
  else if (asked !== undefined) warnOnce(`JELLYFIN_RECORDINGS must be dispatcharr, local or off; ${mode} is used`);
  if (mode === 'dispatcharr' && !dispatcharr) {
    warnOnce('JELLYFIN_RECORDINGS=dispatcharr needs Live TV from Dispatcharr (JELLYFIN_DISPATCHARR_URL and a login); recording is off');
    mode = 'off';
  }
  return {
    mode,
    dir: path.resolve(readEnv('JELLYFIN_RECORDINGS_DIR') ?? 'addon/data/recordings'),
    preMinutes: readNumber('JELLYFIN_RECORDINGS_PRE_MINUTES', 1, 0, 120),
    postMinutes: readNumber('JELLYFIN_RECORDINGS_POST_MINUTES', 5, 0, 240),
    keepDays: readNumber('JELLYFIN_RECORDINGS_KEEP_DAYS', 0, 0, 3650),
    maxAtOnce: readNumber('JELLYFIN_RECORDINGS_MAX_AT_ONCE', 4, 1, 50),
    users: (readEnv('JELLYFIN_RECORDINGS_USERS') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
  };
}

/** Changes whenever a setting does. */
export function recordingFingerprint(settings: RecordingSettings): string {
  return JSON.stringify(settings);
}
