import { describe, expect, it } from 'vitest';
import { parseResearchCliArgs } from '../../src/cli/research.js';
import type { SignalRunPoint } from '../../src/pipeline/research.js';
import {
  cohortStats,
  computeSignalStats,
  dailySubsample,
  quintileSpread,
  spearmanRankIC,
} from '../../src/pipeline/research.js';

describe('spearmanRankIC', () => {
  it('is 1 for a perfectly monotone increasing relationship', () => {
    const pairs = [
      { signal: 1, fwd: 10 },
      { signal: 2, fwd: 20 },
      { signal: 3, fwd: 30 },
      { signal: 4, fwd: 40 },
    ];
    expect(spearmanRankIC(pairs)).toBeCloseTo(1, 10);
  });

  it('is -1 for a perfectly monotone inverse relationship', () => {
    const pairs = [
      { signal: 1, fwd: 40 },
      { signal: 2, fwd: 30 },
      { signal: 3, fwd: 20 },
      { signal: 4, fwd: 10 },
    ];
    expect(spearmanRankIC(pairs)).toBeCloseTo(-1, 10);
  });

  it('averages tied ranks (hand-computed: signal [1,2,2,3], fwd [1,3,2,4])', () => {
    // signal ranks: 1, 2.5, 2.5, 4 (the two 2s tie and split ranks 2 and 3).
    // fwd ranks: 1, 3, 2, 4 (no ties).
    // Pearson correlation of those two rank series works out to 1.5*sqrt(2/5), i.e.
    // 4.5 / sqrt(4.5 * 5) = 0.9486832980505138.
    const pairs = [
      { signal: 1, fwd: 1 },
      { signal: 2, fwd: 3 },
      { signal: 2, fwd: 2 },
      { signal: 3, fwd: 4 },
    ];
    expect(spearmanRankIC(pairs)).toBeCloseTo(0.9486832980505138, 6);
  });

  it('is null when the signal is constant (zero rank variance)', () => {
    const pairs = [
      { signal: 5, fwd: 1 },
      { signal: 5, fwd: 2 },
      { signal: 5, fwd: 3 },
    ];
    expect(spearmanRankIC(pairs)).toBeNull();
  });

  it('is null below n=2', () => {
    expect(spearmanRankIC([{ signal: 1, fwd: 1 }])).toBeNull();
    expect(spearmanRankIC([])).toBeNull();
  });
});

describe('quintileSpread', () => {
  it('computes the top-20% minus bottom-20% mean fwd on a 10-row fixture', () => {
    // Sorted by signal already: bottom 2 rows (signal 1,2) have fwd -5,-3 -> mean -4.
    // Top 2 rows (signal 9,10) have fwd 8,10 -> mean 9. Spread = 9 - (-4) = 13.
    const pairs = [
      { signal: 3, fwd: 0 },
      { signal: 1, fwd: -5 },
      { signal: 7, fwd: 4 },
      { signal: 10, fwd: 10 },
      { signal: 2, fwd: -3 },
      { signal: 5, fwd: 2 },
      { signal: 9, fwd: 8 },
      { signal: 4, fwd: 1 },
      { signal: 6, fwd: 3 },
      { signal: 8, fwd: 5 },
    ];
    expect(quintileSpread(pairs)).toBeCloseTo(13, 10);
  });

  it('is null when a bucket would have fewer than 2 rows', () => {
    const pairs = Array.from({ length: 9 }, (_, index) => ({ signal: index, fwd: index }));
    expect(quintileSpread(pairs)).toBeNull();
  });
});

