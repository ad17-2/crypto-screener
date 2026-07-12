import { roundTripCostPct } from './costs.js';
import { DIRECTIONAL_FACTORS } from './factorDefinitions.js';
import { clamp, mean, pyRound, toFloat } from './scoring.js';
import type { MarketContext, PipelineConfig, Row } from './types.js';
import { asRecord } from './types.js';

// Named rowScoring.ts, not scoring.ts, because pipeline/scoring.ts already holds the shared math primitives this builds on.
export interface ConflictItem {
  code: string;
  label: string;
  severity: number;
  detail: string;
}

export interface SignalConflictSummary {
  signal_conflict_label: string;
  signal_conflict_score: number;
  signal_conflicts: ConflictItem[];
  regime_alignment_score: number;
  breadth_alignment_score: number;
}

export interface RowScores {
  factor_score: number;
  liquidity_quality: number;
  long_score: number;
  short_score: number;
  crowded_long_score: number;
  squeeze_risk_score: number;
  confidence_score: number;
  signal_conflict_score: number;
  regime_alignment_score: number;
  breadth_alignment_score: number;
  round_trip_cost_pct: number;
  size_multiplier: number;
}

export interface DirectionalWeightsLike {
  directional?: Record<string, number>;
}
export interface RegimeLike {
  bias?: string;
  bias_score?: number | null;
}

/** Mutates `row` in place. */
export function applyScores(
  row: Row,
  factors: Record<string, number>,
  weights: DirectionalWeightsLike,
  regime: RegimeLike,
  marketContext: MarketContext,
  config: PipelineConfig,
): void {
  const directionalWeights = weights.directional ?? {};
  let directionalScore = 0.0;
  for (const [name, weight] of Object.entries(directionalWeights)) {
    directionalScore += (factors[name] ?? 0.0) * weight;
  }
  const liquidityQuality = qualityPercentile(factors.liquidity_30d ?? 0.0);
  const conflicts = signalConflictSummary(row, factors, directionalScore, regime, marketContext);

  const funding = toFloat(row.funding_rate_pct, 0.0) ?? 0.0;
  let ls = toFloat(row.long_short_account_ratio);
  if (ls === null) {
    ls = toFloat(row.long_short_ratio);
  }
  const oiChange = toFloat(row.oi_change_24h_pct, 0.0) ?? 0.0;
  const priceChange = toFloat(row.price_change_24h_pct, 0.0) ?? 0.0;

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
  // not already crowded.
  const longScore =
    clamp(Math.max(priceChange, 0.0) / 10.0) * 45.0 +
    clamp(Math.max(oiChange, 0.0) / 12.0) * 15.0 +
    liquidityQuality * 0.25 -
    longCrowding * 10.0;
  const shortScore =
    clamp(Math.max(-priceChange, 0.0) / 10.0) * 45.0 +
    clamp(Math.max(oiChange, 0.0) / 12.0) * 15.0 +
    liquidityQuality * 0.25 -
    shortCrowding * 8.0;
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

  // long_score/short_score are THE SCREEN's pure crowding/momentum read -- no longer scaled by
  // regime-alignment or signal-conflict (that blended a prediction into an observation). Those two
  // fields are still computed below solely to keep the frozen 49-column CSV (reportFields.ts)
  // populated; they are no longer consumed for ranking or sizing.
  const alignment = conflicts.regime_alignment_score;
  const conflictScore = conflicts.signal_conflict_score;

  const roundTripCost = roundTripCostPct(
    row,
    config.costs ?? {},
    config.factors?.forward_return_hours ?? 24,
    directionalScore,
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
    factor_score: pyRound(directionalScore, 4),
    liquidity_quality: pyRound(liquidityQuality, 2),
    long_score: pyRound(Math.max(longScore, 0.0), 2),
    short_score: pyRound(Math.max(shortScore, 0.0), 2),
    crowded_long_score: pyRound(crowdedLongScore, 2),
    squeeze_risk_score: pyRound(squeezeRiskScore, 2),
    confidence_score: pyRound(
      confidenceScore(row, factors, directionalScore, liquidityQuality, conflicts),
      0,
    ),
    signal_conflict_score: pyRound(conflictScore, 0),
    regime_alignment_score: pyRound(alignment, 3),
    breadth_alignment_score: pyRound(conflicts.breadth_alignment_score, 3),
    round_trip_cost_pct: pyRound(roundTripCost, 4),
    size_multiplier: pyRound(sizeMultiplier, 3),
  };
  row.scores = scores;
  Object.assign(row, conflicts);
  Object.assign(row, scores);
}

