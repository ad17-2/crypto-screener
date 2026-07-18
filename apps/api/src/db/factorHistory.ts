import type Database from 'better-sqlite3';
import { stableStringify } from './json.js';
import {
  formatJakartaIso,
  horizonTolerance,
  parseGeneratedAt,
  selectHorizonMatch,
} from './time.js';
import type { FactorHistoryRecordInput } from './types.js';

/** Allowlist copied into factor_history.metrics_json — backs factor history and the dashboard sparklines. */
const HISTORY_METRIC_KEYS = [
  'price_change_24h_pct',
  'oi_change_24h_pct',
  'funding_rate_pct',
  'long_short_ratio',
  'long_short_account_ratio',
  'top_trader_long_short_ratio',
  'quote_volume_usd',
  'open_interest_usd',
  'technical_setup',
  'technical_interval',
  'derivatives_interval',
  'rsi_14',
  'macd_histogram_pct',
  'atr_14_pct',
  'bb_position',
  'bb_width_pct',
  'distance_ema20_pct',
  'technical_trend_score',
  'technical_momentum_score',
  'oi_change_4h_pct_history',
  'oi_change_24h_pct_history',
  'oi_acceleration_4h_pct',
  'oi_zscore_30',
  'funding_avg_24h_pct',
  'funding_persistence_24h',
  'long_liquidation_usd_24h_history',
  'short_liquidation_usd_24h_history',
  'liquidation_imbalance_24h_pct',
  'taker_buy_sell_ratio_24h',
  'taker_imbalance_24h_pct',
  'derivatives_confirmation_score',
  'btc_beta',
  'btc_correlation',
  'residual_change_24h_pct',
  'price_change_72h_pct',
  'top_trader_position_ratio',
  'top_trader_ratio_delta_24h',
  'trend_state',
  'breakout_pct_20',
  'breakdown_pct_20',
  'donchian_position_20',
  'breakout_volume_ratio_20',
  'ema_cross_direction',
  'ema_cross_bars_since',
  'technical_divergence',
  'technical_divergence_strength',
  'cvd_trend_72h_pct',
  'oi_change_72h_pct_history',
  'fights_btc',
  'cvd_absorption_state',
  'oi_price_trend_state',
  'is_trusted',
  'data_quality_flags',
  // Membership annotation (dashboard/watchlists.ts's annotateWatchlistMembership) -- set only on
  // rows that made the long/short watchlist for this run; absent on every other row.
  'watchlist_side',
  'watchlist_rank',
  'setup_confidence',
] as const;

export function historyMetrics(row: Record<string, unknown>): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  for (const key of HISTORY_METRIC_KEYS) {
    const value = row[key];
    if (value !== null && value !== undefined) {
      metrics[key] = value;
    }
  }
  return metrics;
}

export function prepareFactorHistoryInsert(db: Database.Database): Database.Statement {
  return db.prepare(`
    INSERT OR REPLACE INTO factor_history
        (run_id, generated_at, symbol, price_usd, factors_json, scores_json, metrics_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
}

/** A direct backfill write path: writes only to factor_history, never `runs` or `market_rows`. */
export function saveFactorHistoryRecords(
  db: Database.Database,
  records: FactorHistoryRecordInput[],
): number {
  if (records.length === 0) {
    return 0;
  }
  const insert = prepareFactorHistoryInsert(db);
  const insertAll = db.transaction((rows: FactorHistoryRecordInput[]) => {
    for (const row of rows) {
      insert.run(
        row.run_id,
        row.generated_at,
        row.symbol ?? null,
        row.price_usd ?? null,
        stableStringify(row.factors ?? {}),
        stableStringify(row.scores ?? {}),
        stableStringify(historyMetrics(row)),
      );
    }
  });
  insertAll(records);
  return records.length;
}

interface PriceLookbackDbRow {
  generated_at: string;
  symbol: string;
  price_usd: number;
}

/** The match target is `hours` itself, not a tolerance band's midpoint. */
export function loadPriceLookback(db: Database.Database, hours: number): Record<string, number> {
  const referenceAt = new Date();
  const [minTargetHours, maxTargetHours] = horizonTolerance(hours);
  const cutoff = formatJakartaIso(
    new Date(referenceAt.getTime() - maxTargetHours * 1.25 * 3_600_000),
  );
  const referenceIso = formatJakartaIso(referenceAt);

  const rows = db
    .prepare(`
      SELECT generated_at, symbol, price_usd
      FROM factor_history
      WHERE generated_at >= ?
        AND generated_at <= ?
        AND price_usd IS NOT NULL
        AND price_usd > 0
      ORDER BY generated_at ASC
    `)
    .all(cutoff, referenceIso) as PriceLookbackDbRow[];

  const bySymbol = new Map<string, Array<{ generatedAtInstant: Date; price_usd: number }>>();
  for (const row of rows) {
    const item = {
      generatedAtInstant: parseGeneratedAt(row.generated_at),
      price_usd: row.price_usd,
    };
    const existing = bySymbol.get(row.symbol);
    if (existing) {
      existing.push(item);
    } else {
      bySymbol.set(row.symbol, [item]);
    }
  }

  const result: Record<string, number> = {};
  for (const [symbol, history] of bySymbol) {
    const items = history.map((row) => ({
      value: row,
      deltaHours: (referenceAt.getTime() - row.generatedAtInstant.getTime()) / 3_600_000,
    }));
    const matched = selectHorizonMatch(items, minTargetHours, maxTargetHours, hours);
    if (matched !== null) {
      result[symbol] = matched.price_usd;
    }
  }
  return result;
}
