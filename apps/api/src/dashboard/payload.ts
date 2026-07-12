import type {
  DashboardPayload,
  DashboardRow,
  DashboardRowSide,
  FactorCorrelation,
  ModelWeights,
  Quality,
  RunSummary,
  Sections,
  Watchlist,
  WatchlistId,
} from '@crypto-screener/contracts';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import { computeScoreboard, loadRecommendationsWithOutcomes } from '../db/recommendations.js';
import { median, pyRound, toFloat } from '../pipeline/scoring.js';
import type { Row } from '../pipeline/types.js';
import { asArray, asRecord } from '../pipeline/types.js';
import { freshnessSummary } from './freshness.js';
import { dashboardRow, type HistoryPoint, numberOrNull, stringOrNull } from './rows.js';
import { factorLabel } from './taxonomy.js';
import {
  isCrowdedLong,
  isCrowdedShort,
  isLongCandidate,
  isShortCandidate,
  topBy,
  WATCHLIST_LABELS,
} from './watchlists.js';

/** `config` is passed alongside `db` so `database` reports the CONFIGURED storage_path, not whatever file `db` is physically backed by (e.g. a test's temp copy). */

const CORE_SYMBOLS = ['BTC', 'ETH', 'SOL'] as const;
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
  const placeholders = runIds.map(() => '?').join(',');

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
  factor_weights_json: string;
}

const SELECTED_RUN_COLUMNS =
  'run_id, generated_at, context_json, provider_status_json, regime_json, factor_weights_json';

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
  const placeholders = uniqueSymbols.map(() => '?').join(',');
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
      factor_score: numberOrNull(scores.factor_score),
      long_score: numberOrNull(scores.long_score),
      short_score: numberOrNull(scores.short_score),
      crowded_long_score: numberOrNull(scores.crowded_long_score),
      squeeze_risk_score: numberOrNull(scores.squeeze_risk_score),
    });
    bySymbol.set(dbRow.symbol, points);
  }

  const hasAnyPoints = [...bySymbol.values()].some((points) => points.length > 0);
  if (!hasAnyPoints) {
    return legacyHistoryBySymbol(db, uniqueSymbols, generatedAt, limit);
  }
  const result: Record<string, HistoryPoint[]> = {};
  for (const [symbol, points] of bySymbol) {
    result[symbol] = [...points].reverse();
  }
  return result;
}

interface MarketRowLegacyDbRow {
  symbol: string;
  generated_at: string;
  row_json: string;
}

/**
 * Fallback when factor_history has no rows yet; unreachable against production (populated by
 * saveSnapshot), so not exercised by the parity fixture. row_json lacks factors_json/metrics_json,
 * so technical_trend_4h/technical_momentum_4h/rsi_14 are always null here.
 */
