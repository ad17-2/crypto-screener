import { describe, expect, it } from 'vitest';
import type { RawHistoryRow } from '../../src/pipeline/derivatives.js';
import {
  DERIVATIVES_SNAPSHOT_FIELDS,
  derivativesSnapshot,
} from '../../src/pipeline/derivatives.js';

const START = 1_700_000_000_000;
const STEP_4H = 14_400_000;

// 20 4h bars -> candlesPerWindow('4h', 72) = 18, so the 72h window drops the oldest 2 bars.
// oiCloses[1] = 100, oiCloses[19] = 280 (index 20-18-1 = 1 to the last index):
// pct = (280-100)/100*100 = 180.
function oiHistoryFixture(): RawHistoryRow[] {
  const rows: RawHistoryRow[] = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push({ time: START + i * STEP_4H, close: 90 + 10 * i });
  }
  return rows;
}

function takerRow(time: number, buy: number, sell: number): RawHistoryRow {
  return {
    time,
    aggregated_buy_volume_usd: buy,
    aggregated_sell_volume_usd: sell,
  };
}

// 20 4h bars; only the last 18 (indices 2..19) should count toward the 72h CVD window.
// Indices 0-1 carry decoy values that would blow up the ratio if wrongly included.
function takerHistoryFixture(): RawHistoryRow[] {
  const rows: RawHistoryRow[] = [];
  rows.push(takerRow(START, 999, 1));
  rows.push(takerRow(START + STEP_4H, 999, 1));
  for (let i = 2; i < 20; i += 1) {
    rows.push(takerRow(START + i * STEP_4H, 120, 80));
  }
  return rows;
}

describe('derivativesSnapshot: oi_change_72h_pct_history', () => {
  it('computes the 72h OI pct change over candlesPerWindow(interval, 72) bars (18 bars at 4h)', () => {
    const snapshot = derivativesSnapshot(oiHistoryFixture(), [], [], [], '4h');
    expect(snapshot.oi_change_72h_pct_history).toBeCloseTo(180, 9);
  });

  it('is null when there are not enough bars for the 72h window', () => {
    const shortHistory = oiHistoryFixture().slice(0, 10);
    const snapshot = derivativesSnapshot(shortHistory, [], [], [], '4h');
    expect(snapshot.oi_change_72h_pct_history).toBeUndefined();
  });

  it('leaves the existing 4h/24h OI fields untouched (bit-identical)', () => {
    const snapshot = derivativesSnapshot(oiHistoryFixture(), [], [], [], '4h');
    // oi_change_4h_pct_history: pctChange(closes[18], closes[19]) = (280-270)/270*100.
    expect(snapshot.oi_change_4h_pct_history).toBeCloseTo(((280 - 270) / 270) * 100, 9);
    // oi_change_24h_pct_history: window=candlesPerWindow('4h',24)=6 -> pctChange(closes[13], closes[19]).
    expect(snapshot.oi_change_24h_pct_history).toBeCloseTo(((280 - 220) / 220) * 100, 9);
  });
});

describe('derivativesSnapshot: cvd_trend_72h_pct', () => {
  it('sums buy-sell and buy+sell over the last 18 bars only (direct sum, not the full history)', () => {
    const snapshot = derivativesSnapshot([], [], [], takerHistoryFixture(), '4h');
    // Window bars (indices 2..19): buy=120, sell=80, 18 bars.
    // netDelta = 18*(120-80) = 720; turnover = 18*(120+80) = 3600.
    // cvd_trend_72h_pct = 100*720/3600 = 20.00.
    expect(snapshot.cvd_trend_72h_pct).toBeCloseTo(20, 9);
  });

  it('is null when there are fewer than 18 bars (insufficient data)', () => {
    const shortHistory = takerHistoryFixture().slice(0, 10);
    const snapshot = derivativesSnapshot([], [], [], shortHistory, '4h');
    expect(snapshot.cvd_trend_72h_pct).toBeUndefined();
  });

  it('is null when turnover is zero even with a full window', () => {
    const rows: RawHistoryRow[] = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push(takerRow(START + i * STEP_4H, 0, 0));
    }
    const snapshot = derivativesSnapshot([], [], [], rows, '4h');
    expect(snapshot.cvd_trend_72h_pct).toBeUndefined();
  });

  it('leaves the existing 24h taker fields untouched (bit-identical)', () => {
    const snapshot = derivativesSnapshot([], [], [], takerHistoryFixture(), '4h');
    // 24h window = candlesPerWindow('4h', 24) = 6 bars -> the last 6 of the fixture, all buy=120/sell=80.
    // taker_buy_sell_ratio_24h = buyVolume/sellVolume = (6*120)/(6*80) = 1.5.
    expect(snapshot.taker_buy_sell_ratio_24h).toBeCloseTo(1.5, 9);
    // taker_imbalance_24h_pct = (buy-sell)/(buy+sell)*100 = (720-480)/(720+480)*100 = 20.
    expect(snapshot.taker_imbalance_24h_pct).toBeCloseTo(20, 9);
  });
});

describe('derivativesSnapshot field allowlist (drift guard)', () => {
  it('emits exactly the keys covered by DERIVATIVES_SNAPSHOT_FIELDS', () => {
    // 40 bars clears every internal window this function uses (18 for the 72h taker/OI windows, 30
    // for the OI z-score) with real per-bar variance, so every one of the 19 fields comes back
    // non-null -- a field silently dropped from the return object (or added without updating the
    // allowlist) would show up as a mismatch in either direction below, not just a missing key.
    const BARS = 40;
    const oiHistory: RawHistoryRow[] = Array.from({ length: BARS }, (_, i) => ({
      time: START + i * STEP_4H,
      close: 1_000_000 + i * 15_000 + (i % 3) * 4_000,
    }));
    const fundingHistory: RawHistoryRow[] = Array.from({ length: BARS }, (_, i) => ({
      time: START + i * STEP_4H,
      close: i % 2 === 0 ? 0.012 : 0.009,
    }));
    const liquidationHistory: RawHistoryRow[] = Array.from({ length: BARS }, (_, i) => ({
      time: START + i * STEP_4H,
      aggregated_long_liquidation_usd: 50_000 + i * 500,
      aggregated_short_liquidation_usd: 40_000 + i * 300,
    }));
    const takerHistory: RawHistoryRow[] = Array.from({ length: BARS }, (_, i) => ({
      time: START + i * STEP_4H,
      aggregated_buy_volume_usd: 120_000 + i * 200,
      aggregated_sell_volume_usd: 100_000 + i * 150,
    }));

    const snapshot = derivativesSnapshot(
      oiHistory,
      fundingHistory,
      liquidationHistory,
      takerHistory,
      '4h',
    );

    for (const key of Object.keys(snapshot)) {
      expect(DERIVATIVES_SNAPSHOT_FIELDS as readonly string[]).toContain(key);
    }
    for (const key of DERIVATIVES_SNAPSHOT_FIELDS) {
      expect(snapshot).toHaveProperty(key);
    }
  });
});
