// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { RecorderError } from './types';

/**
 * Repeating recordings: a time slot on chosen weekdays, from one day to another. Dispatcharr keeps
 * one as weekdays, times of day and dates in its own time zone; a client asks with the first
 * recording's window, and weekdays and a last day in its own zone. Here are the clocks of both
 * zones, the one turned into the other, and the recordings a schedule sets.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** With no last day asked for, it repeats this many days on (Dispatcharr sets every one at once). */
export const REPEAT_DAYS = 90;
/** The most days on one may repeat for. */
export const MAX_REPEAT_DAYS = 400;
/** The longest window one may record. */
const MAX_WINDOW_MS = DAY_MS;

/** Weekday names, Monday first, as Jellyfin's `Days` name them; the index is Dispatcharr's number for the day. */
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** A day and a time of day, as a clock in some time zone shows them. */
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * A repeating schedule as Dispatcharr keeps it, read: weekdays (0 for Monday), times of day in
 * seconds (an end no later than the start is on the next day), and the first and last days a
 * recording may start on as day numbers (days since 1970-01-01), null for no bound.
 */
export interface Repeat {
  days: number[];
  start: number;
  end: number;
  from: number | null;
  until: number | null;
}

/** A repeating schedule as Dispatcharr's recurring rules take it. */
export interface RepeatRule {
  days_of_week: number[];
  start_time: string;
  end_time: string;
  start_date: string;
  end_date: string;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(zone, format);
  }
  return format;
}

