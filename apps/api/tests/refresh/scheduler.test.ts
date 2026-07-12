import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSnapshot } from '../../src/db/runs.js';
import {
  dailyRefreshDue,
  scheduledDatetime,
  scheduledRefreshDue,
  secondsUntilNextDailyCheck,
} from '../../src/refresh/scheduler.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

// Instants below are "Asia/Jakarta wall-clock HH:MM" -> UTC (fixed +07:00, no DST).

const ZONE = 'Asia/Jakarta';

function jakarta(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute, 0));
}

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  ({ dir, dbPath, db } = setupTempDb('crypto-screener-scheduler-'));
});

afterEach(() => {
  teardownTempDb(dir, db);
});

describe('scheduledDatetime', () => {
  it('combines the current Jakarta calendar date with the given HH:MM', () => {
    const now = jakarta(2026, 7, 3, 12, 0);
    const target = scheduledDatetime(now, { hour: 6, minute: 0 }, ZONE);
    expect(target.getTime()).toBe(jakarta(2026, 7, 3, 6, 0).getTime());
  });
});

describe('dailyRefreshDue', () => {
  it('is due only once per day, after the scheduled time and only once a fresh run exists', () => {
    const refreshTime = { hour: 6, minute: 0 };

    expect(dailyRefreshDue(db, jakarta(2026, 7, 3, 5, 59), refreshTime, ZONE)).toBe(false);
    expect(dailyRefreshDue(db, jakarta(2026, 7, 3, 6, 0), refreshTime, ZONE)).toBe(true);

    saveSnapshot(
      db,
      {
        run_id: 'today',
        generated_at: '2026-07-03T06:05:00+07:00',
        rows: [{ symbol: 'BTC', price_usd: 100 }],
      },
      { storage_path: dbPath },
    );

    expect(dailyRefreshDue(db, jakarta(2026, 7, 3, 12, 0), refreshTime, ZONE)).toBe(false);
    expect(dailyRefreshDue(db, jakarta(2026, 7, 4, 6, 0), refreshTime, ZONE)).toBe(true);
  });
});

describe('scheduledRefreshDue / secondsUntilNextDailyCheck', () => {
  it('supports multiple times per day, deduped/sorted upstream by parseDailyRefreshTimes', () => {
    // Pre-sorted/deduped here directly rather than via parseDailyRefreshTimes, which env.ts owns and tests.
    const refreshTimes = [
      { hour: 7, minute: 10 },
      { hour: 11, minute: 10 },
      { hour: 15, minute: 10 },
    ];

    expect(scheduledRefreshDue(db, jakarta(2026, 7, 3, 7, 9), refreshTimes, ZONE)).toBe(false);
    expect(scheduledRefreshDue(db, jakarta(2026, 7, 3, 7, 10), refreshTimes, ZONE)).toBe(true);

    saveSnapshot(
      db,
      {
        run_id: 'morning',
        generated_at: '2026-07-03T07:15:00+07:00',
        rows: [{ symbol: 'BTC', price_usd: 100 }],
      },
      { storage_path: dbPath },
    );

    expect(scheduledRefreshDue(db, jakarta(2026, 7, 3, 10, 59), refreshTimes, ZONE)).toBe(false);
    expect(scheduledRefreshDue(db, jakarta(2026, 7, 3, 11, 10), refreshTimes, ZONE)).toBe(true);

    saveSnapshot(
      db,
      {
        run_id: 'midday',
        generated_at: '2026-07-03T11:20:00+07:00',
        rows: [{ symbol: 'BTC', price_usd: 101 }],
      },
      { storage_path: dbPath },
    );

    expect(scheduledRefreshDue(db, jakarta(2026, 7, 3, 15, 9), refreshTimes, ZONE)).toBe(false);
    expect(scheduledRefreshDue(db, jakarta(2026, 7, 3, 15, 10), refreshTimes, ZONE)).toBe(true);
    expect(secondsUntilNextDailyCheck(jakarta(2026, 7, 3, 15, 11), refreshTimes, ZONE)).toBe(1800);
  });

  it('restart idempotency: a fresh process re-derives the same due-ness from SQLite alone', () => {
    // Due-ness is recomputed from the latest run row every call, not a persisted "next fire time".
    const refreshTime = { hour: 6, minute: 0 };
    saveSnapshot(
      db,
      {
        run_id: 'today',
        generated_at: '2026-07-03T06:05:00+07:00',
        rows: [{ symbol: 'BTC', price_usd: 100 }],
      },
      { storage_path: dbPath },
    );

    expect(dailyRefreshDue(db, jakarta(2026, 7, 3, 8, 0), refreshTime, ZONE)).toBe(false);
    expect(dailyRefreshDue(db, jakarta(2026, 7, 4, 6, 0), refreshTime, ZONE)).toBe(true);
  });
});
