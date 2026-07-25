import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchlistDiff } from '../../src/dashboard/runDiff.js';
import { formatJakartaIso } from '../../src/db/time.js';
import {
  BRIEFING_FALLBACK_SYSTEM_PROMPT,
  BRIEFING_MAX_TOOL_ITERATIONS,
  BRIEFING_SYSTEM_PROMPT,
  BRIEFING_TOOL_BUDGET_MS,
  buildBriefingPayload,
  createBriefingToolExecutor,
  generateBriefing,
} from '../../src/pipeline/briefing.js';
import type { Row } from '../../src/pipeline/types.js';
import type {
  DeepSeekClient,
  DeepSeekCompletion,
  DeepSeekToolOptions,
} from '../../src/providers/deepseek.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

// See providers/deepseekTools.test.ts's precedent: an ambient DEEPSEEK_API_KEY (dev laptop, CI
// sharing deploy secrets) must never let a test in this file fall through to a real, paid fetch.
// Every client below is a hand-built fake, but this stub is defense in depth against that ever
// changing.
beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

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
    expect(payload.new_to_list_total).toBe(0);
  });

  it('new_to_list_total counts every new-to-list row across the whole run, not just the top-5-per-side slice', () => {
    const rows: Row[] = Array.from({ length: 8 }, (_, i) =>
      row({ symbol: `SYM${i}`, watchlist_side: 'long', watchlist_rank: i + 1 }),
    );
    // SYM0 is new and ranks into the top-5 slice topCandidates keeps; SYM6/SYM7 are new too but
    // rank outside it -- the bug this fix addresses is exactly this gap between what the model sees
    // per-row and the true global count.
    const diff: WatchlistDiff = {
      newToList: new Set(['SYM0', 'SYM6', 'SYM7']),
      changes: null,
    };

    const payload = buildBriefingPayload(rows, diff, {}, {}, '2026-07-19T00:00:00+07:00');

    expect(payload.long.map((r) => r.symbol)).toEqual(['SYM0', 'SYM1', 'SYM2', 'SYM3', 'SYM4']);
    expect(payload.long.filter((r) => r.new_to_list).map((r) => r.symbol)).toEqual(['SYM0']);
    expect(payload.new_to_list_total).toBe(3);
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

      expect(payload.macro_events).toEqual([
        { title: 'CPI m/m', in_hours: 47.5, btc_change_since_print_pct: null },
      ]);
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

      expect(payload.macro_events).toEqual([
        { title: 'CPI y/y', in_hours: -11.5, btc_change_since_print_pct: null },
      ]);
    });

    it('carries btc_change_since_print_pct through when pipeline/macroReaction.ts already stamped it', () => {
      const payload = buildBriefingPayload(
        [],
        EMPTY_DIFF,
        macroContext([
          {
            title: 'CPI y/y',
            time_utc: '2026-07-18T12:30:00.000Z',
            btc_change_since_print_pct: -1.23,
          },
        ]),
        {},
        NOW,
      );

      expect(payload.macro_events).toEqual([
        { title: 'CPI y/y', in_hours: -11.5, btc_change_since_print_pct: -1.23 },
      ]);
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
      tool_calls: null,
      used_tools: false,
      tool_error: null,
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

  it('with no toolContext, issues exactly one complete call with two arguments -- backward compat', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: 'Quiet night.',
      model: 'deepseek-v4-pro',
      output_tokens: 10,
      reasoning_tokens: 2,
    } satisfies DeepSeekCompletion);
    const client: DeepSeekClient = { complete };
    const payload = buildBriefingPayload([], EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    const briefing = await generateBriefing(client, payload, '2026-07-19T00:00:00+07:00');

    expect(briefing.text).toBe('Quiet night.');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]).toHaveLength(2);
    // No toolContext at all -- distinct from a tool loop that ran and threw (used_tools is false
    // in both cases, but this one has no tool_error since nothing was attempted).
    expect(briefing.used_tools).toBe(false);
    expect(briefing.tool_calls).toBeNull();
    expect(briefing.tool_error).toBeNull();
  });
});

