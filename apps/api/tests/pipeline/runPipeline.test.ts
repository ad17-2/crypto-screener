import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import type { EnrichmentCacheBlob } from '../../src/db/enrichmentCache.js';
import { loadEnrichmentCache, saveEnrichmentCache } from '../../src/db/enrichmentCache.js';
import { FOUR_H_MS, fourHourBarStartMs } from '../../src/pipeline/fourHourBar.js';
import type { DeepSeekClient } from '../../src/providers/deepseek.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

const {
  collectMarketMock,
  scoreSnapshotMock,
  saveSnapshotMock,
  writeReportsMock,
  updateRunContextMock,
} = vi.hoisted(() => ({
  collectMarketMock: vi.fn(),
  scoreSnapshotMock: vi.fn(),
  saveSnapshotMock: vi.fn(),
  writeReportsMock: vi.fn(),
  updateRunContextMock: vi.fn(),
}));

// db/index.js's read-path functions are left real, only saveSnapshot/updateRunContext are stubbed
// -- with storage_path=":memory:" below they run against a genuine, freshly-empty in-memory db.
vi.mock('../../src/pipeline/collector.js', () => ({ collectMarket: collectMarketMock }));
vi.mock('../../src/pipeline/factors.js', () => ({ scoreSnapshot: scoreSnapshotMock }));
vi.mock('../../src/reports/writeReports.js', () => ({ writeReports: writeReportsMock }));
vi.mock('../../src/db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/index.js')>();
  return { ...actual, saveSnapshot: saveSnapshotMock, updateRunContext: updateRunContextMock };
});

const { runPipeline } = await import('../../src/pipeline/runPipeline.js');

// Blank the briefing activation switch for EVERY test in this file: attachBriefing constructs a
// real DeepSeekHttpClient whenever no client is injected AND the env key is present, so an ambient
// DEEPSEEK_API_KEY (dev laptop, CI sharing deploy secrets) would turn these unit tests into live
// paid API calls. Tests that want the live-key path must stub the env themselves.
beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runPipeline', () => {
  it('save=true + writeReportFiles=false calls saveSnapshot once and skips writeReports', async () => {
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    const collected = {
      rows: [{ symbol: 'BTC' }],
      market_context: { btc_dominance_pct: 55 },
      provider_status: { coinglass: { status: 'ok' } },
    };
    // market_context omitted here on purpose: exercises the fallback to collected.market_context.
    const scored = {
      rows: [{ symbol: 'BTC', scores: {}, factors: {} }],
      regime: { bias: 'risk-on' },
    };

    collectMarketMock.mockResolvedValueOnce(collected);
    scoreSnapshotMock.mockReturnValueOnce(scored);

    const { payload, paths } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: true,
      writeReportFiles: false,
    });

    expect(payload.rows).toEqual(scored.rows);
    expect(payload.market_context).toEqual(collected.market_context);
    expect(paths).toEqual({});
    expect(saveSnapshotMock).toHaveBeenCalledOnce();
    expect(writeReportsMock).not.toHaveBeenCalled();
  });
});

