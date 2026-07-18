import type {
  DashboardPayload,
  DashboardRow,
  Quality,
  RunSummary,
  Sections,
  Watchlist,
  WatchlistId,
} from '@crypto-screener/contracts';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import { sqlPlaceholders } from '../db/client.js';
import type { Row } from '../pipeline/types.js';
import { asArray, asRecord } from '../pipeline/types.js';
import { freshnessSummary } from './freshness.js';
import { dashboardRow, type HistoryPoint, numberOrNull, stringOrNull } from './rows.js';
import { previousRunMembership, watchlistDiff } from './runDiff.js';
import {
  CORE_SYMBOLS,
  isCrowdedLong,
  isCrowdedShort,
  isLongCandidate,
  isShortCandidate,
  topBy,
  WATCHLIST_LABELS,
} from './watchlists.js';

const HISTORY_POINTS_LIMIT = 16;

export interface BuildDashboardPayloadOptions {
  runId?: string;
  limit: number;
}

function loadsJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface RunsDbRow {
  run_id: string;
  generated_at: string;
  provider_status_json: string;
  regime_json: string;
}

function recentRuns(db: Database.Database, limit = 30): RunSummary[] {
  const dbRows = db
    .prepare(
      'SELECT run_id, generated_at, provider_status_json, regime_json FROM runs ORDER BY generated_at DESC LIMIT ?',
    )
    .all(limit) as RunsDbRow[];
  if (dbRows.length === 0) {
    return [];
  }

  const runIds = dbRows.map((row) => row.run_id);
  const placeholders = sqlPlaceholders(runIds.length);

  const countRows = db
    .prepare(
      `SELECT run_id, COUNT(*) AS row_count FROM market_rows WHERE run_id IN (${placeholders}) GROUP BY run_id`,
    )
    .all(...runIds) as Array<{ run_id: string; row_count: number }>;
  const counts = new Map(countRows.map((row) => [row.run_id, row.row_count]));

  const flagged = new Map<string, number>(runIds.map((runId) => [runId, 0]));
  const flagRows = db
    .prepare(`SELECT run_id, row_json FROM market_rows WHERE run_id IN (${placeholders})`)
    .all(...runIds) as Array<{ run_id: string; row_json: string }>;
  for (const row of flagRows) {
    const item = loadsJson<Row>(row.row_json, {});
    if (asArray(item.data_quality_flags).length > 0) {
      flagged.set(row.run_id, (flagged.get(row.run_id) ?? 0) + 1);
    }
  }

  return dbRows.map((row) => {
    const regime = loadsJson<Record<string, unknown>>(row.regime_json, {});
    const providers = loadsJson<Record<string, unknown>>(row.provider_status_json, {});
    const coinglass = asRecord(providers.coinglass);
    return {
      run_id: row.run_id,
      generated_at: row.generated_at,
      row_count: counts.get(row.run_id) ?? 0,
      excluded_count: flagged.get(row.run_id) ?? 0,
      bias: typeof regime.bias === 'string' ? regime.bias : 'unknown',
      factor_regime: typeof regime.label === 'string' ? regime.label : 'unknown',
      coinglass_status: typeof coinglass.status === 'string' ? coinglass.status : '-',
    };
  });
}

interface SelectedRunDbRow {
  run_id: string;
  generated_at: string;
  context_json: string;
  provider_status_json: string;
  regime_json: string;
}

const SELECTED_RUN_COLUMNS =
  'run_id, generated_at, context_json, provider_status_json, regime_json';

function selectedRunRow(
  db: Database.Database,
  runId: string | undefined,
): SelectedRunDbRow | undefined {
  if (runId) {
    return db.prepare(`SELECT ${SELECTED_RUN_COLUMNS} FROM runs WHERE run_id = ?`).get(runId) as
      | SelectedRunDbRow
      | undefined;
  }
  return db
    .prepare(`SELECT ${SELECTED_RUN_COLUMNS} FROM runs ORDER BY generated_at DESC LIMIT 1`)
    .get() as SelectedRunDbRow | undefined;
}

interface FactorHistoryDbRow {
  symbol: string;
  generated_at: string;
  price_usd: number | null;
  factors_json: string;
  scores_json: string;
  metrics_json: string;
}

