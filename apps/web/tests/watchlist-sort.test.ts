import type { DashboardRow } from '@crypto-screener/contracts';
import { describe, expect, it } from 'vitest';
import { defaultSortDirection, sortRows } from '../lib/watchlist-sort';

// Minimal fixtures -- only the fields sortRows actually reads. The array order below stands in
// for the API's own row order (residual momentum + vetoes), which 'rank' must preserve untouched.
function row(
  symbol: string,
  priceChange: number,
): Pick<DashboardRow, 'symbol' | 'price_change_24h_pct'> {
  return { symbol, price_change_24h_pct: priceChange };
}

describe("'rank' sort key", () => {
  it('is the default sort direction (asc)', () => {
    expect(defaultSortDirection('rank')).toBe('asc');
  });

  it('preserves the API row order untouched, regardless of the 24h price column', () => {
    // Deliberately NOT sorted by price -- if sortRows silently fell back to a field sort, this
    // would come back price-descending (ETH, SOL, BTC) instead of the given order.
    const rows = [row('BTC', -5), row('ETH', 10), row('SOL', 2)] as DashboardRow[];
    expect(sortRows(rows, 'rank', 'asc').map((r) => r.symbol)).toEqual(['BTC', 'ETH', 'SOL']);
  });

  it('ignores direction -- there is no clickable Rank header to reverse it from', () => {
    const rows = [row('BTC', -5), row('ETH', 10), row('SOL', 2)] as DashboardRow[];
    expect(sortRows(rows, 'rank', 'desc').map((r) => r.symbol)).toEqual(['BTC', 'ETH', 'SOL']);
  });

  it('treats no sort key the same way, preserving row order (the pre-existing null behavior)', () => {
    const rows = [row('BTC', -5), row('ETH', 10), row('SOL', 2)] as DashboardRow[];
    expect(sortRows(rows, null, 'desc').map((r) => r.symbol)).toEqual(['BTC', 'ETH', 'SOL']);
  });
});

describe('other sort keys still re-sort on their own field (unchanged by the rank default)', () => {
  it("'price' still sorts by 24h change, independent of the given row order", () => {
    const rows = [row('BTC', -5), row('ETH', 10), row('SOL', 2)] as DashboardRow[];
    expect(sortRows(rows, 'price', 'desc').map((r) => r.symbol)).toEqual(['ETH', 'SOL', 'BTC']);
  });
});