describe('runPipeline screener sector rotation wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // screener_sectors is now computed inside scoreSnapshot itself (pipeline/factors.ts, see
  // factors.test.ts for that wiring), since it needs residual_change_24h_pct before breadth is
  // scored. This module mocks scoreSnapshot entirely, so runPipeline's remaining, still-real
  // responsibility is only to strip the raw screener_sector_members plumbing off whatever
  // market_context scoreSnapshot returns -- exercised here by having the mock return a
  // market_context shaped like the real scoreSnapshot's (both the raw map and the computed result
  // present), matching production where the map survives on enrichedContext via its initial spread.
  it('strips the collector-stashed member map from market_context, preserving what scoreSnapshot computed', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const config = AppConfigSchema.parse({
      storage_path: ':memory:',
      providers: { coingecko: { sector_min_members: 2 } },
    });
    collectMarketMock.mockResolvedValueOnce({
      rows: [{ symbol: 'BTC' }, { symbol: 'ETH' }],
      market_context: { screener_sector_members: { 'Layer 1': ['BTC', 'ETH'] } },
      provider_status: {},
    });
    scoreSnapshotMock.mockReturnValueOnce({
      rows: [
        { symbol: 'BTC', scores: {}, factors: {}, residual_change_24h_pct: 2 },
        { symbol: 'ETH', scores: {}, factors: {}, residual_change_24h_pct: 6 },
      ],
      market_context: {
        screener_sector_members: { 'Layer 1': ['BTC', 'ETH'] },
        // median([2, 6]) = 4.
        screener_sectors: [{ sector: 'Layer 1', median_residual_change_24h_pct: 4, n: 2 }],
      },
      regime: {},
    });

    const { payload } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: false,
      writeReportFiles: false,
    });

    expect(payload.market_context.screener_sectors).toEqual([
      { sector: 'Layer 1', median_residual_change_24h_pct: 4, n: 2 },
    ]);
    expect(payload.market_context).not.toHaveProperty('screener_sector_members');
  });

  it('leaves screener_sectors absent (not an empty array) when the collector-stashed member map is empty', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    collectMarketMock.mockResolvedValueOnce({
      rows: [{ symbol: 'BTC' }],
      market_context: { screener_sector_members: {} },
      provider_status: {},
    });
    scoreSnapshotMock.mockReturnValueOnce({
      rows: [{ symbol: 'BTC', scores: {}, factors: {}, residual_change_24h_pct: 2 }],
      regime: {},
    });

    const { payload } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: false,
      writeReportFiles: false,
    });

    expect(payload.market_context).not.toHaveProperty('screener_sectors');
    expect(payload.market_context).not.toHaveProperty('screener_sector_members');
  });
});

describe('runPipeline deepseek briefing wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function baseCollected() {
    return {
      rows: [{ symbol: 'BTC' }],
      market_context: { btc_dominance_pct: 55 },
      provider_status: { coinglass: { status: 'ok' } },
    };
  }

  function baseScored() {
    return { rows: [{ symbol: 'BTC', scores: {}, factors: {} }], regime: { bias: 'risk-on' } };
  }

  it('DEEPSEEK_API_KEY missing -> provider_status.deepseek disabled, no market_context.briefing', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());

    const { payload } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: false,
      writeReportFiles: false,
    });

    expect(payload.provider_status.deepseek).toEqual({
      status: 'disabled',
      note: 'DEEPSEEK_API_KEY not set',
    });
    expect(payload.market_context.briefing).toBeUndefined();
  });

  it('config.providers.deepseek.enabled=false -> provider_status.deepseek disabled with no note', async () => {
    const config = AppConfigSchema.parse({
      storage_path: ':memory:',
      providers: { deepseek: { enabled: false } },
    });
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());

    const { payload } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: false,
      writeReportFiles: false,
    });

    expect(payload.provider_status.deepseek).toEqual({ status: 'disabled' });
    expect(payload.market_context.briefing).toBeUndefined();
  });

  it('a throwing client is caught: provider_status.deepseek reports error and the refresh still completes', async () => {
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());
    const deepseekClient: DeepSeekClient = {
      complete: vi.fn().mockRejectedValue(new Error('DeepSeek unreachable')),
    };

    const { payload } = await runPipeline(
      config,
      '/tmp/crypto-screener-unused-out-dir',
      { save: false, writeReportFiles: false },
      { deepseekClient },
    );

    expect(payload.provider_status.deepseek).toEqual({
      status: 'error',
      errors: ['DeepSeek unreachable'],
    });
    expect(payload.market_context.briefing).toBeUndefined();
  });

  it('a succeeding client leaves the briefing on market_context and reports status=ok', async () => {
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());
    const deepseekClient: DeepSeekClient = {
      complete: vi.fn().mockResolvedValue({
        text: 'Tonight the tape is quiet.',
        model: 'deepseek-v4-pro',
        output_tokens: 100,
        reasoning_tokens: 40,
      }),
    };

    const { payload } = await runPipeline(
      config,
      '/tmp/crypto-screener-unused-out-dir',
      { save: false, writeReportFiles: false },
      { deepseekClient },
    );

    expect(payload.market_context.briefing).toMatchObject({
      text: 'Tonight the tape is quiet.',
      model: 'deepseek-v4-pro',
      output_tokens: 100,
      reasoning_tokens: 40,
    });
    expect(payload.provider_status.deepseek).toMatchObject({ status: 'ok' });
  });
});

