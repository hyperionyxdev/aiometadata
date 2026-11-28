// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createHash } from 'crypto';
import consola from 'consola';

const logger = consola.withTag('JellyfinDispatcharr');

/**
 * Live TV read straight from Dispatcharr, set up by environment variables only (see
 * docs/live-tv-dispatcharr.md). Without `JELLYFIN_DISPATCHARR_URL` and a login, Live TV comes
 * from the stream addon as before.
 */
export interface DispatcharrSettings {
  /** The API base the server reaches. */
  url: string;
  /** The base players are sent to for channels, catch-up and logos. */
  streamUrl: string;
  apiKey?: string;
  username?: string;
  password?: string;
  /** A Host header sent in place of the URL's own (a container name Dispatcharr refuses). */
  hostHeader?: string;
  /** An XC login: only that user's channels, Auto played as that user, and catch-up. */
  xc?: { username: string; password: string };
  /** The `output_format` asked of channel links, or none for Dispatcharr's own. */
  outputFormat?: string;
  /** Configurations, profiles or Jellyfin user ids that get this Live TV; empty for all. */
  users: string[];
  /** Only these channel groups, in this order; empty for all, in channel-number order. */
  groups: string[];
  /** The label before a channel's sources ("Dispatcharr · Auto"). */
  name: string;
  /** First, a source that plays the channel as it is and lets Dispatcharr fail over. */
  autoSource: boolean;
  /** Picking a stream switches the channel to it with Dispatcharr's own switcher (admin key). */
  switchStreams: boolean;
  timeoutMs: number;
  /** How long the channel list and a day of the guide are used before they are read again. */
  cacheMs: number;
}

const FORMATS = new Set(['mpegts', 'ts', 'hls', 'm3u8', 'fmp4', 'mp4']);

