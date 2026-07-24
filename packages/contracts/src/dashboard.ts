import { z } from 'zod';

/**
 * snake_case keys: preserved wire contract for an existing client, not idiomatic TS.
 * regime/market_context/provider_status/validation are intentionally non-strict + jsonRecord —
 * the pipeline assembles them as free-form blobs.
 */

const jsonRecord = z.record(z.string(), z.unknown());

const ReasonPartSchema = z.object({
  kind: z.string(),
  label: z.string(),
  value: z.string(),
  tone: z.string(),
  help: z.string(),
});

const RowScoresSchema = z.object({
  long_score: z.number().nullable(),
  short_score: z.number().nullable(),
  crowded_long_score: z.number().nullable(),
  squeeze_risk_score: z.number().nullable(),
  round_trip_cost_pct: z.number().nullable(),
  size_multiplier: z.number().nullable(),
});

const TechnicalStateSchema = z.object({
  technical_interval: z.string().optional(),
  technical_candle_count: z.number().optional(),
  technical_close: z.number().optional(),
  ema_20: z.number().optional(),
  ema_50: z.number().optional(),
  ema_200: z.number().optional(),
  distance_ema20_pct: z.number().optional(),
  rsi_14: z.number().optional(),
  macd_histogram_pct: z.number().optional(),
  atr_14_pct: z.number().optional(),
  bb_position: z.number().optional(),
  bb_width_pct: z.number().optional(),
  technical_trend_score: z.number().optional(),
  technical_momentum_score: z.number().optional(),
  trend_state: z
    .enum(['uptrend', 'downtrend', 'chop', 'exhaustion_top', 'exhaustion_bottom'])
    .nullable()
    .optional(),
  breakout_pct_20: z.number().nullable().optional(),
  breakdown_pct_20: z.number().nullable().optional(),
  donchian_position_20: z.number().nullable().optional(),
  donchian_high_20: z.number().nullable().optional(),
  donchian_low_20: z.number().nullable().optional(),
  breakout_volume_ratio_20: z.number().nullable().optional(),
  ema_cross_direction: z.enum(['bullish', 'bearish']).nullable().optional(),
  ema_cross_bars_since: z.number().nullable().optional(),
  technical_divergence: z.enum(['bearish', 'bullish']).nullable().optional(),
  technical_divergence_strength: z.number().nullable().optional(),
  fib_leg_high: z.number().nullable().optional(),
  fib_leg_low: z.number().nullable().optional(),
  fib_leg_direction: z.enum(['up', 'down']).nullable().optional(),
  golden_pocket_upper: z.number().nullable().optional(),
  golden_pocket_lower: z.number().nullable().optional(),
  distance_to_golden_pocket_pct: z.number().nullable().optional(),
});

// A cross this recent (<=1 day at 4h bars) is still tradeable news; older ones are already priced
// in. Shared by apps/api (the "Fresh EMA20/50 cross" reason-part chip) and apps/web (the Chart
// detail "Trend shift" line) so the chip and the line always agree on what counts as fresh.
export const FRESH_EMA_CROSS_MAX_BARS = 6;

const HistoryPointSchema = z.object({
  generated_at: z.string(),
  price_usd: z.number().nullable(),
  price_change_24h_pct: z.number().nullable(),
  oi_change_24h_pct: z.number().nullable(),
  funding_rate_pct: z.number().nullable(),
  long_short_ratio: z.number().nullable(),
  long_short_account_ratio: z.number().nullable(),
  top_trader_long_short_ratio: z.number().nullable(),
  quote_volume_usd: z.number().nullable(),
  technical_trend_4h: z.number().nullable(),
  technical_momentum_4h: z.number().nullable(),
  rsi_14: z.number().nullable(),
  long_score: z.number().nullable(),
  short_score: z.number().nullable(),
  crowded_long_score: z.number().nullable(),
  squeeze_risk_score: z.number().nullable(),
});

export const DashboardRowSideSchema = z.enum([
  'core',
  'long',
  'short',
  'fade-long',
  'squeeze-risk',
]);

export const CvdAbsorptionStateSchema = z.enum([
  'absorption_bearish',
  'absorption_bullish',
  'confirmation_long',
  'confirmation_short',
]);

export const OiPriceTrendStateSchema = z.enum([
  'diverging_long',
  'diverging_short',
  'confirmed_long',
  'confirmed_short',
]);

