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
    /** 0 = no cap. Any cap here shrinks the cross-section the technical factors are ranked over. */
    max_symbols: z.number().int().default(0),
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
    include_top_position: z.boolean().default(true),
    request_delay_seconds: z.number().default(2.1),
  })
  .strict();

const DerivativesHistoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval: z.string().default('4h'),
    limit: z.number().int().default(220),
    /** 0 = no cap. At 25 this estimated four derivative factors' IC on 25 of ~48 names. */
    max_symbols: z.number().int().default(0),
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
    // Also holds the tokenized equities/commodities CoinGlass lists alongside perps: a cross-sectional
    // factor rank mixing XAU or MSFT with DOGE is a category error. Excluded here rather than after
    // the universe cut, so an exclusion costs neither a universe slot nor a provider call.
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

const RegimeConfigSchema = z
  .object({
    dispersion_threshold_pct: z.number().default(8.0),
    hysteresis_margin: z.number().default(0.15),
    breadth_weak_threshold: z.number().default(0.15),
    breadth_strong_threshold: z.number().default(0.25),
    dominance_delta_scale_pct: z.number().default(0.5),
    eth_btc_scale_pct: z.number().default(2.0),
  })
  .strict();

const FactorsConfigSchema = z
  .object({
    forward_return_hours: z.number().default(24),
    reversal_lookback_hours: z.number().default(72),
    ic_min_cross_section: z.number().int().default(5),
    // See pipeline/factors.ts#residualiseOiPriceSignal; off compares against the raw, collinear factor.
    residualise_collinear_factors: z.boolean().default(true),
    regime: RegimeConfigSchema.default(() => RegimeConfigSchema.parse({})),
  })
  .strict();

const ReportConfigSchema = z
  .object({
    limit: z.number().int().default(12),
    core_symbols: z.array(z.string()).default(['BTC', 'ETH', 'SOL']),
  })
  .strict();

// spread_bps is never populated by any provider (see pipeline/costs.ts). funding_settlements_per_day
// must match scoring.ts's hardcoded 8-hourly settlement assumption.
const CostsConfigSchema = z
  .object({
    taker_fee_bps: z.number().default(5),
    slippage_bps: z.number().default(2),
    assumed_spread_bps: z.number().default(2),
    funding_settlements_per_day: z.number().default(3),
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
    costs: CostsConfigSchema.default(() => CostsConfigSchema.parse({})),
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
export type RegimeConfig = z.infer<typeof RegimeConfigSchema>;
export type CostsConfig = z.infer<typeof CostsConfigSchema>;
export type ReportConfig = z.infer<typeof ReportConfigSchema>;
