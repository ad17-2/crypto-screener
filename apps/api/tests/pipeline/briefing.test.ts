import { describe, expect, it, vi } from 'vitest';
import type { WatchlistDiff } from '../../src/dashboard/runDiff.js';
import { buildBriefingPayload, generateBriefing } from '../../src/pipeline/briefing.js';
import type { Row } from '../../src/pipeline/types.js';
import type { DeepSeekClient, DeepSeekCompletion } from '../../src/providers/deepseek.js';

const EMPTY_DIFF: WatchlistDiff = { newToList: new Set(), changes: null };

function row(overrides: Partial<Row> & { symbol: string }): Row {
  return {
    watchlist_side: 'long',
    watchlist_rank: 1,
    price_usd: 1.23,
    price_change_24h_pct: 4.5,
    trend_state: 'uptrend',
    setup_confidence: 'A',
    distance_to_golden_pocket_pct: 2.1,
    fib_leg_direction: 'up',
    fights_btc: null,
    ...overrides,
  };
}

describe('buildBriefingPayload', () => {
  it('reads only the allowlisted fields per candidate row -- no extra keys leak in', () => {
    const rows: Row[] = [
      row({
        symbol: 'ABC',
        watchlist_side: 'long',
        watchlist_rank: 1,
        // Fields NOT on the allowlist -- must never appear in the payload.
        funding_rate_pct: 0.01,
        open_interest_usd: 999,
        factors: { momentum: 1 },
      }),
    ];

    const payload = buildBriefingPayload(rows, EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    expect(payload.long).toHaveLength(1);
    expect(Object.keys(payload.long[0] as object).sort()).toEqual(
      [
        'symbol',
        'rank',
        'side',
        'price_usd',
        'price_change_24h_pct',
        'trend_state',
        'setup_confidence',
        'distance_to_golden_pocket_pct',
        'fib_leg_direction',
        'new_to_list',
        'fights_btc',
      ].sort(),
    );
    expect(payload.long[0]).toEqual({
      symbol: 'ABC',
      rank: 1,
      side: 'long',
      price_usd: 1.23,
      price_change_24h_pct: 4.5,
      trend_state: 'uptrend',
      setup_confidence: 'A',
      distance_to_golden_pocket_pct: 2.1,
      fib_leg_direction: 'up',
      new_to_list: false,
      fights_btc: null,
    });
  });

  it('caps each directional list at 5 candidates, keeping the lowest watchlist_rank first', () => {
    const rows: Row[] = Array.from({ length: 8 }, (_, i) =>
      row({ symbol: `SYM${i}`, watchlist_side: 'long', watchlist_rank: 8 - i }),
    );

    const payload = buildBriefingPayload(rows, EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    expect(payload.long).toHaveLength(5);
    expect(payload.long.map((r) => r.symbol)).toEqual(['SYM7', 'SYM6', 'SYM5', 'SYM4', 'SYM3']);
  });

  it('marks new_to_list from the watchlist diff, and surfaces departures when present', () => {
    const rows: Row[] = [row({ symbol: 'FRESH', watchlist_side: 'long', watchlist_rank: 1 })];
    const diff: WatchlistDiff = {
      newToList: new Set(['FRESH']),
      changes: { baseline_run_id: 'run-1', departed_long: ['OLD'], departed_short: [] },
    };

    const payload = buildBriefingPayload(rows, diff, {}, {}, '2026-07-19T00:00:00+07:00');

    expect(payload.long[0]?.new_to_list).toBe(true);
    expect(payload.watchlist_departures).toEqual({
      baseline_run_id: 'run-1',
      departed_long: ['OLD'],
      departed_short: [],
    });
  });

  it('returns an empty long/short shape and null departures when nothing qualifies', () => {
    const payload = buildBriefingPayload([], EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    expect(payload.long).toEqual([]);
    expect(payload.short).toEqual([]);
    expect(payload.watchlist_departures).toBeNull();
  });

  it('reads regime.regime_state/bias and fear_greed value+classification defensively', () => {
    const payload = buildBriefingPayload(
      [],
      EMPTY_DIFF,
      { fear_greed_value: 22, fear_greed_classification: 'Extreme Fear' },
      { regime_state: 'trending', bias: 'risk-off' },
      '2026-07-19T00:00:00+07:00',
    );

    expect(payload.regime).toEqual({ state: 'trending', bias: 'risk-off' });
    expect(payload.fear_greed).toEqual({ value: 22, classification: 'Extreme Fear' });
  });

  it('falls back to regime.label when regime_state is absent', () => {
    const payload = buildBriefingPayload(
      [],
      EMPTY_DIFF,
      {},
      { label: 'legacy-label' },
      '2026-07-19T00:00:00+07:00',
    );

    expect(payload.regime.state).toBe('legacy-label');
  });

  it('reads btc_change_24h_pct off the BTC row when present', () => {
    const rows: Row[] = [
      row({ symbol: 'BTC', watchlist_side: undefined, price_change_24h_pct: 3.3 }),
    ];

    const payload = buildBriefingPayload(rows, EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    expect(payload.btc_change_24h_pct).toBe(3.3);
  });

  it('falls back to market_context.btc_price_change_24h_pct when no BTC row is present', () => {
    const payload = buildBriefingPayload(
      [],
      EMPTY_DIFF,
      { btc_price_change_24h_pct: -1.7 },
      {},
      '2026-07-19T00:00:00+07:00',
    );

    expect(payload.btc_change_24h_pct).toBe(-1.7);
  });

  describe('macro_events window + in_hours math', () => {
    const NOW = '2026-07-19T00:00:00.000Z';

    function macroContext(events: Array<Record<string, unknown>>) {
      return { macro_events: events };
    }

    it('includes an event 47.5h in the future, rounded to 1dp', () => {
      const payload = buildBriefingPayload(
        [],
        EMPTY_DIFF,
        macroContext([{ title: 'CPI m/m', time_utc: '2026-07-20T23:30:00.000Z' }]),
        {},
        NOW,
      );

      expect(payload.macro_events).toEqual([{ title: 'CPI m/m', in_hours: 47.5 }]);
    });

    it('excludes an event 49h in the future (past the 48h lookahead)', () => {
      const payload = buildBriefingPayload(
        [],
        EMPTY_DIFF,
        macroContext([{ title: 'Later', time_utc: '2026-07-21T01:00:00.000Z' }]),
        {},
        NOW,
      );

      expect(payload.macro_events).toEqual([]);
    });

    it('includes an event that printed 11.5h ago as a negative in_hours', () => {
      const payload = buildBriefingPayload(
        [],
        EMPTY_DIFF,
        macroContext([{ title: 'CPI y/y', time_utc: '2026-07-18T12:30:00.000Z' }]),
        {},
        NOW,
      );

      expect(payload.macro_events).toEqual([{ title: 'CPI y/y', in_hours: -11.5 }]);
    });

    it('excludes an event that printed 13h ago (past the 12h lookback)', () => {
      const payload = buildBriefingPayload(
        [],
        EMPTY_DIFF,
        macroContext([{ title: 'Earlier', time_utc: '2026-07-18T11:00:00.000Z' }]),
        {},
        NOW,
      );

      expect(payload.macro_events).toEqual([]);
    });

    it('drops an event missing a title or an unparseable time_utc', () => {
      const payload = buildBriefingPayload(
        [],
        EMPTY_DIFF,
        macroContext([
          { time_utc: '2026-07-19T01:00:00.000Z' },
          { title: 'Bad time', time_utc: 'not-a-date' },
        ]),
        {},
        NOW,
      );

      expect(payload.macro_events).toEqual([]);
    });
  });
});

describe('generateBriefing', () => {
  function fakeClient(completion: DeepSeekCompletion): DeepSeekClient {
    return { complete: vi.fn().mockResolvedValue(completion) };
  }

  it('trims whitespace off the completion text and stamps generated_at from nowIso', async () => {
    const client = fakeClient({
      text: '  Tonight the tape is quiet.  ',
      model: 'deepseek-v4-pro',
      output_tokens: 100,
      reasoning_tokens: 80,
    });
    const payload = buildBriefingPayload([], EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    const briefing = await generateBriefing(client, payload, '2026-07-19T00:00:00+07:00');

    expect(briefing).toEqual({
      text: 'Tonight the tape is quiet.',
      model: 'deepseek-v4-pro',
      generated_at: '2026-07-19T00:00:00+07:00',
      output_tokens: 100,
      reasoning_tokens: 80,
    });
  });

  it('rejects when the completion text is empty after trimming', async () => {
    const client = fakeClient({
      text: '   ',
      model: 'deepseek-v4-pro',
      output_tokens: null,
      reasoning_tokens: null,
    });
    const payload = buildBriefingPayload([], EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    await expect(generateBriefing(client, payload, '2026-07-19T00:00:00+07:00')).rejects.toThrow();
  });
});