// apps/api/src/dashboard/runDiff.ts `runTrend()` -- a directional row's run-over-run score
// trajectory against the previous version-matched run. See DashboardRowSchema.run_trend below for
// when it's present at all.
export const RunTrendSchema = z.enum(['new', 'strengthening', 'weakening', 'holding']);

export const DashboardRowSchema = z.object({
  symbol: z.string().nullable(),
  side: DashboardRowSideSchema,
  setup: z.string(),
  setup_tone: z.string(),
  // null for 'core' rows: majors are shown for context, not ranked -- there is no observable score.
  score_field: z.string().nullable(),
  score: z.number().nullable(),
  priority: z.number(),
  quality: z.number(),
  primary_exchange: z.string().nullable(),
  price_usd: z.number().nullable(),
  price_change_24h_pct: z.number().nullable(),
  oi_change_24h_pct: z.number().nullable(),
  funding_rate_pct: z.number().nullable(),
  long_short_ratio: z.number().nullable(),
  long_short_account_ratio: z.number().nullable(),
  top_trader_long_short_ratio: z.number().nullable(),
  btc_correlation: z.number().nullable(),
  btc_beta: z.number().nullable().optional(),
  residual_change_24h_pct: z.number().nullable().optional(),
  fights_btc: z.enum(['long', 'short']).nullable().optional(),
  oi_price_quadrant: z
    .enum(['new_longs', 'short_covering', 'new_shorts', 'long_liquidation'])
    .nullable()
    .optional(),
  cvd_trend_72h_pct: z.number().nullable().optional(),
  cvd_absorption_state: CvdAbsorptionStateSchema.nullable().optional(),
  oi_change_72h_pct_history: z.number().nullable().optional(),
  oi_price_trend_state: OiPriceTrendStateSchema.nullable().optional(),
  top_trader_position_ratio: z.number().nullable().optional(),
  top_trader_ratio_delta_24h: z.number().nullable().optional(),
  price_history_gapped: z.boolean().nullable().optional(),
  funding_percentile: z.number().nullable(),
  oi_change_percentile: z.number().nullable(),
  positioning_percentile: z.number().nullable(),
  positioning_divergence: z.number().nullable(),
  liquidation_imbalance_24h_pct: z.number().nullable(),
  taker_imbalance_24h_pct: z.number().nullable(),
  quote_volume_usd: z.number().nullable(),
  open_interest_usd: z.number().nullable(),
  technical_setup: z.string().nullable(),
  setup_confidence: z.enum(['A', 'B', 'C']).optional(),
  // Present (true) only when this row just joined the long/short watchlist this run; absent
  // otherwise (not new, not a directional row, or the run-over-run diff was suppressed -- see
  // apps/api/src/dashboard/runDiff.ts).
  new_to_list: z.boolean().optional(),
  // Present only for a directional (long/short) row when a version-matched previous run's
  // same-side score was available to compare against; absent otherwise (no baseline, a
  // pipeline_version mismatch, or a non-directional row) -- see apps/api/src/dashboard/runDiff.ts.
  run_trend: RunTrendSchema.optional(),
  technical_state: TechnicalStateSchema,
  data_source: z.string().nullable(),
  is_trusted: z.boolean(),
  data_quality_flags: z.array(z.string()),
  scores: RowScoresSchema,
  history: z.array(HistoryPointSchema),
  reason_parts: z.array(ReasonPartSchema),
});

export const RunSummarySchema = z.object({
  run_id: z.string(),
  generated_at: z.string(),
  row_count: z.number(),
  excluded_count: z.number(),
  bias: z.string(),
  factor_regime: z.string(),
  coinglass_status: z.string(),
});

export const SelectedRunSchema = RunSummarySchema.pick({
  run_id: true,
  generated_at: true,
  row_count: true,
});

export const FreshnessSchema = z.object({
  status: z.string(),
  label: z.string(),
  generated_at: z.string().optional(),
  age_seconds: z.number().nullable(),
  age_minutes: z.number().nullable(),
  help: z.string().optional(),
});

const FlaggedRowSchema = z.object({
  symbol: z.string().nullable(),
  data_source: z.string().nullable(),
  price_change_24h_pct: z.number().nullable(),
  oi_change_24h_pct: z.number().nullable(),
  flags: z.array(z.string()),
});

