/** An open bag of pipeline-produced metric fields; `symbol`/`price_usd`/`factors`/`scores` are the only fields the db layer reads explicitly. */
export interface MarketRow {
  symbol: string;
  price_usd?: number | null;
  factors?: Record<string, unknown>;
  scores?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SnapshotPayload {
  run_id: string;
  generated_at: string;
  market_context?: Record<string, unknown>;
  provider_status?: Record<string, unknown>;
  regime?: Record<string, unknown>;
  factor_weights?: Record<string, unknown>;
  rows?: MarketRow[];
}

export interface FactorHistoryRecordInput {
  run_id: string;
  generated_at: string;
  symbol: string;
  price_usd?: number | null;
  factors?: Record<string, unknown>;
  scores?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LabeledFactorRecord {
  symbol: string;
  generated_at: string;
  forward_return_pct: number;
  /** null when the row's ATR was unavailable at prediction time -- consumers on ic_target 'vol_adjusted' must DROP the record rather than fall back to forward_return_pct. */
  forward_return_vol_adj: number | null;
  /** The row's own atr_14_pct at the point of prediction (never the forward row's -- that would be lookahead bias). null when unavailable. */
  atr_pct: number | null;
  factors: Record<string, unknown>;
  /** Blended score output (`factor_score` et al.) this row was scored with, so validationMetrics() can test the ensemble, not just individual factors; empty when the row has no persisted scores. */
  scores: Record<string, unknown>;
}

export interface LabeledFactorRecordWithRegime extends LabeledFactorRecord {
  regime: string | null;
}

export interface RegimeStateSummary {
  btc_dominance_pct: number | null;
  eth_btc_performance_pct: number | null;
  regime_state: string | null;
}

export interface PruneResult {
  kept_runs: number;
  deleted_runs: number;
  deleted_rows: number;
}

export interface RecommendationRecordInput {
  run_id: string;
  generated_at: string;
  symbol: string;
  watchlist: string;
  /** DashboardRow['side'] -- the call's directional thesis ('core' rows have none). */
  side?: string | null;
  /** Which score field drove this call (e.g. 'long_score', 'regime_fit_score'). */
  score_field?: string | null;
  /** The value of `score_field` at call time -- "the signal value that drove the call". */
  signal_value?: number | null;
  size_multiplier?: number | null;
  round_trip_cost_pct?: number | null;
}

/** Structural subset of dashboard/payload.ts's Watchlist[]/DashboardRow -- kept here instead of importing @crypto-screener/contracts to keep db/ decoupled from the dashboard layer. */
export interface RecommendationWatchlistInput {
  id: string;
  rows: Array<{
    symbol: string | null;
    side: string;
    score_field: string;
    score: number | null;
    scores: { round_trip_cost_pct?: number | null; size_multiplier?: number | null };
  }>;
}

export interface RecommendationOutcome {
  run_id: string;
  generated_at: string;
  symbol: string;
  watchlist: string;
  side: string | null;
  score_field: string | null;
  signal_value: number | null;
  size_multiplier: number | null;
  round_trip_cost_pct: number | null;
  /** null when no realised forward-return match exists yet (horizon not reached, or no later snapshot). */
  forward_return_pct: number | null;
}

/**
 * Layer 4 accountability read. `n_calls` >= `n_resolved` (has a forward_return_pct) >= `n_scored`
 * (resolved AND has a directional `side` AND a known cost -- 'core' rows are never scored, they
 * have no thesis to grade). hit_rate/mean/cumulative are computed net of round_trip_cost_pct.
 */
export interface Scoreboard {
  status: 'insufficient' | 'ok';
  n_calls: number;
  n_resolved: number;
  n_scored: number;
  hit_rate_pct: number | null;
  mean_net_return_pct: number | null;
  cumulative_net_return_pct: number | null;
}
