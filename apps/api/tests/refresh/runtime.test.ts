import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import { formatJakartaIso } from '../../src/db/time.js';
import { RefreshRuntime } from '../../src/refresh/runtime.js';
import { hoursAgo, setupTempDb, teardownTempDb } from '../support/tempDb.js';

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  ({ dir, dbPath, db } = setupTempDb('crypto-screener-runtime-'));
  // Blank the DeepSeek activation switch for every test: attachWeeklyReview constructs a real
  // DeepSeekHttpClient whenever no client is injected AND the env key is present, so an ambient
  // DEEPSEEK_API_KEY (dev laptop, CI sharing deploy secrets) would turn these unit tests into live
  // paid API calls. Tests that want the narration path inject `deepseekClient` instead.
  vi.stubEnv('DEEPSEEK_API_KEY', '');
});

afterEach(() => {
  teardownTempDb(dir, db);
  vi.unstubAllEnvs();
});

function fakeConfig() {
  return AppConfigSchema.parse({ storage_path: dbPath });
}

describe('RefreshRuntime.refresh', () => {
  it('starts idle', () => {
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
    });
    expect(runtime.getStatus()).toEqual({ state: 'idle' });
  });

  it('calls run_pipeline with save=true, writeReportFiles=false, and records the outcome', async () => {
    const runPipeline = vi.fn().mockResolvedValue({
      payload: { run_id: 'run-refresh', generated_at: '2026-07-03T06:00:00+07:00' },
      paths: {},
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 1 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    const status = await runtime.refresh('test');

    expect(runPipeline).toHaveBeenCalledOnce();
    expect(runPipeline.mock.calls[0]?.[2]).toEqual({ save: true, writeReportFiles: false });
    expect(status).toMatchObject({
      state: 'ok',
      reason: 'test',
      run_id: 'run-refresh',
      generated_at: '2026-07-03T06:00:00+07:00',
      paths: {},
      // No runs exist yet in this fresh DB, so pruning 1 keeps 0 and deletes nothing.
      retention: { kept_runs: 0, deleted_runs: 0, deleted_rows: 0 },
    });
    expect(status.state === 'ok' && status.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(runtime.getStatus()).toEqual(status);
  });

  it('skips retention when retainRuns is 0', async () => {
    const runPipeline = vi.fn().mockResolvedValue({
      payload: { run_id: 'run-1', generated_at: '2026-07-03T06:00:00+07:00' },
      paths: {},
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    const status = await runtime.refresh('test');

    expect(status).toMatchObject({ state: 'ok', retention: null });
  });

  it('records a failed refresh as state=error without throwing', async () => {
    const runPipeline = vi.fn().mockRejectedValue(new Error('coinglass unreachable'));
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    const status = await runtime.refresh('auto');

    expect(status).toEqual({
      state: 'error',
      reason: 'auto',
      error: 'coinglass unreachable',
      finished_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/),
    });
  });

  it('a second refresh() while one is in flight does not call run_pipeline again', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const runPipeline = vi.fn().mockImplementation(async () => {
      await gate;
      return { payload: { run_id: 'run-1', generated_at: '2026-07-03T06:00:00+07:00' }, paths: {} };
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    const first = runtime.refresh('daily');
    // Busy flag is set synchronously before run_pipeline's first await, so this deterministically observes state=running.
    const second = await runtime.refresh('manual');

    expect(second).toMatchObject({ state: 'running', reason: 'daily' });
    expect(runPipeline).toHaveBeenCalledOnce();

    resolveFirst?.();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ state: 'ok', reason: 'daily' });
  });
});

describe('RefreshRuntime mode passthrough', () => {
  it('refresh() passes an explicit mode override through to runPipelineFn', async () => {
    const runPipeline = vi.fn().mockResolvedValue({
      payload: {
        run_id: 'run-mode',
        generated_at: '2026-07-03T06:00:00+07:00',
        provider_status: { refresh_mode: 'light' },
      },
      paths: {},
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    await runtime.refresh('test', 'light');

    expect(runPipeline.mock.calls[0]?.[2]).toEqual({
      save: true,
      writeReportFiles: false,
      mode: 'light',
    });
  });

  it('refresh() with no override passes mode: undefined, and the resolved status reflects what runPipeline actually did', async () => {
    const runPipeline = vi.fn().mockResolvedValue({
      payload: {
        run_id: 'run-full',
        generated_at: '2026-07-03T06:00:00+07:00',
        // Simulates a light override that degraded to full inside runPipeline (no usable cache).
        provider_status: { refresh_mode: 'full' },
      },
      paths: {},
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    const status = await runtime.refresh('test');

    expect(runPipeline.mock.calls[0]?.[2]).toEqual({ save: true, writeReportFiles: false });
    expect(status).toMatchObject({ state: 'ok', refresh_mode: 'full' });
  });

  it('refresh_mode is null on the ok status when provider_status never carried the field', async () => {
    const runPipeline = vi.fn().mockResolvedValue({
      payload: { run_id: 'run-none', generated_at: '2026-07-03T06:00:00+07:00' },
      paths: {},
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    const status = await runtime.refresh('test');

    expect(status).toMatchObject({ state: 'ok', refresh_mode: null });
  });

  it('refreshAsync() echoes the requested override (not yet a resolved mode) in its immediate result', () => {
    const runPipeline = vi.fn().mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves -- only the immediate return value is asserted */
        }),
    );
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    expect(runtime.refreshAsync('manual', 'light')).toEqual({
      state: 'queued',
      reason: 'manual',
      mode: 'light',
    });
    expect(runPipeline.mock.calls[0]?.[2]).toMatchObject({ mode: 'light' });
  });

  it('refreshAsync() with no override reports mode: null', () => {
    const runPipeline = vi.fn().mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves -- only the immediate return value is asserted */
        }),
    );
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    expect(runtime.refreshAsync('manual')).toEqual({
      state: 'queued',
      reason: 'manual',
      mode: null,
    });
  });
});

describe('RefreshRuntime.refresh post-save housekeeping (outcome labeling + weekly review)', () => {
  function insertFactorHistoryRow(
    runId: string,
    generatedAt: string,
    symbol: string,
    metrics: Record<string, unknown> = { is_trusted: true },
  ): void {
    db.prepare(
      `INSERT INTO factor_history (run_id, generated_at, symbol, price_usd, factors_json, scores_json, metrics_json)
       VALUES (?, ?, ?, 100, '{}', '{}', ?)`,
    ).run(runId, generatedAt, symbol, JSON.stringify(metrics));
  }

  function insertOutcomeLabelRow(runId: string, generatedAt: string, symbol: string): void {
    db.prepare(
      `INSERT INTO outcome_labels
          (run_id, generated_at, symbol, horizon_hours, fwd_return_pct, fwd_residual_pct,
           btc_fwd_return_pct, beta_used, matched_run_id, matched_delta_hours)
       VALUES (?, ?, ?, 24, 5, NULL, NULL, NULL, ?, 24)`,
    ).run(runId, generatedAt, symbol, runId);
  }

  function mockedRunPipeline(now: Date) {
    return vi.fn().mockResolvedValue({
      payload: { run_id: 'run-1', generated_at: formatJakartaIso(now) },
      paths: {},
    });
  }

  it('labels closed-but-unlabeled factor_history rows after a successful refresh, and notes the write count', async () => {
    const now = new Date();
    // 40h-old base row + its 24h-later forward match -- both already closed relative to `now`
    // (24h's tolerance band tops out at 36h).
    insertFactorHistoryRow('base', hoursAgo(now, 40), 'SYM');
    insertFactorHistoryRow('fwd', hoursAgo(now, 16), 'SYM');

    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline: mockedRunPipeline(now),
    });

    const status = await runtime.refresh('test');

    expect(status.state).toBe('ok');
    expect(status.state === 'ok' ? status.notes : []).toEqual(
      expect.arrayContaining([expect.stringMatching(/^outcome_labeling: wrote \d+ row\(s\)$/)]),
    );
    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM outcome_labels').get() as { count: number }
    ).count;
    expect(count).toBeGreaterThan(0);
  });

  it('does not label a closed row older than the 14-day auto floor', async () => {
    const now = new Date();
    // 15 days old, with a valid closed forward match at 24h -- old enough for the window to have
    // fully closed, but outside labelClosedWindows' AUTO_LABEL_WINDOW_DAYS (14) floor.
    insertFactorHistoryRow('old-base', hoursAgo(now, 15 * 24), 'SYM');
    insertFactorHistoryRow('old-fwd', hoursAgo(now, 14 * 24), 'SYM');

    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline: mockedRunPipeline(now),
    });

    const status = await runtime.refresh('test');

    expect(status.state).toBe('ok');
    const row = db.prepare('SELECT 1 FROM outcome_labels WHERE run_id = ?').get('old-base');
    expect(row).toBeUndefined();
  });

  it('produces no notes and no weekly_reviews row when nothing is labeled yet', async () => {
    const now = new Date();
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline: mockedRunPipeline(now),
    });

    const status = await runtime.refresh('test');

    expect(status.state === 'ok' ? status.notes : ['unexpected state']).toEqual([]);
    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM weekly_reviews').get() as { count: number }
    ).count;
    expect(count).toBe(0);
  });

  it('generates and narrates a weekly review once labeled rows exist and no prior review does, using the injected DeepSeek client', async () => {
    const now = new Date();
    insertFactorHistoryRow('lbl-run', hoursAgo(now, 40), 'SYM', {
      is_trusted: true,
      watchlist_side: 'long',
    });
    insertOutcomeLabelRow('lbl-run', hoursAgo(now, 40), 'SYM');

    const complete = vi.fn().mockResolvedValue({
      text: 'Long setups hit about half the time this week.',
      model: 'deepseek-v4-pro',
      output_tokens: 10,
      reasoning_tokens: 2,
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline: mockedRunPipeline(now),
      deepseekClient: { complete },
    });

    const status = await runtime.refresh('test');

    expect(complete).toHaveBeenCalledOnce();
    expect(status.state === 'ok' ? status.notes : []).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^weekly_review: generated \(n=1, narrated=true\)$/),
      ]),
    );

    const row = db.prepare('SELECT narrative, model FROM weekly_reviews').get() as {
      narrative: string | null;
      model: string | null;
    };
    expect(row.narrative).toBe('Long setups hit about half the time this week.');
    expect(row.model).toBe('deepseek-v4-pro');
  });

  it('still persists the computed metrics when narration fails -- narrative/model stay null, facts beat prose', async () => {
    const now = new Date();
    insertFactorHistoryRow('lbl-run', hoursAgo(now, 40), 'SYM');
    insertOutcomeLabelRow('lbl-run', hoursAgo(now, 40), 'SYM');

    const complete = vi.fn().mockRejectedValue(new Error('DeepSeek unreachable'));
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline: mockedRunPipeline(now),
      deepseekClient: { complete },
    });

    const status = await runtime.refresh('test');

    expect(status.state === 'ok' ? status.notes : []).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^weekly_review: generated \(n=1, narrated=false\)$/),
      ]),
    );

    const row = db.prepare('SELECT narrative, model, metrics_json FROM weekly_reviews').get() as {
      narrative: string | null;
      model: string | null;
      metrics_json: string;
    };
    expect(row.narrative).toBeNull();
    expect(row.model).toBeNull();
    expect(JSON.parse(row.metrics_json)).toMatchObject({ horizons: [24, 72] });
  });

  it('skips weekly review generation when the latest review is still within its 7-day window', async () => {
    const now = new Date();
    insertFactorHistoryRow('lbl-run', hoursAgo(now, 1), 'SYM');
    insertOutcomeLabelRow('lbl-run', hoursAgo(now, 1), 'SYM');
    db.prepare(
      `INSERT INTO weekly_reviews (generated_at, week_start, week_end, metrics_json, narrative, model)
       VALUES (?, ?, ?, '{}', 'stale-but-fresh', NULL)`,
    ).run(hoursAgo(now, 24), hoursAgo(now, 192), hoursAgo(now, 24));

    const complete = vi.fn();
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline: mockedRunPipeline(now),
      deepseekClient: { complete },
    });

    const status = await runtime.refresh('test');

    expect(complete).not.toHaveBeenCalled();
    expect(status.state === 'ok' ? status.notes : ['unexpected state']).toEqual([]);
    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM weekly_reviews').get() as { count: number }
    ).count;
    expect(count).toBe(1); // still just the pre-seeded row -- no second one generated
  });
});

