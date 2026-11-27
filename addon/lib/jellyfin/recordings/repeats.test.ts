// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// Repeating recordings' clocks: wall times in a time zone and back, a schedule asked for in one zone
// as Dispatcharr keeps it in another, and the recordings it sets. Fixed dates, so DST is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instantOf, isTimeZone, lastOf, nextOf, readRepeat, repeatRuleOf, wallOf } from './repeats';

const MIN = 60 * 1000;
const at = (text: string) => Date.parse(text);
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = at('2026-11-27T12:00:00Z');

test('a wall time in a zone is the instant its clocks show it, across the clocks changing', () => {
  assert.equal(iso(instantOf({ year: 2030, month: 1, day: 7, hour: 22, minute: 30, second: 0 }, 'America/Los_Angeles')), '2030-01-08T06:30:00.000Z');
  assert.equal(iso(instantOf({ year: 2030, month: 7, day: 1, hour: 9, minute: 0, second: 0 }, 'Europe/London')), '2030-07-01T08:00:00.000Z');
  // Skipped when the clocks go forward: read with the offset before, so an hour later.
  assert.equal(iso(instantOf({ year: 2030, month: 3, day: 10, hour: 2, minute: 30, second: 0 }, 'America/Los_Angeles')), '2030-03-10T10:30:00.000Z');
  // Shown twice when they go back: the first.
  assert.equal(iso(instantOf({ year: 2030, month: 11, day: 3, hour: 1, minute: 30, second: 0 }, 'America/Los_Angeles')), '2030-11-03T08:30:00.000Z');
  assert.deepEqual(wallOf(at('2030-01-08T06:30:00Z'), 'America/Los_Angeles'), { year: 2030, month: 1, day: 7, hour: 22, minute: 30, second: 0 });
  assert.equal(isTimeZone('Asia/Tokyo'), true);
  assert.equal(isTimeZone('Nowhere/Special'), false);
  assert.equal(isTimeZone(''), false);
});

test('asked ahead of Dispatcharr, the days move back a day, and the last day ends before the next', () => {
  // 05:00 on Tuesday in UTC is 21:00 on Monday in Los Angeles.
  const rule = repeatRuleOf({ start: at('2030-01-08T05:00:00Z'), end: at('2030-01-08T06:00:00Z'), days: [1], timeZone: 'UTC', until: '2030-01-15' }, 'America/Los_Angeles', NOW);
  assert.deepEqual(rule, { days_of_week: [0], start_time: '21:00:00', end_time: '22:00:00', start_date: '2030-01-07', end_date: '2030-01-14' });
});

test('a schedule in the same zone is kept as asked; with no last day it repeats 90 days, at most 400', () => {
  const start = at('2030-01-07T09:00:00Z');
  const ask = { start, end: start + 30 * MIN, days: [0, 1, 2, 3, 4], timeZone: 'Europe/London' };
  assert.deepEqual(repeatRuleOf(ask, 'Europe/London', NOW), { days_of_week: [0, 1, 2, 3, 4], start_time: '09:00:00', end_time: '09:30:00', start_date: '2030-01-07', end_date: '2030-04-07' });
  assert.equal(repeatRuleOf({ ...ask, until: '2035-01-01' }, 'Europe/London', NOW).end_date, '2031-02-11');
  // No zone given: the days are Dispatcharr's own.
  assert.deepEqual(repeatRuleOf({ start, end: start + 30 * MIN, days: [0] }, 'Asia/Tokyo', NOW).days_of_week, [0]);
});

test('one that runs past midnight on its first day only is set so Dispatcharr takes it', () => {
  const start = at('2030-01-07T23:00:00Z');
  const once = repeatRuleOf({ start, end: start + 120 * MIN, days: [0], timeZone: 'UTC', until: '2030-01-07' }, 'UTC', NOW);
  assert.deepEqual(once, { days_of_week: [0], start_time: '23:00:00', end_time: '01:00:00', start_date: '2030-01-07', end_date: '2030-01-08' });
  assert.throws(() => repeatRuleOf({ start, end: start + 120 * MIN, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'UTC', until: '2030-01-07' }, 'UTC', NOW), /only once/);
});

test('the next recording is the first not ended, one under way past midnight included; the last is on the last day', () => {
  const repeat = readRepeat({ days_of_week: [0, 4], start_time: '23:30:00', end_time: '00:30:00', start_date: '2030-01-07', end_date: '2030-01-31', name: '' });
  assert.ok(repeat);
  assert.equal(iso(nextOf(repeat, 'UTC', NOW)!.start), '2030-01-07T23:30:00.000Z');
  // Under way, a quarter past midnight on Tuesday: still the one begun on Monday.
  assert.deepEqual(nextOf(repeat, 'UTC', at('2030-01-08T00:15:00Z')), { start: at('2030-01-07T23:30:00Z'), end: at('2030-01-08T00:30:00Z') });
  assert.equal(iso(nextOf(repeat, 'UTC', at('2030-01-08T00:45:00Z'))!.start), '2030-01-11T23:30:00.000Z');
  assert.equal(nextOf(repeat, 'UTC', at('2030-02-02T00:00:00Z')), null);
  assert.equal(iso(lastOf(repeat, 'UTC')!.start), '2030-01-28T23:30:00.000Z');
  // In a zone with summer time, each one at its own wall time.
  const london = readRepeat({ days_of_week: [6], start_time: '09:00', end_time: '10:00', start_date: '2030-03-24', end_date: '2030-04-07' });
  assert.equal(iso(nextOf(london, 'Europe/London', NOW)!.start), '2030-03-24T09:00:00.000Z');
  assert.equal(iso(lastOf(london, 'Europe/London')!.start), '2030-04-07T08:00:00.000Z');
});
