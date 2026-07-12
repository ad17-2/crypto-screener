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
