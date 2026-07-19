#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs as nodeParseArgs } from 'node:util';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { sqlPlaceholders } from '../db/client.js';
import { openDatabase } from '../db/index.js';
import type { CohortStats, SignalFwdPair, SignalRunPoint } from '../pipeline/research.js';
import {
  cohortStats,
  computeSignalStats,
  dailySubsample,
  quintileSpread,
  spearmanRankIC,
} from '../pipeline/research.js';
import { median } from '../pipeline/scoring.js';
import { runIfMain } from './support.js';

/**
 * Offline signal-research harness: joins outcome_labels to factor_history, evaluates every
 * tracked signal's forward-return rank-IC/quintile-spread run by run, aggregates across runs
 * (pipeline/research.ts owns that pure math), and reports a few fixed cohort cuts (momentum,
 * crowding, RSI extremes). Read-only against the DB -- it never writes factor_history/outcome_labels.
 */

const DEFAULT_HORIZONS = [24, 72];

// Allowlist copied from the brief -- these are evaluated even when never observed in the data
// (e.g. confidence_score/signal_conflict_score/breadth_alignment_score/regime_alignment_score were
// retired from the quant model, see reports/reportFields.ts's comment, and no longer appear on any
// row), so a retired field shows up with 0% coverage instead of silently vanishing from the report.
const METRIC_SIGNAL_KEYS = [
  'price_change_24h_pct',
  'residual_change_24h_pct',
  'price_change_72h_pct',
  'rsi_14',
  'macd_histogram_pct',
  'bb_position',
  'bb_width_pct',
  'distance_ema20_pct',
  'technical_trend_score',
  'technical_momentum_score',
  'atr_14_pct',
  'funding_rate_pct',
  'funding_avg_24h_pct',
  'funding_persistence_24h',
  'long_short_ratio',
  'long_short_account_ratio',
  'top_trader_long_short_ratio',
  'top_trader_position_ratio',
  'top_trader_ratio_delta_24h',
  'oi_change_24h_pct',
  'oi_acceleration_4h_pct',
  'oi_zscore_30',
  'oi_change_72h_pct_history',
  'liquidation_imbalance_24h_pct',
  'taker_imbalance_24h_pct',
  'taker_buy_sell_ratio_24h',
  'cvd_trend_72h_pct',
  'derivatives_confirmation_score',
  'confidence_score',
  'signal_conflict_score',
  'breadth_alignment_score',
  'regime_alignment_score',
  'breakout_pct_20',
  'breakdown_pct_20',
  'donchian_position_20',
  'quote_volume_usd',
] as const;

export interface ResearchCliArgs {
  config: string;
  db?: string | undefined;
  horizons: number[];
  minCrossSection: number;
  start?: string | undefined;
  end?: string | undefined;
  format: 'table' | 'json';
  out?: string | undefined;
}

function parseHorizons(raw: string | undefined): number[] {
  if (!raw) {
    return DEFAULT_HORIZONS;
  }
  const horizons = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const parsed = Number(part);
      if (Number.isNaN(parsed)) {
        throw new Error(`invalid value for --horizons: "${raw}"`);
      }
      return parsed;
    });
  return horizons.length > 0 ? horizons : DEFAULT_HORIZONS;
}

function parseFormat(raw: string | undefined): 'table' | 'json' {
  if (raw === undefined || raw === 'table') {
    return 'table';
  }
  if (raw === 'json') {
    return 'json';
  }
  throw new Error(`invalid value for --format: "${raw}"`);
}

