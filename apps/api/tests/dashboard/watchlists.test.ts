import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import { buildSections } from '../../src/dashboard/payload.js';
import { fightsBtcOrNull, setupConfidence } from '../../src/dashboard/rows.js';
import {
  annotateWatchlistMembership,
  isCrowdedLong,
  isCrowdedShort,
  isLongCandidate,
  isShortCandidate,
  topBy,
} from '../../src/dashboard/watchlists.js';
import { toFloat } from '../../src/pipeline/scoring.js';
import type { Row } from '../../src/pipeline/types.js';

function row(overrides: Partial<Row>): Row {
  return { symbol: 'DOGE', ...overrides };
}

// Full directional-signal set, so tests that aren't specifically about the signal gate don't
// trip over it.
const directionalSignals = { btc_beta: 1.1, btc_correlation: 0.6, atr_14_pct: 3.2 };

describe('isLongCandidate', () => {
  it('rejects a move below the 0.5% noise floor', () => {
    expect(isLongCandidate(row({ price_change_24h_pct: 0.4, ...directionalSignals }))).toBe(false);
  });

  it('accepts a move at the 0.5% noise floor', () => {
    expect(isLongCandidate(row({ price_change_24h_pct: 0.5, ...directionalSignals }))).toBe(true);
  });

  it.each(['BTC', 'ETH', 'SOL'])('never treats core symbol %s as a long candidate', (symbol) => {
    expect(isLongCandidate(row({ symbol, price_change_24h_pct: 5.0, ...directionalSignals }))).toBe(
      false,
    );
  });

  it('qualifies when all three directional signals are present', () => {
    expect(
      isLongCandidate(row({ price_change_24h_pct: 5.0, long_score: 10, ...directionalSignals })),
    ).toBe(true);
  });

  it('excludes an otherwise-qualifying row missing btc_beta', () => {
    expect(
      isLongCandidate(
        row({
          price_change_24h_pct: 5.0,
          long_score: 10,
          ...directionalSignals,
          btc_beta: null,
        }),
      ),
    ).toBe(false);
  });

  it('excludes an otherwise-qualifying row missing btc_correlation', () => {
    expect(
      isLongCandidate(
        row({
          price_change_24h_pct: 5.0,
          long_score: 10,
          ...directionalSignals,
          btc_correlation: null,
        }),
      ),
    ).toBe(false);
  });

  it('excludes an otherwise-qualifying row missing atr_14_pct', () => {
    expect(
      isLongCandidate(
        row({
          price_change_24h_pct: 5.0,
          long_score: 10,
          ...directionalSignals,
          atr_14_pct: null,
        }),
      ),
    ).toBe(false);
  });
});

describe('isShortCandidate', () => {
  it('rejects a move below the -0.5% noise floor', () => {
    expect(isShortCandidate(row({ price_change_24h_pct: -0.4, ...directionalSignals }))).toBe(
      false,
    );
  });

  it('accepts a move at the -0.5% noise floor', () => {
    expect(isShortCandidate(row({ price_change_24h_pct: -0.5, ...directionalSignals }))).toBe(true);
  });

  it.each(['BTC', 'ETH', 'SOL'])('never treats core symbol %s as a short candidate', (symbol) => {
    expect(
      isShortCandidate(row({ symbol, price_change_24h_pct: -5.0, ...directionalSignals })),
    ).toBe(false);
  });

  it('qualifies when all three directional signals are present', () => {
    expect(
      isShortCandidate(row({ price_change_24h_pct: -5.0, short_score: 10, ...directionalSignals })),
    ).toBe(true);
  });

  it('excludes an otherwise-qualifying row missing btc_beta', () => {
    expect(
      isShortCandidate(
        row({
          price_change_24h_pct: -5.0,
          short_score: 10,
          ...directionalSignals,
          btc_beta: null,
        }),
      ),
    ).toBe(false);
  });

  it('excludes an otherwise-qualifying row missing btc_correlation', () => {
    expect(
      isShortCandidate(
        row({
          price_change_24h_pct: -5.0,
          short_score: 10,
          ...directionalSignals,
          btc_correlation: null,
        }),
      ),
    ).toBe(false);
  });

  it('excludes an otherwise-qualifying row missing atr_14_pct', () => {
    expect(
      isShortCandidate(
        row({
          price_change_24h_pct: -5.0,
          short_score: 10,
          ...directionalSignals,
          atr_14_pct: null,
        }),
      ),
    ).toBe(false);
  });
});