describe('runPipeline macro reaction wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stamps btc_change_since_print_pct onto a recent macro event, visible to the briefing payload too', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    // 7 bars, 4h apart, ending "now" -- closes step +5 each bar so the math is exact.
    const bars = Array.from({ length: 7 }, (_, index) => ({
      time: now - (24 - index * 4) * HOUR_MS,
      close: 100 + index * 5,
    }));
    const eventTimeUtc = new Date(now - 5 * HOUR_MS).toISOString(); // between the -8h and -4h bars

    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    collectMarketMock.mockResolvedValueOnce({
      rows: [{ symbol: 'BTC' }],
      market_context: { macro_events: [{ title: 'CPI m/m', time_utc: eventTimeUtc }] },
      provider_status: {},
    });
    scoreSnapshotMock.mockReturnValueOnce({
      rows: [{ symbol: 'BTC', scores: {}, factors: {}, price_history_bars: bars }],
      regime: {},
    });

    const { payload } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: false,
      writeReportFiles: false,
    });

    const events = payload.market_context.macro_events as Array<Record<string, unknown>>;
    // (125 -> 130) / 125 * 100 = 4.
    expect(events[0]?.btc_change_since_print_pct).toBe(4);
  });

  it('runs before attachBriefing, so the DeepSeek payload sees the enriched value too', async () => {
    const HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    const bars = Array.from({ length: 7 }, (_, index) => ({
      time: now - (24 - index * 4) * HOUR_MS,
      close: 100 + index * 5,
    }));
    const eventTimeUtc = new Date(now - 5 * HOUR_MS).toISOString();

    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    collectMarketMock.mockResolvedValueOnce({
      rows: [{ symbol: 'BTC' }],
      market_context: { macro_events: [{ title: 'CPI m/m', time_utc: eventTimeUtc }] },
      provider_status: {},
    });
    scoreSnapshotMock.mockReturnValueOnce({
      rows: [{ symbol: 'BTC', scores: {}, factors: {}, price_history_bars: bars }],
      regime: {},
    });
    const complete = vi.fn().mockResolvedValue({
      text: 'Tonight the tape is quiet.',
      model: 'deepseek-v4-pro',
      output_tokens: 100,
      reasoning_tokens: 40,
    });
    const deepseekClient: DeepSeekClient = { complete };

    await runPipeline(
      config,
      '/tmp/crypto-screener-unused-out-dir',
      { save: false, writeReportFiles: false },
      { deepseekClient },
    );

    expect(complete).toHaveBeenCalledOnce();
    const userPrompt = complete.mock.calls[0]?.[1] as string;
    const sentPayload = JSON.parse(userPrompt) as {
      macro_events: Array<{ btc_change_since_print_pct: number | null }>;
    };
    expect(sentPayload.macro_events[0]?.btc_change_since_print_pct).toBe(4);
  });
});

