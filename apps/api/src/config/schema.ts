import { z } from 'zod';

/**
 * All objects are `.strict()` (unknown keys throw). Nested defaults use
 * `Schema.default(() => Schema.parse({}))`, not `Schema.default({})` — the latter skips the
 * schema entirely on a missing key, so nested field defaults never populate.
 */

const TechnicalIndicatorsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval: z.string().default('4h'),
    limit: z.number().int().default(220),
    max_symbols: z.number().int().default(40),
    request_delay_seconds: z.number().default(2.1),
  })
  .strict();

const LongShortRatioConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval: z.string().default('4h'),
    limit: z.number().int().default(30),
    max_symbols: z.number().int().default(0),
    ratio_exchange: z.string().default('Binance'),
    include_top_trader: z.boolean().default(true),
    request_delay_seconds: z.number().default(2.1),
  })
  .strict();

const DerivativesHistoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval: z.string().default('4h'),
    limit: z.number().int().default(220),
    max_symbols: z.number().int().default(25),
    request_delay_seconds: z.number().default(2.1),
  })
  .strict();

const CoinGlassConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    base_url: z.string().default('https://open-api-v4.coinglass.com'),
    api_key_env: z.string().default('COINGLASS_API_KEY'),
    candidate_symbols: z.number().int().default(80),
    min_exchange_count: z.number().int().default(2),
    request_delay_seconds: z.number().default(2.1),
    request_timeout_seconds: z.number().default(12),
    exchanges: z.array(z.string()).default([]),
    technical_indicators: TechnicalIndicatorsConfigSchema.default(() =>
      TechnicalIndicatorsConfigSchema.parse({}),
    ),
    derivatives_history: DerivativesHistoryConfigSchema.default(() =>
      DerivativesHistoryConfigSchema.parse({}),
    ),
    long_short_ratio: LongShortRatioConfigSchema.default(() =>
      LongShortRatioConfigSchema.parse({}),
    ),
  })
  .strict();

const CoinGeckoConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    base_url: z.string().default('https://api.coingecko.com/api/v3'),
    api_key_env: z.string().default('COINGECKO_API_KEY'),
    categories_limit: z.number().int().default(12),
    request_timeout_seconds: z.number().default(12),
    retry_429: z.boolean().default(true),
    retry_429_initial_delay_seconds: z.number().default(30),
    retry_429_max_delay_seconds: z.number().default(300),
    retry_429_jitter_seconds: z.number().default(15),
    retry_429_max_attempts: z.number().int().default(0),
  })
  .strict();

const SoSoValueConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    api_key_env: z.string().default('SOSOVALUE_API_KEY'),
    note: z.string().nullable().default(null),
  })
  .strict();

const ProvidersConfigSchema = z
  .object({
    coinglass: CoinGlassConfigSchema.default(() => CoinGlassConfigSchema.parse({})),
    coingecko: CoinGeckoConfigSchema.default(() => CoinGeckoConfigSchema.parse({})),
    sosovalue: SoSoValueConfigSchema.default(() => SoSoValueConfigSchema.parse({})),
  })
  .strict();

const UniverseConfigSchema = z
  .object({
    quote_asset: z.string().default('USDT'),
    contract_type: z.string().default('PERPETUAL'),
    top_symbols_by_volume: z.number().int().default(80),
    min_quote_volume_usd: z.number().default(20_000_000),
    exclude_base_assets: z.array(z.string()).default([]),
  })
  .strict();

const DataQualityConfigSchema = z
  .object({
    max_abs_price_change_24h_pct: z.number().default(300),
    max_abs_oi_change_24h_pct: z.number().default(300),
    max_abs_volume_change_24h_pct: z.number().default(1000),
    max_abs_funding_rate_pct: z.number().default(2),
    max_price_deviation_from_index_pct: z.number().default(25),
    min_quote_volume_usd: z.number().default(10_000_000),
    min_coinglass_exchange_count: z.number().int().default(2),
  })
  .strict();

const RegimeWeightingConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    max_factor_multiplier: z.number().default(1.35),
    score_adjustment_strength: z.number().default(0.08),
    conflict_penalty_strength: z.number().default(0.18),
  })
  .strict();

const RegimeConfigSchema = z
  .object({
    dispersion_threshold_pct: z.number().default(8.0),
    hysteresis_margin: z.number().default(0.15),
    breadth_weak_threshold: z.number().default(0.15),
    breadth_strong_threshold: z.number().default(0.25),
    dominance_delta_scale_pct: z.number().default(0.5),
    eth_btc_scale_pct: z.number().default(2.0),
    nudge_btc_led: z.number().default(1.12),
    nudge_alts_strong: z.number().default(1.1),
    nudge_chaos_trend: z.number().default(0.88),
    nudge_chaos_contrarian: z.number().default(1.12),
  })
  .strict();

const FactorsConfigSchema = z
  .object({
    forward_return_hours: z.number().default(24),
    decay_horizons: z.array(z.number()).default([4, 8, 12, 24, 48, 72]),
    reversal_lookback_hours: z.number().default(72),
    ic_window_days: z.number().int().default(30),
    min_observations: z.number().int().default(30),
    min_abs_ic: z.number().default(0.02),
    max_abs_weight: z.number().default(0.35),
    ic_min_periods: z.number().int().default(10),
    min_abs_t: z.number().default(2.0),
    ic_prior_strength: z.number().int().default(10),
    ic_min_cross_section: z.number().int().default(5),
    walk_forward_train_fraction: z.number().default(0.6),
    walk_forward_min_train_periods: z.number().int().default(15),
    walk_forward_min_oos_periods: z.number().int().default(10),
    walk_forward_robust_min_ic: z.number().default(0.02),
    walk_forward_overfit_penalty: z.number().default(0.0),
    walk_forward_gating: z.boolean().default(false),
    regime_conditional_prior_strength: z.number().default(12.0),
    regime_min_periods: z.number().int().default(8),
    regime_weighting: RegimeWeightingConfigSchema.default(() =>
      RegimeWeightingConfigSchema.parse({}),
    ),
    regime: RegimeConfigSchema.default(() => RegimeConfigSchema.parse({})),
    priors: z.record(z.string(), z.number()).default({}),
  })
  .strict();

const ReportConfigSchema = z
  .object({
    limit: z.number().int().default(12),
    core_symbols: z.array(z.string()).default(['BTC', 'ETH', 'SOL']),
  })
  .strict();

export const AppConfigSchema = z
  .object({
    version: z.number().int().default(2),
    storage_path: z.string().default('data/crypto_screener.sqlite3'),
    universe: UniverseConfigSchema.default(() => UniverseConfigSchema.parse({})),
    providers: ProvidersConfigSchema.default(() => ProvidersConfigSchema.parse({})),
    data_quality: DataQualityConfigSchema.default(() => DataQualityConfigSchema.parse({})),
    factors: FactorsConfigSchema.default(() => FactorsConfigSchema.parse({})),
    report: ReportConfigSchema.default(() => ReportConfigSchema.parse({})),
  })
  .strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type UniverseConfig = z.infer<typeof UniverseConfigSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
export type CoinGlassConfig = z.infer<typeof CoinGlassConfigSchema>;
export type CoinGeckoConfig = z.infer<typeof CoinGeckoConfigSchema>;
export type SoSoValueConfig = z.infer<typeof SoSoValueConfigSchema>;
export type DataQualityConfig = z.infer<typeof DataQualityConfigSchema>;
export type FactorsConfig = z.infer<typeof FactorsConfigSchema>;
export type RegimeWeightingConfig = z.infer<typeof RegimeWeightingConfigSchema>;
export type RegimeConfig = z.infer<typeof RegimeConfigSchema>;
export type ReportConfig = z.infer<typeof ReportConfigSchema>;
