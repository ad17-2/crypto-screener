import { describe, expect, it } from 'vitest';
import { shouldScrollRailIntoView } from '../lib/detail-rail-visibility';

// Viewport stand-in for all cases below: 950px tall, matching the 1512x950 viewport the bug was
// measured at.
const VIEWPORT_HEIGHT = 950;

describe('shouldScrollRailIntoView', () => {
  it('does nothing when the rail is fully visible', () => {
    const rail = { top: 100, bottom: 500, height: 400 };
    expect(shouldScrollRailIntoView(rail, VIEWPORT_HEIGHT)).toBe(false);
  });

  it('scrolls when the rail is fully below the viewport', () => {
    // Matches the reported bug: rail top far past the viewport bottom.
    const rail = { top: 1124, bottom: 1906, height: 782 };
    expect(shouldScrollRailIntoView(rail, VIEWPORT_HEIGHT)).toBe(true);
  });

  it('scrolls when the rail is fully above the viewport', () => {
    const rail = { top: -900, bottom: -100, height: 800 };
    expect(shouldScrollRailIntoView(rail, VIEWPORT_HEIGHT)).toBe(true);
  });

  it('does nothing when partially visible but substantially so (>= 60% of its height showing)', () => {
    // height 800, only the bottom 100px clipped past the viewport -- 700/800 = 87.5% visible.
    const rail = { top: 150, bottom: 950 + 100, height: 800 };
    expect(shouldScrollRailIntoView(rail, VIEWPORT_HEIGHT)).toBe(false);
  });

  it('scrolls when partially visible but mostly off-screen (< 60% of its height showing)', () => {
    // height 800, only the top 200px poking above the viewport bottom -- 200/800 = 25% visible.
    const rail = { top: 750, bottom: 750 + 800, height: 800 };
    expect(shouldScrollRailIntoView(rail, VIEWPORT_HEIGHT)).toBe(true);
  });

  it('treats a zero-height rail (nothing rendered) as nothing to scroll to', () => {
    const rail = { top: 100, bottom: 100, height: 0 };
    expect(shouldScrollRailIntoView(rail, VIEWPORT_HEIGHT)).toBe(false);
  });

  it('is defensive against a zero viewport height', () => {
    const rail = { top: 0, bottom: 400, height: 400 };
    expect(shouldScrollRailIntoView(rail, 0)).toBe(false);
  });
});