export function parseResearchCliArgs(argv: string[]): ResearchCliArgs {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'config/default.json' },
      db: { type: 'string' },
      horizons: { type: 'string' },
      'min-cross-section': { type: 'string', default: '10' },
      start: { type: 'string' },
      end: { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });

  return {
    config: values.config as string,
    db: values.db as string | undefined,
    horizons: parseHorizons(values.horizons as string | undefined),
    minCrossSection: Number(values['min-cross-section']),
    start: values.start as string | undefined,
    end: values.end as string | undefined,
    format: parseFormat(values.format as string | undefined),
    out: values.out as string | undefined,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Parses the three JSON columns, keeps only the finite-number signals, then lets the parsed objects go -- rows can number in the hundreds of thousands (see loadHorizonBuckets). */
function extractSignals(
  metricsJson: string,
  factorsJson: string,
  scoresJson: string,
): Record<string, number> {
  const signals: Record<string, number> = {};
  const metrics = safeParseObject(metricsJson);
  for (const key of METRIC_SIGNAL_KEYS) {
    const value = metrics[key];
    if (isFiniteNumber(value)) {
      signals[key] = value;
    }
  }
  const factors = safeParseObject(factorsJson);
  for (const [key, value] of Object.entries(factors)) {
    if (isFiniteNumber(value)) {
      signals[`factor:${key}`] = value;
    }
  }
  const scores = safeParseObject(scoresJson);
  for (const [key, value] of Object.entries(scores)) {
    if (isFiniteNumber(value)) {
      signals[`score:${key}`] = value;
    }
  }
  return signals;
}

interface CrossSectionRow {
  fwd: number;
  signals: Record<string, number>;
}

interface RunBucket {
  generated_at: string;
  rows: CrossSectionRow[];
}

interface HorizonBucket {
  totalRows: number;
  presentCounts: Map<string, number>;
  runGeneratedAt: Map<string, string>;
  allRows: CrossSectionRow[];
  runs: Map<string, RunBucket>;
}

function createHorizonBucket(): HorizonBucket {
  return {
    totalRows: 0,
    presentCounts: new Map(),
    runGeneratedAt: new Map(),
    allRows: [],
    runs: new Map(),
  };
}

interface JoinedDbRow {
  run_id: string;
  generated_at: string;
  symbol: string;
  factors_json: string;
  scores_json: string;
  metrics_json: string;
  horizon_hours: number;
  fwd_return_pct: number | null;
  fwd_residual_pct: number | null;
}

/**
 * Single streamed join (outcome_labels x factor_history on run_id+symbol), grouped into a
 * per-horizon, per-run cross-section. Uses `.iterate()`, not `.all()` -- this join can be ~460k
 * rows, and each row's three JSON columns are parsed and immediately reduced to a handful of
 * finite numbers rather than retained.
 */
function loadHorizonBuckets(
  db: Database.Database,
  horizons: number[],
  start: string | undefined,
  end: string | undefined,
): Map<number, HorizonBucket> {
  const buckets = new Map<number, HorizonBucket>();
  for (const horizon of horizons) {
    buckets.set(horizon, createHorizonBucket());
  }

  const conditions = [`ol.horizon_hours IN (${sqlPlaceholders(horizons.length)})`];
  const params: Array<string | number> = [...horizons];
  if (start !== undefined) {
    conditions.push('fh.generated_at >= ?');
    params.push(start);
  }
  if (end !== undefined) {
    conditions.push('fh.generated_at < ?');
    params.push(end);
  }

  const stmt = db.prepare(`
    SELECT fh.run_id AS run_id, fh.generated_at AS generated_at, fh.symbol AS symbol,
           fh.factors_json AS factors_json, fh.scores_json AS scores_json,
           fh.metrics_json AS metrics_json, ol.horizon_hours AS horizon_hours,
           ol.fwd_return_pct AS fwd_return_pct, ol.fwd_residual_pct AS fwd_residual_pct
    FROM outcome_labels ol
    JOIN factor_history fh ON fh.run_id = ol.run_id AND fh.symbol = ol.symbol
    WHERE ${conditions.join(' AND ')}
  `);

  const rows = stmt.iterate(...params) as IterableIterator<JoinedDbRow>;
  for (const dbRow of rows) {
    const bucket = buckets.get(dbRow.horizon_hours);
    if (bucket === undefined) {
      continue;
    }
    const signals = extractSignals(dbRow.metrics_json, dbRow.factors_json, dbRow.scores_json);
    bucket.totalRows += 1;
    bucket.runGeneratedAt.set(dbRow.run_id, dbRow.generated_at);
    for (const key of Object.keys(signals)) {
      bucket.presentCounts.set(key, (bucket.presentCounts.get(key) ?? 0) + 1);
    }

    if (!isFiniteNumber(dbRow.fwd_return_pct)) {
      continue;
    }
    const crossRow: CrossSectionRow = { fwd: dbRow.fwd_return_pct, signals };
    bucket.allRows.push(crossRow);
    let runBucket = bucket.runs.get(dbRow.run_id);
    if (runBucket === undefined) {
      runBucket = { generated_at: dbRow.generated_at, rows: [] };
      bucket.runs.set(dbRow.run_id, runBucket);
    }
    runBucket.rows.push(crossRow);
  }

  return buckets;
}

export interface RunCadence {
  n_runs: number;
  date_start: string | null;
  date_end: string | null;
  median_runs_per_day: number | null;
}

function runCadence(runGeneratedAt: Map<string, string>): RunCadence {
  if (runGeneratedAt.size === 0) {
    return { n_runs: 0, date_start: null, date_end: null, median_runs_per_day: null };
  }
  const generatedAts = [...runGeneratedAt.values()].sort();
  const perDay = new Map<string, number>();
  for (const generatedAt of generatedAts) {
    const day = generatedAt.slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  return {
    n_runs: runGeneratedAt.size,
    date_start: generatedAts[0] as string,
    date_end: generatedAts[generatedAts.length - 1] as string,
    median_runs_per_day: median([...perDay.values()]),
  };
}

export interface SignalReportRow {
  signal: string;
  coverage_pct: number | null;
  n_runs: number;
  n_obs: number;
  ic_mean: number | null;
  ic_tstat: number | null;
  ic_tstat_effn: number | null;
  spread_mean: number | null;
  daily_ic_mean: number | null;
  daily_ic_tstat: number | null;
  daily_n_runs: number;
}

function buildSignalRow(
  signal: string,
  bucket: HorizonBucket,
  minCrossSection: number,
): SignalReportRow {
  const presentCount = bucket.presentCounts.get(signal) ?? 0;
  const coverage_pct = bucket.totalRows > 0 ? presentCount / bucket.totalRows : null;

  const perRunSeries: SignalRunPoint[] = [];
  for (const [runId, runBucket] of bucket.runs) {
    const pairs: SignalFwdPair[] = [];
    for (const row of runBucket.rows) {
      const value = row.signals[signal];
      if (value !== undefined) {
        pairs.push({ signal: value, fwd: row.fwd });
      }
    }
    if (pairs.length >= minCrossSection) {
      perRunSeries.push({
        run_id: runId,
        generated_at: runBucket.generated_at,
        ic: spearmanRankIC(pairs),
        spread: quintileSpread(pairs),
        n: pairs.length,
      });
    }
  }

  const stats = computeSignalStats(perRunSeries);
  const dailyStats = computeSignalStats(dailySubsample(perRunSeries));

  return {
    signal,
    coverage_pct,
    n_runs: stats.n_runs,
    n_obs: stats.n_obs,
    ic_mean: stats.ic_mean,
    ic_tstat: stats.ic_tstat,
    ic_tstat_effn: stats.ic_tstat_effn,
    spread_mean: stats.spread_mean,
    daily_ic_mean: dailyStats.ic_mean,
    daily_ic_tstat: dailyStats.ic_tstat,
    daily_n_runs: dailyStats.n_runs,
  };
}

function absOrLast(value: number | null): number {
  return value === null ? -1 : Math.abs(value);
}

/** hitDirection picks which side of `fwd` counts as a "hit"; cohortStats itself only ever reports fwd>0 (pipeline/research.ts's own contract), so a fwd<0 cohort re-derives hit_rate here instead of sign-adjusting fwd (which would also flip mean_fwd, and mean_fwd here is meant to stay the raw mean). */
function cohortReport(
  rows: CrossSectionRow[],
  predicate: (row: CrossSectionRow) => boolean,
  hitDirection: 'positive' | 'negative',
): CohortStats {
  const base = cohortStats(rows, predicate);
  if (hitDirection === 'positive' || base.n === 0) {
    return base;
  }
  const cohort = rows.filter(predicate);
  const negativeHits = cohort.filter((row) => row.fwd < 0).length;
  return { ...base, hit_rate: negativeHits / cohort.length };
}

export interface HorizonCohorts {
  momentum_advance: CohortStats;
  momentum_decline: CohortStats;
  crowded_long_fade: CohortStats;
  squeeze: CohortStats;
  rsi_overbought: CohortStats;
  rsi_oversold: CohortStats;
}

/** Crowded-long/squeeze thresholds mirror dashboard/watchlists.ts's isCrowdedLong/isCrowdedShort exactly (funding default 0 when missing, long/short ratio excluded when missing). */
function computeCohorts(rows: CrossSectionRow[]): HorizonCohorts {
  const priceChange24h = (row: CrossSectionRow) => row.signals.price_change_24h_pct ?? Number.NaN;
  const funding = (row: CrossSectionRow) => row.signals.funding_rate_pct ?? 0;
  const lsRatio = (row: CrossSectionRow) => row.signals.long_short_ratio ?? Number.NaN;
  const rsi14 = (row: CrossSectionRow) => row.signals.rsi_14 ?? Number.NaN;

  return {
    momentum_advance: cohortReport(rows, (row) => priceChange24h(row) >= 0.5, 'positive'),
    momentum_decline: cohortReport(rows, (row) => priceChange24h(row) <= -0.5, 'negative'),
    crowded_long_fade: cohortReport(
      rows,
      (row) => funding(row) > 0.015 || lsRatio(row) >= 1.3,
      'negative',
    ),
    squeeze: cohortReport(rows, (row) => funding(row) < -0.015 || lsRatio(row) <= 0.8, 'positive'),
    rsi_overbought: cohortReport(rows, (row) => rsi14(row) >= 70, 'positive'),
    rsi_oversold: cohortReport(rows, (row) => rsi14(row) <= 30, 'positive'),
  };
}

export interface HorizonReport {
  horizon_hours: number;
  run_cadence: RunCadence;
  signals: SignalReportRow[];
  cohorts: HorizonCohorts;
}

function computeHorizonReport(
  horizon: number,
  bucket: HorizonBucket,
  minCrossSection: number,
): HorizonReport {
  const signalNames = new Set<string>(METRIC_SIGNAL_KEYS);
  for (const key of bucket.presentCounts.keys()) {
    if (key.startsWith('factor:') || key.startsWith('score:')) {
      signalNames.add(key);
    }
  }

  const signals = [...signalNames]
    .map((signal) => buildSignalRow(signal, bucket, minCrossSection))
    .sort((a, b) => absOrLast(b.ic_tstat_effn) - absOrLast(a.ic_tstat_effn));

  return {
    horizon_hours: horizon,
    run_cadence: runCadence(bucket.runGeneratedAt),
    signals,
    cohorts: computeCohorts(bucket.allRows),
  };
}

export interface ResearchReport {
  generated_at: string;
  db_path: string;
  horizons: number[];
  min_cross_section: number;
  start: string | null;
  end: string | null;
  results: HorizonReport[];
  caveats: string[];
}

const RESEARCH_CAVEATS = [
  'backfill panel replays the CURRENT universe (~69 surviving symbols) into the past — reversal/bounce effects are survivorship-inflated',
  'derivatives signals (funding/OI/taker/liquidation/LS) only cover 2026-01-13 onward; technical/price signals cover the full panel — do not compare ICs across the two groups',
] as const;

export function runResearch(config: AppConfig, args: ResearchCliArgs): ResearchReport {
  const dbPath = args.db ?? config.storage_path;
  const db = openDatabase(dbPath);
  try {
    const buckets = loadHorizonBuckets(db, args.horizons, args.start, args.end);
    const results = args.horizons.map((horizon) =>
      computeHorizonReport(horizon, buckets.get(horizon) as HorizonBucket, args.minCrossSection),
    );
    return {
      generated_at: new Date().toISOString(),
      db_path: dbPath,
      horizons: args.horizons,
      min_cross_section: args.minCrossSection,
      start: args.start ?? null,
      end: args.end ?? null,
      results,
      caveats: [...RESEARCH_CAVEATS],
    };
  } finally {
    db.close();
  }
}

function formatFixed(value: number | null, digits: number): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function formatPct(value: number | null, digits = 1): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

function printCohortLine(label: string, cohort: CohortStats): void {
  console.log(
    `  ${label.padEnd(48)} n=${String(cohort.n).padStart(6)}  mean_fwd=${formatFixed(
      cohort.mean_fwd,
      3,
    ).padStart(9)}  hit_rate=${formatPct(cohort.hit_rate).padStart(7)}`,
  );
}

function printTable(report: ResearchReport): void {
  console.log(`db=${report.db_path}`);
  console.log(`horizons=${report.horizons.join(',')}`);
  console.log(`min_cross_section=${report.min_cross_section}`);
  console.log(`start=${report.start ?? 'n/a'}`);
  console.log(`end=${report.end ?? 'n/a'}`);

  for (const horizonReport of report.results) {
    console.log('');
    console.log(`== horizon=${horizonReport.horizon_hours}h ==`);
    const cadence = horizonReport.run_cadence;
    const medianRunsPerDay =
      cadence.median_runs_per_day === null ? 'n/a' : cadence.median_runs_per_day.toFixed(1);
    console.log(
      `runs: n=${cadence.n_runs}  range=[${cadence.date_start ?? 'n/a'} .. ${cadence.date_end ?? 'n/a'}]  median_runs_per_day=${medianRunsPerDay}`,
    );

    if (horizonReport.signals.length === 0) {
      console.log('(no signals)');
    } else {
      const nameWidth = Math.max(6, ...horizonReport.signals.map((row) => row.signal.length));
      console.log(
        [
          'signal'.padEnd(nameWidth),
          'coverage%'.padStart(10),
          'n_runs'.padStart(7),
          'ic_mean'.padStart(9),
          'ic_tstat'.padStart(9),
          'ic_tstat_effn'.padStart(14),
          'daily_ic_mean'.padStart(14),
          'q5_q1_spread_pp'.padStart(16),
        ].join(' '),
      );
      for (const row of horizonReport.signals) {
        console.log(
          [
            row.signal.padEnd(nameWidth),
            formatPct(row.coverage_pct).padStart(10),
            String(row.n_runs).padStart(7),
            formatFixed(row.ic_mean, 4).padStart(9),
            formatFixed(row.ic_tstat, 2).padStart(9),
            formatFixed(row.ic_tstat_effn, 2).padStart(14),
            formatFixed(row.daily_ic_mean, 4).padStart(14),
            formatFixed(row.spread_mean, 2).padStart(16),
          ].join(' '),
        );
      }
    }

    console.log('');
    console.log('cohorts:');
    printCohortLine(
      'momentum_advance (price_change_24h_pct >= 0.5)',
      horizonReport.cohorts.momentum_advance,
    );
    printCohortLine(
      'momentum_decline (price_change_24h_pct <= -0.5)',
      horizonReport.cohorts.momentum_decline,
    );
    printCohortLine(
      'crowded_long_fade (funding>0.015% or L/S>=1.3)',
      horizonReport.cohorts.crowded_long_fade,
    );
    printCohortLine('squeeze (funding<-0.015% or L/S<=0.8)', horizonReport.cohorts.squeeze);
    printCohortLine('rsi_overbought (rsi_14 >= 70)', horizonReport.cohorts.rsi_overbought);
    printCohortLine('rsi_oversold (rsi_14 <= 30)', horizonReport.cohorts.rsi_oversold);
  }

  console.log('');
  console.log('caveats:');
  for (const caveat of RESEARCH_CAVEATS) {
    console.log(`  - ${caveat}`);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseResearchCliArgs(argv);
  const config = loadConfig(args.config);
  const report = runResearch(config, args);

  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
  }

  if (args.out !== undefined) {
    writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf-8');
  }

  return 0;
}

runIfMain(import.meta.url, main);
