import type { DashboardRow } from '@crypto-screener/contracts';
import { describe, expect, it } from 'vitest';
import { formatGoldenPocketDistance, rankGoldenPocketWatch } from '../lib/golden-pocket-watch';

// Minimal fixtures -- only the fields rankGoldenPocketWatch actually reads (technical_state) plus
// symbol/side for asserting identity/order, cast to DashboardRow[] the same way
// tests/watchlist-sort.test.ts does for sortRows.
function row(
  symbol: string,
  technicalState: Partial<DashboardRow['technical_state']>,
  side: DashboardRow['side'] = 'long',
): Pick<DashboardRow, 'symbol' | 'side' | 'technical_state'> {
  return { symbol, side, technical_state: technicalState };
}

function goldenPocket(distance: number, lower = 100, upper = 110) {
  return {
    distance_to_golden_pocket_pct: distance,
    golden_pocket_lower: lower,
    golden_pocket_upper: upper,
  };
}

describe('rankGoldenPocketWatch', () => {
  it('sorts kept rows by absolute distance ascending, regardless of sign or input order', () => {
    const longRows = [
      row('FAR_ABOVE', goldenPocket(9.5)),
      row('NEAR_BELOW', goldenPocket(-1.2)),
      row('MID_ABOVE', goldenPocket(4.0)),
    ] as DashboardRow[];

    const { ranked } = rankGoldenPocketWatch(longRows, []);

    expect(ranked.map((item) => item.row.symbol)).toEqual(['NEAR_BELOW', 'MID_ABOVE', 'FAR_ABOVE']);
  });

  it('excludes rows with a null/undefined distance or either zone bound null, keeping the rest', () => {
    const longRows = [
      row('OK', goldenPocket(2.5)),
      row('NULL_DISTANCE', {
        distance_to_golden_pocket_pct: null,
        golden_pocket_lower: 100,
        golden_pocket_upper: 110,
      }),
      row('UNDEFINED_DISTANCE', { golden_pocket_lower: 100, golden_pocket_upper: 110 }),
      row('NULL_LOWER', {
        distance_to_golden_pocket_pct: 1.0,
        golden_pocket_lower: null,
        golden_pocket_upper: 110,
      }),
      row('NULL_UPPER', {
        distance_to_golden_pocket_pct: 1.0,
        golden_pocket_lower: 100,
        golden_pocket_upper: null,
      }),
    ] as DashboardRow[];

    const { ranked } = rankGoldenPocketWatch(longRows, []);

    expect(ranked.map((item) => item.row.symbol)).toEqual(['OK']);
  });

  it('keeps a row at exactly 0 distance rather than treating it as falsy/missing', () => {
    const longRows = [
      row('AT_ZERO', goldenPocket(0)),
      row('FAR', goldenPocket(3.0)),
    ] as DashboardRow[];

    const { ranked } = rankGoldenPocketWatch(longRows, []);

    expect(ranked.map((item) => item.row.symbol)).toEqual(['AT_ZERO', 'FAR']);
    expect(ranked[0]?.distance).toBe(0);
  });

  it('reports total as every long+short row before filtering, and kept as only the eligible ones', () => {
    const longRows = [
      row('KEPT_1', goldenPocket(1.0)),
      row('DROPPED_1', {
        distance_to_golden_pocket_pct: null,
        golden_pocket_lower: 100,
        golden_pocket_upper: 110,
      }),
    ] as DashboardRow[];
    const shortRows = [
      row('KEPT_2', goldenPocket(-2.0), 'short'),
      row('DROPPED_2', { golden_pocket_lower: null, golden_pocket_upper: null }, 'short'),
      row('DROPPED_3', { golden_pocket_lower: null, golden_pocket_upper: null }, 'short'),
    ] as DashboardRow[];

    const { ranked, total } = rankGoldenPocketWatch(longRows, shortRows);

    expect(total).toBe(5);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((item) => item.row.symbol).sort()).toEqual(['KEPT_1', 'KEPT_2']);
  });

  it("returns an empty ranked list (the data condition behind the card's empty state) when nothing has a golden pocket", () => {
    const longRows = [
      row('A', {
        distance_to_golden_pocket_pct: null,
        golden_pocket_lower: null,
        golden_pocket_upper: null,
      }),
    ] as DashboardRow[];
    const shortRows = [
      row(
        'B',
        {
          distance_to_golden_pocket_pct: null,
          golden_pocket_lower: null,
          golden_pocket_upper: null,
        },
        'short',
      ),
    ] as DashboardRow[];

    const { ranked, total } = rankGoldenPocketWatch(longRows, shortRows);

    expect(ranked).toEqual([]);
    expect(total).toBe(2);
  });

  it('handles no watchlist rows at all', () => {
    expect(rankGoldenPocketWatch([], [])).toEqual({ ranked: [], total: 0 });
  });
});

describe('formatGoldenPocketDistance', () => {
  it('renders exactly 0 as the IN THE ZONE emphasis state', () => {
    expect(formatGoldenPocketDistance(0)).toBe('IN THE ZONE');
  });

  it('renders a positive distance as "above" with 2 decimal places, unsigned', () => {
    expect(formatGoldenPocketDistance(3.456)).toBe('3.46% above');
  });

  it('renders a negative distance as "below" with 2 decimal places, unsigned', () => {
    expect(formatGoldenPocketDistance(-1.2)).toBe('1.20% below');
  });
});
