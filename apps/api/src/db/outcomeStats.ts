import type Database from 'better-sqlite3';

/**
 * Aggregated forward-outcome stats grouped by a factor_history metric (technical_setup /
 * trend_state), for callers that want to cite a cohort's live track record instead of quoting raw
 * outcome_labels rows. Joins outcome_labels to factor_history the same way db/weeklyReview.ts does
 * (same run_id + symbol -- factor_history's own primary key).
 *
 * SURVIVORSHIP: outcome_labels has 462k rows, but 98.6% are from a single historical backfill
 * (run_id LIKE 'backfill%') covering exactly 69 symbols that were still alive when the backfill
 * ran -- coins that died between 2024-09 and 2026-07 are absent from it. Serving those rows as
 * evidence would be dishonest, so every query here excludes them with a hardcoded
 * `AND ol.run_id NOT LIKE 'backfill%'`. There is no parameter, flag, or option anywhere in this
 * module that can turn that exclusion off.
 *
 * `fwd_residual_pct`/`beta_used` on outcome_labels are populated on only 193 rows total (effectively
 * dead) -- this module never reads either column. `btc_beta` for the excess-vs-BTC figure instead
 * comes from factor_history.metrics_json, which reaches only a small and recent slice of live rows
 * (4.9% at horizon 24, 0% at horizon 72, measured against data/prod_snapshot_20260719.sqlite3) --
 * so `mean_excess_vs_btc_pct` is usually null by design (suppressed below OUTCOME_STATS_TOO_THIN_N
 * backing rows) and self-heals as btc_beta coverage accrues.
 */

export type OutcomeStatsGroupBy = 'technical_setup' | 'trend_state';

/** Matches pipeline/weeklyReview.ts's own n<30 "too thin to conclude" convention. */
export const OUTCOME_STATS_TOO_THIN_N = 30;

export interface OutcomeStatsQuery {
  group_by: OutcomeStatsGroupBy;
  horizon_hours: number;
  symbol?: string;
}

export interface OutcomeStatsCell {
  key: string;
  n: number;
  symbols: number;
  mean_fwd_return_pct: number | null;
  median_fwd_return_pct: number | null;
  win_rate_pct: number | null;
  mean_excess_vs_btc_pct: number | null;
  excess_n: number;
  too_thin: boolean;
}

export interface OutcomeStatsResult {
  group_by: OutcomeStatsGroupBy;
  horizon_hours: number;
  symbol: string | null;
  /** Excludes the survivorship-biased backfill corpus -- always true, surfaced so the model can say so. */
  live_era_only: true;
  earliest: string | null;
  latest: string | null;
  cells: OutcomeStatsCell[];
}

interface OutcomeStatsDbRow {
  symbol: string;
  generated_at: string;
  key: string | null;
  fwd_return_pct: number | null;
  btc_fwd_return_pct: number | null;
  btc_beta: number | null;
}

/**
 * Whitelists `groupBy` against the JSON path it reads from factor_history.metrics_json --
 * `query.group_by` (or any other caller-controlled string) must never be interpolated into SQL
 * directly. The `never` branch below is both the exhaustiveness check against OutcomeStatsGroupBy
 * at compile time and the runtime guard against a caller that bypasses the type (e.g. an HTTP
 * handler forwarding an unchecked query string).
 */
function jsonPathFor(groupBy: OutcomeStatsGroupBy): string {
  switch (groupBy) {
    case 'technical_setup':
      return '$.technical_setup';
    case 'trend_state':
      return '$.trend_state';
    default: {
      const exhaustive: never = groupBy;
      throw new Error(`Unsupported group_by: ${String(exhaustive)}`);
    }
  }
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

interface CellAccumulator {
  fwdReturns: number[];
  excess: number[];
  symbols: Set<string>;
}

/**
 * One SELECT pulling the live-era rows for the requested horizon (+ optional symbol filter), then
 * aggregates in JS -- the live corpus is only a few thousand rows at each horizon, so JS
 * aggregation is simpler and far more testable than computing a median in SQL.
 */
export function queryOutcomeStats(
  db: Database.Database,
  query: OutcomeStatsQuery,
): OutcomeStatsResult {
  const jsonPath = jsonPathFor(query.group_by);
  const params: Array<string | number> = [query.horizon_hours];
  let sql = `
    SELECT ol.symbol AS symbol,
           ol.generated_at AS generated_at,
           json_extract(fh.metrics_json, '${jsonPath}') AS key,
           ol.fwd_return_pct AS fwd_return_pct,
           ol.btc_fwd_return_pct AS btc_fwd_return_pct,
           json_extract(fh.metrics_json, '$.btc_beta') AS btc_beta
    FROM outcome_labels ol
    JOIN factor_history fh ON fh.run_id = ol.run_id AND fh.symbol = ol.symbol
    WHERE ol.horizon_hours = ?
      -- Survivorship exclusion (see module doc comment above) -- hardcoded, not optional.
      AND ol.run_id NOT LIKE 'backfill%'
  `;
  if (query.symbol !== undefined) {
    sql += ' AND ol.symbol = ?';
    params.push(query.symbol);
  }

  const rows = db.prepare(sql).all(...params) as OutcomeStatsDbRow[];

  const cellsByKey = new Map<string, CellAccumulator>();
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const row of rows) {
    if (row.key === null || row.key === '') {
      continue;
    }
    if (!isFiniteNumber(row.fwd_return_pct)) {
      continue;
    }
    if (earliest === null || row.generated_at < earliest) {
      earliest = row.generated_at;
    }
    if (latest === null || row.generated_at > latest) {
      latest = row.generated_at;
    }

    let acc = cellsByKey.get(row.key);
    if (!acc) {
      acc = { fwdReturns: [], excess: [], symbols: new Set() };
      cellsByKey.set(row.key, acc);
    }
    acc.symbols.add(row.symbol);
    acc.fwdReturns.push(row.fwd_return_pct);
    if (isFiniteNumber(row.btc_beta) && isFiniteNumber(row.btc_fwd_return_pct)) {
      acc.excess.push(row.fwd_return_pct - row.btc_beta * row.btc_fwd_return_pct);
    }
  }

  const cells: OutcomeStatsCell[] = Array.from(cellsByKey.entries()).map(([key, acc]) => {
    const n = acc.fwdReturns.length;
    const wins = acc.fwdReturns.filter((value) => value > 0).length;
    return {
      key,
      n,
      symbols: acc.symbols.size,
      mean_fwd_return_pct: mean(acc.fwdReturns),
      median_fwd_return_pct: median(acc.fwdReturns),
      win_rate_pct: (wins / n) * 100,
      mean_excess_vs_btc_pct:
        acc.excess.length < OUTCOME_STATS_TOO_THIN_N ? null : mean(acc.excess),
      excess_n: acc.excess.length,
      too_thin: n < OUTCOME_STATS_TOO_THIN_N,
    };
  });
  cells.sort((a, b) => b.n - a.n);

  return {
    group_by: query.group_by,
    horizon_hours: query.horizon_hours,
    symbol: query.symbol ?? null,
    live_era_only: true,
    earliest,
    latest,
    cells,
  };
}
