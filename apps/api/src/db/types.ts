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
  priority?: number | null;
  factor_score?: number | null;
  round_trip_cost_pct?: number | null;
}

/** Structural subset of dashboard/payload.ts's Watchlist[]/DashboardRow -- kept here instead of importing @crypto-screener/contracts to keep db/ decoupled from the dashboard layer. */
export interface RecommendationWatchlistInput {
  id: string;
  rows: Array<{
    symbol: string | null;
    priority: number;
    scores: { factor_score?: number | null; round_trip_cost_pct?: number | null };
  }>;
}

export interface RecommendationOutcome {
  run_id: string;
  generated_at: string;
  symbol: string;
  watchlist: string;
  priority: number | null;
  factor_score: number | null;
  round_trip_cost_pct: number | null;
  /** null when no realised forward-return match exists yet (horizon not reached, or no later snapshot). */
  forward_return_pct: number | null;
}
