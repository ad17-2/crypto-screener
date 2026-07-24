import { describe, expect, it } from 'vitest';
import { buildSections } from '../../src/dashboard/payload.js';
import type { PreviousRunMembership, PreviousRunScoreEntry } from '../../src/dashboard/runDiff.js';
import type { Row } from '../../src/pipeline/types.js';

// Full directional-signal set, so these fixtures pass isLongCandidate/isShortCandidate's own gate
// (dashboard/watchlists.ts) without the test being about that gate.
const directionalSignals = { btc_beta: 1.1, btc_correlation: 0.6, atr_14_pct: 3.2 };

function longRow(overrides: Partial<Row>): Row {
  return {
    symbol: 'AAA',
    price_change_24h_pct: 5.0,
    long_score: 10,
    ...directionalSignals,
    ...overrides,
  };
}

function shortRow(overrides: Partial<Row>): Row {
  return {
    symbol: 'AAA',
    price_change_24h_pct: -5.0,
    short_score: 10,
    ...directionalSignals,
    ...overrides,
  };
}

/**
 * dashboard/runDiff.ts's own units (previousRunScores/runTrend, tests/db/runDiff.test.ts) cover the
 * per-value logic exhaustively; this only proves buildSections (dashboard/payload.ts) actually
 * threads its new optional params through to dashboardRow() for the right side/score field --
 * the wiring the brief calls out (payload.ts:343-346 -> buildSections -> rows.ts dashboardRow()).
 */
describe('buildSections run_trend wiring', () => {
  it('threads a resolved run_trend onto a qualifying long row', () => {
    const rows: Row[] = [longRow({ long_score: 12 })];
    const previous: PreviousRunMembership = {
      runId: 'run-0',
      bySymbol: new Map([['AAA', 'long']]),
    };
    const previousScores: Map<string, PreviousRunScoreEntry> = new Map([
      ['AAA', { longScore: 5, shortScore: null, pipelineVersion: 'v1' }],
    ]);

    const sections = buildSections(rows, 12, {}, new Set(), previous, previousScores, 'v1');
    expect(sections.long[0]?.run_trend).toBe('strengthening');
  });

  it('threads a resolved run_trend onto a qualifying short row, comparing short_score not long_score', () => {
    const rows: Row[] = [shortRow({ short_score: 12 })];
    const previous: PreviousRunMembership = {
      runId: 'run-0',
      bySymbol: new Map([['AAA', 'short']]),
    };
    const previousScores: Map<string, PreviousRunScoreEntry> = new Map([
      ['AAA', { longScore: 999, shortScore: 5, pipelineVersion: 'v1' }],
    ]);

    const sections = buildSections(rows, 12, {}, new Set(), previous, previousScores, 'v1');
    expect(sections.short[0]?.run_trend).toBe('strengthening');
  });

  it('omits run_trend on a pipeline_version mismatch (the guard, threaded end to end)', () => {
    const rows: Row[] = [longRow({ long_score: 12 })];
    const previous: PreviousRunMembership = {
      runId: 'run-0',
      bySymbol: new Map([['AAA', 'long']]),
    };
    const previousScores: Map<string, PreviousRunScoreEntry> = new Map([
      ['AAA', { longScore: 5, shortScore: null, pipelineVersion: 'v1' }],
    ]);

    const sections = buildSections(rows, 12, {}, new Set(), previous, previousScores, 'v2');
    expect(sections.long[0]?.run_trend).toBeUndefined();
  });

  it('defaults to no run_trend at all when the optional baseline params are omitted (back-compat with existing 3/4-arg callers)', () => {
    const rows: Row[] = [longRow({})];
    const sections = buildSections(rows, 12, {});
    expect(sections.long[0]?.run_trend).toBeUndefined();
  });

  it('never emits run_trend on core rows -- they have no side-specific score to trend', () => {
    const rows: Row[] = [{ symbol: 'BTC' }];
    const previous: PreviousRunMembership = {
      runId: 'run-0',
      bySymbol: new Map([['BTC', 'long']]),
    };
    const sections = buildSections(rows, 12, {}, new Set(), previous, new Map(), 'v1');
    expect(sections.core[0]?.run_trend).toBeUndefined();
  });
});
