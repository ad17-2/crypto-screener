import type Database from 'better-sqlite3';

/** factor_history deliberately has no FOREIGN KEY on run_id — backfill jobs write rows with no matching runs row. Do not add one. */
const DDL = `
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL,
    config_json TEXT NOT NULL,
    context_json TEXT NOT NULL,
    provider_status_json TEXT NOT NULL,
    regime_json TEXT NOT NULL DEFAULT '{}',
    -- Retired: no longer populated explicitly by application code; relies on the DEFAULT above.
    factor_weights_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS market_rows (
    run_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price_usd REAL,
    factors_json TEXT NOT NULL,
    scores_json TEXT NOT NULL,
    row_json TEXT NOT NULL,
    PRIMARY KEY (run_id, symbol),
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_market_rows_symbol_time
    ON market_rows(symbol, generated_at);
CREATE INDEX IF NOT EXISTS idx_market_rows_time
    ON market_rows(generated_at);

CREATE TABLE IF NOT EXISTS factor_history (
    run_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price_usd REAL,
    factors_json TEXT NOT NULL,
    scores_json TEXT NOT NULL DEFAULT '{}',
    metrics_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_factor_history_symbol_time
    ON factor_history(symbol, generated_at);
CREATE INDEX IF NOT EXISTS idx_factor_history_time
    ON factor_history(generated_at);

-- Forward-outcome labels derived from factor_history (db/outcomeLabels.ts). Same no-FK stance as
-- factor_history above: run_id/matched_run_id may point at backfill-* synthetic runs with no
-- matching runs row.
CREATE TABLE IF NOT EXISTS outcome_labels (
    run_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    symbol TEXT NOT NULL,
    horizon_hours INTEGER NOT NULL,
    fwd_return_pct REAL,
    fwd_residual_pct REAL,
    btc_fwd_return_pct REAL,
    beta_used REAL,
    matched_run_id TEXT NOT NULL,
    matched_delta_hours REAL NOT NULL,
    PRIMARY KEY (run_id, symbol, horizon_hours)
);

CREATE INDEX IF NOT EXISTS idx_outcome_labels_symbol_time
    ON outcome_labels(symbol, generated_at);

CREATE TABLE IF NOT EXISTS market_regime_history (
    run_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    btc_dominance_pct REAL,
    eth_btc_performance_pct REAL,
    regime_state TEXT,
    regime_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_market_regime_history_time
    ON market_regime_history(generated_at);

-- priority/factor_score are legacy: still readable on old rows, no longer written (see
-- ensureSchema's ensureColumn calls below for the columns that replaced them).
-- Retired: no longer written by application code; table/index kept as-is for existing databases.
CREATE TABLE IF NOT EXISTS recommendations (
    run_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    symbol TEXT NOT NULL,
    watchlist TEXT NOT NULL,
    priority REAL,
    factor_score REAL,
    round_trip_cost_pct REAL,
    PRIMARY KEY (run_id, symbol, watchlist),
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_recommendations_symbol_time
    ON recommendations(symbol, generated_at);
`;

export function ensureSchema(db: Database.Database): void {
  db.exec(DDL);
  ensureColumn(db, 'runs', 'regime_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'runs', 'factor_weights_json', "TEXT NOT NULL DEFAULT '{}'");
  // Layer 4 scoreboard columns. `priority`/`factor_score` above are no longer written (superseded
  // by `signal_value`, the value of whichever score field actually drove the call) but are kept,
  // not dropped -- old rows still carry them.
  ensureColumn(db, 'recommendations', 'side', 'TEXT');
  ensureColumn(db, 'recommendations', 'score_field', 'TEXT');
  ensureColumn(db, 'recommendations', 'signal_value', 'REAL');
  ensureColumn(db, 'recommendations', 'size_multiplier', 'REAL');
}

interface TableInfoRow {
  name: string;
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
  const hasColumn = columns.some((row) => row.name === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