describe('RefreshRuntime.refreshAsync', () => {
  it('returns {state: "queued"} immediately without waiting for the pipeline', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const runPipeline = vi.fn().mockImplementation(async () => {
      await gate;
      return { payload: { run_id: 'run-1', generated_at: '2026-07-03T06:00:00+07:00' }, paths: {} };
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    const result = runtime.refreshAsync('manual');

    expect(result).toEqual({ state: 'queued', reason: 'manual', mode: null });
    expect(runtime.getStatus()).toMatchObject({ state: 'running', reason: 'manual' });

    resolveFirst?.();
    await vi.waitFor(() => expect(runtime.getStatus()).toMatchObject({ state: 'ok' }));
  });

  it('returns the merged running status (not queued) when a refresh is already in flight', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const runPipeline = vi.fn().mockImplementation(async () => {
      await gate;
      return { payload: { run_id: 'run-1', generated_at: '2026-07-03T06:00:00+07:00' }, paths: {} };
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig: () => fakeConfig(),
      runPipeline,
    });

    const firstResult = runtime.refreshAsync('daily');
    const secondResult = runtime.refreshAsync('manual');

    expect(firstResult).toEqual({ state: 'queued', reason: 'daily', mode: null });
    expect(secondResult).toMatchObject({ state: 'running', reason: 'daily' });
    expect(runPipeline).toHaveBeenCalledOnce();

    resolveFirst?.();
    await vi.waitFor(() => expect(runtime.getStatus()).toMatchObject({ state: 'ok' }));
  });
});

describe('RefreshRuntime config reloading', () => {
  it('reloads the config file fresh and overrides storage_path with the runtime dbPath', async () => {
    const loadConfig = vi.fn().mockReturnValue(AppConfigSchema.parse({ storage_path: 'ignored' }));
    const runPipeline = vi.fn().mockResolvedValue({
      payload: { run_id: 'run-1', generated_at: '2026-07-03T06:00:00+07:00' },
      paths: {},
    });
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/custom.json', dbPath, reportDir: dir, retainRuns: 0 },
      loadConfig,
      runPipeline,
    });

    await runtime.refresh('manual');

    expect(loadConfig).toHaveBeenCalledWith('config/custom.json');
    expect(runPipeline.mock.calls[0]?.[0]).toMatchObject({ storage_path: dbPath });
  });
});
