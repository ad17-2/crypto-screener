import type { DashboardRow } from '@crypto-screener/contracts';
import { fmtNum } from './format';

export interface RankedGoldenPocketRow {
  row: DashboardRow;
  distance: number;
  lower: number;
  upper: number;
}

/**
 * Filters long+short watchlist rows down to the ones with a computed 4h golden-pocket zone, then
 * sorts by proximity (|distance_to_golden_pocket_pct|) ascending -- nearest-to-trigger first.
 * Pure so GoldenPocketWatchStage's ranking/filtering is unit-testable directly: vitest's esbuild
 * transform can't parse a .tsx file's JSX under this repo's `jsx: "preserve"` tsconfig (see
 * apps/web/tests/golden-pocket-watch-stage.test.ts), so this logic lives here rather than inline
 * in the component, matching how watchlist-sort.ts/dashboard-row.ts/weekly-review.ts already split
 * testable logic out of their components.
 */
export function rankGoldenPocketWatch(
  longRows: DashboardRow[],
  shortRows: DashboardRow[],
): { ranked: RankedGoldenPocketRow[]; total: number } {
  const all = [...longRows, ...shortRows];
  const ranked: RankedGoldenPocketRow[] = [];
  for (const row of all) {
    const state = row.technical_state;
    const distance = state.distance_to_golden_pocket_pct;
    const lower = state.golden_pocket_lower;
    const upper = state.golden_pocket_upper;
    if (distance == null || lower == null || upper == null) continue;
    ranked.push({ row, distance, lower, upper });
  }
  ranked.sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance));
  return { ranked, total: all.length };
}

/**
 * distance is signed (apps/api/src/pipeline/technicals.ts goldenPocket()'s pctDistance call):
 * positive means price has already run above the zone's upper bound, negative means it's dropped
 * below the lower bound, 0 means price is inside the zone right now -- the highest-value signal
 * on this card.
 */
export function formatGoldenPocketDistance(distance: number): string {
  if (distance === 0) return 'IN THE ZONE';
  return `${fmtNum(Math.abs(distance), 2)}% ${distance > 0 ? 'above' : 'below'}`;
}
