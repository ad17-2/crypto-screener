import { describe, expect, it } from 'vitest';
import { dismissGuidePatch, guideDismissed } from '../lib/guide';

describe('guideDismissed', () => {
  it('is false for an empty prefs blob (first visit)', () => {
    expect(guideDismissed({})).toBe(false);
  });

  it('is false for an unrelated or corrupt prefs blob', () => {
    expect(guideDismissed({ sortKey: 'rank' })).toBe(false);
    expect(guideDismissed({ guideDismissed: 'yes' })).toBe(false);
    expect(guideDismissed({ guideDismissed: 0 })).toBe(false);
  });

  it('is true once the dismiss patch has been merged in', () => {
    expect(guideDismissed({ ...dismissGuidePatch() })).toBe(true);
  });
});

describe('dismissGuidePatch', () => {
  it('is a patch writePrefs can merge without clobbering unrelated keys', () => {
    const existing = { sortKey: 'rank', sortDir: 'asc' };
    const merged = { ...existing, ...dismissGuidePatch() };
    expect(merged).toEqual({ sortKey: 'rank', sortDir: 'asc', guideDismissed: true });
  });
});