describe('isLongCandidate trend-state gate', () => {
  it.each(['chop', 'downtrend'])('excludes a row in trend_state %s', (trend_state) => {
    expect(
      isLongCandidate(row({ price_change_24h_pct: 5.0, ...directionalSignals, trend_state })),
    ).toBe(false);
  });

  it('accepts a row in trend_state uptrend', () => {
    expect(
      isLongCandidate(
        row({ price_change_24h_pct: 5.0, ...directionalSignals, trend_state: 'uptrend' }),
      ),
    ).toBe(true);
  });

  it.each([
    'exhaustion_top',
    'exhaustion_bottom',
  ])('accepts a row in trend_state %s (stretch/lateness penalties already price the risk)', (trend_state) => {
    expect(
      isLongCandidate(row({ price_change_24h_pct: 5.0, ...directionalSignals, trend_state })),
    ).toBe(true);
  });

  it('passes a row with no trend_state at all (exclusion-list semantics)', () => {
    expect(isLongCandidate(row({ price_change_24h_pct: 5.0, ...directionalSignals }))).toBe(true);
  });

  it('passes a row with a null trend_state', () => {
    expect(
      isLongCandidate(row({ price_change_24h_pct: 5.0, ...directionalSignals, trend_state: null })),
    ).toBe(true);
  });
});

describe('isShortCandidate trend-state gate', () => {
  it.each(['chop', 'uptrend'])('excludes a row in trend_state %s', (trend_state) => {
    expect(
      isShortCandidate(row({ price_change_24h_pct: -5.0, ...directionalSignals, trend_state })),
    ).toBe(false);
  });

  it('accepts a row in trend_state downtrend', () => {
    expect(
      isShortCandidate(
        row({ price_change_24h_pct: -5.0, ...directionalSignals, trend_state: 'downtrend' }),
      ),
    ).toBe(true);
  });

  it.each([
    'exhaustion_top',
    'exhaustion_bottom',
  ])('accepts a row in trend_state %s (stretch/lateness penalties already price the risk)', (trend_state) => {
    expect(
      isShortCandidate(row({ price_change_24h_pct: -5.0, ...directionalSignals, trend_state })),
    ).toBe(true);
  });

  it('passes a row with no trend_state at all (exclusion-list semantics)', () => {
    expect(isShortCandidate(row({ price_change_24h_pct: -5.0, ...directionalSignals }))).toBe(true);
  });

  it('passes a row with a null trend_state', () => {
    expect(
      isShortCandidate(
        row({ price_change_24h_pct: -5.0, ...directionalSignals, trend_state: null }),
      ),
    ).toBe(true);
  });
});

describe('topBy tie-break', () => {
  it('selects and ranks identical symbols regardless of input order, for tied scores', () => {
    const tiedRows = (order: string[]): Row[] =>
      order.map((symbol) => row({ symbol, long_score: 10 }));

    // Same three tied-score symbols, fed in two different input orderings -- mirrors the
    // divergence between collector.ts's quote-volume-desc feed and the dashboard's symbol-ASC
    // market_rows scan (see topBy's comment).
    const orderA = tiedRows(['CCC', 'AAA', 'BBB']);
    const orderB = tiedRows(['BBB', 'CCC', 'AAA']);

    const rankedA = topBy(orderA, 'long_score', 2).map((r) => r.symbol);
    const rankedB = topBy(orderB, 'long_score', 2).map((r) => r.symbol);

    expect(rankedA).toEqual(['AAA', 'BBB']);
    expect(rankedB).toEqual(['AAA', 'BBB']);
  });
});

describe('isCrowdedLong', () => {
  it('is unaffected by the membership move floor or core-symbol gate', () => {
    expect(
      isCrowdedLong(row({ symbol: 'BTC', price_change_24h_pct: 0.1, funding_rate_pct: 0.02 })),
    ).toBe(true);
    expect(
      isCrowdedLong(row({ symbol: 'ETH', price_change_24h_pct: 0.1, long_short_ratio: 1.5 })),
    ).toBe(true);
  });

  it('does not gate on the directional signal set (crowded_longs is not a directional list)', () => {
    expect(
      isCrowdedLong(
        row({
          funding_rate_pct: 0.02,
          btc_beta: null,
          btc_correlation: null,
          atr_14_pct: null,
        }),
      ),
    ).toBe(true);
  });
});

describe('isCrowdedShort', () => {
  it('is unaffected by the membership move floor or core-symbol gate', () => {
    expect(
      isCrowdedShort(row({ symbol: 'SOL', price_change_24h_pct: -0.1, funding_rate_pct: -0.02 })),
    ).toBe(true);
    expect(
      isCrowdedShort(row({ symbol: 'BTC', price_change_24h_pct: -0.1, long_short_ratio: 0.5 })),
    ).toBe(true);
  });

  it('does not gate on the directional signal set (squeeze_risks is not a directional list)', () => {
    expect(
      isCrowdedShort(
        row({
          funding_rate_pct: -0.02,
          btc_beta: null,
          btc_correlation: null,
          atr_14_pct: null,
        }),
      ),
    ).toBe(true);
  });
});

