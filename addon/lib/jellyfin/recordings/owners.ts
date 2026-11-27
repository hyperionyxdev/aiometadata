// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import fs from 'fs';
import path from 'path';
import consola from 'consola';

const logger = consola.withTag('JellyfinRecordings');

/** A recording, a series (a programme's title), or a repeating schedule (a time slot on weekdays). */
export type OwnedKind = 'recording' | 'series' | 'slot';

interface Stored {
  recordings: Record<string, string[]>;
  series: Record<string, string[]>;
  /** Missing from a file kept before repeating schedules were: none are owned. */
  slots: Record<string, string[]>;
}

/**
 * Who set each recording, series and repeating schedule: the profiles that asked for it
 * (`<configuration>` for a configuration's main profile, `<configuration>/<profile>` for another),
 * by the recorder's own id. Two profiles asking for the same programme share the one recording;
 * it's gone once neither wants it. Kept in a file beside the server's data (`addon/data`, on a
 * volume in the usual setup), as neither recorder keeps who asked: Dispatcharr's has no profiles,
 * and the server's own keeps one. One set before this was kept, or in Dispatcharr's own web app,
 * has no owner: the household's.
 */
export class RecordingOwners {
  private data: Stored | null = null;

  constructor(private readonly file: string) {}

  private read(): Stored {
    if (this.data) return this.data;
    let stored: Stored = { recordings: {}, series: {}, slots: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      stored = { recordings: { ...(parsed?.recordings ?? {}) }, series: { ...(parsed?.series ?? {}) }, slots: { ...(parsed?.slots ?? {}) } };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') logger.warn(`Who set each recording couldn't be read; starting afresh: ${error?.message || error}`);
    }
    this.data = stored;
    return stored;
  }

  private write(): void {
    const data = this.read();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(data));
      fs.renameSync(temporary, this.file);
    } catch (error: any) {
      logger.warn(`Who set each recording couldn't be kept: ${error?.message || error}`);
    }
  }

  private table(kind: OwnedKind): Record<string, string[]> {
    const data = this.read();
    if (kind === 'recording') return data.recordings;
    return kind === 'series' ? data.series : data.slots;
  }

  private static key(recorder: string, id: number): string {
    return `${recorder}:${id}`;
  }

  /** Who set it, oldest first; none for one set before owners were kept. */
  owners(kind: OwnedKind, recorder: string, id: number): string[] {
    return [...(this.table(kind)[RecordingOwners.key(recorder, id)] ?? [])];
  }

  add(kind: OwnedKind, recorder: string, id: number, owner: string): void {
    if (!owner) return;
    const table = this.table(kind);
    const key = RecordingOwners.key(recorder, id);
    const list = table[key] ?? [];
    if (list.includes(owner)) return;
    table[key] = [...list, owner];
    this.write();
  }

  /** One owner let go; who's left. */
  remove(kind: OwnedKind, recorder: string, id: number, owner: string): string[] {
    const table = this.table(kind);
    const key = RecordingOwners.key(recorder, id);
    const left = (table[key] ?? []).filter((entry) => entry !== owner);
    if (left.length) table[key] = left;
    else delete table[key];
    this.write();
    return left;
  }

  /** It's gone: so is who set it. */
  forget(kind: OwnedKind, recorder: string, id: number): void {
    const table = this.table(kind);
    const key = RecordingOwners.key(recorder, id);
    if (!(key in table)) return;
    delete table[key];
    this.write();
  }

}

let shared: RecordingOwners | null = null;

/** The server's one store of who set each recording, in its data folder. */
export function recordingOwners(): RecordingOwners {
  if (!shared) shared = new RecordingOwners(path.resolve('addon/data/recording-owners.json'));
  return shared;
}

/** Another store in its place (a test's own file); nil goes back to the data folder's. */
export function useRecordingOwners(store: RecordingOwners | null): void {
  shared = store;
}

/** The configuration an owner belongs to. */
export function configurationOf(owner: string): string {
  return owner.split('/')[0];
}