describe('BRIEFING_SYSTEM_PROMPT', () => {
  it('makes the base-rate call unconditional, not gated behind an assertion the 6-sentence format discourages', () => {
    // A prior version only required calling get_outcome_base_rate "before asserting a tendency" --
    // a fully compliant briefing never asserts one, so a compliant model made zero tool calls. This
    // string assertion fails loudly if that conditional phrasing ever comes back.
    expect(BRIEFING_SYSTEM_PROMPT).toContain(
      "you must call get_outcome_base_rate for that candidate's technical_setup",
    );
  });

  it('states the round budget and requires convergence to finished text on the final round', () => {
    // The 2026-07-25 incident run exhausted 3 iterations without ever producing text -- the model
    // kept requesting tools instead of converging. These assertions fail loudly if the convergence
    // instruction, or its wiring to the real iteration ceiling, ever regresses.
    expect(BRIEFING_SYSTEM_PROMPT).toContain(
      `You have at most ${BRIEFING_MAX_TOOL_ITERATIONS} rounds of tool calls`,
    );
    expect(BRIEFING_SYSTEM_PROMPT).toContain(
      'on your final round you must return the finished briefing text instead of more tool calls',
    );
  });

  it('instructs the lead-sentence / candidate-line / closing-sentence shape, without reintroducing bullets', () => {
    expect(BRIEFING_SYSTEM_PROMPT).toContain(
      'Write your answer as three blocks separated by exactly one blank line',
    );
    expect(BRIEFING_SYSTEM_PROMPT).toContain(
      'per named candidate -- ticker, one space, "long" or "short", then " — "',
    );
    expect(BRIEFING_SYSTEM_PROMPT).toContain(
      'the line-per-candidate shape replaces bullets, it must not reintroduce them',
    );
  });
});

describe('BRIEFING_MAX_TOOL_ITERATIONS', () => {
  it('is 5, raised from the 3 that let the 2026-07-25 incident run exhaust its budget without converging', () => {
    expect(BRIEFING_MAX_TOOL_ITERATIONS).toBe(5);
  });
});

describe('BRIEFING_FALLBACK_SYSTEM_PROMPT', () => {
  it('never mentions get_outcome_base_rate -- the fallback call has no tools to call it with', () => {
    expect(BRIEFING_FALLBACK_SYSTEM_PROMPT).not.toContain('get_outcome_base_rate');
  });

  it('explicitly prohibits claiming to have consulted, called, or looked anything up', () => {
    // This is the fix for the 2026-07-25 incident: the fallback prompt inherited the tool-enabled
    // prompt's mandatory base-rate call, had no tool to satisfy it with, and invented a
    // get_outcome_base_rate result instead. This string assertion fails loudly if a future edit
    // reverts to the shared prompt or drops this prohibition.
    expect(BRIEFING_FALLBACK_SYSTEM_PROMPT).toContain('You have no tools this run');
    expect(BRIEFING_FALLBACK_SYSTEM_PROMPT).toContain(
      'you must not claim to have consulted, called, queried, or looked up anything',
    );
  });

  it('carries the identical lead-sentence / candidate-line / closing-sentence shape instruction as the tool-enabled prompt', () => {
    expect(BRIEFING_FALLBACK_SYSTEM_PROMPT).toContain(
      'Write your answer as three blocks separated by exactly one blank line',
    );
    expect(BRIEFING_FALLBACK_SYSTEM_PROMPT).toContain(
      'per named candidate -- ticker, one space, "long" or "short", then " — "',
    );
  });
});