/** Whether this names a time zone the clocks here know (an IANA name, such as Europe/London). */
export function isTimeZone(zone: unknown): boolean {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try {
    formatFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** What a clock in the zone shows at this instant, to the second. */
export function wallOf(ms: number, zone: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatFor(zone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

const asUtc = (wall: Wall): number => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

/** How far the zone's clocks are ahead of UTC at this instant, in ms. */
function offsetAt(ms: number, zone: string): number {
  return asUtc(wallOf(ms, zone)) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a clock in the zone shows this day and time. Shown twice on the night the clocks go
 * back: the first. Never shown on the night they go forward: read with the offset before the
 * change, so as much later as the clocks skipped, as Dispatcharr reads such a time.
 */
export function instantOf(wall: Wall, zone: string): number {
  const local = asUtc(wall);
  const before = offsetAt(local - DAY_MS, zone);
  // The offset where that time would be, found again from where the first guess lands.
  let guess = local - offsetAt(local, zone);
  guess = local - offsetAt(guess, zone);
  const fits = [local - before, guess, local - offsetAt(local + DAY_MS, zone)].filter((at) => asUtc(wallOf(at, zone)) === local);
  return fits.length ? Math.min(...fits) : local - before;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** A day's number (days since 1970-01-01) for the day a wall shows. */
export const dayNumberOf = (wall: Pick<Wall, 'year' | 'month' | 'day'>): number => Math.round(Date.UTC(wall.year, wall.month - 1, wall.day) / DAY_MS);

/** A day number written "YYYY-MM-DD". */
export function dayText(number: number): string {
  const date = new Date(number * DAY_MS);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

/** The weekday of a day number, 0 for Monday to 6 for Sunday. */
export const weekdayOf = (number: number): number => (new Date(number * DAY_MS).getUTCDay() + 6) % 7;

/** A day written "YYYY-MM-DD" as its number (anything after the date, such as a time, left out), or null. */
export function parseDay(text: unknown): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text ?? '').trim());
  if (!match) return null;
  const number = dayNumberOf({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
  return dayText(number) === match[0] ? number : null;
}

/** A time of day written "HH:MM" or "HH:MM:SS" (a fraction of a second left out) as seconds into the day, or null. */
export function parseTime(text: unknown): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  return hour < 24 && minute < 60 && second < 60 ? hour * 3600 + minute * 60 + second : null;
}

/** Seconds into the day written "HH:MM:SS". */
export const timeText = (seconds: number): string => `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;

const secondsOf = (wall: Wall): number => wall.hour * 3600 + wall.minute * 60 + wall.second;

function wallAt(day: number, seconds: number): Wall {
  const date = new Date(day * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: Math.floor(seconds / 3600),
    minute: Math.floor(seconds / 60) % 60,
    second: seconds % 60,
  };
}

/** A recurring rule's days, times and dates as Dispatcharr gives them, read; null where its times can't be. */
export function readRepeat(rule: any): Repeat | null {
  const start = parseTime(rule?.start_time);
  const end = parseTime(rule?.end_time);
  if (start === null || end === null) return null;
  const listed: unknown[] = Array.isArray(rule?.days_of_week) ? rule.days_of_week : [];
  const days = [...new Set(listed.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
  return { days, start, end, from: parseDay(rule?.start_date), until: parseDay(rule?.end_date) };
}

/** The recording it sets on a day, as Dispatcharr sets it: from its start, to its end that day or the next where that's no later. */
function onDay(repeat: Repeat, day: number, zone: string): { start: number; end: number } {
  const start = instantOf(wallAt(day, repeat.start), zone);
  let end = instantOf(wallAt(day, repeat.end), zone);
  if (end <= start) end = instantOf(wallAt(day + 1, repeat.end), zone);
  return { start, end };
}

/** The next recording it sets that hasn't ended by `now` (one under way included), or null when none is left. */
export function nextOf(repeat: Repeat, zone: string, now: number): { start: number; end: number } | null {
  if (!repeat.days.length) return null;
  // From the day before today there, for one that runs past midnight and is still recording.
  let day = dayNumberOf(wallOf(now, zone)) - 1;
  if (repeat.from !== null && repeat.from > day) day = repeat.from;
  const last = repeat.until ?? day + 8;
  for (; day <= last; day++) {
    if (!repeat.days.includes(weekdayOf(day))) continue;
    const at = onDay(repeat, day, zone);
    if (at.end > now) return at;
  }
  return null;
}

/** The last recording it sets, or null where it has no last day. */
export function lastOf(repeat: Repeat, zone: string): { start: number; end: number } | null {
  if (repeat.until === null || !repeat.days.length) return null;
  for (let day = repeat.until; day > repeat.until - 7 && (repeat.from === null || day >= repeat.from); day--) {
    if (repeat.days.includes(weekdayOf(day))) return onDay(repeat, day, zone);
  }
  return null;
}

/**
 * The schedule asked for (the first recording's window, and weekdays and a last day in the asker's
 * time zone) as Dispatcharr keeps it, in its own zone `zone`: the window's times of day there; the
 * weekdays moved by as many days as the first recording's date differs between the two zones; from
 * the first recording's day there, to the last day there a recording starts before the end of the
 * last day asked for (90 days on where none is, 400 at most). Refused in plain words where it
 * can't be one.
 */
export function repeatRuleOf(ask: { start: number; end: number; days: number[]; timeZone?: string; until?: string }, zone: string, now: number): RepeatRule {
  const { start, end } = ask;
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new RecorderError('A repeating recording needs a start and an end');
  if (end <= start) throw new RecorderError('A repeating recording has to end after it starts');
  if (end - start > MAX_WINDOW_MS) throw new RecorderError('A repeating recording can be 24 hours long at most');
  const asked = [...new Set(ask.days ?? [])].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (!asked.length) throw new RecorderError('Choose at least one day for it to repeat on');
  const theirs = ask.timeZone ?? zone;
  if (!isTimeZone(theirs)) throw new RecorderError(`"${String(theirs).slice(0, 60)}" isn't a time zone`);

  const first = wallOf(start, zone);
  const firstDay = dayNumberOf(first);
  const shift = firstDay - dayNumberOf(wallOf(start, theirs));
  const days = [...new Set(asked.map((day) => (((day + shift) % 7) + 7) % 7))].sort((a, b) => a - b);
  const startSeconds = secondsOf(first);
  const endSeconds = secondsOf(wallOf(end, zone));

  let lastDay = firstDay + REPEAT_DAYS;
  if (ask.until !== undefined) {
    const until = parseDay(ask.until);
    if (until === null) throw new RecorderError('The last day must be a date (YYYY-MM-DD)');
    // The end of that day where it was asked; then the last day here a recording starts by then.
    const ends = instantOf(wallAt(until + 1, 0), theirs) - 1;
    lastDay = dayNumberOf(wallOf(ends, zone));
    if (instantOf(wallAt(lastDay, startSeconds), zone) > ends) lastDay -= 1;
    if (lastDay < firstDay) throw new RecorderError("The last day can't be before the first recording's");
  }
  lastDay = Math.min(lastDay, firstDay + MAX_REPEAT_DAYS);

  let firstDate = firstDay;
  // Dispatcharr wants its last day and end time after its first day and start time, so one that
  // runs past midnight, recorded on its first day only, needs a day either side with nothing on it.
  if (lastDay === firstDay && endSeconds <= startSeconds) {
    if (!days.includes(weekdayOf(firstDay + 1))) lastDay = firstDay + 1;
    else if (!days.includes(weekdayOf(firstDay - 1))) firstDate = firstDay - 1;
    else throw new RecorderError('It would record only once: set it as a single recording instead');
  }

  const repeat: Repeat = { days, start: startSeconds, end: endSeconds, from: firstDate, until: lastDay };
  if (!nextOf(repeat, zone, now)) throw new RecorderError('Every time it would record is already over');
  return { days_of_week: days, start_time: timeText(startSeconds), end_time: timeText(endSeconds), start_date: dayText(firstDate), end_date: dayText(lastDay) };
}
