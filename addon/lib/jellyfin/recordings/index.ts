// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import type { DispatcharrLive } from '../dispatcharr';
import { allowedFor, type WhoProfile } from '../dispatcharr/settings';
import { DispatcharrRecorder } from './dispatcharr';
import { LocalRecorder, type LocalDeps } from './local';
import { recordingFingerprint, recordingSettings, type RecordingSettings } from './settings';
import type { Recorder } from './types';

export { registerRecordings, type RecordingRouteDeps } from './jellyfin';
export type { ChannelRef, ProgrammeInfo, Recorder } from './types';

const logger = consola.withTag('JellyfinRecordings');

let current: { fingerprint: string; settings: RecordingSettings; recorder: Recorder | null; live: DispatcharrLive | null } | null = null;

/**
 * The recorder the environment sets up, made once and made again when a setting (or Dispatcharr's
 * own setup) changes; null with recording off.
 */
export function currentRecorder(live: DispatcharrLive | null, localDeps: () => LocalDeps): { recorder: Recorder; settings: RecordingSettings } | null {
  const settings = recordingSettings(live !== null);
  const fingerprint = recordingFingerprint(settings);
  if (!current || current.fingerprint !== fingerprint || (settings.mode === 'dispatcharr' && current.live !== live)) {
    current?.recorder?.close().catch(() => undefined);
    let recorder: Recorder | null = null;
    if (settings.mode === 'dispatcharr' && live) recorder = new DispatcharrRecorder(live);
    else if (settings.mode === 'local') recorder = new LocalRecorder(settings, localDeps());
    current = { fingerprint, settings, recorder, live };
    if (recorder) logger.info(recorder.kind === 'dispatcharr' ? "Live TV records with Dispatcharr's DVR" : 'Live TV records to a folder on this server');
  }
  return current.recorder ? { recorder: current.recorder, settings: current.settings } : null;
}

/** Whether this configuration and profile may record: all who have Live TV, or those listed. */
export function mayRecord(settings: RecordingSettings, who: { userUUID?: string; profiles?: WhoProfile[] }): boolean {
  return allowedFor({ users: settings.users } as any, who);
}

/** Stops the recorder (its timers and captures) when the server stops. */
export async function closeRecorder(): Promise<void> {
  await current?.recorder?.close();
  current = null;
}
