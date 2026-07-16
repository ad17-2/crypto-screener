import { describe, expect, it } from 'vitest';
import {
  isCrowdedLong,
  isCrowdedShort,
  isLongCandidate,
  isShortCandidate,
} from '../../src/dashboard/watchlists.js';
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
