import type Database from 'better-sqlite3';
import { horizonTolerance, parseGeneratedAt, selectHorizonMatch } from './time.js';

// factor_history has no FK on run_id (see schema.ts); BTC's own leg is looked up by run_id, not by
// a foreign key -- matches the same synthetic backfill-* run_ids the base rows may carry.
const BTC_SYMBOL = 'BTC';
const DEFAULT_HORIZONS = [24, 72];

interface FactorHistoryLabelDbRow {
  run_id: string;
  generated_at: string;
  symbol: string;
  price_usd: number | null;
  metrics_json: string;
}

interface SeriesPoint {
  run_id: string;
  generated_at: string;
  instant: Date;
  price_usd: number | null;
  metrics: Record<string, unknown>;
}

/** Local, not imported from dashboard/payload.ts's loadsJson -- the db layer does not depend on dashboard/. */
function parseMetrics(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * `symbols`, when given, pushes the filter into SQL so a --symbols run doesn't full-scan
 * factor_history (never-pruned) and JSON-parse every row just to throw most of them away. BTC is
 * always added to the fetch set -- the residual leg needs BTC's own series even when BTC itself
 * wasn't requested -- but callers still gate BTC *output* by whether BTC was actually requested
 * (see buildOutcomeLabels's symbolFilter check).
 */
function loadSeriesBySymbol(
  db: Database.Database,
  symbols?: string[] | undefined,
): Map<string, SeriesPoint[]> {
  let query = `SELECT run_id, generated_at, symbol, price_usd, metrics_json
       FROM factor_history`;
  const params: string[] = [];
  if (symbols && symbols.length > 0) {
    const fetchSymbols = new Set(symbols);
    fetchSymbols.add(BTC_SYMBOL);
    query += ` WHERE symbol IN (${Array.from(fetchSymbols, () => '?').join(', ')})`;
    params.push(...fetchSymbols);
  }
  query += ` ORDER BY symbol ASC, generated_at ASC`;

  const rows = db.prepare(query).all(...params) as FactorHistoryLabelDbRow[];

  const bySymbol = new Map<string, SeriesPoint[]>();
  for (const row of rows) {
    const point: SeriesPoint = {
      run_id: row.run_id,
      generated_at: row.generated_at,
      instant: parseGeneratedAt(row.generated_at),
      price_usd: row.price_usd,
      metrics: parseMetrics(row.metrics_json),
    };
    const existing = bySymbol.get(row.symbol);
    if (existing) {
      existing.push(point);
    } else {
      bySymbol.set(row.symbol, [point]);
    }
  }
  return bySymbol;
}

/** `(future/base - 1) x 100`. Callers only invoke this once `basePrice > 0` is already known. */
function forwardReturnPct(basePrice: number, futurePrice: number): number {
  return ((futurePrice - basePrice) / basePrice) * 100;
}

/** Same tolerance semantics as loadPriceLookback (factorHistory.ts), but forward: candidates strictly after `baseInstant`. */
function findForwardMatch(
  series: SeriesPoint[],
  baseInstant: Date,
  hours: number,
): SeriesPoint | null {
  const [minHours, maxHours] = horizonTolerance(hours);
  const candidates = series
    .filter((point) => point.price_usd !== null && point.price_usd > 0)
    .map((point) => ({
      value: point,
      deltaHours: (point.instant.getTime() - baseInstant.getTime()) / 3_600_000,
    }));
  return selectHorizonMatch(candidates, minHours, maxHours, hours);
}

export interface OutcomeLabelRecord {
  run_id: string;
  generated_at: string;
  symbol: string;
  horizon_hours: number;
  fwd_return_pct: number;
  fwd_residual_pct: number | null;
  btc_fwd_return_pct: number | null;
  beta_used: number | null;
  matched_run_id: string;
  matched_delta_hours: number;
}

export function prepareOutcomeLabelInsert(db: Database.Database): Database.Statement {
  return db.prepare(`
    INSERT OR REPLACE INTO outcome_labels
        (run_id, generated_at, symbol, horizon_hours, fwd_return_pct, fwd_residual_pct,
         btc_fwd_return_pct, beta_used, matched_run_id, matched_delta_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

/** Idempotent: INSERT OR REPLACE on the (run_id, symbol, horizon_hours) primary key. */
export function saveOutcomeLabelRecords(
  db: Database.Database,
  records: OutcomeLabelRecord[],
): number {
  if (records.length === 0) {
    return 0;
  }
  const insert = prepareOutcomeLabelInsert(db);
  const insertAll = db.transaction((rows: OutcomeLabelRecord[]) => {
    for (const row of rows) {
      insert.run(
        row.run_id,
        row.generated_at,
        row.symbol,
        row.horizon_hours,
        row.fwd_return_pct,
        row.fwd_residual_pct,
        row.btc_fwd_return_pct,
        row.beta_used,
        row.matched_run_id,
        row.matched_delta_hours,
      );
    }
  });
  insertAll(records);
  return records.length;
}

export interface LabelOutcomesOptions {
  horizons?: number[] | undefined;
  symbols?: string[] | undefined;
}

export interface OutcomeLabelSummary {
  horizons: number[];
  base_rows_considered: number;
  base_rows_skipped_untrusted: number;
  base_rows_trusted_missing_flag: number;
  labeled: Record<number, number>;
  skipped_no_forward_match: Record<number, number>;
  null_residual: Record<number, number>;
  null_residual_missing_beta: Record<number, number>;
  null_residual_missing_btc_match: Record<number, number>;
}

export interface BuildOutcomeLabelsResult {
  records: OutcomeLabelRecord[];
  summary: OutcomeLabelSummary;
}

/**
 * Builds forward-outcome labels for every factor_history base row (any run_id, including
 * backfill-*) whose metrics_json.is_trusted !== false, at each requested horizon. Read-only --
 * does not write to the database; callers decide whether/how to persist `records` (see
 * cli/outcomes.ts's --dry-run and saveOutcomeLabelRecords).
 */
export function buildOutcomeLabels(
  db: Database.Database,
  options: LabelOutcomesOptions = {},
): BuildOutcomeLabelsResult {
  const horizons = options.horizons ?? DEFAULT_HORIZONS;
  const symbolFilter = options.symbols ? new Set(options.symbols) : null;
  const bySymbol = loadSeriesBySymbol(db, options.symbols);
  const btcSeries = bySymbol.get(BTC_SYMBOL) ?? [];
  const btcByRunId = new Map(btcSeries.map((point) => [point.run_id, point]));

  const summary: OutcomeLabelSummary = {
    horizons,
    base_rows_considered: 0,
    base_rows_skipped_untrusted: 0,
    base_rows_trusted_missing_flag: 0,
    labeled: Object.fromEntries(horizons.map((h) => [h, 0])),
    skipped_no_forward_match: Object.fromEntries(horizons.map((h) => [h, 0])),
    null_residual: Object.fromEntries(horizons.map((h) => [h, 0])),
    null_residual_missing_beta: Object.fromEntries(horizons.map((h) => [h, 0])),
    null_residual_missing_btc_match: Object.fromEntries(horizons.map((h) => [h, 0])),
  };

  const records: OutcomeLabelRecord[] = [];

  for (const [symbol, series] of bySymbol) {
    if (symbolFilter && !symbolFilter.has(symbol)) {
      continue;
    }
    for (const base of series) {
      const isTrusted = base.metrics.is_trusted;
      if (isTrusted === false) {
        summary.base_rows_skipped_untrusted += 1;
        continue;
      }
      if (isTrusted === undefined) {
        summary.base_rows_trusted_missing_flag += 1;
      }
      summary.base_rows_considered += 1;

      const hasValidBasePrice = base.price_usd !== null && base.price_usd > 0;

      for (const hours of horizons) {
        if (!hasValidBasePrice) {
          summary.skipped_no_forward_match[hours] =
            (summary.skipped_no_forward_match[hours] ?? 0) + 1;
          continue;
        }
        const matched = findForwardMatch(series, base.instant, hours);
        if (matched === null || matched.price_usd === null) {
          summary.skipped_no_forward_match[hours] =
            (summary.skipped_no_forward_match[hours] ?? 0) + 1;
          continue;
        }

        const basePrice = base.price_usd as number;
        const fwdReturnPct = forwardReturnPct(basePrice, matched.price_usd);
        const matchedDeltaHours = (matched.instant.getTime() - base.instant.getTime()) / 3_600_000;

        const betaUsed = numberOrNull(base.metrics.btc_beta);
        let btcFwdReturnPct: number | null = null;
        const btcBase = btcByRunId.get(base.run_id);
        if (btcBase && btcBase.price_usd !== null && btcBase.price_usd > 0) {
          // Prefer BTC's row at the symbol's own matched run -- both legs then span exactly
          // [base run -> matched run] instead of an independent closest-to-target search that can
          // land BTC on a different run than the symbol. Fall back to that independent search when
          // BTC has no row (or no valid price) at the matched run.
          const btcAtMatchedRun = btcByRunId.get(matched.run_id);
          const btcMatched =
            btcAtMatchedRun && btcAtMatchedRun.price_usd !== null && btcAtMatchedRun.price_usd > 0
              ? btcAtMatchedRun
              : findForwardMatch(btcSeries, btcBase.instant, hours);
          if (btcMatched !== null && btcMatched.price_usd !== null) {
            btcFwdReturnPct = forwardReturnPct(btcBase.price_usd, btcMatched.price_usd);
          }
        }

        let fwdResidualPct: number | null = null;
        if (betaUsed === null) {
          summary.null_residual_missing_beta[hours] =
            (summary.null_residual_missing_beta[hours] ?? 0) + 1;
          summary.null_residual[hours] = (summary.null_residual[hours] ?? 0) + 1;
        } else if (btcFwdReturnPct === null) {
          summary.null_residual_missing_btc_match[hours] =
            (summary.null_residual_missing_btc_match[hours] ?? 0) + 1;
          summary.null_residual[hours] = (summary.null_residual[hours] ?? 0) + 1;
        } else {
          fwdResidualPct = fwdReturnPct - betaUsed * btcFwdReturnPct;
        }

        records.push({
          run_id: base.run_id,
          generated_at: base.generated_at,
          symbol,
          horizon_hours: hours,
          fwd_return_pct: fwdReturnPct,
          fwd_residual_pct: fwdResidualPct,
          btc_fwd_return_pct: btcFwdReturnPct,
          beta_used: betaUsed,
          matched_run_id: matched.run_id,
          matched_delta_hours: matchedDeltaHours,
        });
        summary.labeled[hours] = (summary.labeled[hours] ?? 0) + 1;
      }
    }
  }

  return { records, summary };
}