describe('runPipeline price_history_bars stripping', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('strips price_history_bars before saveSnapshot, after both consumers (annotateMacroReactions, attachBriefing) have already run', async () => {
    const HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    const bars = Array.from({ length: 7 }, (_, index) => ({
      time: now - (24 - index * 4) * HOUR_MS,
      close: 100 + index * 5,
    }));
    const eventTimeUtc = new Date(now - 5 * HOUR_MS).toISOString();

    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    // This file's saveSnapshotMock is a shared, module-level mock with no global clearMocks config
    // -- reset its call history so `toHaveBeenCalledOnce` below reflects only this test's call, not
    // an earlier save:true test's call earlier in the file.
    saveSnapshotMock.mockClear();
    collectMarketMock.mockResolvedValueOnce({
      rows: [{ symbol: 'BTC' }],
      market_context: { macro_events: [{ title: 'CPI m/m', time_utc: eventTimeUtc }] },
      provider_status: {},
    });
    scoreSnapshotMock.mockReturnValueOnce({
      rows: [{ symbol: 'BTC', scores: {}, factors: {}, price_history_bars: bars }],
      regime: {},
    });
    const deepseekClient: DeepSeekClient = {
      complete: vi.fn().mockResolvedValue({
        text: 'Tonight the tape is quiet.',
        model: 'deepseek-v4-pro',
        output_tokens: 100,
        reasoning_tokens: 40,
      }),
    };

    const { payload } = await runPipeline(
      config,
      '/tmp/crypto-screener-unused-out-dir',
      { save: true, writeReportFiles: false },
      { deepseekClient },
    );

    // Consumption already happened before the strip: the macro event's BTC reaction, computed off
    // price_history_bars, is still on the saved payload.
    const events = payload.market_context.macro_events as Array<Record<string, unknown>>;
    expect(events[0]?.btc_change_since_print_pct).toBe(4);

    expect(saveSnapshotMock).toHaveBeenCalledOnce();
    const savedPayload = saveSnapshotMock.mock.calls[0]?.[1] as {
      rows: Array<Record<string, unknown>>;
    };
    expect(savedPayload.rows[0]).not.toHaveProperty('price_history_bars');
    // The rest of the row survives the strip untouched.
    expect(savedPayload.rows[0]?.symbol).toBe('BTC');
  });
});

