import { roundTripCostPct } from './costs.js';
import { clamp, pyRound, toFloat } from './scoring.js';
import type { MarketContext, PipelineConfig, Row } from './types.js';

// Named rowScoring.ts, not scoring.ts, because pipeline/scoring.ts already holds the shared math primitives this builds on.
export interface RowScores {
  liquidity_quality: number;
  long_score: number;
  short_score: number;
  crowded_long_score: number;
  squeeze_risk_score: number;
  round_trip_cost_pct: number;
  size_multiplier: number;
}

/**
 * No directional model prediction exists any more (the factor-weighting engine that used to
 * produce one was deleted -- no factor forward-validates, so every weight was 0 anyway). The
 * cost computation below used to take a sign from that deleted factor-weighted score; direction
 * is now intentionally treated as neutral (0), which is exactly the already-observed production
 * behaviour under the old zero_unvalidated_weights gate.
 */
const NO_DIRECTIONAL_SIGNAL = 0;

/** Mutates `row` in place. */
export function applyScores(
  row: Row,
  factors: Record<string, number>,
  marketContext: MarketContext,
  config: PipelineConfig,
): void {
  const liquidityQuality = qualityPercentile(factors.liquidity_30d ?? 0.0);

  const funding = toFloat(row.funding_rate_pct, 0.0) ?? 0.0;
  let ls = toFloat(row.long_short_account_ratio);
  if (ls === null) {
    ls = toFloat(row.long_short_ratio);
  }
  const oiChange = toFloat(row.oi_change_24h_pct, 0.0) ?? 0.0;
  const priceChange = toFloat(row.price_change_24h_pct, 0.0) ?? 0.0;
  const atrPct = toFloat(row.atr_14_pct);
  const btcBeta = toFloat(row.btc_beta);
  const btcCorrelation = toFloat(row.btc_correlation);
  const btcChange24h = toFloat(marketContext.btc_change_24h_pct);
  const btcMomentumScore = toFloat(marketContext.btc_momentum_score);
  const priceChange72h = toFloat(row.price_change_72h_pct);
  const liquidationImbalance24h = toFloat(row.liquidation_imbalance_24h_pct);

  let longCrowding = clamp(Math.max(funding, 0.0) / 0.08);
  if (ls !== null) {
    longCrowding += clamp((ls - 1.3) / 0.7);
  }
  let shortCrowding = clamp(Math.abs(Math.min(funding, 0.0)) / 0.08);
  if (ls !== null && ls > 0) {
    shortCrowding += clamp((0.8 - ls) / 0.5);
  }

  // THE SCREEN (layer 2) ranks on OBSERVABLE FACTS. directionalScore is deliberately absent: no
  // factor forward-validates, so it is 0 for every coin and ranking by it would rank by nothing.
  // What is left is what actually happened -- price moved, open interest built, it is liquid, it is
  // not already crowded. The terms below are still hand-set mechanical rationale, not fitted
  // weights (this codebase deliberately has none):
  //   - residual strips the beta-implied BTC move first, so a coin that only fell because BTC fell
  //     doesn't rank as idiosyncratic weakness, and shorts rank on what the coin did on its own.
  //   - the veto handles the case residual can't: a live BTC impulse the coin is correlated to but
  //     hasn't visibly reacted to yet.
  //   - scale normalizes momentum credit by the coin's own volatility, so a 5% move in a 2%-ATR
  //     name and a 5% move in a 10%-ATR name aren't treated as the same conviction.
  //   - stretch and lateness penalize chasing a move (3d) or a liquidation flush (24h) that has
  //     already happened, rather than anticipating one.
  const residualChange =
    btcBeta !== null && btcChange24h !== null ? priceChange - btcBeta * btcChange24h : priceChange;
  if (btcBeta !== null && btcChange24h !== null) {
    row.residual_change_24h_pct = pyRound(residualChange, 2);
  }

  const momentumScale = atrPct !== null ? clamp(5.0 * atrPct, 4.0, 25.0) : 10.0;
  const longMomentum = clamp(Math.max(residualChange, 0.0) / momentumScale);
  const shortMomentum = clamp(Math.max(-residualChange, 0.0) / momentumScale);

  const oiTermLong = oiChange >= 0 ? clamp(oiChange / 12.0) * 15.0 : -clamp(-oiChange / 12.0) * 8.0;
  const oiTermShort =
    oiChange >= 0 ? clamp(oiChange / 12.0) * 15.0 : -clamp(-oiChange / 12.0) * 10.0;

  const btcUp =
    btcChange24h !== null &&
    btcChange24h >= 1.0 &&
    (btcMomentumScore === null || btcMomentumScore >= 0);
  const btcDown =
    btcChange24h !== null &&
    btcChange24h <= -1.0 &&
    (btcMomentumScore === null || btcMomentumScore <= 0);
  const vetoShort =
    btcCorrelation !== null && btcCorrelation >= 0.5 && btcUp
      ? clamp((btcCorrelation - 0.5) / 0.4) * clamp((btcChange24h as number) / 3.0) * 18.0
      : 0;
  const vetoLong =
    btcCorrelation !== null && btcCorrelation >= 0.5 && btcDown
      ? clamp((btcCorrelation - 0.5) / 0.4) * clamp(-(btcChange24h as number) / 3.0) * 18.0
      : 0;
  row.fights_btc = vetoShort > 0 ? 'short' : vetoLong > 0 ? 'long' : null;

  const stretchLong =
    priceChange72h !== null
      ? clamp(Math.max(priceChange72h, 0.0) / (3.0 * momentumScale) - 1.0) * 10.0
      : 0;
  const stretchShort =
    priceChange72h !== null
      ? clamp(Math.max(-priceChange72h, 0.0) / (3.0 * momentumScale) - 1.0) * 10.0
      : 0;

  const lateShort =
    liquidationImbalance24h !== null && liquidationImbalance24h <= -40.0
      ? clamp((-liquidationImbalance24h - 40.0) / 40.0) * 6.0
      : 0;
  const lateLong =
    liquidationImbalance24h !== null && liquidationImbalance24h >= 40.0
      ? clamp((liquidationImbalance24h - 40.0) / 40.0) * 6.0
      : 0;

  const longScore =
    longMomentum * 45.0 +
    oiTermLong +
    liquidityQuality * 0.25 -
    longCrowding * 10.0 -
    vetoLong -
    stretchLong -
    lateLong;
  const shortScore =
    shortMomentum * 45.0 +
    oiTermShort +
    liquidityQuality * 0.25 -
    shortCrowding * 8.0 -
    vetoShort -
    stretchShort -
    lateShort;
  const crowdedLongScore =
    longCrowding * 35.0 +
    clamp(Math.max(oiChange, 0.0) / 12.0) * 25.0 +
    clamp(Math.max(priceChange, 0.0) / 10.0) * 15.0 +
    liquidityQuality * 0.25;
  const squeezeRiskScore =
    shortCrowding * 38.0 +
    clamp(Math.max(oiChange, 0.0) / 12.0) * 24.0 +
    clamp(Math.max(priceChange, 0.0) / 8.0) * 13.0 +
    liquidityQuality * 0.25;

  const roundTripCost = roundTripCostPct(
    row,
    config.costs ?? {},
    config.factors?.forward_return_hours ?? 24,
    NO_DIRECTIONAL_SIGNAL,
  );

  // Inverse-vol position sizing (measured, not just backtest theory -- see the MEASURED note):
  // a coin at 2x the cross-section's typical ATR gets sized to ~0.5x. Clamped both ways so a
  // near-zero-ATR outlier can't blow past 2x, and a very high-ATR name still gets a floor of 0.25x
  // rather than being sized to zero. Falls back to neutral (1.0) when there's no cross-sectional
  // ATR read to size against.
  const medianAtrPct = toFloat(marketContext.median_atr_pct);
  const rowAtrPct = toFloat(row.atr_14_pct);
  const sizeMultiplier =
    medianAtrPct === null
      ? 1.0
      : clamp(medianAtrPct / Math.max(rowAtrPct ?? medianAtrPct, 1.0), 0.25, 2.0);

  const scores: RowScores = {
    liquidity_quality: pyRound(liquidityQuality, 2),
    long_score: pyRound(Math.max(longScore, 0.0), 2),
    short_score: pyRound(Math.max(shortScore, 0.0), 2),
    crowded_long_score: pyRound(crowdedLongScore, 2),
    squeeze_risk_score: pyRound(squeezeRiskScore, 2),
    round_trip_cost_pct: pyRound(roundTripCost, 4),
    size_multiplier: pyRound(sizeMultiplier, 3),
  };
  row.scores = scores;
  Object.assign(row, scores);
}

/** Mutates `row` in place. */
export function applyExcludedScores(row: Row): void {
  const scores: RowScores = {
    liquidity_quality: 0.0,
    long_score: 0.0,
    short_score: 0.0,
    crowded_long_score: 0.0,
    squeeze_risk_score: 0.0,
    round_trip_cost_pct: 0.0,
    size_multiplier: 0.0,
  };
  row.scores = scores;
  Object.assign(row, scores);
}

function qualityPercentile(zscore: number): number {
  return 100.0 / (1.0 + Math.exp(-zscore));
}
