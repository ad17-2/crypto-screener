import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import type { DeepSeekClient } from '../../src/providers/deepseek.js';

const { collectMarketMock, scoreSnapshotMock, saveSnapshotMock, writeReportsMock } = vi.hoisted(
  () => ({
    collectMarketMock: vi.fn(),
    scoreSnapshotMock: vi.fn(),
    saveSnapshotMock: vi.fn(),
    writeReportsMock: vi.fn(),
  }),
);

// db/index.js's read-path functions are left real, only saveSnapshot is stubbed -- with
// storage_path=":memory:" below they run against a genuine, freshly-empty in-memory db.
vi.mock('../../src/pipeline/collector.js', () => ({ collectMarket: collectMarketMock }));
vi.mock('../../src/pipeline/factors.js', () => ({ scoreSnapshot: scoreSnapshotMock }));
vi.mock('../../src/reports/writeReports.js', () => ({ writeReports: writeReportsMock }));
vi.mock('../../src/db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/index.js')>();
  return { ...actual, saveSnapshot: saveSnapshotMock };
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
