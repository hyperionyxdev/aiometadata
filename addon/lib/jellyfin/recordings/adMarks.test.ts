// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// A recording's ads, read from the edit list a commercial detector writes beside it: which lines
// are ads, and finding the list where this server sees the recorder's folder.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findIn, parseEditList, readAdMarks } from './adMarks';

let folder = '';

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-marks-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

function put(relative: string, text: string): string {
  const file = path.join(folder, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('cuts and commercial breaks are ads; mutes, scene marks and flickers are not', () => {
  const text = ['0.00\t12.50\t0', '600.2 780.9 3', '900 905 1', '1000 1001 2', '1200.0\t1200.4\t0', 'junk line', '1500 1620'].join('\n');
  assert.deepEqual(parseEditList(text), [
    { start: 0, end: 12.5 },
    { start: 600.2, end: 780.9 },
    { start: 1500, end: 1620 },
  ]);
});

test('breaks that touch or overlap are one; out of order, they are put in order', () => {
  assert.deepEqual(parseEditList('300 400 0\n100 200 0\n399.8 450 0\r\n-2 50 0\n'), [
    { start: 0, end: 50 },
    { start: 100, end: 200 },
    { start: 300, end: 450 },
  ]);
});

test("the list is found whichever of the recorder's folders is shared", () => {
  const file = put('TV/News/News 2026-11-27.edl', '1 2 0');
  // The recorder's recordings folder shared as it is, or the folder above it.
  assert.equal(findIn(folder, '/data/recordings/TV/News/News 2026-11-27.edl'), file);
  assert.equal(findIn(path.join(folder, 'TV'), '/data/recordings/TV/News/News 2026-11-27.edl'), path.join(folder, 'TV/News/News 2026-11-27.edl'));
  assert.equal(findIn(folder, '/data/recordings/TV/News/Another.edl'), null);
});

test('nothing outside the shared folder is read', () => {
  put('secret.edl', '1 2 0');
  const inside = path.join(folder, 'inside');
  fs.mkdirSync(inside);
  assert.equal(findIn(inside, '/data/../secret.edl'), null);
  assert.equal(findIn(inside, '../secret.edl'), null);
});

test('the list is read again once it changes', () => {
  const file = put('a/show.edl', '10 20 0');
  assert.deepEqual(readAdMarks(folder, '/rec/a/show.edl'), [{ start: 10, end: 20 }]);
  fs.writeFileSync(file, '10 20 0\n30 40 0');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.deepEqual(readAdMarks(folder, '/rec/a/show.edl'), [{ start: 10, end: 20 }, { start: 30, end: 40 }]);
  assert.equal(readAdMarks(folder, '/rec/a/missing.edl'), null);
});