// Read by name at call time, so a test or a restart with other values sees them.
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readList(name: string): string[] {
  return (readEnv(name) ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readFlag(name: string, fallback: boolean): boolean {
  const value = readEnv(name)?.toLowerCase();
  if (value === undefined) return fallback;
  return !['false', '0', 'no', 'off'].includes(value);
}

function readSeconds(name: string, fallback: number, min: number): number {
  const parsed = Number(readEnv(name));
  return (Number.isFinite(parsed) ? Math.max(min, parsed) : fallback) * 1000;
}

const withoutSlash = (value: string) => value.replace(/\/+$/, '');

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  logger.warn(message);
}

let turnedOff: boolean | undefined;

/** The dashboard's switch: on unless turned off. Said in the log as it changes. */
function switchedOn(): boolean {
  const on = readFlag('JELLYFIN_DISPATCHARR_ENABLED', true);
  if (turnedOff !== undefined && turnedOff === on) {
    logger.info(on ? 'Dispatcharr Live TV turned back on' : "Dispatcharr Live TV turned off: Live TV comes from the stream addon, and recording through Dispatcharr's DVR is off");
  }
  turnedOff = !on;
  return on;
}

/**
 * The settings from the environment, or null when Dispatcharr Live TV is not set up (or set up
 * wrongly), or turned off in the dashboard (`JELLYFIN_DISPATCHARR_ENABLED`). Off, everything that
 * asks here (the lineup, the guide, playback, Dispatcharr's DVR) finds it not set up: Live TV comes
 * from the stream addon, and the logins stay in the environment for when it's back on.
 */
export function dispatcharrSettings(): DispatcharrSettings | null {
  if (!switchedOn()) return null;
  const rawUrl = readEnv('JELLYFIN_DISPATCHARR_URL');
  if (!rawUrl) return null;
  let url: string;
  try {
    const parsed = new URL(rawUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http');
    url = withoutSlash(parsed.toString());
  } catch {
    warnOnce('JELLYFIN_DISPATCHARR_URL is not an http(s) address; Live TV comes from the stream addon');
    return null;
  }
  const apiKey = readEnv('JELLYFIN_DISPATCHARR_API_KEY');
  const username = readEnv('JELLYFIN_DISPATCHARR_USERNAME');
  const password = readEnv('JELLYFIN_DISPATCHARR_PASSWORD');
  if (!apiKey && !(username && password)) {
    warnOnce('JELLYFIN_DISPATCHARR_URL is set without JELLYFIN_DISPATCHARR_API_KEY, or a username and password; Live TV comes from the stream addon');
    return null;
  }
  // `default`, the dashboard's own choice for this, is the same as leaving it unset.
  const chosen = readEnv('JELLYFIN_DISPATCHARR_OUTPUT_FORMAT')?.toLowerCase();
  const format = chosen === 'default' ? undefined : chosen;
  if (format && !FORMATS.has(format)) {
    warnOnce('JELLYFIN_DISPATCHARR_OUTPUT_FORMAT must be default, mpegts, hls or fmp4; Dispatcharr\'s own format is used');
  }
  const xcUser = readEnv('JELLYFIN_DISPATCHARR_XC_USERNAME');
  const xcPassword = readEnv('JELLYFIN_DISPATCHARR_XC_PASSWORD');
  let streamUrl = url;
  const rawStream = readEnv('JELLYFIN_DISPATCHARR_STREAM_URL');
  if (rawStream) {
    try {
      streamUrl = withoutSlash(new URL(rawStream).toString());
    } catch {
      warnOnce('JELLYFIN_DISPATCHARR_STREAM_URL is not an address; players are sent to JELLYFIN_DISPATCHARR_URL');
    }
  }
  return {
    url,
    streamUrl,
    apiKey,
    username: apiKey ? undefined : username,
    password: apiKey ? undefined : password,
    hostHeader: readEnv('JELLYFIN_DISPATCHARR_HOST_HEADER'),
    xc: xcUser && xcPassword ? { username: xcUser, password: xcPassword } : undefined,
    outputFormat: format && FORMATS.has(format) ? format : undefined,
    users: readList('JELLYFIN_DISPATCHARR_USERS'),
    groups: readList('JELLYFIN_DISPATCHARR_GROUPS'),
    name: readEnv('JELLYFIN_DISPATCHARR_NAME') ?? 'Dispatcharr',
    autoSource: readFlag('JELLYFIN_DISPATCHARR_AUTO_SOURCE', true),
    switchStreams: readFlag('JELLYFIN_DISPATCHARR_SWITCH_STREAMS', false),
    timeoutMs: readSeconds('JELLYFIN_DISPATCHARR_TIMEOUT', 90, 5),
    cacheMs: readSeconds('JELLYFIN_DISPATCHARR_CACHE_SECONDS', 300, 30),
  };
}

/** Changes whenever any setting does, without holding a secret in the clear. */
export function settingsFingerprint(settings: DispatcharrSettings): string {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

const normalised = (value: string) => value.trim().toLowerCase().replace(/-/g, '');

/** A profile of a configuration: its id (null for the main user) and the Jellyfin user id the server makes from both. */
export interface WhoProfile {
  id: string | null;
  userId: string;
}

/**
 * Whether a configuration gets Dispatcharr Live TV for any of these profiles: every one when the
 * list is empty. Otherwise only names the server makes, never ones a configuration's owner writes:
 * a configuration UUID (every profile in it), a profile's Jellyfin user id (made from that UUID and
 * the profile), or `<configuration UUID>/<profile id>`. A bare profile id is not enough, since any
 * configuration can give one of its profiles the same id. Dispatcharr's login is the server's, so
 * an open server lists who may use it.
 */
export function allowedFor(settings: DispatcharrSettings, who: { userUUID?: string; profiles?: WhoProfile[] }): boolean {
  if (!settings.users.length) return true;
  if (!who.userUUID) return false;
  const uuid = normalised(who.userUUID);
  const profiles = who.profiles ?? [];
  return settings.users.some((entry) => {
    const slash = entry.indexOf('/');
    if (slash < 0) {
      const name = normalised(entry);
      return name === uuid || profiles.some((profile) => normalised(profile.userId) === name);
    }
    const profileId = entry.slice(slash + 1).trim().toLowerCase();
    return normalised(entry.slice(0, slash)) === uuid && !!profileId
      && profiles.some((profile) => profile.id !== null && profile.id.trim().toLowerCase() === profileId);
  });
}
