import {
  CvdAbsorptionStateSchema,
  type DashboardRow,
  type DashboardRowSide,
  FRESH_EMA_CROSS_MAX_BARS,
  OiPriceTrendStateSchema,
} from '@crypto-screener/contracts';
import { DIRECTIONAL_FACTORS } from '../pipeline/factorDefinitions.js';
import { formatSigned, pyRound, toFloat } from '../pipeline/scoring.js';
import type { Row } from '../pipeline/types.js';
import { asArray, asRecord } from '../pipeline/types.js';
import { factorLabel } from './taxonomy.js';

const MIN_HISTORY_POINTS = 6;

export interface HistoryPoint {
  generated_at: string;
  price_usd: number | null;
  price_change_24h_pct: number | null;
  oi_change_24h_pct: number | null;
  funding_rate_pct: number | null;
  long_short_ratio: number | null;
  long_short_account_ratio: number | null;
  top_trader_long_short_ratio: number | null;
  quote_volume_usd: number | null;
  technical_trend_4h: number | null;
  technical_momentum_4h: number | null;
  rsi_14: number | null;
  long_score: number | null;
  short_score: number | null;
  crowded_long_score: number | null;
  squeeze_risk_score: number | null;
}

/** Passes a value through only if it is already a JS `number`, else `null`; no coercion. */
export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Passes a value through only if it is already a JS `boolean`, else `null`; no coercion. */
export function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Passes 'long'/'short' through as-is; anything else (absent, garbage) becomes null. */
export function fightsBtcOrNull(value: unknown): 'long' | 'short' | null {
  return value === 'long' || value === 'short' ? value : null;
}

