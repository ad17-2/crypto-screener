import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../src/config/schema.js';
import { scoreSnapshot } from '../src/pipeline/factors.js';
import type { FactorRecord, Row } from '../src/pipeline/types.js';
import { assertMatches } from './support/goldenDiff.js';

/**
 * GOLDEN REGRESSION GATE: replays fixtures/parity-run.json (see fixtures/README.md) through the
 * scoring/factor stage; output must match fixture.expected to a 1e-9 tolerance.
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
 * `factor_history` remains in the fixture JSON for historical shape only; it is no longer passed
 * to scoreSnapshot (the factor-weighting engine that consumed it was deleted).
 */

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/parity-run.json');

interface Fixture {
  config: unknown;
  market_context: Record<string, unknown>;
  input_rows: Row[];
  factor_history: FactorRecord[];
  expected: {
    regime: Record<string, unknown>;
    rows: Array<{ symbol: string; factors: unknown; raw_factors: unknown; scores: unknown }>;
  };
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;
}

describe('factor engine vs. golden regression fixture', () => {
  const fixture = loadFixture();
  const config = AppConfigSchema.parse(fixture.config);
  // input_rows are deep-cloned per test since scoreSnapshot mutates rows in place.
  const rows: Row[] = JSON.parse(JSON.stringify(fixture.input_rows));

  const result = scoreSnapshot(rows, fixture.market_context, config, undefined);

  it('classifies the same regime as the golden baseline', () => {
    assertMatches(result.regime, fixture.expected.regime, 'regime');
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
