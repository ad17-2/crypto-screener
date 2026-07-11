import type Database from 'better-sqlite3';
import { stableStringify } from './json.js';
import { loadRegimeStates } from './regimeHistory.js';
import {
  formatJakartaIso,
  horizonTolerance,
  parseGeneratedAt,
  selectHorizonMatch,
} from './time.js';
import type {
  FactorHistoryRecordInput,
  LabeledFactorRecord,
  LabeledFactorRecordWithRegime,
} from './types.js';

/** Allowlist copied into factor_history.metrics_json — every downstream IC/decay/walk-forward computation reads this column. */
const HISTORY_METRIC_KEYS = [
  'price_change_24h_pct',
  'oi_change_24h_pct',
  'funding_rate_pct',
  'long_short_ratio',
  'long_short_account_ratio',
  'top_trader_long_short_ratio',
  'quote_volume_usd',
  'open_interest_usd',
  'confidence_score',
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
  'funding_abs_avg_24h_pct',
  'funding_persistence_24h',
  'long_liquidation_usd_24h_history',
  'short_liquidation_usd_24h_history',
  'liquidation_total_24h_usd',
  'liquidation_imbalance_24h_pct',
  'taker_buy_volume_usd_24h',
  'taker_sell_volume_usd_24h',
  'taker_buy_sell_ratio_24h',
  'taker_imbalance_24h_pct',
  'derivatives_confirmation_score',
  'signal_conflict_label',
  'signal_conflict_score',
  'regime_alignment_score',
  'breadth_alignment_score',
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

interface FactorHistoryDbRow {
  generated_at: string;
  symbol: string;
  price_usd: number | null;
  factors_json: string;
  scores_json: string;
}

function loadFactorHistoryRows(db: Database.Database, cutoff: string): FactorHistoryDbRow[] {
  return db
    .prepare(`
      SELECT generated_at, symbol, price_usd, factors_json, scores_json
      FROM factor_history
      WHERE generated_at >= ?
      ORDER BY generated_at ASC
    `)
    .all(cutoff) as FactorHistoryDbRow[];
}

interface LabelingItem {
  /** Raw DB text, reused verbatim in output records instead of re-formatting a parsed Date. */
  generatedAt: string;
  generatedAtInstant: Date;
  symbol: string;
  price_usd: number;
  factors: Record<string, unknown>;
  scores: Record<string, unknown>;
}

/** `scores_json` is NOT NULL in schema.ts, but the market_rows fallback and older rows can still be
 *  empty text -- degrade to {} rather than throwing mid-load. */
function parseJsonObject(text: string | null): Record<string, unknown> {
  if (!text) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Rows grouped by symbol, keeping only positive prices; falls back to market_rows if factor_history has none yet. */
function labelingRowsBySymbol(
  db: Database.Database,
  icWindowDays: number,
): Map<string, LabelingItem[]> {
  const cutoff = formatJakartaIso(new Date(Date.now() - (icWindowDays + 3) * 24 * 3_600_000));
  let rows = loadFactorHistoryRows(db, cutoff);
  if (rows.length === 0) {
    rows = db
      .prepare(`
        SELECT generated_at, symbol, price_usd, factors_json, scores_json
        FROM market_rows
        WHERE generated_at >= ?
        ORDER BY generated_at ASC
      `)
      .all(cutoff) as FactorHistoryDbRow[];
  }

  const bySymbol = new Map<string, LabelingItem[]>();
  for (const row of rows) {
    const price = row.price_usd;
    if (price === null || price <= 0) {
      continue;
    }
    const item: LabelingItem = {
      generatedAt: row.generated_at,
      generatedAtInstant: parseGeneratedAt(row.generated_at),
      symbol: row.symbol,
      price_usd: price,
      factors: JSON.parse(row.factors_json) as Record<string, unknown>,
      scores: parseJsonObject(row.scores_json),
    };
    const existing = bySymbol.get(item.symbol);
    if (existing) {
      existing.push(item);
    } else {
      bySymbol.set(item.symbol, [item]);
    }
  }
  return bySymbol;
}

/**
 * Matches on the MIDPOINT of the tolerance band — unlike `loadPriceLookback` below, which matches
 * on the raw horizon. Scan breaks at the first candidate past the window (ascending order).
 */
function findForwardRow(
  candidates: LabelingItem[],
  generatedAt: Date,
  minTargetHours: number,
  maxTargetHours: number,
): LabelingItem | null {
  const items: Array<{ value: LabelingItem; deltaHours: number }> = [];
  for (const candidate of candidates) {
    const deltaHours = (candidate.generatedAtInstant.getTime() - generatedAt.getTime()) / 3_600_000;
    if (deltaHours < minTargetHours) {
      continue;
    }
    if (deltaHours > maxTargetHours) {
      break;
    }
    items.push({ value: candidate, deltaHours });
  }
  const forwardTargetHours = (minTargetHours + maxTargetHours) / 2.0;
  return selectHorizonMatch(items, minTargetHours, maxTargetHours, forwardTargetHours);
}

function labeledRecordsForHorizon(
  bySymbol: Map<string, LabelingItem[]>,
  horizonHours: number,
): LabeledFactorRecord[] {
  const [minTargetHours, maxTargetHours] = horizonTolerance(horizonHours);
  const records: LabeledFactorRecord[] = [];
  for (const symbolRows of bySymbol.values()) {
    for (const [index, current] of symbolRows.entries()) {
      const target = findForwardRow(
        symbolRows.slice(index + 1),
        current.generatedAtInstant,
        minTargetHours,
        maxTargetHours,
      );
      if (!target) {
        continue;
      }
      const forwardReturnPct = ((target.price_usd - current.price_usd) / current.price_usd) * 100.0;
      records.push({
        symbol: current.symbol,
        generated_at: current.generatedAt,
        forward_return_pct: forwardReturnPct,
        factors: current.factors,
        scores: current.scores,
      });
    }
  }
  return records;
}

export function loadLabeledFactorRecords(
  db: Database.Database,
  options: { forwardReturnHours?: number; icWindowDays?: number } = {},
): LabeledFactorRecordWithRegime[] {
  const horizonHours = options.forwardReturnHours ?? 24;
  const bySymbol = labelingRowsBySymbol(db, options.icWindowDays ?? 30);
  const records = labeledRecordsForHorizon(bySymbol, horizonHours);
  const regimeMap = loadRegimeStates(db);
  return records.map((record) => ({
    ...record,
    regime: regimeMap[record.generated_at] ?? null,
  }));
}

export function loadLabeledRecordsByHorizon(
  db: Database.Database,
  horizons: number[],
  options: { icWindowDays?: number } = {},
): Map<number, LabeledFactorRecord[]> {
  const bySymbol = labelingRowsBySymbol(db, options.icWindowDays ?? 30);
  const result = new Map<number, LabeledFactorRecord[]>();
  for (const horizon of horizons) {
    result.set(horizon, labeledRecordsForHorizon(bySymbol, horizon));
  }
  return result;
}

interface PriceLookbackDbRow {
  generated_at: string;
  symbol: string;
  price_usd: number;
}

/** Unlike `findForwardRow` above, the match target is `hours` itself, not the tolerance band's midpoint. */
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
