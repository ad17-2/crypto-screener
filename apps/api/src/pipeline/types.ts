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
export interface RegimeWeightingConfigInput {
  enabled?: boolean;
  max_factor_multiplier?: number;
  score_adjustment_strength?: number;
  conflict_penalty_strength?: number;
}

export interface RegimeConfigInput {
  dispersion_threshold_pct?: number;
  hysteresis_margin?: number;
  breadth_weak_threshold?: number;
  breadth_strong_threshold?: number;
  dominance_delta_scale_pct?: number;
  eth_btc_scale_pct?: number;
  nudge_btc_led?: number;
  nudge_alts_strong?: number;
  nudge_chaos_trend?: number;
  nudge_chaos_contrarian?: number;
}

export interface FactorsConfigInput {
  forward_return_hours?: number;
  decay_horizons?: number[];
  reversal_lookback_hours?: number;
  ic_window_days?: number;
  min_observations?: number;
  min_abs_ic?: number;
  max_abs_weight?: number;
  ic_min_periods?: number;
  min_abs_t?: number;
  ic_prior_strength?: number;
  ic_min_cross_section?: number;
  walk_forward_train_fraction?: number;
  walk_forward_min_train_periods?: number;
  walk_forward_min_oos_periods?: number;
  walk_forward_robust_min_ic?: number;
  walk_forward_overfit_penalty?: number;
  walk_forward_gating?: boolean;
  regime_conditional_prior_strength?: number;
  regime_min_periods?: number;
  regime_weighting?: RegimeWeightingConfigInput;
  regime?: RegimeConfigInput;
  priors?: Record<string, number>;
}

export interface PipelineConfig {
  factors?: FactorsConfigInput;
}
