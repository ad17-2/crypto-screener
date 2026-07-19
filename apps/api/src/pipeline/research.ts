import { mean, pearsonCorr, stdev } from './scoring.js';

/**
 * Offline signal-research harness -- pure functions, no I/O. Computes rank-IC / quintile-spread
 * style statistics between a candidate signal and a forward return, plus the run-level aggregation
 * on top of them. apps/api/src/cli/research.ts owns the DB reads, the signal extraction from
 * factor_history/outcome_labels, and the table/JSON printing; everything here is hand-fixture
 * testable (apps/api/tests/pipeline/research.test.ts).
 */

export interface SignalFwdPair {
  signal: number;
  fwd: number;
}

/** 1-based rank of each value; ties get the average of the ranks they span. */
function rankValues(values: number[]): number[] {
  const order = values
    .map((_, index) => index)
    .sort((a, b) => (values[a] as number) - (values[b] as number));
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1] as number] === values[order[i] as number]) {
      j += 1;
    }
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      ranks[order[k] as number] = averageRank;
    }
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank-IC: Pearson correlation of the average-ranked (ties averaged) series. Reuses
 * pearsonCorr's own guards (null below n=2, null on zero variance) instead of duplicating them --
 * a fully tied signal or forward-return column ranks to a constant, which is exactly the
 * zero-rank-variance case.
 */
export function spearmanRankIC(pairs: SignalFwdPair[]): number | null {
  if (pairs.length < 2) {
    return null;
  }
  const signalRanks = rankValues(pairs.map((pair) => pair.signal));
  const fwdRanks = rankValues(pairs.map((pair) => pair.fwd));
  return pearsonCorr(signalRanks, fwdRanks);
}

/** Top-20% mean forward return minus bottom-20% mean forward return, sorted by signal. Each bucket needs >=2 rows, else null. */
export function quintileSpread(pairs: SignalFwdPair[]): number | null {
  const bucketSize = Math.floor(pairs.length / 5);
  if (bucketSize < 2) {
    return null;
  }
  const sorted = [...pairs].sort((a, b) => a.signal - b.signal);
  const bottom = sorted.slice(0, bucketSize);
  const top = sorted.slice(sorted.length - bucketSize);
  return mean(top.map((pair) => pair.fwd)) - mean(bottom.map((pair) => pair.fwd));
}

export interface SignalRunPoint {
  run_id: string;
  generated_at: string;
  ic: number | null;
  spread: number | null;
  n: number;
}

export interface SignalStats {
  n_runs: number;
  n_obs: number;
  ic_mean: number | null;
  ic_tstat: number | null;
  ic_tstat_effn: number | null;
  spread_mean: number | null;
}

function sortByGeneratedAt<T extends { generated_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.generated_at < b.generated_at ? -1 : a.generated_at > b.generated_at ? 1 : 0,
  );
}

/**
 * Lag-1 autocorrelation of a (chronologically ordered) series, computed as the Pearson correlation
 * of the series against itself shifted by one run -- null below 3 points (a 2-point series has
 * only one lag pair, and pearsonCorr itself refuses n<2).
 */
function lag1Autocorrelation(values: number[]): number | null {
  if (values.length < 3) {
    return null;
  }
  return pearsonCorr(values.slice(0, -1), values.slice(1));
}

/**
 * Runs happen ~4x/day against 24-72h forward horizons, so consecutive runs' forward-return windows
 * overlap heavily -- the naive tstat below (`ic_tstat`, using `sqrt(n_runs)`) treats every run as
 * an independent draw and overstates significance. `ic_tstat_effn` is the overlap-aware variant:
 * it shrinks n_runs by the IC series' own lag-1 autocorrelation r1 (clamped to [0, 0.99] -- only
 * ever shrinks, since a *negative* r1 would inflate n above its nominal value, which isn't a real
 * gain in independent information here).
 */
export function computeSignalStats(perRunSeries: SignalRunPoint[]): SignalStats {
  const n_runs = perRunSeries.length;
  const n_obs = perRunSeries.reduce((sum, row) => sum + row.n, 0);
  const sorted = sortByGeneratedAt(perRunSeries);
  const ics = sorted.map((row) => row.ic).filter((value): value is number => value !== null);
  const spreads = sorted
    .map((row) => row.spread)
    .filter((value): value is number => value !== null);

  const ic_mean = ics.length > 0 ? mean(ics) : null;
  const icStd = ics.length > 0 ? stdev(ics) : 0;
  const ic_tstat =
    ic_mean !== null && ics.length >= 2 && icStd > 0
      ? ic_mean / (icStd / Math.sqrt(ics.length))
      : null;

  let ic_tstat_effn: number | null = null;
  if (ic_tstat !== null && ic_mean !== null) {
    const r1raw = lag1Autocorrelation(ics);
    const r1 = Math.min(0.99, Math.max(0, r1raw ?? 0));
    const effN = ics.length * ((1 - r1) / (1 + r1));
    ic_tstat_effn = ic_mean / (icStd / Math.sqrt(effN));
  }

  return {
    n_runs,
    n_obs,
    ic_mean,
    ic_tstat,
    ic_tstat_effn,
    spread_mean: spreads.length > 0 ? mean(spreads) : null,
  };
}

/**
 * Keeps one row per Asia/Jakarta calendar day -- the first run of that day, by `generated_at`.
 * `generated_at` always carries an explicit offset (db/time.ts's fixed "+07:00" suffix), so the
 * date already IS the Jakarta date: parsing into a `Date` here only validates the timestamp, the
 * day key itself comes straight from the string. No re-zoning (e.g. `toISOString()`, which would
 * convert to UTC and shift the day boundary) is involved.
 */
export function dailySubsample<T extends { run_id: string; generated_at: string }>(rows: T[]): T[] {
  const sorted = sortByGeneratedAt(rows);
  const seenDays = new Set<string>();
  const kept: T[] = [];
  for (const row of sorted) {
    if (Number.isNaN(new Date(row.generated_at).getTime())) {
      throw new Error(`invalid generated_at: "${row.generated_at}"`);
    }
    const day = row.generated_at.slice(0, 10);
    if (!seenDays.has(day)) {
      seenDays.add(day);
      kept.push(row);
    }
  }
  return kept;
}

export interface CohortStats {
  n: number;
  mean_fwd: number | null;
  hit_rate: number | null;
}

/**
 * hit_rate = share of the cohort with fwd > 0. Callers that want the opposite direction (e.g. a
 * "decline continues" or "crowded long fades" cohort) sign-adjust `fwd` before calling --
 * db/weeklyReview.ts's sideAdjustedReturn is the existing precedent for that pattern.
 */
export function cohortStats<T extends { fwd: number }>(
  rows: T[],
  predicate: (row: T) => boolean,
): CohortStats {
  const cohort = rows.filter(predicate);
  if (cohort.length === 0) {
    return { n: 0, mean_fwd: null, hit_rate: null };
  }
  const hits = cohort.filter((row) => row.fwd > 0).length;
  return {
    n: cohort.length,
    mean_fwd: mean(cohort.map((row) => row.fwd)),
    hit_rate: hits / cohort.length,
  };
}
