import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../src/config/schema.js';
import { scoreSnapshot } from '../src/pipeline/factors.js';
import type { FactorRecord } from '../src/pipeline/ic.js';
import type { Row } from '../src/pipeline/types.js';

/**
 * GOLDEN REGRESSION GATE: replays fixtures/parity-run.json (see fixtures/README.md) through the
 * scoring/factor/weighting stage; output must match fixture.expected to a 1e-9 tolerance.
 *
 * This used to be a parity gate against the deleted Python original -- that job is done (Python
 * parity was last proven green at commit db7f68f, CI run 29171479923, 263 tests; see
 * fixtures/README.md). `expected` is now a golden baseline for the CURRENT TypeScript model: the
 * frozen inputs (config/input_rows/market_context/factor_history) never change, but `expected` may
 * be regenerated when a fix intentionally changes the model -- only via
 * `apps/api/scripts/regen-golden.ts parity`, and only with the printed delta reviewed. Never edit
 * this fixture by hand.
 *
 * scoreSnapshot is called with prior_market_state=undefined: the regime lookup against the
 * fixture's own timestamp returns nothing, matching what produced this fixture.
 *
 * expected.factor_weights.factor_decay is excluded: factorDecay() needs per-horizon
 * (4h/8h/12h/24h/48h/72h) relabeled records the fixture doesn't ship (factor_history is only the
 * collapsed 24h output, with no price_usd). factorDecay itself is covered by validation.test.ts.
 */

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/parity-run.json');

const FLOAT_TOLERANCE = 1e-9;

interface Fixture {
  config: unknown;
  market_context: Record<string, unknown>;
  input_rows: Row[];
  factor_history: FactorRecord[];
  expected: {
    factor_weights: Record<string, unknown>;
    regime: Record<string, unknown>;
    rows: Array<{ symbol: string; factors: unknown; raw_factors: unknown; scores: unknown }>;
  };
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;
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
    const report = diffs.slice(0, 50).join('\n');
    const more = diffs.length > 50 ? `\n... and ${diffs.length - 50} more` : '';
    throw new Error(`${diffs.length} mismatch(es) under ${label}:\n${report}${more}`);
  }
}

describe('factor engine vs. golden regression fixture', () => {
  const fixture = loadFixture();
  const config = AppConfigSchema.parse(fixture.config);
  // input_rows are deep-cloned per test since scoreSnapshot mutates rows in place.
  const rows: Row[] = JSON.parse(JSON.stringify(fixture.input_rows));

  const result = scoreSnapshot(
    rows,
    fixture.market_context,
    fixture.factor_history,
    config,
    undefined,
  );

  it('classifies the same regime as the golden baseline', () => {
    assertMatches(result.regime, fixture.expected.regime, 'regime');
  });

  it('computes the same factor_weights as the golden baseline (factor_decay excluded, see file header)', () => {
    const { factor_decay: _omitted, ...expectedWithoutDecay } = fixture.expected
      .factor_weights as Record<string, unknown> & { factor_decay?: unknown };
    const { factor_decay: _actualOmitted, ...actualWithoutDecay } =
      result.factor_weights as unknown as Record<string, unknown> & { factor_decay?: unknown };
    assertMatches(actualWithoutDecay, expectedWithoutDecay, 'factor_weights');
  });

  it('computes the same factors/raw_factors/scores for all 50 rows as the golden baseline', () => {
    expect(result.rows.length).toBe(fixture.expected.rows.length);
    const bySymbol = new Map(result.rows.map((row) => [row.symbol, row]));
    for (const expectedRow of fixture.expected.rows) {
      const actualRow = bySymbol.get(expectedRow.symbol);
      expect(actualRow, `row for symbol ${expectedRow.symbol} not found`).toBeDefined();
      assertMatches(actualRow?.factors, expectedRow.factors, `rows[${expectedRow.symbol}].factors`);
      assertMatches(
        actualRow?.raw_factors,
        expectedRow.raw_factors,
        `rows[${expectedRow.symbol}].raw_factors`,
      );
      assertMatches(actualRow?.scores, expectedRow.scores, `rows[${expectedRow.symbol}].scores`);
    }
  });
});
