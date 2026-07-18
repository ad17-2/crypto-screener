import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOutcomeLabels, saveOutcomeLabelRecords } from '../../src/db/outcomeLabels.js';
import { formatJakartaIso } from '../../src/db/time.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

// A fixed instant with no sub-second component, so whole-hour offsets round-trip exactly through
// formatJakartaIso's 19-char (second) precision.
const REFERENCE = new Date('2026-01-01T00:00:00.000Z');

function atHours(offsetHours: number): string {
  return formatJakartaIso(new Date(REFERENCE.getTime() + offsetHours * 3_600_000));
}

function insertFactorHistoryRow(
  db: Database.Database,
  runId: string,
  offsetHours: number,
  symbol: string,
  price: number,
  metrics: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO factor_history (run_id, generated_at, symbol, price_usd, factors_json, scores_json, metrics_json)
     VALUES (?, ?, ?, ?, '{}', '{}', ?)`,
  ).run(runId, atHours(offsetHours), symbol, price, JSON.stringify(metrics));
}

interface OutcomeLabelDbRow {
  run_id: string;
  generated_at: string;
  symbol: string;
  horizon_hours: number;
  fwd_return_pct: number | null;
  fwd_residual_pct: number | null;
  btc_fwd_return_pct: number | null;
  beta_used: number | null;
  matched_run_id: string;
  matched_delta_hours: number;
}

function readOutcomeLabel(
  db: Database.Database,
  runId: string,
  symbol: string,
  horizonHours: number,
): OutcomeLabelDbRow | undefined {
  return db
    .prepare('SELECT * FROM outcome_labels WHERE run_id = ? AND symbol = ? AND horizon_hours = ?')
    .get(runId, symbol, horizonHours) as OutcomeLabelDbRow | undefined;
}

let dir: string;
let db: Database.Database;

beforeEach(() => {
  ({ dir, db } = setupTempDb('crypto-screener-outcome-labels-'));

  // Core SYM+BTC pair at t, t+24h, t+72h -- beta only set on the t0 SYM row (mirrors a row that has
  // enough correlation history; other rows below deliberately lack it).
  insertFactorHistoryRow(db, 't0', 0, 'SYM', 100, { is_trusted: true, btc_beta: 1.5 });
  insertFactorHistoryRow(db, 't0', 0, 'BTC', 50_000, { is_trusted: true });
  insertFactorHistoryRow(db, 't24', 24, 'SYM', 110, { is_trusted: true });
  insertFactorHistoryRow(db, 't24', 24, 'BTC', 51_500, { is_trusted: true });
  insertFactorHistoryRow(db, 't72', 72, 'SYM', 130, { is_trusted: true });
  insertFactorHistoryRow(db, 't72', 72, 'BTC', 54_000, { is_trusted: true });

  // Out-of-band row for the t0->24h search (deltaHours=10 is below horizonTolerance(24)'s 18h
  // floor): must never be chosen over the real t24 row for t0's 24h label. It legitimately IS a
  // valid 72h-horizon base of its own (deltaHours to t72 is 62h, inside [54,108]) with no btc_beta
  // -- doubles as the null-residual-missing-beta fixture.
  insertFactorHistoryRow(db, 'decoy', 10, 'SYM', 99_999, { is_trusted: true });

  // Explicitly untrusted base row: must be skipped entirely (no outcome_labels row, counted in
  // base_rows_skipped_untrusted, never attempted as a forward match target for anything above).
  insertFactorHistoryRow(db, 'untrusted-base', 500, 'SYM', 200, { is_trusted: false });

  // Legacy row with no is_trusted key at all: treated as trusted, but counted separately. Isolated
  // in time so it has no forward match either way.
  insertFactorHistoryRow(db, 'legacy-base', -500, 'SYM', 90, {});
});

afterEach(() => {
  teardownTempDb(dir, db);
});

describe('buildOutcomeLabels', () => {
  it('computes exact fwd_return/residual math for the SYM base row at t0', () => {
    const { records } = buildOutcomeLabels(db);
    const h24 = records.find(
      (r) => r.run_id === 't0' && r.symbol === 'SYM' && r.horizon_hours === 24,
    );
    const h72 = records.find(
      (r) => r.run_id === 't0' && r.symbol === 'SYM' && r.horizon_hours === 72,
    );
    expect(h24).toBeDefined();
    expect(h72).toBeDefined();

    // (110/100 - 1) x 100 = 10; BTC leg (51500/50000 - 1) x 100 = 3; residual = 10 - 1.5x3 = 5.5.
    expect(h24?.fwd_return_pct).toBeCloseTo(10.0, 9);
    expect(h24?.btc_fwd_return_pct).toBeCloseTo(3.0, 9);
    expect(h24?.beta_used).toBeCloseTo(1.5, 9);
    expect(h24?.fwd_residual_pct).toBeCloseTo(5.5, 9);
    expect(h24?.matched_run_id).toBe('t24');
    expect(h24?.matched_delta_hours).toBeCloseTo(24.0, 9);

    // (130/100 - 1) x 100 = 30; BTC leg (54000/50000 - 1) x 100 = 8; residual = 30 - 1.5x8 = 18.
    expect(h72?.fwd_return_pct).toBeCloseTo(30.0, 9);
    expect(h72?.btc_fwd_return_pct).toBeCloseTo(8.0, 9);
    expect(h72?.fwd_residual_pct).toBeCloseTo(18.0, 9);
    expect(h72?.matched_run_id).toBe('t72');
    expect(h72?.matched_delta_hours).toBeCloseTo(72.0, 9);
  });

  it('respects the tolerance band: the out-of-band decoy is never matched for t0->24h', () => {
    const { records } = buildOutcomeLabels(db);
    const h24 = records.find(
      (r) => r.run_id === 't0' && r.symbol === 'SYM' && r.horizon_hours === 24,
    );
    expect(h24?.matched_run_id).not.toBe('decoy');
    // Sanity: if the decoy's price (99999) had leaked in, this would be nowhere near 10%.
    expect(h24?.fwd_return_pct).toBeCloseTo(10.0, 9);
  });

  it('leaves fwd_residual_pct NULL (never fabricates beta=1) when btc_beta is missing at base time', () => {
    const { records } = buildOutcomeLabels(db);
    // The decoy row is itself a valid, trusted base with no btc_beta; its own 72h horizon finds a
    // real forward match (t72, deltaHours=62, inside [54,108]).
    const decoyH72 = records.find(
      (r) => r.run_id === 'decoy' && r.symbol === 'SYM' && r.horizon_hours === 72,
    );
    expect(decoyH72).toBeDefined();
    expect(decoyH72?.beta_used).toBeNull();
    expect(decoyH72?.fwd_residual_pct).toBeNull();
    // fwd_return_pct itself is still computed even though the residual can't be.
    expect(decoyH72?.fwd_return_pct).not.toBeNull();
  });

  it('skips the untrusted base row entirely: no row written, no forward-match attempt', () => {
    const { records, summary } = buildOutcomeLabels(db);
    const untrustedRows = records.filter((r) => r.run_id === 'untrusted-base');
    expect(untrustedRows).toHaveLength(0);
    expect(summary.base_rows_skipped_untrusted).toBe(1);
  });

  it('treats a row with no is_trusted key as trusted, but tallies it separately', () => {
    const { summary } = buildOutcomeLabels(db);
    expect(summary.base_rows_trusted_missing_flag).toBe(1);
  });

  it('filtering to one symbol via SQL pushdown yields records equal to the unfiltered run for that symbol, and no BTC records', () => {
    const unfiltered = buildOutcomeLabels(db);
    const filtered = buildOutcomeLabels(db, { symbols: ['SYM'] });

    const unfilteredSym = unfiltered.records.filter((r) => r.symbol === 'SYM');
    const filteredSym = filtered.records.filter((r) => r.symbol === 'SYM');
    expect(filteredSym).toEqual(unfilteredSym);
    expect(filteredSym.length).toBeGreaterThan(0);

    // BTC's series must still be pulled in for the residual leg (fwd_residual_pct above proves
    // that), but BTC was never requested, so it must not produce its own label records.
    expect(filtered.records.some((r) => r.symbol === 'BTC')).toBe(false);
  });

  it('is idempotent on re-run: writing twice yields the same row count and the same values', () => {
    const first = buildOutcomeLabels(db);
    const firstWritten = saveOutcomeLabelRecords(db, first.records);
    const firstCount = (
      db.prepare('SELECT COUNT(*) AS count FROM outcome_labels').get() as { count: number }
    ).count;
    const firstRow = readOutcomeLabel(db, 't0', 'SYM', 24);

    const second = buildOutcomeLabels(db);
    const secondWritten = saveOutcomeLabelRecords(db, second.records);
    const secondCount = (
      db.prepare('SELECT COUNT(*) AS count FROM outcome_labels').get() as { count: number }
    ).count;
    const secondRow = readOutcomeLabel(db, 't0', 'SYM', 24);

    expect(firstWritten).toBe(first.records.length);
    expect(secondWritten).toBe(second.records.length);
    expect(secondCount).toBe(firstCount);
    expect(secondRow).toEqual(firstRow);
  });
});

// Isolated from the shared fixture above (own temp db) -- these tests need full control over which
// BTC rows exist at which run_id, and the shared fixture's BTC rows (all at exact-target deltas)
// would otherwise win any independent closest-to-target search regardless of run_id, masking the
// bug this fix addresses.
describe('buildOutcomeLabels BTC residual leg run alignment', () => {
  let dir2: string;
  let db2: Database.Database;

  beforeEach(() => {
    ({ dir: dir2, db: db2 } = setupTempDb('crypto-screener-outcome-labels-btc-align-'));
  });

  afterEach(() => {
    teardownTempDb(dir2, db2);
  });

  it("prefers BTC's price at the symbol's matched run over a nearer off-run BTC candidate", () => {
    // SYM's own forward search only has one candidate in the [18,36] band for horizon=24: run
    // 's24' at deltaHours=26 (not the exact target -- deliberately, so a decoy at deltaHours=24
    // exact would otherwise win an independent closest-to-target BTC search).
    insertFactorHistoryRow(db2, 's0', 0, 'SYM', 100, { is_trusted: true, btc_beta: 2.0 });
    insertFactorHistoryRow(db2, 's24', 26, 'SYM', 110, { is_trusted: true });

    insertFactorHistoryRow(db2, 's0', 0, 'BTC', 50_000, { is_trusted: true });
    // The correct pick: BTC's row at SYM's actual matched run_id 's24'.
    insertFactorHistoryRow(db2, 's24', 26, 'BTC', 52_000, { is_trusted: true });
    // A decoy BTC row at a different run_id, sitting exactly on the 24h target (deltaHours=24,
    // distance 0) -- closer to target than 's24' (distance 2), so an independent closest-to-target
    // search would wrongly prefer this over the matched-run row. Its price is absurd so a wrong
    // pick is unmistakable.
    insertFactorHistoryRow(db2, 's24-decoy', 24, 'BTC', 999_999, { is_trusted: true });

    const { records } = buildOutcomeLabels(db2, { horizons: [24] });
    const h24 = records.find(
      (r) => r.run_id === 's0' && r.symbol === 'SYM' && r.horizon_hours === 24,
    );

    expect(h24).toBeDefined();
    expect(h24?.matched_run_id).toBe('s24');
    // BTC leg must be (52000/50000 - 1) x 100 = 4, from the matched-run row, not the decoy.
    expect(h24?.btc_fwd_return_pct).toBeCloseTo(4.0, 9);
    // fwd_return = (110/100-1)x100 = 10; residual = 10 - 2.0x4 = 2.
    expect(h24?.fwd_return_pct).toBeCloseTo(10.0, 9);
    expect(h24?.fwd_residual_pct).toBeCloseTo(2.0, 9);
  });

  it('falls back to the independent closest-to-target BTC match when BTC has no row at the matched run', () => {
    insertFactorHistoryRow(db2, 'f0', 0, 'SYM', 100, { is_trusted: true, btc_beta: 1.0 });
    insertFactorHistoryRow(db2, 'f24', 24, 'SYM', 120, { is_trusted: true });

    insertFactorHistoryRow(db2, 'f0', 0, 'BTC', 50_000, { is_trusted: true });
    // No BTC row at run_id 'f24' -- only an off-run candidate for the fallback search to find.
    insertFactorHistoryRow(db2, 'f-other', 24, 'BTC', 51_000, { is_trusted: true });

    const { records } = buildOutcomeLabels(db2, { horizons: [24] });
    const h24 = records.find(
      (r) => r.run_id === 'f0' && r.symbol === 'SYM' && r.horizon_hours === 24,
    );

    expect(h24).toBeDefined();
    expect(h24?.matched_run_id).toBe('f24');
    // BTC leg must fall back to the off-run 'f-other' match: (51000/50000-1)x100 = 2.
    expect(h24?.btc_fwd_return_pct).toBeCloseTo(2.0, 9);
    // fwd_return = (120/100-1)x100 = 20; residual = 20 - 1.0x2 = 18.
    expect(h24?.fwd_return_pct).toBeCloseTo(20.0, 9);
    expect(h24?.fwd_residual_pct).toBeCloseTo(18.0, 9);
  });
});
