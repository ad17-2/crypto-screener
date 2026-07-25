// Rows/context/config are open bags of fields (index signatures), not closed interfaces --
// callers and parity fixtures build partial objects. Do not tighten these.

export interface Row {
  symbol?: string | null;
  is_trusted?: boolean;
  [key: string]: unknown;
}

export type MarketContext = Record<string, unknown>;

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Structurally compatible with AppConfig['factors'] (config/schema.ts) -- a zod-validated config can be passed here as-is.
export interface RegimeConfigInput {
  dispersion_threshold_pct?: number;
  hysteresis_margin?: number;
  breadth_weak_threshold?: number;
  breadth_strong_threshold?: number;
  dominance_delta_scale_pct?: number;
  eth_btc_scale_pct?: number;
}

export interface FactorsConfigInput {
  forward_return_hours?: number;
  reversal_lookback_hours?: number;
  ic_min_cross_section?: number;
  residualise_collinear_factors?: boolean;
  prefer_screener_sector_momentum?: boolean;
  regime?: RegimeConfigInput;
}

export interface CostsConfigInput {
  taker_fee_bps?: number;
  slippage_bps?: number;
  assumed_spread_bps?: number;
  funding_settlements_per_day?: number;
}

export interface CoinGeckoConfigInput {
  sector_min_members?: number;
}

export interface ProvidersConfigInput {
  coingecko?: CoinGeckoConfigInput;
}

export interface PipelineConfig {
  factors?: FactorsConfigInput;
  costs?: CostsConfigInput;
  providers?: ProvidersConfigInput;
}
