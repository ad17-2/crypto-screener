/**
 * Bounding-box shape needed to decide whether the detail rail should be scrolled into view --
 * matches the subset of DOMRect that Element.getBoundingClientRect() returns. Kept as a plain
 * interface (rather than importing DOMRect) so this stays pure and unit-testable: DOMRect isn't
 * constructible outside a DOM environment, and this repo's tsconfig (`jsx: "preserve"`) means
 * WatchlistWorkbench.tsx itself can't be imported by vitest -- see
 * apps/web/tests/detail-rail-visibility.test.ts.
 */
export interface ElementViewportRect {
  top: number;
  bottom: number;
  height: number;
}

// Below this fraction of its own height showing inside the viewport, a partially visible rail
// still counts as "off-screen" and gets scrolled into view -- a sliver poking above/below the fold
// isn't enough feedback that the selection actually changed. High enough that a rail with only a
// few px clipped stays "visible" (no yank out from under someone reading it).
const SUBSTANTIALLY_VISIBLE_FRACTION = 0.6;

/**
 * Given the rail's viewport-relative rect (as returned by getBoundingClientRect()) and the
 * current viewport height, decide whether selecting a new coin should scroll the rail into view.
 * Fully or substantially visible -> false (do nothing). Mostly or fully off-screen, above or
 * below -> true.
 */
export function shouldScrollRailIntoView(
  rail: ElementViewportRect,
  viewportHeight: number,
): boolean {
  if (viewportHeight <= 0 || rail.height <= 0) return false;
  const visibleTop = Math.max(rail.top, 0);
  const visibleBottom = Math.min(rail.bottom, viewportHeight);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const visibleFraction = visibleHeight / rail.height;
  return visibleFraction < SUBSTANTIALLY_VISIBLE_FRACTION;
}