describe('computeSignalStats', () => {
  it('computes an exact t-stat on a hand-built 3-run series', () => {
    // ics = [0.1, 0.2, 0.3] -> mean 0.2, population std sqrt(1/150) = 0.081649658...
    // tstat = 0.2 / (std / sqrt(3)) = 3*sqrt(2) = 4.242640687...
    const series: SignalRunPoint[] = [
      { run_id: 'r1', generated_at: '2026-01-01T00:00:00+07:00', ic: 0.1, spread: 1, n: 10 },
      { run_id: 'r2', generated_at: '2026-01-01T06:00:00+07:00', ic: 0.2, spread: 2, n: 12 },
      { run_id: 'r3', generated_at: '2026-01-01T12:00:00+07:00', ic: 0.3, spread: 3, n: 14 },
    ];
    const stats = computeSignalStats(series);
    expect(stats.n_runs).toBe(3);
    expect(stats.n_obs).toBe(36);
    expect(stats.ic_mean).toBeCloseTo(0.2, 10);
    expect(stats.ic_tstat).toBeCloseTo(3 * Math.sqrt(2), 6);
    expect(stats.spread_mean).toBeCloseTo(2, 10);
  });

  it('shrinks ic_tstat_effn below ic_tstat for a noise-free positively autocorrelated series', () => {
    // A strictly increasing arithmetic series has lag-1 autocorrelation exactly 1 (clamped to
    // 0.99), which collapses the effective n and should shrink the overlap-aware tstat well
    // below the naive one.
    const series: SignalRunPoint[] = [
      { run_id: 'b1', generated_at: '2026-02-01T00:00:00+07:00', ic: 0.1, spread: null, n: 10 },
      { run_id: 'b2', generated_at: '2026-02-01T06:00:00+07:00', ic: 0.15, spread: null, n: 10 },
      { run_id: 'b3', generated_at: '2026-02-01T12:00:00+07:00', ic: 0.2, spread: null, n: 10 },
      { run_id: 'b4', generated_at: '2026-02-01T18:00:00+07:00', ic: 0.25, spread: null, n: 10 },
      { run_id: 'b5', generated_at: '2026-02-02T00:00:00+07:00', ic: 0.3, spread: null, n: 10 },
    ];
    const stats = computeSignalStats(series);
    expect(stats.ic_tstat).not.toBeNull();
    expect(stats.ic_tstat_effn).not.toBeNull();
    expect(stats.ic_tstat_effn as number).toBeLessThan(stats.ic_tstat as number);
  });

  it('leaves ic_tstat_effn equal to ic_tstat when lag-1 autocorrelation is <= 0 (no inflation)', () => {
    // ics = [0.3, 0.1, 0.3, 0.1] alternates perfectly -> lag-1 autocorrelation is exactly -1,
    // clamped to 0, so effective n == n_runs and the two tstats must match exactly.
    const series: SignalRunPoint[] = [
      { run_id: 'c1', generated_at: '2026-03-01T00:00:00+07:00', ic: 0.3, spread: null, n: 10 },
      { run_id: 'c2', generated_at: '2026-03-01T06:00:00+07:00', ic: 0.1, spread: null, n: 10 },
      { run_id: 'c3', generated_at: '2026-03-01T12:00:00+07:00', ic: 0.3, spread: null, n: 10 },
      { run_id: 'c4', generated_at: '2026-03-01T18:00:00+07:00', ic: 0.1, spread: null, n: 10 },
    ];
    const stats = computeSignalStats(series);
    expect(stats.ic_tstat).toBeCloseTo(4, 10);
    expect(stats.ic_tstat_effn).toBeCloseTo(stats.ic_tstat as number, 10);
  });

  it('returns nulls for an empty series without dividing by zero', () => {
    const stats = computeSignalStats([]);
    expect(stats).toEqual({
      n_runs: 0,
      n_obs: 0,
      ic_mean: null,
      ic_tstat: null,
      ic_tstat_effn: null,
      spread_mean: null,
    });
  });
});

