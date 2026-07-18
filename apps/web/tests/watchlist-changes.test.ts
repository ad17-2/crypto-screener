import { describe, expect, it } from 'vitest';
import { departedSymbols, departureLineText } from '../lib/watchlist-changes';
import { NO_LEAKED_VALUES } from './noLeakedValues';

const CHANGES = {
  baseline_run_id: 'run-1',
  departed_long: ['BTC', 'ETH'],
  departed_short: ['SOL'],
};

describe('departedSymbols', () => {
  it('reads departed_long for the long tab', () => {
    expect(departedSymbols(CHANGES, 'long')).toEqual(['BTC', 'ETH']);
  });

  it('reads departed_short for the short tab', () => {
    expect(departedSymbols(CHANGES, 'short')).toEqual(['SOL']);
  });

  it('returns an empty list for a non-directional tab (chart_next, crowded_longs, squeeze_risks, core)', () => {
    expect(departedSymbols(CHANGES, 'chart_next')).toEqual([]);
    expect(departedSymbols(CHANGES, 'crowded_longs')).toEqual([]);
    expect(departedSymbols(CHANGES, 'squeeze_risks')).toEqual([]);
    expect(departedSymbols(CHANGES, 'core')).toEqual([]);
  });

  it('returns an empty list when changes is null (no baseline this cycle)', () => {
    expect(departedSymbols(null, 'long')).toEqual([]);
  });

  it('returns an empty list when changes is undefined (old payload, field absent)', () => {
    expect(departedSymbols(undefined, 'long')).toEqual([]);
  });
});

describe('departureLineText', () => {
  it('builds the departure line for the long tab', () => {
    expect(departureLineText(CHANGES, 'long')).toBe(
      'Left this list since the previous run: BTC, ETH',
    );
  });

  it('builds the departure line for the short tab', () => {
    expect(departureLineText(CHANGES, 'short')).toBe('Left this list since the previous run: SOL');
  });

  it('returns null when the side has no departures', () => {
    const noDepartures = { baseline_run_id: 'run-1', departed_long: [], departed_short: [] };
    expect(departureLineText(noDepartures, 'long')).toBeNull();
  });

  it('returns null when changes is null', () => {
    expect(departureLineText(null, 'long')).toBeNull();
  });

  it('returns null when changes is undefined', () => {
    expect(departureLineText(undefined, 'short')).toBeNull();
  });

  it('returns null on a non-directional tab even when both sides have departures', () => {
    expect(departureLineText(CHANGES, 'chart_next')).toBeNull();
  });

  it('never leaks null/NaN/undefined into the rendered line', () => {
    const line = departureLineText(CHANGES, 'long');
    expect(line).not.toBeNull();
    expect(line as string).not.toMatch(NO_LEAKED_VALUES);
  });
});