function historyBySymbol(
  db: Database.Database,
  symbols: string[],
  generatedAt: string,
  limit = HISTORY_POINTS_LIMIT,
): Record<string, HistoryPoint[]> {
  const uniqueSymbols = [...new Set(symbols.filter((symbol) => symbol))].sort();
  if (uniqueSymbols.length === 0) {
    return {};
  }
  const placeholders = sqlPlaceholders(uniqueSymbols.length);
  const rows = db
    .prepare(
      `SELECT symbol, generated_at, price_usd, factors_json, scores_json, metrics_json
       FROM factor_history
       WHERE symbol IN (${placeholders}) AND generated_at <= ?
       ORDER BY symbol ASC, generated_at DESC`,
    )
    .all(...uniqueSymbols, generatedAt) as FactorHistoryDbRow[];

  const bySymbol = new Map<string, HistoryPoint[]>(uniqueSymbols.map((symbol) => [symbol, []]));
  for (const dbRow of rows) {
    const points = bySymbol.get(dbRow.symbol) ?? [];
    if (points.length >= limit) {
      continue;
    }
    const item = loadsJson<Record<string, unknown>>(dbRow.metrics_json, {});
    const factors = loadsJson<Record<string, unknown>>(dbRow.factors_json, {});
    const scores = loadsJson<Record<string, unknown>>(dbRow.scores_json, {});
    points.push({
      generated_at: dbRow.generated_at,
      price_usd: dbRow.price_usd,
      price_change_24h_pct: numberOrNull(item.price_change_24h_pct),
      oi_change_24h_pct: numberOrNull(item.oi_change_24h_pct),
      funding_rate_pct: numberOrNull(item.funding_rate_pct),
      long_short_ratio: numberOrNull(item.long_short_ratio),
      long_short_account_ratio: numberOrNull(item.long_short_account_ratio),
      top_trader_long_short_ratio: numberOrNull(item.top_trader_long_short_ratio),
      quote_volume_usd: numberOrNull(item.quote_volume_usd),
      technical_trend_4h: numberOrNull(factors.technical_trend_4h),
      technical_momentum_4h: numberOrNull(factors.technical_momentum_4h),
      rsi_14: numberOrNull(item.rsi_14),
      long_score: numberOrNull(scores.long_score),
      short_score: numberOrNull(scores.short_score),
      crowded_long_score: numberOrNull(scores.crowded_long_score),
      squeeze_risk_score: numberOrNull(scores.squeeze_risk_score),
    });
    bySymbol.set(dbRow.symbol, points);
  }

  const result: Record<string, HistoryPoint[]> = {};
  for (const [symbol, points] of bySymbol) {
    result[symbol] = [...points].reverse();
  }
  return result;
}

/** `CORE_SYMBOLS` is deliberately hardcoded, not read from config.report.core_symbols — they coincide today but are not the same source of truth. */
export function buildSections(
  rows: Row[],
  limit: number,
  history: Record<string, HistoryPoint[]>,
  newToList: Set<string> = new Set(),
): Sections {
  const coreBySymbol = new Map<string, Row>();
  for (const row of rows) {
    const symbol = typeof row.symbol === 'string' ? row.symbol : null;
    if (symbol !== null && (CORE_SYMBOLS as readonly string[]).includes(symbol)) {
      coreBySymbol.set(symbol, row);
    }
  }

  return {
    // Majors are shown for context, not ranked -- there is no observable "core" score.
    core: CORE_SYMBOLS.filter((symbol) => coreBySymbol.has(symbol)).map((symbol) =>
      dashboardRow(coreBySymbol.get(symbol) as Row, null, 'core', history[symbol] ?? []),
    ),
    long: topBy(rows, 'long_score', limit, { predicate: isLongCandidate }).map((row) =>
      dashboardRow(
        row,
        'long_score',
        'long',
        history[String(row.symbol)] ?? [],
        newToList.has(String(row.symbol)),
      ),
    ),
    short: topBy(rows, 'short_score', limit, { predicate: isShortCandidate }).map((row) =>
      dashboardRow(
        row,
        'short_score',
        'short',
        history[String(row.symbol)] ?? [],
        newToList.has(String(row.symbol)),
      ),
    ),
    crowded_longs: topBy(rows, 'crowded_long_score', limit, { predicate: isCrowdedLong }).map(
      (row) =>
        dashboardRow(row, 'crowded_long_score', 'fade-long', history[String(row.symbol)] ?? []),
    ),
    squeeze_risks: topBy(rows, 'squeeze_risk_score', limit, { predicate: isCrowdedShort }).map(
      (row) =>
        dashboardRow(row, 'squeeze_risk_score', 'squeeze-risk', history[String(row.symbol)] ?? []),
    ),
  };
}

function chartNextRows(sections: Sections, limit: number): DashboardRow[] {
  const candidates = new Map<string, DashboardRow>();
  const keys: Array<keyof Sections> = ['long', 'short', 'squeeze_risks', 'crowded_longs', 'core'];
  for (const key of keys) {
    for (const row of sections[key]) {
      const symbol = row.symbol ?? '';
      const current = candidates.get(symbol);
      if (current === undefined || row.priority > current.priority) {
        candidates.set(symbol, row);
      }
    }
  }
  return [...candidates.values()]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Math.max(limit, 12));
}