describe('runPipeline commits before generating the briefing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function baseCollected() {
    return {
      rows: [{ symbol: 'BTC' }],
      market_context: { btc_dominance_pct: 55 },
      provider_status: { coinglass: { status: 'ok' } },
    };
  }

  function baseScored() {
    return { rows: [{ symbol: 'BTC', scores: {}, factors: {} }], regime: { bias: 'risk-on' } };
  }

  it('runs saveSnapshot, then the briefing client, then updateRunContext, in that order', async () => {
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    saveSnapshotMock.mockClear();
    updateRunContextMock.mockClear();
    const order: string[] = [];
    saveSnapshotMock.mockImplementationOnce(() => {
      order.push('save');
    });
    updateRunContextMock.mockImplementationOnce(() => {
      order.push('update');
    });
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());
    const deepseekClient: DeepSeekClient = {
      complete: vi.fn().mockImplementation(async () => {
        order.push('briefing');
        return {
          text: 'Tonight the tape is quiet.',
          model: 'deepseek-v4-pro',
          output_tokens: 100,
          reasoning_tokens: 40,
        };
      }),
    };

    await runPipeline(
      config,
      '/tmp/crypto-screener-unused-out-dir',
      { save: true, writeReportFiles: false },
      { deepseekClient },
    );

    expect(order).toEqual(['save', 'briefing', 'update']);
  });

  it('sets provider_status.deepseek to pending on the row saveSnapshot commits, before the briefing runs', async () => {
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    saveSnapshotMock.mockClear();
    updateRunContextMock.mockClear();
    // payload is one mutable object shared across the whole pipeline -- inspecting
    // saveSnapshotMock.mock.calls AFTER runPipeline resolves would see attachBriefing's later
    // mutations too, so this snapshots provider_status (deep clone) at the moment saveSnapshot is
    // actually called, which is the only way to observe what the commit itself saw.
    let providerStatusAtSaveTime: Record<string, unknown> | undefined;
    saveSnapshotMock.mockImplementationOnce((_db: unknown, payload: unknown) => {
      providerStatusAtSaveTime = JSON.parse(
        JSON.stringify((payload as { provider_status: Record<string, unknown> }).provider_status),
      ) as Record<string, unknown>;
    });
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());
    const deepseekClient: DeepSeekClient = {
      complete: vi.fn().mockResolvedValue({
        text: 'Tonight the tape is quiet.',
        model: 'deepseek-v4-pro',
        output_tokens: 100,
        reasoning_tokens: 40,
      }),
    };

    await runPipeline(
      config,
      '/tmp/crypto-screener-unused-out-dir',
      { save: true, writeReportFiles: false },
      { deepseekClient },
    );

    expect(saveSnapshotMock).toHaveBeenCalledOnce();
    expect(providerStatusAtSaveTime?.deepseek).toEqual({
      status: 'pending',
      note: 'briefing generates after publish',
    });
  });

  it('after resolving, updateRunContext receives the finished briefing, a non-pending status, and timings.briefing_ms', async () => {
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    saveSnapshotMock.mockClear();
    updateRunContextMock.mockClear();
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());
    const deepseekClient: DeepSeekClient = {
      complete: vi.fn().mockResolvedValue({
        text: 'Tonight the tape is quiet.',
        model: 'deepseek-v4-pro',
        output_tokens: 100,
        reasoning_tokens: 40,
      }),
    };

    const { payload } = await runPipeline(
      config,
      '/tmp/crypto-screener-unused-out-dir',
      { save: true, writeReportFiles: false },
      { deepseekClient },
    );

    expect(updateRunContextMock).toHaveBeenCalledOnce();
    const [, , contextArg, providerStatusArg] = updateRunContextMock.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(contextArg.briefing).toMatchObject({ text: 'Tonight the tape is quiet.' });
    const deepseekStatus = providerStatusArg.deepseek as { status: string };
    expect(deepseekStatus.status).not.toBe('pending');
    expect(deepseekStatus.status).toBe('ok');
    const timings = providerStatusArg.timings as { briefing_ms?: number };
    expect(timings.briefing_ms).toBeGreaterThanOrEqual(0);
    // The resolved payload (used for report files/the caller) carries the same finished state.
    expect(payload.provider_status.deepseek).toMatchObject({ status: 'ok' });
  });

  it('when no briefing will run (no client, no API key), no pending status is ever written, and the final commit matches today', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    saveSnapshotMock.mockClear();
    updateRunContextMock.mockClear();
    // Same snapshot-at-call-time reasoning as the 'pending' test above: attachBriefing mutates the
    // same payload object again after saveSnapshot runs, so this must be captured synchronously
    // inside the mock, not read back off .mock.calls after runPipeline resolves.
    let providerStatusAtSaveTime: Record<string, unknown> | undefined;
    saveSnapshotMock.mockImplementationOnce((_db: unknown, payload: unknown) => {
      providerStatusAtSaveTime = JSON.parse(
        JSON.stringify((payload as { provider_status: Record<string, unknown> }).provider_status),
      ) as Record<string, unknown>;
    });
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());

    await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: true,
      writeReportFiles: false,
    });

    expect(providerStatusAtSaveTime).not.toHaveProperty('deepseek');

    expect(updateRunContextMock).toHaveBeenCalledOnce();
    const providerStatusArg = updateRunContextMock.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(providerStatusArg.deepseek).toEqual({
      status: 'disabled',
      note: 'DEEPSEEK_API_KEY not set',
    });
  });
});

describe('runPipeline provider_status.timings', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets numeric collect_ms/score_ms/save_ms/total_ms after a run', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    collectMarketMock.mockResolvedValueOnce({
      rows: [{ symbol: 'BTC' }],
      market_context: { btc_dominance_pct: 55 },
      provider_status: { coinglass: { status: 'ok' } },
    });
    scoreSnapshotMock.mockReturnValueOnce({
      rows: [{ symbol: 'BTC', scores: {}, factors: {} }],
      regime: { bias: 'risk-on' },
    });

    const { payload } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: false,
      writeReportFiles: false,
    });

    const timings = payload.provider_status.timings as Record<string, unknown>;
    expect(typeof timings.collect_ms).toBe('number');
    expect(typeof timings.score_ms).toBe('number');
    expect(typeof timings.save_ms).toBe('number');
    expect(typeof timings.total_ms).toBe('number');
  });
});

