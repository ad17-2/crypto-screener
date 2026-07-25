import { describe, expect, it } from 'vitest';
import { FOUR_H_MS, fourHourBarStartMs } from '../../src/pipeline/fourHourBar.js';

describe('fourHourBarStartMs', () => {
  it('is a no-op on an exact bar edge', () => {
    const edge = 20 * FOUR_H_MS; // 2000-01-01T20:00:00.000Z-equivalent multiple of 4h since epoch
    expect(fourHourBarStartMs(edge)).toBe(edge);
  });

  it('floors to the same edge one ms after it', () => {
    const edge = 20 * FOUR_H_MS;
    expect(fourHourBarStartMs(edge + 1)).toBe(edge);
  });

  it('floors down to the PRIOR edge one ms before it', () => {
    const edge = 20 * FOUR_H_MS;
    expect(fourHourBarStartMs(edge - 1)).toBe(edge - FOUR_H_MS);
  });

  it('floors an arbitrary mid-bar timestamp to its containing 4h edge', () => {
    // 2026-07-25T13:47:22Z falls inside the 12:00-16:00 UTC bar.
    const nowMs = Date.UTC(2026, 6, 25, 13, 47, 22);
    const expected = Date.UTC(2026, 6, 25, 12, 0, 0);
    expect(fourHourBarStartMs(nowMs)).toBe(expected);
  });

  it('is UTC-aligned regardless of local offsets: 00:00:00 UTC is its own bar start', () => {
    const midnightUtc = Date.UTC(2026, 6, 25, 0, 0, 0);
    expect(fourHourBarStartMs(midnightUtc)).toBe(midnightUtc);
  });
});
