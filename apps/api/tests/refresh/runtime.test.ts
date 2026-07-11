import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import { openDatabase } from '../../src/db/client.js';
import { RefreshRuntime } from '../../src/refresh/runtime.js';

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crypto-screener-runtime-'));
  dbPath = join(dir, 'screener.sqlite3');
  db = openDatabase(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
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

    expect(result).toEqual({ state: 'queued', reason: 'manual' });
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

    expect(firstResult).toEqual({ state: 'queued', reason: 'daily' });
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
