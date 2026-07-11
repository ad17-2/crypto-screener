import type Database from 'better-sqlite3';
import { latestRunAgeSeconds, latestRunGeneratedAt } from '../dashboard/freshness.js';
import type { DailyRefreshTime } from '../env.js';
import type { RefreshRuntime } from './runtime.js';

/**
 * Due-ness is recomputed from the latest run's `generated_at` on every tick, not a persisted
 * "next fire time" — a restart can't double-fire (the just-written run is already newer than
 * today's target) or skip a day (a missed target is still in the past and still due).
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

interface FullZonedParts extends ZonedParts {
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): FullZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const lookup = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    return part ? Number.parseInt(part.value, 10) : 0;
  };
  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: lookup('hour'),
    minute: lookup('minute'),
    second: lookup('second'),
  };
}

/** Positive when `timeZone` is ahead of UTC (e.g. +420 for Asia/Jakarta). */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Guess-as-UTC-then-correct-by-actual-offset; inexact within a DST transition's ambiguous/skipped
 * hour (not a concern for daily refresh windows).
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = offsetMinutesAt(new Date(guessMs), timeZone);
  return new Date(guessMs - offset * 60_000);
}

export function scheduledDatetime(
  now: Date,
  refreshTime: DailyRefreshTime,
  timeZone: string,
): Date {
  const { year, month, day } = zonedParts(now, timeZone);
  return zonedTimeToUtc(year, month, day, refreshTime.hour, refreshTime.minute, timeZone);
}

export function dailyRefreshDue(
  db: Database.Database,
  now: Date,
  refreshTime: DailyRefreshTime,
  timeZone: string,
): boolean {
  const target = scheduledDatetime(now, refreshTime, timeZone);
  if (now.getTime() < target.getTime()) {
    return false;
  }
  const latest = latestRunGeneratedAt(db);
  if (latest === null) {
    return true;
  }
  return latest.getTime() < target.getTime();
}

export function scheduledRefreshDue(
  db: Database.Database,
  now: Date,
  refreshTimes: readonly DailyRefreshTime[],
  timeZone: string,
): boolean {
  return refreshTimes.some((refreshTime) => dailyRefreshDue(db, now, refreshTime, timeZone));
}

export function secondsUntilNextDailyCheck(
  now: Date,
  refreshTimes: readonly DailyRefreshTime[],
  timeZone: string,
): number {
  const targets = refreshTimes.map((refreshTime) => scheduledDatetime(now, refreshTime, timeZone));
  const futureTargets = targets.filter((target) => target.getTime() > now.getTime());
  const target =
    futureTargets.length > 0
      ? futureTargets.reduce((min, t) => (t.getTime() < min.getTime() ? t : min))
      : new Date(Math.min(...targets.map((t) => t.getTime())) + 24 * 60 * 60 * 1000);
  const deltaSeconds = (target.getTime() - now.getTime()) / 1000;
  return Math.max(60, Math.min(deltaSeconds, 1800));
}

export type StopScheduler = () => void;

export interface AutoRefreshOptions {
  dailyRefreshTimes: readonly DailyRefreshTime[];
  refreshTimezone: string;
  autoRefreshSeconds: number;
}

/** Daily mode takes precedence over interval mode. */
export function startAutoRefresh(
  runtime: RefreshRuntime,
  db: Database.Database,
  options: AutoRefreshOptions,
): StopScheduler {
  if (options.dailyRefreshTimes.length > 0) {
    return startDailyRefresh(runtime, db, options.dailyRefreshTimes, options.refreshTimezone);
  }
  if (options.autoRefreshSeconds <= 0) {
    return () => {};
  }
  return startIntervalRefresh(runtime, db, options.autoRefreshSeconds);
}

function startIntervalRefresh(
  runtime: RefreshRuntime,
  db: Database.Database,
  autoRefreshSeconds: number,
): StopScheduler {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const delayMs = Math.max(60, Math.min(autoRefreshSeconds, 1800)) * 1000;

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    const age = latestRunAgeSeconds(db);
    if (age === null || age >= autoRefreshSeconds) {
      await runtime.refresh('auto');
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), delayMs);
    }
  };
  void tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function startDailyRefresh(
  runtime: RefreshRuntime,
  db: Database.Database,
  refreshTimes: readonly DailyRefreshTime[],
  timeZone: string,
): StopScheduler {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    const now = new Date();
    if (scheduledRefreshDue(db, now, refreshTimes, timeZone)) {
      const status = await runtime.refresh('daily');
      if (stopped) {
        return;
      }
      if (status.state !== 'ok') {
        timer = setTimeout(() => void tick(), 300_000);
        return;
      }
    }
    if (!stopped) {
      const delayMs = secondsUntilNextDailyCheck(new Date(), refreshTimes, timeZone) * 1000;
      timer = setTimeout(() => void tick(), delayMs);
    }
  };
  void tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