/** Passes a recognized cvd_absorption_state value through as-is; anything else becomes null. */
export function cvdAbsorptionStateOrNull(value: unknown): DashboardRow['cvd_absorption_state'] {
  const parsed = CvdAbsorptionStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Passes a recognized oi_price_trend_state value through as-is; anything else becomes null. */
export function oiPriceTrendStateOrNull(value: unknown): DashboardRow['oi_price_trend_state'] {
  const parsed = OiPriceTrendStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Top-trader long/short positioning relative to the crowd's (top ÷ global). >1 = smart money more long than retail; null when either ratio is missing or the crowd ratio is non-positive. */
export function positioningDivergenceRatio(
  global: number | null,
  top: number | null,
): number | null {
  if (global === null || top === null || global <= 0) {
    return null;
  }
  return top / global;
}

// Below these magnitudes a 24h price or OI move is noise, not a legible positioning read.
const OI_PRICE_QUADRANT_PRICE_DEADZONE_PCT = 0.5;
const OI_PRICE_QUADRANT_OI_DEADZONE_PCT = 1.0;

/** Reads price change x OI change into a positioning quadrant; null when either input is missing or either magnitude sits inside its dead-zone. */
export function oiPriceQuadrant(
  priceChangePct: number | null,
  oiChangePct: number | null,
): DashboardRow['oi_price_quadrant'] {
  if (priceChangePct === null || oiChangePct === null) {
    return null;
  }
  if (
    Math.abs(priceChangePct) < OI_PRICE_QUADRANT_PRICE_DEADZONE_PCT ||
    Math.abs(oiChangePct) < OI_PRICE_QUADRANT_OI_DEADZONE_PCT
  ) {
    return null;
  }
  if (priceChangePct > 0) {
    return oiChangePct > 0 ? 'new_longs' : 'short_covering';
  }
  return oiChangePct > 0 ? 'new_shorts' : 'long_liquidation';
}

export function historyPercentile(
  history: HistoryPoint[] | null | undefined,
  historyKey: keyof HistoryPoint,
  currentValue: unknown,
  fallbackKey?: keyof HistoryPoint,
): number | null {
  const values: number[] = [];
  for (const point of history ?? []) {
    let value = toFloat(point[historyKey]);
    if (value === null && fallbackKey) {
      value = toFloat(point[fallbackKey]);
    }
    if (value !== null) {
      values.push(value);
    }
  }
  if (values.length < MIN_HISTORY_POINTS) {
    return null;
  }
  const current = toFloat(currentValue);
  if (current === null) {
    return null;
  }
  const rank = (values.filter((value) => value <= current).length / values.length) * 100.0;
  return pyRound(rank, 0);
}

export function setupLabel(row: Row, side: string): string {
  const technicalSetup = typeof row.technical_setup === 'string' ? row.technical_setup : '';
  if (technicalSetup && (side === 'long' || side === 'short')) {
    const suffix = side === 'long' ? 'Long' : 'Short';
    return `${technicalSetup} ${suffix}`;
  }
  const priceChange = toFloat(row.price_change_24h_pct) ?? 0.0;
  const oiChange = toFloat(row.oi_change_24h_pct) ?? 0.0;
  const funding = toFloat(row.funding_rate_pct) ?? 0.0;
  const lsRatio = toFloat(row.long_short_ratio);
  if (side === 'core') {
    return 'Core Regime Read';
  }
  if (side === 'fade-long') {
    return 'Crowded Long Fade';
  }
  if (side === 'squeeze-risk') {
    return 'Short Squeeze Risk';
  }
  if (side === 'long') {
    if (priceChange > 0 && oiChange > 0) {
      return 'OI Momentum Long';
    }
    if (priceChange < 0 && oiChange <= 0) {
      return 'Reversal Long';
    }
    if (funding < 0) {
      return 'Funding Tailwind Long';
    }
    return 'Long Candidate';
  }
  if (side === 'short') {
    if (priceChange < 0 && oiChange > 0) {
      return 'OI Breakdown Short';
    }
    if (priceChange > 0 && oiChange <= 0) {
      return 'Reversal Short';
    }
    if (funding > 0.01 || (lsRatio !== null && lsRatio > 1.2)) {
      return 'Crowding Short';
    }
    return 'Short Candidate';
  }
  return 'Watchlist';
}

export function setupTone(side: string): string {
  if (side === 'long') {
    return 'pos';
  }
  if (side === 'short') {
    return 'neg';
  }
  if (side === 'fade-long' || side === 'squeeze-risk') {
    return 'warn';
  }
  return 'neutral';
}

/**
 * Purely observable ranking key (score magnitude x data quality) used to pick and order the
 * cross-section "chart_next" watchlist.
 */
export function chartPriority(row: Row, score: unknown): number {
  const numericScore = Math.abs(toFloat(score) ?? 0.0);
  const quality = toFloat(row.data_quality_score);
  let qualityMultiplier = Math.max(
    0.0,
    Math.min(1.0, (quality === null ? 100.0 : quality) / 100.0),
  );
  if (row.is_trusted === false) {
    qualityMultiplier *= 0.35;
  }
  return pyRound(numericScore * qualityMultiplier, 2);
}

export function reasonTone(value: number): string {
  if (value > 0) {
    return 'pos';
  }
  if (value < 0) {
    return 'neg';
  }
  return 'neutral';
}

export interface ReasonPart {
  kind: string;
  label: string;
  value: string;
  tone: string;
  help: string;
}

function appendReasonMetric(
  parts: ReasonPart[],
  label: string,
  value: unknown,
  format: (numeric: number) => string,
  helpText: string,
  neutralValue = 0.0,
): void {
  const numeric = toFloat(value);
  if (numeric === null) {
    return;
  }
  parts.push({
    kind: 'metric',
    label,
    value: format(numeric),
    tone: reasonTone(numeric - neutralValue),
    help: helpText,
  });
}

export function reasonParts(row: Row, side: string): ReasonPart[] {
  const parts: ReasonPart[] = [];
  const factors = asRecord(row.factors);

  appendReasonMetric(
    parts,
    '24h',
    row.price_change_24h_pct,
    (n) => `${formatSigned(n, 2)}%`,
    'Spot or mark price change over the last 24 hours.',
  );
  appendReasonMetric(
    parts,
    'OI 24h',
    row.oi_change_24h_pct,
    (n) => `${formatSigned(n, 2)}%`,
    'Open-interest change over the last 24 hours; rising OI means more futures positioning.',
  );
  appendReasonMetric(
    parts,
    'Funding',
    row.funding_rate_pct,
    (n) => `${formatSigned(n, 4)}%`,
    'Perpetual funding rate; positive usually means longs pay shorts, negative means shorts pay longs.',
  );
  if (row.long_short_ratio !== null && row.long_short_ratio !== undefined) {
    appendReasonMetric(
      parts,
      'L/S',
      row.long_short_ratio,
      (n) => n.toFixed(2),
      'Long/short volume ratio; above 1 leans long, below 1 leans short.',
      1.0,
    );
  }
  if (row.technical_setup) {
    parts.push({
      kind: 'context',
      label: 'Tech',
      value: String(row.technical_setup),
      tone: technicalTone(row),
      help: '4h CoinGlass OHLC technical state used as confirmation context.',
    });
  }
  if (row.rsi_14 !== null && row.rsi_14 !== undefined) {
    appendReasonMetric(
      parts,
      'RSI',
      row.rsi_14,
      (n) => n.toFixed(1),
      '14-period RSI on the configured CoinGlass candle interval.',
      50.0,
    );
  }

  if (row.cvd_absorption_state === 'absorption_bearish') {
    parts.push({
      kind: 'context',
      label: 'Tape',
      value: 'distribution into strength',
      tone: 'warn',
      help: '3d price up but net taker flow is negative -- selling into strength.',
    });
  } else if (row.cvd_absorption_state === 'absorption_bullish') {
    parts.push({
      kind: 'context',
      label: 'Tape',
      value: 'sellers absorbed',
      tone: 'warn',
      help: '3d price down but net taker flow is positive -- sellers being absorbed.',
    });
  } else if (row.cvd_absorption_state === 'confirmation_long') {
    parts.push({
      kind: 'context',
      label: 'Tape',
      value: 'confirms strength',
      tone: 'pos',
      help: '3d price up and net taker flow agrees -- the move has real buying behind it.',
    });
  } else if (row.cvd_absorption_state === 'confirmation_short') {
    parts.push({
      kind: 'context',
      label: 'Tape',
      value: 'confirms weakness',
      tone: 'pos',
      help: '3d price down and net taker flow agrees -- the move has real selling behind it.',
    });
  }

  if (row.oi_price_trend_state === 'diverging_long') {
    parts.push({
      kind: 'context',
      label: 'OI',
      value: '3d drain vs move',
      tone: 'warn',
      help: '24h price up but 3d open interest has been draining -- late positioning.',
    });
  } else if (row.oi_price_trend_state === 'diverging_short') {
    parts.push({
      kind: 'context',
      label: 'OI',
      value: '3d build vs move',
      tone: 'warn',
      help: '24h price down but 3d open interest has been building -- crowded short.',
    });
  }

  if (row.technical_divergence === 'bearish' || row.technical_divergence === 'bullish') {
    parts.push({
      kind: 'context',
      label: 'RSI divergence',
      value: String(row.technical_divergence),
      tone: 'warn',
      help: 'Price made a new swing extreme but RSI did not confirm it -- a possible momentum divergence.',
    });
  }

  const emaCrossBarsSince = toFloat(row.ema_cross_bars_since);
  if (
    emaCrossBarsSince !== null &&
    emaCrossBarsSince <= FRESH_EMA_CROSS_MAX_BARS &&
    (row.ema_cross_direction === 'bullish' || row.ema_cross_direction === 'bearish')
  ) {
    parts.push({
      kind: 'context',
      label: 'Fresh EMA20/50 cross',
      value: row.ema_cross_direction === 'bullish' ? 'bull' : 'bear',
      tone: row.ema_cross_direction === 'bullish' ? 'pos' : 'neg',
      help: `EMA20 crossed EMA50 ${emaCrossBarsSince} bars ago.`,
    });
  }

  const strongest = Object.entries(factors)
    .filter((entry): entry is [string, unknown] => DIRECTIONAL_FACTORS.includes(entry[0]))
    .map(([name, value]) => [name, toFloat(value)] as const)
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 2);
  for (const [name, value] of strongest) {
    if (Math.abs(value) >= 0.5) {
      parts.push({
        kind: 'driver',
        label: factorLabel(name),
        value: formatSigned(value, 2),
        tone: reasonTone(value),
        help: 'Normalized factor driver. Larger absolute values contributed more to the setup read.',
      });
    }
  }

  if (side === 'fade-long') {
    parts.push({
      kind: 'context',
      label: 'Crowding',
      value: 'long fade',
      tone: 'warn',
      help: 'Crowded-long watchlist: useful for fade ideas, not automatic shorts.',
    });
  }
  if (side === 'squeeze-risk') {
    parts.push({
      kind: 'context',
      label: 'Crowding',
      value: 'short squeeze',
      tone: 'warn',
      help: 'Crowded-short watchlist: useful for squeeze-risk review, not automatic longs.',
    });
  }

  const qualityFlags = asArray(row.data_quality_flags);
  if (qualityFlags.length > 0) {
    parts.push({
      kind: 'quality',
      label: 'Excluded',
      value: qualityFlags.map((flag) => String(flag)).join(', '),
      tone: 'bad',
      help: 'This row failed sanity checks and is excluded from ranking.',
    });
  }

  return parts;
}

const TECHNICAL_STATE_KEYS = [
  'technical_interval',
  'technical_candle_count',
  'technical_close',
  'ema_20',
  'ema_50',
  'ema_200',
  'distance_ema20_pct',
  'rsi_14',
  'macd_histogram_pct',
  'atr_14_pct',
  'bb_position',
  'bb_width_pct',
  'technical_trend_score',
  'technical_momentum_score',
  'trend_state',
  'breakout_pct_20',
  'breakdown_pct_20',
  'donchian_position_20',
  'donchian_high_20',
  'donchian_low_20',
  'breakout_volume_ratio_20',
  'ema_cross_direction',
  'ema_cross_bars_since',
  'technical_divergence',
  'technical_divergence_strength',
  'fib_leg_high',
  'fib_leg_low',
  'fib_leg_direction',
  'golden_pocket_upper',
  'golden_pocket_lower',
  'distance_to_golden_pocket_pct',
] as const;

/** The cast to DashboardRow['technical_state'] is safe because these keys are only ever written by technicals.ts as the types the schema expects. */
export function technicalState(row: Row): DashboardRow['technical_state'] {
  const state: Record<string, unknown> = {};
  for (const key of TECHNICAL_STATE_KEYS) {
    const value = row[key];
    if (value !== null && value !== undefined) {
      state[key] = value;
    }
  }
  return state as DashboardRow['technical_state'];
}

export function technicalTone(row: Row): string {
  const trend = toFloat(row.technical_trend_score);
  const momentum = toFloat(row.technical_momentum_score);
  const values = [trend, momentum].filter((value): value is number => value !== null);
  if (values.length === 0) {
    return 'neutral';
  }
  return reasonTone(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// Reuses trendStateOf/trendScoreOf's own 0.55 threshold (technicals.ts) for the trend vote.
const SETUP_CONFIDENCE_TREND_FLOOR = 0.55;
// Below this many of the 4 votes agreeing, confidence drops to the lowest grade.
const SETUP_CONFIDENCE_MIN_VOTES_FOR_B = 2;

/**
 * Grades a directional setup by how many independent, already-computed reads agree with it: trend
 * score, momentum score, 24h OI change not draining, and not being actively BTC-veto'd. Missing
 * evidence counts as a failed vote (not an ignored one) -- an unreadable input is not agreement.
 * All 4 agreeing -> 'A'; at least half -> 'B'; otherwise -> 'C'.
 */
export function setupConfidence(
  side: 'long' | 'short',
  trendScore: number | null,
  momentumScore: number | null,
  oiChange24hPct: number | null,
  fightsBtc: 'long' | 'short' | null,
): 'A' | 'B' | 'C' {
  const votes =
    side === 'long'
      ? [
          trendScore !== null && trendScore >= SETUP_CONFIDENCE_TREND_FLOOR,
          momentumScore !== null && momentumScore > 0,
          oiChange24hPct !== null && oiChange24hPct >= 0,
          fightsBtc !== 'long',
        ]
      : [
          trendScore !== null && trendScore <= -SETUP_CONFIDENCE_TREND_FLOOR,
          momentumScore !== null && momentumScore < 0,
          oiChange24hPct !== null && oiChange24hPct >= 0,
          fightsBtc !== 'short',
        ];
  const votesPassed = votes.filter(Boolean).length;
  if (votesPassed === votes.length) {
    return 'A';
  }
  if (votesPassed >= SETUP_CONFIDENCE_MIN_VOTES_FOR_B) {
    return 'B';
  }
  return 'C';
}

const SCORE_KEYS = [
  'long_score',
  'short_score',
  'crowded_long_score',
  'squeeze_risk_score',
  'round_trip_cost_pct',
  'size_multiplier',
] as const satisfies ReadonlyArray<keyof DashboardRow['scores']>;

function rowScores(scores: Record<string, unknown>): DashboardRow['scores'] {
  const result = {} as Record<(typeof SCORE_KEYS)[number], number | null>;
  for (const key of SCORE_KEYS) {
    result[key] = numberOrNull(scores[key]);
  }
  return result;
}

export function dashboardRow(
  row: Row,
  scoreField: string | null,
  side: DashboardRowSide,
  history: HistoryPoint[] | null | undefined = null,
  newToList = false,
): DashboardRow {
  const scores = asRecord(row.scores);
  const score = scoreField === null ? null : row[scoreField];
  const setup = setupLabel(row, side);
  const priority = chartPriority(row, score);
  let positioningRatio = row.long_short_account_ratio;
  if (positioningRatio === null || positioningRatio === undefined) {
    positioningRatio = row.long_short_ratio;
  }
  const fundingPercentile = historyPercentile(history, 'funding_rate_pct', row.funding_rate_pct);
  const oiChangePercentile = historyPercentile(history, 'oi_change_24h_pct', row.oi_change_24h_pct);
  const positioningPercentile = historyPercentile(
    history,
    'long_short_account_ratio',
    positioningRatio,
    'long_short_ratio',
  );

  return {
    symbol: stringOrNull(row.symbol),
    side,
    setup,
    setup_tone: setupTone(side),
    score_field: scoreField,
    score: numberOrNull(score),
    priority,
    quality: numberOrNull(row.data_quality_score) ?? 100,
    primary_exchange: stringOrNull(row.primary_exchange),
    price_usd: numberOrNull(row.price_usd),
    price_change_24h_pct: numberOrNull(row.price_change_24h_pct),
    oi_change_24h_pct: numberOrNull(row.oi_change_24h_pct),
    funding_rate_pct: numberOrNull(row.funding_rate_pct),
    long_short_ratio: numberOrNull(row.long_short_ratio),
    long_short_account_ratio: numberOrNull(row.long_short_account_ratio),
    top_trader_long_short_ratio: numberOrNull(row.top_trader_long_short_ratio),
    btc_correlation: numberOrNull(row.btc_correlation),
    btc_beta: numberOrNull(row.btc_beta),
    residual_change_24h_pct: numberOrNull(row.residual_change_24h_pct),
    fights_btc: fightsBtcOrNull(row.fights_btc),
    oi_price_quadrant: oiPriceQuadrant(
      numberOrNull(row.price_change_24h_pct),
      numberOrNull(row.oi_change_24h_pct),
    ),
    cvd_trend_72h_pct: numberOrNull(row.cvd_trend_72h_pct),
    cvd_absorption_state: cvdAbsorptionStateOrNull(row.cvd_absorption_state),
    oi_change_72h_pct_history: numberOrNull(row.oi_change_72h_pct_history),
    oi_price_trend_state: oiPriceTrendStateOrNull(row.oi_price_trend_state),
    top_trader_position_ratio: numberOrNull(row.top_trader_position_ratio),
    top_trader_ratio_delta_24h: numberOrNull(row.top_trader_ratio_delta_24h),
    price_history_gapped: booleanOrNull(row.price_history_gapped),
    funding_percentile: fundingPercentile,
    oi_change_percentile: oiChangePercentile,
    positioning_percentile: positioningPercentile,
    positioning_divergence: positioningDivergenceRatio(
      numberOrNull(row.long_short_account_ratio),
      numberOrNull(row.top_trader_long_short_ratio),
    ),
    liquidation_imbalance_24h_pct: numberOrNull(row.liquidation_imbalance_24h_pct),
    taker_imbalance_24h_pct: numberOrNull(row.taker_imbalance_24h_pct),
    quote_volume_usd: numberOrNull(row.quote_volume_usd),
    open_interest_usd: numberOrNull(row.open_interest_usd),
    technical_setup: stringOrNull(row.technical_setup),
    // Key genuinely omitted (not set to undefined) for non-directional sides, matching
    // technicalState()'s own convention above -- "field absent" per the wire contract, since
    // setup_confidence is optional-but-not-nullable (no side is not the same as an unreadable A/B/C).
    ...(side === 'long' || side === 'short'
      ? {
          setup_confidence: setupConfidence(
            side,
            toFloat(row.technical_trend_score),
            toFloat(row.technical_momentum_score),
            toFloat(row.oi_change_24h_pct),
            fightsBtcOrNull(row.fights_btc),
          ),
        }
      : {}),
    // Same absent-unless-true convention as setup_confidence above: present only when this row
    // just joined a directional list this run (see dashboard/runDiff.ts's watchlistDiff).
    ...(newToList ? { new_to_list: true } : {}),
    technical_state: technicalState(row),
    data_source: stringOrNull(row.data_source),
    is_trusted: row.is_trusted ?? true,
    data_quality_flags: asArray(row.data_quality_flags) as string[],
    scores: rowScores(scores),
    history: history ?? [],
    reason_parts: reasonParts(row, side),
  };
}
