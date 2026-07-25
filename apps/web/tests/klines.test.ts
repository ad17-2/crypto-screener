import type { DashboardRow } from '@crypto-screener/contracts';
import { describe, expect, it } from 'vitest';
import { parseKlinesResponse, selectChartLevels } from '../lib/klines';

describe('parseKlinesResponse', () => {
  it('passes through candles already in seconds (the shape GET /api/klines returns)', () => {
    const body = [
      { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
      { time: 1_752_638_400, open: 64200, high: 64700, low: 64100, close: 64600 },
    ];

    expect(parseKlinesResponse(body)).toEqual(body);
  });

  it('normalizes a millisecond-scale time down to seconds (defensive ms->s conversion)', () => {
    const body = [{ time: 1_752_624_000_000, open: 64000, high: 64500, low: 63800, close: 64200 }];

    expect(parseKlinesResponse(body)).toEqual([
      { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
    ]);
  });

  it('drops entries with a non-finite field instead of throwing', () => {
    const body = [
      { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
      { time: 1_752_638_400, open: 'nan', high: 64700, low: 64100, close: 64600 },
    ];

    expect(parseKlinesResponse(body)).toEqual([
      { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
    ]);
  });

  it('returns an empty array for a non-array body (e.g. an error payload)', () => {
    expect(parseKlinesResponse({ error: 'klines_unavailable' })).toEqual([]);
  });

  it('returns an empty array for an empty response', () => {
    expect(parseKlinesResponse([])).toEqual([]);
  });
});

function stateWith(
  overrides: Partial<DashboardRow['technical_state']>,
): DashboardRow['technical_state'] {
  return overrides;
}

describe('selectChartLevels', () => {
  it('skips every level that is null or absent rather than drawing a zero', () => {
    const result = selectChartLevels(stateWith({}));

    expect(result.lines).toEqual([]);
    expect(result.goldenPocket).toBeNull();
  });

  it('includes each EMA/Donchian level independently when present', () => {
    const result = selectChartLevels(
      stateWith({
        ema_20: 100,
        ema_50: 95,
        ema_200: 80,
        donchian_high_20: 110,
        donchian_low_20: 90,
      }),
    );

    expect(result.lines).toEqual([
      { id: 'ema20', label: 'EMA 20 (4h)', price: 100 },
      { id: 'ema50', label: 'EMA 50 (4h)', price: 95 },
      { id: 'ema200', label: 'EMA 200 (4h)', price: 80 },
      { id: 'donchian-high', label: 'Donchian 20 high (4h)', price: 110 },
      { id: 'donchian-low', label: 'Donchian 20 low (4h)', price: 90 },
    ]);
  });

  it('omits only the missing EMA/Donchian levels, keeping the rest', () => {
    const result = selectChartLevels(stateWith({ ema_50: 95, donchian_low_20: 90 }));

    expect(result.lines).toEqual([
      { id: 'ema50', label: 'EMA 50 (4h)', price: 95 },
      { id: 'donchian-low', label: 'Donchian 20 low (4h)', price: 90 },
    ]);
  });

  it('draws the golden pocket band only when both bounds are present', () => {
    const upperOnly = selectChartLevels(stateWith({ golden_pocket_upper: 105 }));
    const lowerOnly = selectChartLevels(stateWith({ golden_pocket_lower: 95 }));

    expect(upperOnly.goldenPocket).toBeNull();
    expect(lowerOnly.goldenPocket).toBeNull();
  });

  it('includes the golden pocket band when both bounds are present', () => {
    const result = selectChartLevels(
      stateWith({ golden_pocket_lower: 95, golden_pocket_upper: 105 }),
    );

    expect(result.goldenPocket).toEqual({ lower: 95, upper: 105 });
  });
});