describe('annotateWatchlistMembership', () => {
  const config = AppConfigSchema.parse({ report: { limit: 2 } });

  function candidateRow(overrides: Partial<Row>): Row {
    return row({
      ...directionalSignals,
      technical_trend_score: 0.6,
      technical_momentum_score: 0.2,
      oi_change_24h_pct: 1.0,
      fights_btc: null,
      ...overrides,
    });
  }

  function buildRows(): Row[] {
    return [
      candidateRow({ symbol: 'AAA', price_change_24h_pct: 8.0, long_score: 30 }),
      candidateRow({ symbol: 'BBB', price_change_24h_pct: 5.0, long_score: 50 }),
      candidateRow({ symbol: 'CCC', price_change_24h_pct: 3.0, long_score: 10 }),
      candidateRow({
        symbol: 'DDD',
        price_change_24h_pct: -6.0,
        short_score: 40,
        technical_trend_score: -0.6,
        technical_momentum_score: -0.2,
      }),
      candidateRow({
        symbol: 'EEE',
        price_change_24h_pct: -9.0,
        short_score: 20,
        technical_trend_score: -0.6,
        technical_momentum_score: -0.2,
      }),
      // Core symbol: excluded from both lists no matter how strong its score.
      candidateRow({ symbol: 'BTC', price_change_24h_pct: 10.0, long_score: 999 }),
      // Below the 0.5% membership move floor: excluded despite a nonzero long_score.
      candidateRow({ symbol: 'FFF', price_change_24h_pct: 0.1, long_score: 5 }),
    ];
  }

  it('stamps side/rank/confidence on members in topBy order, and leaves non-members untouched', () => {
    const rows = buildRows();
    const expectedLong = topBy(rows, 'long_score', config.report.limit, {
      predicate: isLongCandidate,
    });
    const expectedShort = topBy(rows, 'short_score', config.report.limit, {
      predicate: isShortCandidate,
    });
    expect(expectedLong.map((r) => r.symbol)).toEqual(['BBB', 'AAA']);
    expect(expectedShort.map((r) => r.symbol)).toEqual(['DDD', 'EEE']);

    annotateWatchlistMembership(rows, config);

    expectedLong.forEach((memberRow, index) => {
      expect(memberRow.watchlist_side).toBe('long');
      expect(memberRow.watchlist_rank).toBe(index + 1);
      expect(memberRow.setup_confidence).toBe(
        setupConfidence(
          'long',
          toFloat(memberRow.technical_trend_score),
          toFloat(memberRow.technical_momentum_score),
          toFloat(memberRow.oi_change_24h_pct),
          fightsBtcOrNull(memberRow.fights_btc),
        ),
      );
    });
    expectedShort.forEach((memberRow, index) => {
      expect(memberRow.watchlist_side).toBe('short');
      expect(memberRow.watchlist_rank).toBe(index + 1);
      expect(memberRow.setup_confidence).toBe(
        setupConfidence(
          'short',
          toFloat(memberRow.technical_trend_score),
          toFloat(memberRow.technical_momentum_score),
          toFloat(memberRow.oi_change_24h_pct),
          fightsBtcOrNull(memberRow.fights_btc),
        ),
      );
    });
    expect(rows.find((r) => r.symbol === 'BBB')?.setup_confidence).toBe('A');

    const memberSymbols = new Set(
      [...expectedLong, ...expectedShort].map((memberRow) => memberRow.symbol),
    );
    for (const candidate of rows) {
      if (!memberSymbols.has(candidate.symbol)) {
        expect(candidate.watchlist_side).toBeUndefined();
        expect(candidate.watchlist_rank).toBeUndefined();
        expect(candidate.setup_confidence).toBeUndefined();
      }
    }
  });

  it("matches buildSections' long/short selection exactly for the same cross-section", () => {
    const rowsForAnnotation = buildRows();
    const rowsForSections = buildRows();

    annotateWatchlistMembership(rowsForAnnotation, config);
    const sections = buildSections(rowsForSections, config.report.limit, {});

    const annotatedLong = rowsForAnnotation
      .filter((r) => r.watchlist_side === 'long')
      .sort((a, b) => (a.watchlist_rank as number) - (b.watchlist_rank as number))
      .map((r) => r.symbol);
    const annotatedShort = rowsForAnnotation
      .filter((r) => r.watchlist_side === 'short')
      .sort((a, b) => (a.watchlist_rank as number) - (b.watchlist_rank as number))
      .map((r) => r.symbol);

    expect(annotatedLong).toEqual(sections.long.map((r) => r.symbol));
    expect(annotatedShort).toEqual(sections.short.map((r) => r.symbol));
  });
});