export function buildWatchlists(sections: Sections, limit: number): Watchlist[] {
  const ordered: Array<[WatchlistId, DashboardRow[]]> = [
    ['chart_next', chartNextRows(sections, limit)],
    ['long', sections.long],
    ['short', sections.short],
    ['squeeze_risks', sections.squeeze_risks],
    ['crowded_longs', sections.crowded_longs],
    ['core', sections.core],
  ];
  return ordered.map(([id, rows]) => ({ id, label: WATCHLIST_LABELS[id], rows }));
}

function qualitySummary(rows: Row[]): Quality {
  const flagged = rows.filter((row) => asArray(row.data_quality_flags).length > 0);
  const trusted = rows.filter((row) => row.is_trusted ?? true).length;
  return {
    trusted_count: trusted,
    excluded_count: rows.length - trusted,
    flagged_count: flagged.length,
    flagged_rows: flagged.slice(0, 20).map((row) => ({
      symbol: stringOrNull(row.symbol),
      data_source: stringOrNull(row.data_source),
      price_change_24h_pct: numberOrNull(row.price_change_24h_pct),
      oi_change_24h_pct: numberOrNull(row.oi_change_24h_pct),
      flags: asArray(row.data_quality_flags) as string[],
    })),
  };
}

/**
 * `validation` is trimmed to a pure observable: counts of how many rows landed in each watchlist.
 * The model-derived fields this used to carry (calibration_label, hit rates, best/weakest
 * factors, net directional return, ...) were retired along with the factor-weighting engine.
 */
function validationSummary(sections: Sections): Record<string, unknown> {
  return {
    watchlist_counts: {
      core: sections.core.length,
      long: sections.long.length,
      short: sections.short.length,
      crowded_longs: sections.crowded_longs.length,
      squeeze_risks: sections.squeeze_risks.length,
    },
  };
}

/** `row.watchlist_side` is stamped pre-save by dashboard/watchlists.ts's annotateWatchlistMembership -- present only on rows that made the long/short list for this run. */
function currentWatchlistMembership(rows: Row[]): Map<string, 'long' | 'short'> {
  const bySymbol = new Map<string, 'long' | 'short'>();
  for (const row of rows) {
    const symbol = typeof row.symbol === 'string' ? row.symbol : null;
    const side = row.watchlist_side;
    if (symbol !== null && (side === 'long' || side === 'short')) {
      bySymbol.set(symbol, side);
    }
  }
  return bySymbol;
}

/** `config` is passed alongside `db` so `database` reports the CONFIGURED storage_path, not whatever file `db` is physically backed by (e.g. a test's temp copy). */
export function buildDashboardPayload(
  db: Database.Database,
  config: AppConfig,
  options: BuildDashboardPayloadOptions,
): DashboardPayload {
  const databasePath = config.storage_path;
  const runs = recentRuns(db);
  const selected = selectedRunRow(db, options.runId);
  if (selected === undefined) {
    return { status: 'empty', database: databasePath, runs, refresh_status: null };
  }

  const rowJsonRows = db
    .prepare('SELECT row_json FROM market_rows WHERE run_id = ?')
    .all(selected.run_id) as Array<{ row_json: string }>;
  const rows = rowJsonRows.map((row) => loadsJson<Row>(row.row_json, {}));
  const symbols = rows
    .map((row) => (row.symbol ? String(row.symbol) : null))
    .filter((symbol): symbol is string => symbol !== null);
  const history = historyBySymbol(db, symbols, selected.generated_at);

  const context = loadsJson<Record<string, unknown>>(selected.context_json, {});
  const providerStatus = loadsJson<Record<string, unknown>>(selected.provider_status_json, {});
  const regime = loadsJson<Record<string, unknown>>(selected.regime_json, {});

  const previousMembership = previousRunMembership(db, selected.run_id, selected.generated_at);
  const diff = watchlistDiff(previousMembership, currentWatchlistMembership(rows));

  const sections = buildSections(rows, options.limit, history, diff.newToList);
  const freshness = freshnessSummary(selected.generated_at);

  return {
    status: 'ok',
    database: databasePath,
    run: { run_id: selected.run_id, generated_at: selected.generated_at, row_count: rows.length },
    runs,
    regime,
    market_context: context,
    provider_status: providerStatus,
    validation: validationSummary(sections),
    freshness,
    quality: qualitySummary(rows),
    sections,
    watchlists: buildWatchlists(sections, options.limit),
    watchlist_changes: diff.changes,
  };
}