describe('generateBriefing with a toolContext', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    ({ dir, db } = setupTempDb('crypto-screener-briefing-tools-'));
  });

  afterEach(() => {
    teardownTempDb(dir, db);
  });

  it('falls back to the plain single-shot call when the tool-loop call rejects, and returns its text', async () => {
    let capturedOptions: DeepSeekToolOptions | undefined;
    const complete = vi.fn(
      async (
        _system: string,
        _user: string,
        options?: DeepSeekToolOptions,
      ): Promise<DeepSeekCompletion> => {
        if (options) {
          capturedOptions = options;
          throw new Error('tool calling not supported by this deployment');
        }
        return {
          text: 'Fallback read: nothing worth trading tonight.',
          model: 'deepseek-v4-pro',
          output_tokens: 42,
          reasoning_tokens: 10,
        };
      },
    );
    const client: DeepSeekClient = { complete };
    const payload = buildBriefingPayload([], EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    const briefing = await generateBriefing(client, payload, '2026-07-19T00:00:00+07:00', {
      db,
      rows: [{ symbol: 'AAA', watchlist_side: 'long', watchlist_rank: 1 }],
      newToList: new Set(),
    });

    expect(briefing.text).toBe('Fallback read: nothing worth trading tonight.');
    expect(complete).toHaveBeenCalledTimes(2);
    // First attempt is the tool loop (3-arg call with options); second is the plain fallback.
    expect(complete.mock.calls[0]).toHaveLength(3);
    expect(complete.mock.calls[1]).toHaveLength(2);

    // The regression this fix closes: the fallback call has no tools, so it must NOT receive the
    // tool-enabled prompt that mandates a get_outcome_base_rate call -- that mandate is exactly
    // what made the model invent a tool result in the 2026-07-25 incident run. Proven red by
    // temporarily reverting this line to BRIEFING_SYSTEM_PROMPT: the equality assertion failed
    // ("expected 'You write ...you must call get_outcome_base_rate...' to be 'You write ...You
    // have no tools this run...'"), and the not.toBe assertion below failed too. Restored here.
    const fallbackSystemPrompt = complete.mock.calls[1]?.[0];
    expect(fallbackSystemPrompt).toBe(BRIEFING_FALLBACK_SYSTEM_PROMPT);
    expect(fallbackSystemPrompt).not.toBe(BRIEFING_SYSTEM_PROMPT);

    // The fallback path must be observable and distinguishable from a tool loop that genuinely ran
    // and made 0 calls: used_tools is false, tool_calls is null (not 0), and the reason the loop
    // threw is captured rather than silently discarded.
    expect(briefing.used_tools).toBe(false);
    expect(briefing.tool_calls).toBeNull();
    expect(briefing.tool_error).toBe('tool calling not supported by this deployment');

    // The assertions above only prove *some* truthy options object was passed as the third
    // argument -- they'd still pass if generateBriefing sent `tools: []` (wire-identical to no
    // tools) or bound execute to the wrong context. Inspect the actual options.
    expect(capturedOptions).toBeDefined();
    const options = capturedOptions as DeepSeekToolOptions;
    expect(options.tools.length).toBeGreaterThan(0);
    expect(options.tools.map((tool) => tool.name).sort()).toEqual(
      ['get_outcome_base_rate', 'get_row', 'list_rows'].sort(),
    );
    for (const tool of options.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.parameters).toBe('object');
      expect(tool.parameters).not.toBeNull();
    }
    expect(options.maxIterations).toBe(BRIEFING_MAX_TOOL_ITERATIONS);
    expect(options.budgetMs).toBe(BRIEFING_TOOL_BUDGET_MS);

    // Prove execute is bound to the toolContext passed into generateBriefing above (symbol 'AAA'
    // in ctx.rows), not an empty or default context.
    const rowRaw = await options.execute({
      name: 'get_row',
      argumentsJson: JSON.stringify({ symbol: 'AAA' }),
    });
    expect(JSON.parse(rowRaw).symbol).toBe('AAA');
  });

  it('tool path where the model executes two tool calls -- used_tools true, tool_calls counts real invocations', async () => {
    const complete = vi.fn(
      async (
        _system: string,
        _user: string,
        options?: DeepSeekToolOptions,
      ): Promise<DeepSeekCompletion> => {
        if (!options) {
          throw new Error('expected the tool-loop call, not the fallback');
        }
        await options.execute({
          name: 'get_row',
          argumentsJson: JSON.stringify({ symbol: 'AAA' }),
        });
        await options.execute({
          name: 'get_outcome_base_rate',
          argumentsJson: JSON.stringify({ group_by: 'technical_setup', horizon_hours: 24 }),
        });
        return {
          text: 'AAA is a breakout_up setup with a 60% live win rate on n=5.',
          model: 'deepseek-v4-pro',
          output_tokens: 50,
          reasoning_tokens: 20,
        };
      },
    );
    const client: DeepSeekClient = { complete };
    const payload = buildBriefingPayload([], EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    const briefing = await generateBriefing(client, payload, '2026-07-19T00:00:00+07:00', {
      db,
      rows: [{ symbol: 'AAA', watchlist_side: 'long', watchlist_rank: 1 }],
      newToList: new Set(),
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(briefing.used_tools).toBe(true);
    expect(briefing.tool_calls).toBe(2);
    expect(briefing.tool_error).toBeNull();
  });

  it('tool path where the model calls nothing -- used_tools true, tool_calls 0, distinguishable from a fallback', async () => {
    // This is the previously-undiagnosable case: a compliant tool loop that simply chose not to
    // call anything produced byte-identical output to a tool loop that threw and fell back.
    const complete = vi.fn(
      async (
        _system: string,
        _user: string,
        options?: DeepSeekToolOptions,
      ): Promise<DeepSeekCompletion> => {
        if (!options) {
          throw new Error('expected the tool-loop call, not the fallback');
        }
        return {
          text: 'Nothing worth trading tonight.',
          model: 'deepseek-v4-pro',
          output_tokens: 30,
          reasoning_tokens: 5,
        };
      },
    );
    const client: DeepSeekClient = { complete };
    const payload = buildBriefingPayload([], EMPTY_DIFF, {}, {}, '2026-07-19T00:00:00+07:00');

    const briefing = await generateBriefing(client, payload, '2026-07-19T00:00:00+07:00', {
      db,
      rows: [],
      newToList: new Set(),
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(briefing.used_tools).toBe(true);
    expect(briefing.tool_calls).toBe(0);
    expect(briefing.tool_error).toBeNull();
  });
});

describe('createBriefingToolExecutor', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    ({ dir, db } = setupTempDb('crypto-screener-briefing-executor-'));
  });

  afterEach(() => {
    teardownTempDb(dir, db);
  });

  function toolRow(symbol: string, side: 'long' | 'short', rank: number): Row {
    return { symbol, watchlist_side: side, watchlist_rank: rank };
  }

  function seedOutcomeRow(params: {
    runId: string;
    symbol: string;
    fwdReturnPct: number;
    metrics: Record<string, unknown>;
  }): void {
    const generatedAt = formatJakartaIso(new Date('2026-01-01T00:00:00.000Z'));
    db.prepare(
      `INSERT INTO factor_history (run_id, generated_at, symbol, price_usd, factors_json, scores_json, metrics_json)
       VALUES (?, ?, ?, 100, '{}', '{}', ?)`,
    ).run(params.runId, generatedAt, params.symbol, JSON.stringify(params.metrics));
    db.prepare(
      `INSERT INTO outcome_labels
          (run_id, generated_at, symbol, horizon_hours, fwd_return_pct, fwd_residual_pct,
           btc_fwd_return_pct, beta_used, matched_run_id, matched_delta_hours)
       VALUES (?, ?, ?, 24, ?, NULL, NULL, NULL, ?, 24)`,
    ).run(params.runId, generatedAt, params.symbol, params.fwdReturnPct, params.runId);
  }

  describe('get_outcome_base_rate', () => {
    it('returns real aggregates from the seeded temp DB, excluding a backfill-* row', async () => {
      seedOutcomeRow({
        runId: 'live-1',
        symbol: 'AAA',
        fwdReturnPct: 5,
        metrics: { technical_setup: 'breakout_up' },
      });
      seedOutcomeRow({
        runId: 'backfill-xyz',
        symbol: 'AAA',
        fwdReturnPct: 999,
        metrics: { technical_setup: 'breakout_up' },
      });
      const executor = createBriefingToolExecutor({ db, rows: [], newToList: new Set() });

      const raw = await executor({
        name: 'get_outcome_base_rate',
        argumentsJson: JSON.stringify({ group_by: 'technical_setup', horizon_hours: 24 }),
      });
      const result = JSON.parse(raw);

      expect(result.live_era_only).toBe(true);
      expect(result.cells).toHaveLength(1);
      expect(result.cells[0]).toMatchObject({
        key: 'breakout_up',
        n: 1,
        mean_fwd_return_pct: 5,
      });
    });
  });

  describe('never throws', () => {
    it('returns a JSON error string for malformed argumentsJson', async () => {
      const executor = createBriefingToolExecutor({ db, rows: [], newToList: new Set() });

      const raw = await executor({ name: 'get_row', argumentsJson: '{not valid json' });

      expect(JSON.parse(raw)).toHaveProperty('error');
    });

    it('returns a JSON error string for an unknown tool name', async () => {
      const executor = createBriefingToolExecutor({ db, rows: [], newToList: new Set() });

      const raw = await executor({ name: 'not_a_real_tool', argumentsJson: '{}' });

      expect(JSON.parse(raw)).toHaveProperty('error');
    });

    it('returns a JSON error string for an out-of-range group_by', async () => {
      const executor = createBriefingToolExecutor({ db, rows: [], newToList: new Set() });

      const raw = await executor({
        name: 'get_outcome_base_rate',
        argumentsJson: JSON.stringify({ group_by: 'not_a_real_group', horizon_hours: 24 }),
      });

      expect(JSON.parse(raw)).toHaveProperty('error');
    });
  });

  describe('list_rows', () => {
    it('respects the side filter, sorts by watchlist_rank ascending, and caps at 25', async () => {
      const longRows = Array.from({ length: 30 }, (_, i) => toolRow(`L${i}`, 'long', i + 1));
      const shortRows = [toolRow('S1', 'short', 1)];
      const executor = createBriefingToolExecutor({
        db,
        rows: [...longRows, ...shortRows],
        newToList: new Set(),
      });

      const raw = await executor({
        name: 'list_rows',
        argumentsJson: JSON.stringify({ side: 'long', limit: 100 }),
      });
      const result = JSON.parse(raw) as Array<{ symbol: string; side: string }>;

      expect(result).toHaveLength(25);
      expect(result.every((row) => row.side === 'long')).toBe(true);
      expect(result.map((row) => row.symbol)).toEqual(
        Array.from({ length: 25 }, (_, i) => `L${i}`),
      );
    });

    it('computes new_to_list from ctx.newToList, not a hardcoded false', async () => {
      const executor = createBriefingToolExecutor({
        db,
        rows: [toolRow('FRESH', 'long', 1), toolRow('OLD', 'long', 2)],
        newToList: new Set(['FRESH']),
      });

      const raw = await executor({
        name: 'list_rows',
        argumentsJson: JSON.stringify({ side: 'long', limit: 25 }),
      });
      const result = JSON.parse(raw) as Array<{ symbol: string; new_to_list: boolean }>;

      expect(result.find((row) => row.symbol === 'FRESH')?.new_to_list).toBe(true);
      expect(result.find((row) => row.symbol === 'OLD')?.new_to_list).toBe(false);
    });
  });

  describe('get_row', () => {
    it('returns {"error":"unknown symbol"} for a symbol not in ctx.rows', async () => {
      const executor = createBriefingToolExecutor({
        db,
        rows: [toolRow('AAA', 'long', 1)],
        newToList: new Set(),
      });

      const raw = await executor({
        name: 'get_row',
        argumentsJson: JSON.stringify({ symbol: 'ZZZ' }),
      });

      expect(raw).toBe(JSON.stringify({ error: 'unknown symbol' }));
    });

    it('computes new_to_list from ctx.newToList, not a hardcoded false', async () => {
      const executor = createBriefingToolExecutor({
        db,
        rows: [toolRow('FRESH', 'long', 1), toolRow('OLD', 'long', 2)],
        newToList: new Set(['FRESH']),
      });

      const freshRaw = await executor({
        name: 'get_row',
        argumentsJson: JSON.stringify({ symbol: 'FRESH' }),
      });
      const oldRaw = await executor({
        name: 'get_row',
        argumentsJson: JSON.stringify({ symbol: 'OLD' }),
      });

      expect(JSON.parse(freshRaw).new_to_list).toBe(true);
      expect(JSON.parse(oldRaw).new_to_list).toBe(false);
    });
  });
});