export const QualitySchema = z.object({
  trusted_count: z.number(),
  excluded_count: z.number(),
  flagged_count: z.number(),
  flagged_rows: z.array(FlaggedRowSchema),
});

export const SectionsSchema = z.object({
  core: z.array(DashboardRowSchema),
  long: z.array(DashboardRowSchema),
  short: z.array(DashboardRowSchema),
  crowded_longs: z.array(DashboardRowSchema),
  squeeze_risks: z.array(DashboardRowSchema),
});

export const WatchlistIdSchema = z.enum([
  'chart_next',
  'long',
  'short',
  'squeeze_risks',
  'crowded_longs',
  'core',
]);

export const WatchlistSchema = z.object({
  id: WatchlistIdSchema,
  label: z.string(),
  rows: z.array(DashboardRowSchema),
});

/**
 * Run-over-run departures from the long/short watchlists, against the immediately-previous run in
 * factor_history (see apps/api/src/dashboard/runDiff.ts). Each list is alphabetical, capped at 12.
 */
export const WatchlistChangesSchema = z.object({
  baseline_run_id: z.string(),
  departed_long: z.array(z.string()),
  departed_short: z.array(z.string()),
});

/**
 * The newest row from weekly_reviews (apps/api's db/weeklyReview.ts), attached by
 * buildDashboardPayload. `metrics` stays a loose jsonRecord -- it's a computed blob, not a wire
 * contract of its own -- so the web layer reads it defensively (apps/web/lib/weekly-review.ts).
 */
export const WeeklyReviewSchema = z.object({
  generated_at: z.string(),
  week_start: z.string(),
  week_end: z.string(),
  metrics: jsonRecord,
  narrative: z.string().nullable(),
  model: z.string().nullable(),
});

const DashboardPayloadEmptySchema = z.object({
  status: z.literal('empty'),
  database: z.string(),
  runs: z.array(RunSummarySchema),
  /** set by the route handler, not the payload builder; null until a refresh has run. */
  refresh_status: z.unknown().nullable(),
});

const DashboardPayloadOkSchema = z.object({
  status: z.literal('ok'),
  database: z.string(),
  run: SelectedRunSchema,
  runs: z.array(RunSummarySchema),
  regime: jsonRecord,
  market_context: jsonRecord,
  provider_status: jsonRecord,
  validation: jsonRecord,
  freshness: FreshnessSchema,
  quality: QualitySchema,
  sections: SectionsSchema,
  watchlists: z.array(WatchlistSchema),
  // null when there's no usable baseline (no previous run, or a previous run that never recorded
  // watchlist membership -- pre-feature runs and backfill rows). Optional/nullable so old payloads
  // and the empty-state schema stay valid.
  watchlist_changes: WatchlistChangesSchema.nullable().optional(),
  // null before the weekly review has ever run (or the table doesn't exist yet on an old
  // deployment). Optional/nullable so payloads captured before this feature shipped still validate.
  weekly_review: WeeklyReviewSchema.nullable().optional(),
  /** set by the route handler; optional here so this schema also validates the builder's raw return. */
  refresh_status: z.unknown().nullable().optional(),
});

export const DashboardPayloadSchema = z.discriminatedUnion('status', [
  DashboardPayloadEmptySchema,
  DashboardPayloadOkSchema,
]);

export type DashboardRow = z.infer<typeof DashboardRowSchema>;
export type DashboardRowSide = z.infer<typeof DashboardRowSideSchema>;
export type CvdAbsorptionState = z.infer<typeof CvdAbsorptionStateSchema>;
export type OiPriceTrendState = z.infer<typeof OiPriceTrendStateSchema>;
export type RunTrend = z.infer<typeof RunTrendSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type Freshness = z.infer<typeof FreshnessSchema>;
export type Quality = z.infer<typeof QualitySchema>;
export type Sections = z.infer<typeof SectionsSchema>;
export type WatchlistId = z.infer<typeof WatchlistIdSchema>;
export type Watchlist = z.infer<typeof WatchlistSchema>;
export type WatchlistChanges = z.infer<typeof WatchlistChangesSchema>;
export type WeeklyReview = z.infer<typeof WeeklyReviewSchema>;
export type DashboardPayload = z.infer<typeof DashboardPayloadSchema>;