describe('runPipeline light/full mode decision', () => {
  // File-based, not ':memory:' -- the mode decision reads back a cache written by a SEPARATE
  // openDatabase() call than runPipeline's own, so the two need to share a real file on disk (an
  // in-memory sqlite connection isn't visible outside the connection that created it).
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    ({ dir, dbPath, db } = setupTempDb('crypto-screener-runpipeline-mode-'));
    vi.stubEnv('DEEPSEEK_API_KEY', '');
  });

  afterEach(() => {
    teardownTempDb(dir, db);
    vi.unstubAllEnvs();
  });

  function baseCollected() {
    return {
      rows: [{ symbol: 'BTC' }],
      market_context: { btc_dominance_pct: 55 },
      provider_status: { coinglass: { status: 'ok' } },
    };
  }

  function baseScored() {
    return { rows: [{ symbol: 'BTC', scores: {}, factors: {} }], regime: { bias: 'risk-on' } };
  }

  interface EnrichmentCacheDepsArg {
    mode: 'light' | 'full';
    barTsMs: number;
    cachedRows: Record<string, Record<string, unknown>> | null;
    save?: (blob: EnrichmentCacheBlob) => void;
  }

  async function runAndCaptureDeps(
    options: { mode?: 'light' | 'full' } = {},
  ): Promise<EnrichmentCacheDepsArg> {
    const config = AppConfigSchema.parse({ storage_path: dbPath });
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());

    await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: false,
      writeReportFiles: false,
      ...options,
    });

    const deps = collectMarketMock.mock.calls.at(-1)?.[1] as {
      enrichmentCache: EnrichmentCacheDepsArg;
    };
    return deps.enrichmentCache;
  }

  it('decides light when a cache exists for the current 4h bar', async () => {
    const barTsMs = fourHourBarStartMs(Date.now());
    saveEnrichmentCache(db, barTsMs, { rows: { BTC: { rsi_14: 55 } } });

    const enrichmentCache = await runAndCaptureDeps();

    expect(enrichmentCache.mode).toBe('light');
    expect(enrichmentCache.barTsMs).toBe(barTsMs);
    expect(enrichmentCache.cachedRows).toEqual({ BTC: { rsi_14: 55 } });
  });

  it('decides full when the cache is for a stale (prior) 4h bar', async () => {
    const staleBarTsMs = fourHourBarStartMs(Date.now()) - FOUR_H_MS;
    saveEnrichmentCache(db, staleBarTsMs, { rows: { BTC: { rsi_14: 55 } } });

    const enrichmentCache = await runAndCaptureDeps();

    expect(enrichmentCache.mode).toBe('full');
    expect(enrichmentCache.cachedRows).toBeNull();
  });

  it('decides full when no cache has ever been saved', async () => {
    const enrichmentCache = await runAndCaptureDeps();

    expect(enrichmentCache.mode).toBe('full');
    expect(enrichmentCache.cachedRows).toBeNull();
  });

  it('an explicit mode="full" override always wins, even over a fresh cache', async () => {
    const barTsMs = fourHourBarStartMs(Date.now());
    saveEnrichmentCache(db, barTsMs, { rows: { BTC: { rsi_14: 55 } } });

    const enrichmentCache = await runAndCaptureDeps({ mode: 'full' });

    expect(enrichmentCache.mode).toBe('full');
  });

  it('an explicit mode="light" override with a fresh cache is honored', async () => {
    const barTsMs = fourHourBarStartMs(Date.now());
    saveEnrichmentCache(db, barTsMs, { rows: { BTC: { rsi_14: 55 } } });

    const enrichmentCache = await runAndCaptureDeps({ mode: 'light' });

    expect(enrichmentCache.mode).toBe('light');
  });

  it('an explicit mode="light" override with no usable cache degrades to full', async () => {
    const enrichmentCache = await runAndCaptureDeps({ mode: 'light' });

    expect(enrichmentCache.mode).toBe('full');
    expect(enrichmentCache.cachedRows).toBeNull();
  });
});

