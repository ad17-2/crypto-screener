import { clamp, mean, pyRound, toFloat } from './scoring.js';
import type { MarketContext, PipelineConfig, Row } from './types.js';
import { asRecord } from './types.js';

export const REGIME_STATES = ['btc-led', 'alts-strong', 'neutral', 'chaos'] as const;
export type RegimeState = (typeof REGIME_STATES)[number];

export interface ClassifiedRegime {
  state: string;
  raw_state: string;
  scores: Record<RegimeState, number>;
}

export function classifyRegime(
  context: MarketContext,
  priorState: string | null | undefined,
  config: PipelineConfig,
): ClassifiedRegime {
  const regimeCfg = config.factors?.regime ?? {};
  const dispersionThreshold = regimeCfg.dispersion_threshold_pct ?? 8.0;
  const hysteresisMargin = regimeCfg.hysteresis_margin ?? 0.15;
  const breadthWeak = regimeCfg.breadth_weak_threshold ?? 0.15;
  const breadthStrong = regimeCfg.breadth_strong_threshold ?? 0.25;
  const dominanceDeltaScale = regimeCfg.dominance_delta_scale_pct ?? 0.5;
  const ethBtcScale = regimeCfg.eth_btc_scale_pct ?? 2.0;

  const btcDomDelta = toFloat(context.btc_dominance_delta_pct);
  const ethBtc = toFloat(context.eth_btc_performance_pct);
  const breadth = asRecord(context.breadth);
  const breadthScore = toFloat(breadth.score);
  const dispersion = toFloat(context.return_dispersion_pct);
  const avgFunding = toFloat(breadth.avg_funding_rate_pct);

  const scores: Record<RegimeState, number> = {
    'btc-led': 0.0,
    'alts-strong': 0.0,
    neutral: 0.0,
    chaos: 0.0,
  };

  if (dispersion !== null && dispersion >= dispersionThreshold) {
    let chaosScore = (dispersion - dispersionThreshold) / Math.max(dispersionThreshold, 1.0);
    if (breadthScore !== null && Math.abs(breadthScore) <= breadthWeak) {
      chaosScore += 0.75;
    }
    if (avgFunding !== null) {
      chaosScore += clamp(Math.abs(avgFunding) / 0.06, 0.0, 0.35);
    }
    scores.chaos = chaosScore;
  }

  let btcLedScore = 0.0;
  if (btcDomDelta !== null && btcDomDelta > 0) {
    btcLedScore += clamp(btcDomDelta / dominanceDeltaScale, 0.0, 1.0);
  }
  if (ethBtc !== null && ethBtc <= 0) {
    btcLedScore += clamp(-ethBtc / ethBtcScale, 0.0, 1.0);
  }
  if (breadthScore !== null && breadthScore <= 0) {
    btcLedScore += clamp(-breadthScore, 0.0, 0.5);
  }
  scores['btc-led'] = btcLedScore;

  let altsScore = 0.0;
  if (btcDomDelta !== null && btcDomDelta < 0) {
    altsScore += clamp(-btcDomDelta / dominanceDeltaScale, 0.0, 1.0);
  }
  if (ethBtc !== null && ethBtc > 0) {
    altsScore += clamp(ethBtc / ethBtcScale, 0.0, 1.0);
  }
  if (breadthScore !== null && breadthScore >= breadthStrong) {
    altsScore += clamp(breadthScore, 0.0, 0.5);
  }
  scores['alts-strong'] = altsScore;

  scores.neutral = 0.2;

  const rawState = (Object.keys(scores) as RegimeState[]).reduce((best, state) =>
    scores[state] > scores[best] ? state : best,
  );
  let state: string = rawState;
  if (
    priorState !== null &&
    priorState !== undefined &&
    priorState in scores &&
    rawState !== priorState &&
    scores[rawState] <= scores[priorState as RegimeState] + hysteresisMargin
  ) {
    state = priorState;
  }

  const roundedScores = Object.fromEntries(
    (Object.keys(scores) as RegimeState[]).map((key) => [key, pyRound(scores[key], 3)]),
  ) as Record<RegimeState, number>;

  return { state, raw_state: rawState, scores: roundedScores };
}

function btcChange(rows: Row[], marketContext: MarketContext): number | null {
  for (const row of rows) {
    if (row.symbol === 'BTC') {
      return toFloat(row.price_change_24h_pct);
    }
  }
  return toFloat(marketContext.btc_price_change_24h_pct);
}

function avg(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length > 0 ? mean(valid) : null;
}

export interface InferredRegime {
  label: string;
  regime_state: string;
  regime_scores: Record<RegimeState, number>;
  raw_regime_state: string;
  bias: 'risk-on' | 'risk-off' | 'mixed';
  bias_score: number;
  btc_change_24h_pct: number | null;
  btc_dominance_delta_pct: number | null;
  eth_btc_performance_pct: number | null;
  avg_funding_rate_pct: number | null;
  market_cap_change_24h_pct: number | null;
  breadth_score: number | null;
  breadth_label: string;
  sector_rotation_label: string;
}

// `_weights` is unused on purpose, kept for call-site parity with scoreSnapshot's inferRegime(weights, rows, marketContext, priorState, config).
export function inferRegime(
  _weights: unknown,
  rows: Row[],
  marketContext: MarketContext,
  priorState: string | null | undefined,
  config: PipelineConfig,
): InferredRegime {
  const avgFunding = avg(rows.map((row) => toFloat(row.funding_rate_pct)));
  const btcChangePct = btcChange(rows, marketContext);
  const marketCapChange = toFloat(marketContext.market_cap_change_24h_pct);
  const breadth = asRecord(marketContext.breadth);
  const sectorRotation = asRecord(marketContext.sector_rotation);
  const breadthScore = toFloat(breadth.score);

  const classified = classifyRegime(marketContext, priorState, config);
  const label = classified.state;

  let biasScore = 0.0;
  if (btcChangePct !== null) {
    biasScore += clamp(btcChangePct / 3.0, -1.0, 1.0);
  }
  if (marketCapChange !== null) {
    biasScore += clamp(marketCapChange / 3.0, -1.0, 1.0);
  }
  if (breadthScore !== null) {
    biasScore += clamp(breadthScore, -1.0, 1.0) * 0.65;
  }
  if (avgFunding !== null) {
    biasScore -= clamp(Math.abs(avgFunding) / 0.06, 0.0, 1.0) * 0.35;
  }

  let bias: 'risk-on' | 'risk-off' | 'mixed';
  if (biasScore >= 0.95) {
    bias = 'risk-on';
  } else if (biasScore <= -0.95) {
    bias = 'risk-off';
  } else {
    bias = 'mixed';
  }

  const btcDominanceDeltaPct = toFloat(marketContext.btc_dominance_delta_pct);
  const ethBtcPerformancePct = toFloat(marketContext.eth_btc_performance_pct);

  return {
    label,
    regime_state: label,
    regime_scores: classified.scores,
    raw_regime_state: classified.raw_state,
    bias,
    bias_score: pyRound(biasScore, 3),
    btc_change_24h_pct: btcChangePct,
    btc_dominance_delta_pct: btcDominanceDeltaPct,
    eth_btc_performance_pct: ethBtcPerformancePct,
    avg_funding_rate_pct: avgFunding,
    market_cap_change_24h_pct: marketCapChange,
    breadth_score: breadthScore,
    breadth_label: (breadth.label as string | undefined) ?? 'unknown',
    sector_rotation_label: (sectorRotation.label as string | undefined) ?? 'unknown',
  };
}
