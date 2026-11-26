// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { Readable } from 'stream';

/**
 * Recording Live TV, done by one of two recorders behind the same calls: Dispatcharr's own DVR
 * (recordings it makes and keeps, exactly as its web app makes them) or this server, saving a
 * channel's stream to a folder of its own. `settings.ts` says which.
 */

/** A Live TV channel as the Live TV code knows it: its meta's type and id, and its name. */
export interface ChannelRef {
  type: string;
  id: string;
  name: string;
  number?: string;
}

/** What the guide says of a programme. Times are epoch milliseconds, as the guide gives them. */
export interface ProgrammeInfo {
  title: string;
  start: number;
  end: number;
  episodeTitle?: string;
  overview?: string;
  season?: number;
  episode?: number;
  isNew?: boolean;
  live?: boolean;
  genres?: string[];
  image?: string;
}

/**
 * Where a recording is: still to start, being recorded, or over. Over, it was recorded to its end
 * (`completed`), stopped early by someone (`stopped`, what was recorded kept), or cut short by a
 * failure (`interrupted`, with `error` saying why).
 */
export type RecordingState = 'scheduled' | 'recording' | 'completed' | 'stopped' | 'interrupted';

export interface RecordingEntry {
  /** The recorder's own id for it, a whole number. Timers and recordings share it. */
  id: number;
  channel: ChannelRef;
  /** The programme it was set for; absent for a time window set by hand. */
  programme?: ProgrammeInfo;
  /** The window recorded, padding included (epoch ms). */
  start: number;
  end: number;
  state: RecordingState;
  /** The series rule that set it, if one did. */
  seriesId?: number;
  /** There is something to play: finished, or begun and playable as it records. */
  playable: boolean;
  /** Bytes recorded so far, where known. */
  size?: number;
  /** Why it was cut short, in plain words, for an interrupted one. */
  error?: string;
  /** The configuration that set it (its UUID), whose Live TV sources play the channel. */
  owner?: string;
}

/**
 * Record every airing of a programme: by its title, on its own channel or on any, new episodes
 * only or every airing.
 */
export interface SeriesEntry {
  id: number;
  title: string;
  /** The channel it was set on; with `anyChannel` it records the title on every channel. */
  channel?: ChannelRef;
  anyChannel: boolean;
  newOnly: boolean;
  /** The configuration that set it (its UUID). */
  owner?: string;
}

export interface RecordAsk {
  channel: ChannelRef;
  /** The programme to record; its own times are the window, padded by the recorder's padding. */
  programme?: ProgrammeInfo;
  /** A window set by hand (epoch ms), used without a programme: no padding. */
  start?: number;
  end?: number;
  /** The configuration asking (its UUID), kept with the recording. */
  owner?: string;
}

export interface SeriesAsk {
  channel: ChannelRef;
  /** The programme it was asked from: its title is what is matched. */
  programme: ProgrammeInfo;
  anyChannel: boolean;
  newOnly: boolean;
  /** The configuration asking (its UUID), kept with the rule and the recordings it sets. */
  owner?: string;
}

/** A recording's bytes, ready to send: an HTTP status, headers and the body. */
export interface MediaAnswer {
  status: number;
  headers: Record<string, string>;
  body?: Readable;
  /** A redirect within this server's own routes (an in-progress recording's playlist). */
  redirect?: string;
}

export class RecorderError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface Recorder {
  readonly kind: 'dispatcharr' | 'local';
  /** Whether this channel can be recorded here (Dispatcharr's recorder: its own channels only). */
  canRecord(channel: Pick<ChannelRef, 'type' | 'id'>): boolean;
  /** Seconds added before and after a programme. */
  padding(): Promise<{ pre: number; post: number }>;
  /** Every recording: scheduled, in progress and over, newest window last. */
  list(): Promise<RecordingEntry[]>;
  get(id: number): Promise<RecordingEntry | null>;
  record(ask: RecordAsk): Promise<RecordingEntry>;
  /** Taken off before it starts; stopped while it records, what was recorded kept. */
  cancel(id: number): Promise<void>;
  /** Gone, with what was recorded. */
  remove(id: number): Promise<void>;
  series(): Promise<SeriesEntry[]>;
  addSeries(ask: SeriesAsk): Promise<SeriesEntry>;
  /** The rule gone, and the recordings it set that haven't started. */
  removeSeries(id: number): Promise<void>;
  /**
   * The recording's media: the finished file with HTTP ranges, or while it records whatever plays
   * it as it grows. `path` is a file within it for a playlist's parts (`hls/seg_00001.ts`).
   */
  open(id: number, options: { range?: string; path?: string }): Promise<MediaAnswer | null>;
  /** Stops anything running (timers, captures) on shutdown or when the settings change. */
  close(): Promise<void>;
}
