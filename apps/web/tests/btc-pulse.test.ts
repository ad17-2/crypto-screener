import { describe, expect, it } from 'vitest';
import {
  BTC_STALENESS_THRESHOLD_PCT,
  btcDeltaPct,
  btcRunPrice,
  pulseChipText,
  stalenessBannerText,
  threatenedSide,
} from '../lib/btc-pulse';

describe('btcDeltaPct', () => {
  it('computes a positive delta when the live price is above the run price', () => {
    expect(btcDeltaPct(102, 100)).toBeCloseTo(2, 10);
  });

  it('computes a negative delta when the live price is below the run price', () => {
    expect(btcDeltaPct(97, 100)).toBeCloseTo(-3, 10);
  });

  it('returns null when the run price is zero (would divide by zero)', () => {
    expect(btcDeltaPct(100, 0)).toBeNull();
  });

  it('returns null when either price is not finite', () => {
    expect(btcDeltaPct(Number.NaN, 100)).toBeNull();
    expect(btcDeltaPct(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('threatenedSide', () => {
  it('threatens shorts exactly at and above the positive threshold', () => {
    expect(threatenedSide(BTC_STALENESS_THRESHOLD_PCT)).toBe('short');
    expect(threatenedSide(BTC_STALENESS_THRESHOLD_PCT + 1)).toBe('short');
  });

  it('threatens longs exactly at and beyond the negative threshold', () => {
    expect(threatenedSide(-BTC_STALENESS_THRESHOLD_PCT)).toBe('long');
    expect(threatenedSide(-BTC_STALENESS_THRESHOLD_PCT - 1)).toBe('long');
  });

  it('threatens neither side inside the threshold', () => {
    expect(threatenedSide(0)).toBeNull();
    expect(threatenedSide(BTC_STALENESS_THRESHOLD_PCT - 0.1)).toBeNull();
    expect(threatenedSide(-(BTC_STALENESS_THRESHOLD_PCT - 0.1))).toBeNull();
  });
});

describe('stalenessBannerText', () => {
  it('warns the Shorts list on an up move', () => {
    expect(stalenessBannerText(2.3, 'short')).toBe(
      'BTC +2.3% since this run — shorts below were ranked before this move; re-check before acting.',
    );
  });

  it('mirrors the wording for the Longs list on a down move', () => {
    expect(stalenessBannerText(-2.3, 'long')).toBe(
      'BTC -2.3% since this run — longs below were ranked before this move; re-check before acting.',
    );
  });
});

describe('pulseChipText', () => {
  it('formats the live price with comma grouping and the signed delta', () => {
    expect(pulseChipText(67234, 2.3)).toBe('BTC now $67,234 · +2.3% since run');
  });

  it('formats a negative delta with a leading minus, not a plus', () => {
    expect(pulseChipText(64000, -1.8)).toBe('BTC now $64,000 · -1.8% since run');
  });
});

describe('btcRunPrice', () => {
  it("reads the BTC core row's price_usd", () => {
    const rows = [
      { symbol: 'ETH', price_usd: 3000 },
      { symbol: 'BTC', price_usd: 65000 },
    ];
    expect(btcRunPrice(rows)).toBe(65000);
  });

  it('returns null when there is no BTC row in core (or core is empty)', () => {
    expect(btcRunPrice([{ symbol: 'ETH', price_usd: 3000 }])).toBeNull();
    expect(btcRunPrice([])).toBeNull();
  });

  it('returns null when the BTC row itself has no price', () => {
    expect(btcRunPrice([{ symbol: 'BTC', price_usd: null }])).toBeNull();
  });
});