describe('dailySubsample', () => {
  it('keeps only the first run of each Asia/Jakarta calendar day', () => {
    // Deliberately out of chronological order to exercise the internal sort.
    const rows = [
      { run_id: 'd1c', generated_at: '2026-01-01T12:00:00+07:00' },
      { run_id: 'd2a', generated_at: '2026-01-02T00:00:00+07:00' },
      { run_id: 'd1a', generated_at: '2026-01-01T00:00:00+07:00' },
      { run_id: 'd2d', generated_at: '2026-01-02T18:00:00+07:00' },
      { run_id: 'd1d', generated_at: '2026-01-01T18:00:00+07:00' },
      { run_id: 'd2b', generated_at: '2026-01-02T06:00:00+07:00' },
      { run_id: 'd1b', generated_at: '2026-01-01T06:00:00+07:00' },
      { run_id: 'd2c', generated_at: '2026-01-02T12:00:00+07:00' },
    ];
    const kept = dailySubsample(rows);
    expect(kept.map((row) => row.run_id)).toEqual(['d1a', 'd2a']);
  });
});

describe('cohortStats', () => {
  it('computes n, mean_fwd, and hit_rate (fwd > 0) for a matching cohort', () => {
    const rows = [{ fwd: 5 }, { fwd: -3 }, { fwd: 2 }, { fwd: -1 }];
    const stats = cohortStats(rows, () => true);
    expect(stats.n).toBe(4);
    expect(stats.mean_fwd).toBeCloseTo(0.75, 10);
    expect(stats.hit_rate).toBeCloseTo(0.5, 10);
  });

  it('filters by the predicate before computing stats', () => {
    const rows = [
      { fwd: 5, tag: 'a' as const },
      { fwd: -3, tag: 'b' as const },
      { fwd: 7, tag: 'a' as const },
    ];
    const stats = cohortStats(rows, (row) => row.tag === 'a');
    expect(stats.n).toBe(2);
    expect(stats.mean_fwd).toBeCloseTo(6, 10);
    expect(stats.hit_rate).toBeCloseTo(1, 10);
  });

  it('returns nulls for an empty cohort', () => {
    const rows = [{ fwd: 5 }, { fwd: -3 }];
    const stats = cohortStats(rows, () => false);
    expect(stats).toEqual({ n: 0, mean_fwd: null, hit_rate: null });
  });
});

describe('parseResearchCliArgs', () => {
  it('defaults horizons to [24, 72], min-cross-section to 10, and format to table', () => {
    const args = parseResearchCliArgs(['--config', 'config/default.json']);
    expect(args.config).toBe('config/default.json');
    expect(args.db).toBeUndefined();
    expect(args.horizons).toEqual([24, 72]);
    expect(args.minCrossSection).toBe(10);
    expect(args.start).toBeUndefined();
    expect(args.end).toBeUndefined();
    expect(args.format).toBe('table');
    expect(args.out).toBeUndefined();
  });

  it('parses --horizons as a comma-separated number list', () => {
    const args = parseResearchCliArgs(['--horizons', '24,72,168']);
    expect(args.horizons).toEqual([24, 72, 168]);
  });

  it('parses --min-cross-section as a number', () => {
    const args = parseResearchCliArgs(['--min-cross-section', '25']);
    expect(args.minCrossSection).toBe(25);
  });

  it('parses --db, --start, --end, and --out', () => {
    const args = parseResearchCliArgs([
      '--db',
      'data/other.sqlite3',
      '--start',
      '2026-01-01',
      '--end',
      '2026-02-01',
      '--out',
      '/tmp/report.json',
    ]);
    expect(args.db).toBe('data/other.sqlite3');
    expect(args.start).toBe('2026-01-01');
    expect(args.end).toBe('2026-02-01');
    expect(args.out).toBe('/tmp/report.json');
  });

  it('parses --format json', () => {
    const args = parseResearchCliArgs(['--format', 'json']);
    expect(args.format).toBe('json');
  });

  it('rejects an invalid --format value', () => {
    expect(() => parseResearchCliArgs(['--format', 'xml'])).toThrow(/invalid value for --format/);
  });

  it('rejects a non-numeric --horizons value', () => {
    expect(() => parseResearchCliArgs(['--horizons', '24,not-a-number'])).toThrow(
      /invalid value for --horizons/,
    );
  });
});