/** Mutates `row` in place. */
export function applyExcludedScores(row: Row): void {
  const scores: RowScores = {
    factor_score: 0.0,
    liquidity_quality: 0.0,
    long_score: 0.0,
    short_score: 0.0,
    crowded_long_score: 0.0,
    squeeze_risk_score: 0.0,
    confidence_score: 0.0,
    signal_conflict_score: 0.0,
    regime_alignment_score: 0.0,
    breadth_alignment_score: 0.0,
    round_trip_cost_pct: 0.0,
    size_multiplier: 0.0,
  };
  row.scores = scores;
  row.signal_conflict_label = 'excluded';
  row.signal_conflicts = [];
  Object.assign(row, scores);
}

function qualityPercentile(zscore: number): number {
  return 100.0 / (1.0 + Math.exp(-zscore));
}

function signalConflictSummary(
  row: Row,
  factors: Record<string, number>,
  directionalScore: number,
  regime: RegimeLike,
  marketContext: MarketContext,
): SignalConflictSummary {
  const direction = directionValue(directionalScore, 0.03);
  if (direction === 0) {
    return {
      signal_conflict_label: 'neutral',
      signal_conflict_score: 0.0,
      signal_conflicts: [],
      regime_alignment_score: 0.0,
      breadth_alignment_score: 0.0,
    };
  }

  const checks: Array<[string, string, number | null, number]> = [
    [
      'technical',
      '4h technicals',
      avgSignal([row.technical_trend_score, row.technical_momentum_score]),
      0.2,
    ],
    ['derivatives', 'derivatives confirmation', toFloat(row.derivatives_confirmation_score), 0.2],
    ['funding', 'funding contrarian', factors.funding_rate_contrarian ?? null, 0.35],
    ['positioning', 'OI/price', factors.oi_price_signal ?? null, 0.35],
    ['taker', 'taker flow', factors.taker_flow_24h ?? null, 0.35],
  ];
  const conflicts: ConflictItem[] = [];
  for (const [code, label, value, threshold] of checks) {
    const conflict = conflictItem(code, label, value, direction, threshold);
    if (conflict) {
      conflicts.push(conflict);
    }
  }

  const regimeAlignment = regimeAlignmentScore(direction, regime);
  if (regimeAlignment < -0.25) {
    conflicts.push({
      code: 'regime_bias',
      label: 'regime bias',
      severity: pyRound(Math.abs(regimeAlignment), 3),
      detail: `${regime.bias ?? 'mixed'} conflicts with model direction`,
    });
  }

  const breadth = asRecord(marketContext.breadth);
  const breadthScore = toFloat(breadth.score);
  const breadthAlignment = breadthScore === null ? 0.0 : clamp(breadthScore * direction, -1.0, 1.0);
  if (breadthAlignment < -0.25) {
    conflicts.push({
      code: 'market_breadth',
      label: 'market breadth',
      severity: pyRound(Math.abs(breadthAlignment), 3),
      detail: `${(breadth.label as string | undefined) ?? 'breadth'} conflicts with model direction`,
    });
  }

  const conflictScore = Math.min(
    100.0,
    conflicts.reduce((sum, item) => sum + (18.0 + item.severity * 22.0), 0),
  );
  return {
    signal_conflict_label: conflictLabel(conflicts),
    signal_conflict_score: pyRound(conflictScore, 2),
    signal_conflicts: conflicts,
    regime_alignment_score: pyRound(regimeAlignment, 3),
    breadth_alignment_score: pyRound(breadthAlignment, 3),
  };
}

