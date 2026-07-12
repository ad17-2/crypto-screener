import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../src/config/schema.js';
import { buildDashboardPayload } from '../src/dashboard/payload.js';
import { openDatabase } from '../src/db/client.js';
import { assertMatches } from './support/goldenDiff.js';

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

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, unknown>;
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

    assertMatches(comparableActual, comparableExpected, 'dashboardPayload', 80);
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