describe('runPipeline enrichment cache save gating', () => {
  // File-based, same reasoning as the mode-decision describe above: loadEnrichmentCache(db) must
  // read back whatever the pipeline's own db connection wrote.
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    ({ dir, dbPath, db } = setupTempDb('crypto-screener-runpipeline-cache-save-'));
    vi.stubEnv('DEEPSEEK_API_KEY', '');
  });

  afterEach(() => {
    teardownTempDb(dir, db);
    vi.unstubAllEnvs();
  });

  function baseCollected() {
    return {
      rows: [{ symbol: 'BTC' }],
      market_context: { btc_dominance_pct: 55 },
      provider_status: { coinglass: { status: 'ok' } },
    };
  }

  function baseScored() {
    return { rows: [{ symbol: 'BTC', scores: {}, factors: {} }], regime: { bias: 'risk-on' } };
  }

  async function runAndCaptureEnrichmentCacheDeps(
    save: boolean,
  ): Promise<{ barTsMs: number; save?: (blob: EnrichmentCacheBlob) => void }> {
    const config = AppConfigSchema.parse({ storage_path: dbPath });
    collectMarketMock.mockResolvedValueOnce(baseCollected());
    scoreSnapshotMock.mockReturnValueOnce(baseScored());

    await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save,
      writeReportFiles: false,
    });

    const deps = collectMarketMock.mock.calls.at(-1)?.[1] as {
      enrichmentCache: { barTsMs: number; save?: (blob: EnrichmentCacheBlob) => void };
    };
    return deps.enrichmentCache;
  }

  it('a save:false run wires enrichmentCache.save as undefined, leaving the cache table untouched', async () => {
    const enrichmentCache = await runAndCaptureEnrichmentCacheDeps(false);

    expect(enrichmentCache.save).toBeUndefined();

    // Simulate what a real full-run harvest would do if the closure WERE present (it isn't, per the
    // assertion above): this is what proves a save:false dry run can never leave a cache row behind,
    // rather than merely observing that collectMarket (mocked in this file) never called it itself.
    enrichmentCache.save?.({ rows: { BTC: { rsi_14: 55 } } });
    expect(loadEnrichmentCache(db)).toBeNull();
  });

  it('a save:true run captures a working save closure, correctly bound to the run db and barTsMs', async () => {
    // The closure must be invoked WHILE runPipeline is still running (as a real collectMarket would
    // do, mid-harvest) rather than after runPipeline resolves: runPipeline opens its own db
    // connection and closes it in a `finally` block once the function returns, so calling the
    // closure afterward would hit an already-closed connection.
    const config = AppConfigSchema.parse({ storage_path: dbPath });
    const blob: EnrichmentCacheBlob = { rows: { ETH: { rsi_14: 42 } } };
    let capturedBarTsMs: number | undefined;
    collectMarketMock.mockImplementationOnce(
      async (
        _config: unknown,
        deps: { enrichmentCache?: { barTsMs: number; save?: (blob: EnrichmentCacheBlob) => void } },
      ) => {
        capturedBarTsMs = deps.enrichmentCache?.barTsMs;
        expect(deps.enrichmentCache?.save).toBeDefined();
        deps.enrichmentCache?.save?.(blob);
        return baseCollected();
      },
    );
    scoreSnapshotMock.mockReturnValueOnce(baseScored());

    await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: true,
      writeReportFiles: false,
    });

    expect(loadEnrichmentCache(db)).toEqual({ barTsMs: capturedBarTsMs, blob });
  });
});