function confidenceScore(
  row: Row,
  factors: Record<string, number>,
  directionalScore: number,
  liquidityQuality: number,
  conflicts: SignalConflictSummary,
): number {
  const dataQuality = toFloat(row.data_quality_score, 100.0) ?? 100.0;
  const trend = toFloat(row.technical_trend_score);
  const momentum = toFloat(row.technical_momentum_score);
  const derivatives = toFloat(row.derivatives_confirmation_score);
  const factorStrength = clamp(Math.abs(directionalScore) / 1.25);
  const liquidity = clamp(liquidityQuality / 100.0);
  const quality = clamp(dataQuality / 100.0);
  const technicalAlignment = technicalAlignmentScore(directionalScore, trend, momentum);
  const derivativesAlignment = signalAlignment(directionalScore, derivatives);
  const breadthAlignment = (conflicts.breadth_alignment_score + 1.0) / 2.0;
  const conflictPenalty = clamp((conflicts.signal_conflict_score || 0.0) / 100.0);
  const driverCount = DIRECTIONAL_FACTORS.filter(
    (name) => Math.abs(factors[name] ?? 0.0) >= 0.5,
  ).length;
  const confirmation = clamp(driverCount / 3.0);

  let confidence =
    (factorStrength * 0.24 +
      liquidity * 0.18 +
      quality * 0.2 +
      technicalAlignment * 0.17 +
      derivativesAlignment * 0.09 +
      breadthAlignment * 0.05 +
      confirmation * 0.07 -
      conflictPenalty * 0.12) *
    100.0;
  if (row.is_trusted === false) {
    confidence *= 0.35;
  }
  return clamp(confidence, 0.0, 100.0);
}

function technicalAlignmentScore(
  directionalScore: number,
  trendScore: number | null,
  momentumScore: number | null,
): number {
  const technicalValues = [trendScore, momentumScore].filter(
    (value): value is number => value !== null,
  );
  if (technicalValues.length === 0) {
    return 0.5;
  }
  if (directionalScore === 0) {
    return 0.5;
  }
  const direction = directionalScore > 0 ? 1.0 : -1.0;
  const aligned = technicalValues.reduce(
    (sum, value) => sum + clamp((value * direction + 1.0) / 2.0),
    0,
  );
  return aligned / technicalValues.length;
}

function signalAlignment(directionalScore: number, signal: number | null): number {
  if (signal === null || directionalScore === 0) {
    return 0.5;
  }
  const direction = directionalScore > 0 ? 1.0 : -1.0;
  return clamp((signal * direction + 1.0) / 2.0);
}

function directionValue(value: number | null, threshold = 0.0): -1 | 0 | 1 {
  const numeric = toFloat(value, 0.0) ?? 0.0;
  if (numeric > threshold) {
    return 1;
  }
  if (numeric < -threshold) {
    return -1;
  }
  return 0;
}

function avgSignal(values: unknown[]): number | null {
  const numeric = values
    .map((value) => toFloat(value))
    .filter((value): value is number => value !== null);
  return numeric.length > 0 ? mean(numeric) : null;
}

function conflictItem(
  code: string,
  label: string,
  value: number | null,
  direction: number,
  threshold: number,
): ConflictItem | null {
  const numeric = toFloat(value);
  if (numeric === null || Math.abs(numeric) < threshold) {
    return null;
  }
  const alignment = clamp(numeric * direction, -1.0, 1.0);
  if (alignment >= -threshold) {
    return null;
  }
  return {
    code,
    label,
    severity: pyRound(Math.abs(alignment), 3),
    detail: `${label} points ${numeric > 0 ? 'long' : 'short'}`,
  };
}

function regimeAlignmentScore(direction: number, regime: RegimeLike): number {
  const bias = regime.bias ?? 'mixed';
  const biasScore = toFloat(regime.bias_score);
  if (biasScore !== null && Math.abs(biasScore) >= 0.25) {
    return clamp(biasScore * direction, -1.0, 1.0);
  }
  if (bias === 'risk-on') {
    return 0.6 * direction;
  }
  if (bias === 'risk-off') {
    return -0.6 * direction;
  }
  return 0.0;
}

function conflictLabel(conflicts: ConflictItem[]): string {
  if (conflicts.length === 0) {
    return 'aligned';
  }
  if (conflicts.length === 1 && (conflicts[0]?.severity ?? 0.0) < 0.55) {
    return 'minor-conflict';
  }
  if (conflicts.some((item) => (item.severity ?? 0.0) >= 0.75) || conflicts.length >= 3) {
    return 'high-conflict';
  }
  return 'mixed-signals';
}
