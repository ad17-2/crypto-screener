// Rows/context/config are open bags of fields (index signatures), not closed interfaces --
// callers and parity fixtures build partial objects. Do not tighten these.

export interface Row {
  symbol?: string | null;
  is_trusted?: boolean;
  [key: string]: unknown;
}

export type MarketContext = Record<string, unknown>;

/**
 * Shape of one labeled `factor_history` record. Relocated from the deleted pipeline/ic.ts (the
 * IC/weighting engine that used to consume these) -- kept only for the golden parity fixture
 * (tests/parity.test.ts, scripts/regen-golden.ts), which still ships a frozen `factor_history`
 * array and passes it through scoreSnapshot's unused historyRecords parameter.
 */
export interface FactorRecord {
  generated_at?: unknown;
  forward_return_pct?: unknown;
  factors?: unknown;
  regime?: unknown;
  [key: string]: unknown;
}

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
  regime?: RegimeConfigInput;
}

export interface CostsConfigInput {
  taker_fee_bps?: number;
  slippage_bps?: number;
  assumed_spread_bps?: number;
  funding_settlements_per_day?: number;
}

export interface PipelineConfig {
  factors?: FactorsConfigInput;
  costs?: CostsConfigInput;
}
