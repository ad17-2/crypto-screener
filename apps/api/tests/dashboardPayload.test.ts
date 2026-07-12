import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../src/config/schema.js';
import { buildDashboardPayload } from '../src/dashboard/payload.js';
import { openDatabase } from '../src/db/client.js';

/**
 * GOLDEN REGRESSION GATE: fixtures/dashboard-payload.json is a captured Python /api/dashboard
 * response; fixtures/parity.sqlite3 is the frozen DB snapshot it came from (see
 * fixtures/README.md). Pinned rather than the live DB because a real screener run shifts IC
 * weights/decay and would break this for reasons unrelated to correctness.
 *
 * This used to be a parity gate against the deleted Python original -- that job is done (Python
 * parity was last proven green at commit db7f68f, CI run 29171479923, 263 tests; see
 * fixtures/README.md). dashboard-payload.json is now a golden baseline for the CURRENT
 * buildDashboardPayload(): parity.sqlite3 never changes, but the payload fixture may be
 * regenerated when a fix intentionally changes the model -- only via
 * `apps/api/scripts/regen-golden.ts payload`, and only with the printed delta reviewed. Never edit
 * this fixture by hand.
 *
 * Excluded from the compare (each still asserted present/typed first):
 *   - freshness.age_seconds/age_minutes: derived from Date.now(), so always "now", not the
 *     fixture's capture time.
 *   - top-level refresh_status: added by the HTTP route after buildDashboardPayload runs, so
 *     the payload builder correctly never produces it.
 * Every other field, including nested row content, is compared exactly.
 */

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/dashboard-payload.json',
);
const SOURCE_DB_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/parity.sqlite3');

const FLOAT_TOLERANCE = 1e-9;

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, unknown>;
}

function collectDiffs(actual: unknown, expected: unknown, path: string, diffs: string[]): void {
  if (expected === null) {
    if (actual !== null) {
      diffs.push(`${path}: expected null, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (typeof expected === 'number') {
    if (
      typeof actual !== 'number' ||
      !Number.isFinite(actual) ||
      Math.abs(actual - expected) > FLOAT_TOLERANCE
    ) {
      diffs.push(`${path}: expected ${expected}, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (typeof expected === 'string' || typeof expected === 'boolean') {
    if (actual !== expected) {
      diffs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push(`${path}: expected an array, got ${JSON.stringify(actual)}`);
      return;
    }
    if (actual.length !== expected.length) {
      diffs.push(
        `${path}: expected array of length ${expected.length}, got length ${actual.length}`,
      );
      return;
    }
    expected.forEach((item, index) => {
      collectDiffs(actual[index], item, `${path}[${index}]`, diffs);
    });
    return;
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null) {
      diffs.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    const expectedKeys = Object.keys(expected as Record<string, unknown>).sort();
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
    const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
    if (missing.length > 0) {
      diffs.push(`${path}: missing key(s) ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      diffs.push(`${path}: unexpected extra key(s) ${extra.join(', ')}`);
    }
    for (const key of expectedKeys) {
      if (actualKeys.includes(key)) {
        collectDiffs(
          (actual as Record<string, unknown>)[key],
          (expected as Record<string, unknown>)[key],
          `${path}.${key}`,
          diffs,
        );
      }
    }
    return;
  }
  throw new Error(`collectDiffs: unhandled expected type at ${path}: ${typeof expected}`);
}

function assertMatches(actual: unknown, expected: unknown, label: string): void {
  const diffs: string[] = [];
  collectDiffs(actual, expected, label, diffs);
  if (diffs.length > 0) {
    const report = diffs.slice(0, 80).join('\n');
    const more = diffs.length > 80 ? `\n... and ${diffs.length - 80} more` : '';
    throw new Error(`${diffs.length} mismatch(es) under ${label}:\n${report}${more}`);
  }
}

describe('buildDashboardPayload vs. golden regression fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-screener-dashboard-payload-'));
  const dbPath = join(dir, 'crypto_screener.sqlite3');
  // Copy-then-open: the original repo database is NEVER opened read-write by this test.
  copyFileSync(SOURCE_DB_PATH, dbPath);
  const db = openDatabase(dbPath);

  const fixture = loadFixture();
  // Must match the defaults used when the fixture was captured, or parity breaks silently.
  const config = AppConfigSchema.parse({});
  expect(config.storage_path).toBe('data/crypto_screener.sqlite3');
  expect(config.report.limit).toBe(12);

  const actual = buildDashboardPayload(db, config, {
    limit: config.report.limit,
  }) as unknown as Record<string, unknown>;

  it('never produces a top-level refresh_status key (HTTP-layer only)', () => {
    expect(fixture).toHaveProperty('refresh_status');
    expect(typeof fixture.refresh_status === 'object').toBe(true);
    expect('refresh_status' in actual).toBe(false);
  });

  it('reports freshness.age_seconds/age_minutes as fresh numeric values (clock-dependent)', () => {
    const freshness = actual.freshness as Record<string, unknown>;
    expect(typeof freshness.age_seconds).toBe('number');
    expect(typeof freshness.age_minutes).toBe('number');
    expect(freshness.age_seconds as number).toBeGreaterThan(0);
    expect(freshness.age_minutes as number).toBeGreaterThan(0);
  });

  it('matches the captured payload exactly on every other field (strict key-set + 1e-9 tolerance)', () => {
    const { refresh_status: _refreshStatus, ...expectedWithoutRefreshStatus } = fixture;
    const expectedFreshness = expectedWithoutRefreshStatus.freshness as Record<string, unknown>;
    const {
      age_seconds: _expectedAgeSeconds,
      age_minutes: _expectedAgeMinutes,
      ...expectedFreshnessRest
    } = expectedFreshness;
    const comparableExpected = {
      ...expectedWithoutRefreshStatus,
      freshness: expectedFreshnessRest,
    };

    const actualFreshness = actual.freshness as Record<string, unknown>;
    const {
      age_seconds: _actualAgeSeconds,
      age_minutes: _actualAgeMinutes,
      ...actualFreshnessRest
    } = actualFreshness;
    const comparableActual = { ...actual, freshness: actualFreshnessRest };

    assertMatches(comparableActual, comparableExpected, 'dashboardPayload');
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