function legacyHistoryBySymbol(
  db: Database.Database,
  symbols: string[],
  generatedAt: string,
  limit: number,
): Record<string, HistoryPoint[]> {
  const placeholders = symbols.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT symbol, generated_at, row_json
       FROM market_rows
       WHERE symbol IN (${placeholders}) AND generated_at <= ?
       ORDER BY symbol ASC, generated_at DESC`,
    )
    .all(...symbols, generatedAt) as MarketRowLegacyDbRow[];

  const bySymbol = new Map<string, HistoryPoint[]>(symbols.map((symbol) => [symbol, []]));
  for (const dbRow of rows) {
    const points = bySymbol.get(dbRow.symbol) ?? [];
    if (points.length >= limit) {
      continue;
    }
    const item = loadsJson<Record<string, unknown>>(dbRow.row_json, {});
    const scores = asRecord(item.scores);
    points.push({
      generated_at: dbRow.generated_at,
      price_usd: numberOrNull(item.price_usd),
      price_change_24h_pct: numberOrNull(item.price_change_24h_pct),
      oi_change_24h_pct: numberOrNull(item.oi_change_24h_pct),
      funding_rate_pct: numberOrNull(item.funding_rate_pct),
      long_short_ratio: numberOrNull(item.long_short_ratio),
      long_short_account_ratio: numberOrNull(item.long_short_account_ratio),
      top_trader_long_short_ratio: numberOrNull(item.top_trader_long_short_ratio),
      quote_volume_usd: numberOrNull(item.quote_volume_usd),
      technical_trend_4h: null,
      technical_momentum_4h: null,
      rsi_14: null,
      factor_score: numberOrNull(scores.factor_score),
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

function regimeFitScoreField(
  row: Row,
  regime: Record<string, unknown>,
): [string, DashboardRowSide] {
  const bias = regime.bias ? String(regime.bias) : 'mixed';
  const label = regime.regime_state
    ? String(regime.regime_state)
    : regime.label
      ? String(regime.label)
      : 'neutral';
  const factorScore = toFloat(row.factor_score, 0.0) ?? 0.0;
  if (label === 'chaos') {
    const crowdedScore = toFloat(row.crowded_long_score, 0.0) ?? 0.0;
    const squeezeScore = toFloat(row.squeeze_risk_score, 0.0) ?? 0.0;
    if (crowdedScore >= squeezeScore) {
      return ['crowded_long_score', 'fade-long'];
    }
    return ['squeeze_risk_score', 'squeeze-risk'];
  }
  if (bias === 'risk-off') {
    return ['short_score', 'short'];
  }
  if (bias === 'risk-on') {
    return ['long_score', 'long'];
  }
  if (factorScore < 0) {
    return ['short_score', 'short'];
  }
  return ['long_score', 'long'];
}

function regimeFitRows(
  rows: Row[],
  limit: number,
  history: Record<string, HistoryPoint[]>,
  regime: Record<string, unknown>,
): DashboardRow[] {
  const ranked: Array<{ fitScore: number; row: Row; side: DashboardRowSide }> = [];
  for (const row of rows) {
    if (row.is_trusted === false) {
      continue;
    }
    const [scoreField, side] = regimeFitScoreField(row, regime);
    const factorScore = toFloat(row.factor_score, 0.0) ?? 0.0;
    if (side === 'long' && factorScore <= 0) {
      continue;
    }
    if (side === 'short' && factorScore >= 0) {
      continue;
    }
    const baseScore = toFloat(row[scoreField], 0.0) ?? 0.0;
    if (baseScore <= 0) {
      continue;
    }
    // fitScore ranks purely on the side's own observable crowding/momentum score plus a
    // data-quality tiebreaker -- no blend-derived alignment/confidence/conflict weighting.
    const quality = toFloat(row.data_quality_score, 100.0) ?? 100.0;
    const fitScore = baseScore + quality * 0.05;
    ranked.push({ fitScore, row, side });
  }

  const top = [...ranked].sort((a, b) => b.fitScore - a.fitScore).slice(0, limit);
  return top.map(({ fitScore, row, side }) => {
    const item: Row = { ...row, regime_fit_score: pyRound(Math.max(0.0, fitScore), 2) };
    return dashboardRow(item, 'regime_fit_score', side, history[String(row.symbol)] ?? []);
  });
}

/** `CORE_SYMBOLS` is deliberately hardcoded, not read from config.report.core_symbols — they coincide today but are not the same source of truth. */
export function buildSections(
  rows: Row[],
  limit: number,
  history: Record<string, HistoryPoint[]>,
  regime: Record<string, unknown>,
): Sections {
  const coreBySymbol = new Map<string, Row>();
  for (const row of rows) {
    const symbol = typeof row.symbol === 'string' ? row.symbol : null;
    if (symbol !== null && (CORE_SYMBOLS as readonly string[]).includes(symbol)) {
      coreBySymbol.set(symbol, row);
    }
  }

  return {
    core: CORE_SYMBOLS.filter((symbol) => coreBySymbol.has(symbol)).map((symbol) =>
      dashboardRow(coreBySymbol.get(symbol) as Row, 'factor_score', 'core', history[symbol] ?? []),
    ),
    long: topBy(rows, 'long_score', limit, { predicate: isLongCandidate }).map((row) =>
      dashboardRow(row, 'long_score', 'long', history[String(row.symbol)] ?? []),
    ),
    regime_fit: regimeFitRows(rows, limit, history, regime),
    short: topBy(rows, 'short_score', limit, { predicate: isShortCandidate }).map((row) =>
      dashboardRow(row, 'short_score', 'short', history[String(row.symbol)] ?? []),
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
  const keys: Array<keyof Sections> = [
    'regime_fit',
    'long',
    'short',
    'squeeze_risks',
    'crowded_longs',
    'core',
  ];
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
    ['regime_fit', sections.regime_fit],
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

function calibrationLabel(hitRate: number | null, observations: number): string {
  if (observations < 20 || hitRate === null) {
    return 'learning';
  }
  if (hitRate >= 58.0) {
    return 'useful';
  }
  if (hitRate >= 50.0) {
    return 'neutral';
  }
  return 'weak';
}

interface ModelWeightFactor {
  name: string;
  label: string;
  weight: number | null;
  base_weight: number | null;
  mode: string | null;
  ic: number | null;
  t_stat: number | null;
  n_periods: number;
  credibility_k: number | null;
  regime_multiplier: number | null;
  robustness: unknown;
  oos_ic: number | null;
  regime_ic: number | null;
  regime_mode: unknown;
  net_spread_pct: number | null;
  net_edge_per_30d_pct: number | null;
  edge_t_stat: number | null;
  edge_n_effective: number | null;
  edge_overlap_factor: number | null;
  edge_verdict: string | null;
  edge_train_net_spread_pct: number | null;
  edge_validation_net_spread_pct: number | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelWeightsSummary(factorWeights: Record<string, unknown>): ModelWeights {
  const stats = asRecord(factorWeights.stats);
  const factors: ModelWeightFactor[] = [];
  for (const [name, details] of Object.entries(stats)) {
    if (!isPlainObject(details)) {
      continue;
    }
    factors.push({
      name,
      label: factorLabel(name),
      weight: toFloat(details.weight),
      base_weight: toFloat(details.base_weight),
      mode: stringOrNull(details.mode),
      ic: toFloat(details.ic),
      t_stat: toFloat(details.t_stat),
      n_periods: Math.trunc(toFloat(details.n_periods, 0) ?? 0),
      credibility_k: toFloat(details.credibility_k),
      regime_multiplier: toFloat(details.regime_multiplier),
      // `?? null`, not undefined: JSON.stringify drops undefined keys, and consumers expect these present even when unset.
      robustness: details.robustness ?? null,
      oos_ic: toFloat(details.oos_ic),
      regime_ic: toFloat(details.regime_ic),
      regime_mode: details.regime_mode ?? null,
      net_spread_pct: toFloat(details.net_spread_pct),
      net_edge_per_30d_pct: toFloat(details.net_edge_per_30d_pct),
      edge_t_stat: toFloat(details.edge_t_stat),
      edge_n_effective: toFloat(details.edge_n_effective),
      edge_overlap_factor: toFloat(details.edge_overlap_factor),
      edge_verdict: stringOrNull(details.edge_verdict),
      edge_train_net_spread_pct: toFloat(details.edge_train_net_spread_pct),
      edge_validation_net_spread_pct: toFloat(details.edge_validation_net_spread_pct),
    });
  }
  factors.sort((a, b) => Math.abs(b.weight ?? 0) - Math.abs(a.weight ?? 0));
  return {
    mode: stringOrNull(factorWeights.mode),
    regime: asRecord(factorWeights.regime_adjustment),
    factors,
    factor_correlations: asArray(factorWeights.factor_correlations) as FactorCorrelation[],
    factor_decay: asRecord(factorWeights.factor_decay),
    walk_forward: asRecord(factorWeights.walk_forward),
    validated_factor_count: Math.trunc(toFloat(factorWeights.validated_factor_count, 0) ?? 0),
  };
}

interface ValidationFactorRank {
  name: string;
  label: string;
  hit_rate: number;
  observations: number;
  avg_forward_return_pct: number | null;
}

function rankValidationFactors(
  factors: Record<string, unknown>,
  reverse: boolean,
): ValidationFactorRank[] {
  const ranked: ValidationFactorRank[] = [];
  for (const [name, details] of Object.entries(factors)) {
    if (!isPlainObject(details)) {
      continue;
    }
    const hitRate = toFloat(details.hit_rate);
    const observations = Math.trunc(toFloat(details.observations, 0.0) ?? 0);
    if (hitRate === null || observations <= 0) {
      continue;
    }
    ranked.push({
      name,
      label: factorLabel(name),
      hit_rate: pyRound(hitRate, 2),
      observations,
      avg_forward_return_pct: toFloat(details.avg_forward_return_pct),
    });
  }
  // Tuple sort on (hit_rate, observations), sign-flipped for reverse; ties keep insertion order (stable sort).
  const sign = reverse ? -1 : 1;
  return ranked
    .sort((a, b) => sign * (a.hit_rate - b.hit_rate || a.observations - b.observations))
    .slice(0, 3);
}

/** Trusted rows only: an excluded row's round_trip_cost_pct is a 0.0 placeholder (see rowScoring.ts applyExcludedScores), not a real cost estimate. */
function medianRoundTripCostPct(rows: Row[]): number | null {
  const values = rows
    .filter((row) => row.is_trusted !== false)
    .map((row) => toFloat(asRecord(row.scores).round_trip_cost_pct))
    .filter((value): value is number => value !== null);
  return values.length > 0 ? median(values) : null;
}

/** Returns an opaque record: factor_weights.validation has no fixed schema in the contract type. */
function validationSummary(
  validation: Record<string, unknown>,
  rows: Row[],
  sections: Sections,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { ...validation };
  const model = asRecord(summary.model);
  const factors = asRecord(summary.factors);
  const hitRate = toFloat(model.hit_rate);
  const observations = Math.trunc(toFloat(summary.observations, 0.0) ?? 0);
  summary.model = model;
  summary.factors = factors;
  summary.model_hit_rate = hitRate;
  summary.model_avg_forward_return_pct = toFloat(model.avg_forward_return_pct);
  summary.calibration_label = calibrationLabel(hitRate, observations);
  summary.best_factors = rankValidationFactors(factors, true);
  summary.weakest_factors = rankValidationFactors(factors, false);

  const avgDirectional = toFloat(model.avg_directional_return_pct);
  const medianCost = medianRoundTripCostPct(rows);
  summary.median_round_trip_cost_pct = medianCost !== null ? pyRound(medianCost, 4) : null;
  summary.net_directional_return_pct =
    avgDirectional !== null && medianCost !== null ? pyRound(avgDirectional - medianCost, 3) : null;

  summary.watchlist_counts = {
    core: sections.core.length,
    long: sections.long.length,
    regime_fit: sections.regime_fit.length,
    short: sections.short.length,
    crowded_longs: sections.crowded_longs.length,
    squeeze_risks: sections.squeeze_risks.length,
  };
  return summary;
}

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
  const factorWeights = loadsJson<Record<string, unknown>>(selected.factor_weights_json, {});
  const sections = buildSections(rows, options.limit, history, regime);
  const freshness = freshnessSummary(selected.generated_at);
  // Not filtered to `selected.run_id`: the scoreboard is a track record across every run ever
  // logged, not just the currently-selected one.
  const scoreboard = computeScoreboard(
    loadRecommendationsWithOutcomes(db, {
      forwardReturnHours: config.factors.forward_return_hours,
      icWindowDays: config.factors.ic_window_days,
    }),
  );

  return {
    status: 'ok',
    database: databasePath,
    run: { run_id: selected.run_id, generated_at: selected.generated_at, row_count: rows.length },
    runs,
    regime,
    market_context: context,
    provider_status: providerStatus,
    factor_weights: factorWeights,
    model_weights: modelWeightsSummary(factorWeights),
    factor_correlations: asArray(factorWeights.factor_correlations) as FactorCorrelation[],
    factor_decay: asRecord(factorWeights.factor_decay),
    walk_forward: asRecord(factorWeights.walk_forward),
    validation: validationSummary(asRecord(factorWeights.validation), rows, sections),
    freshness,
    quality: qualitySummary(rows),
    sections,
    watchlists: buildWatchlists(sections, options.limit),
    scoreboard,
  };
}
