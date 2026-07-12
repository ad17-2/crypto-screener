import { join } from 'node:path';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import { saveSnapshot } from '../../src/db/runs.js';
import { createApp } from '../../src/http/app.js';
import { RefreshRuntime } from '../../src/refresh/runtime.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  ({ dir, dbPath, db } = setupTempDb('crypto-screener-http-'));
});

afterEach(() => {
  teardownTempDb(dir, db);
});

function idleRuntime(): RefreshRuntime {
  return new RefreshRuntime({
    db,
    settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
  });
}

describe('GET /health', () => {
  it('reports database_exists=true and the current refresh status', async () => {
    const app = createApp({
      db,
      config: AppConfigSchema.parse({ storage_path: dbPath }),
      dbPath,
      limit: 5,
      runtime: idleRuntime(),
      refreshToken: null,
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({
      status: 'ok',
      database_exists: true,
      refresh: { state: 'idle' },
    });
  });

  it('reports database_exists=false when the configured db file does not exist', async () => {
    const missingDbPath = join(dir, 'missing.sqlite3');
    const app = createApp({
      db,
      config: AppConfigSchema.parse({ storage_path: dbPath }),
      dbPath: missingDbPath,
      limit: 5,
      runtime: idleRuntime(),
      refreshToken: null,
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.database_exists).toBe(false);
  });
});

describe('GET /api/dashboard', () => {
  it('returns status=empty with refresh_status injected when no run has been saved', async () => {
    const app = createApp({
      db,
      config: AppConfigSchema.parse({ storage_path: dbPath }),
      dbPath,
      limit: 5,
      runtime: idleRuntime(),
      refreshToken: null,
    });

    const response = await request(app).get('/api/dashboard');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('empty');
    expect(response.body.runs).toEqual([]);
    expect(response.body.refresh_status).toEqual({ state: 'idle' });
  });

  it('returns the saved payload for the latest run, and ?run_id= selects a specific run', async () => {
    saveSnapshot(
      db,
      {
        run_id: 'run-1',
        generated_at: '2026-07-02T09:00:00+07:00',
        rows: [{ symbol: 'BTC', price_usd: 100 }],
      },
      { storage_path: dbPath },
    );
    saveSnapshot(
      db,
      {
        run_id: 'run-2',
        generated_at: '2026-07-02T12:00:00+07:00',
        rows: [{ symbol: 'ETH', price_usd: 200 }],
      },
      { storage_path: dbPath },
    );

    const app = createApp({
      db,
      config: AppConfigSchema.parse({ storage_path: dbPath }),
      dbPath,
      limit: 5,
      runtime: idleRuntime(),
      refreshToken: null,
    });

    const latest = await request(app).get('/api/dashboard');
    expect(latest.status).toBe(200);
    expect(latest.body.status).toBe('ok');
    expect(latest.body.run.run_id).toBe('run-2');
    expect(latest.body.refresh_status).toEqual({ state: 'idle' });

    const selected = await request(app).get('/api/dashboard').query({ run_id: 'run-1' });
    expect(selected.body.run.run_id).toBe('run-1');
  });
});

describe('POST /api/refresh', () => {
  function fakeRuntime(): { runtime: RefreshRuntime; runPipeline: ReturnType<typeof vi.fn> } {
    const runPipeline = vi.fn().mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves within the test -- only the immediate HTTP response is asserted */
        }),
    );
    const runtime = new RefreshRuntime({
      db,
      settings: { configPath: 'config/default.json', dbPath, reportDir: dir, retainRuns: 0 },
      runPipeline,
    });
    return { runtime, runPipeline };
  }

  it('403s when CRYPTO_DASHBOARD_REFRESH_TOKEN is unset (default-deny)', async () => {
    const { runtime } = fakeRuntime();
    const app = createApp({
      db,
      config: AppConfigSchema.parse({ storage_path: dbPath }),
      dbPath,
      limit: 5,
      runtime,
      refreshToken: null,
    });

    const response = await request(app).post('/api/refresh').set('X-Refresh-Token', 'anything');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ status: 'forbidden', reason: 'refresh token required' });
  });

  it('403s on a wrong token', async () => {
    const { runtime } = fakeRuntime();
    const app = createApp({
      db,
      config: AppConfigSchema.parse({ storage_path: dbPath }),
      dbPath,
      limit: 5,
      runtime,
      refreshToken: 'secret',
    });

    const response = await request(app).post('/api/refresh').set('X-Refresh-Token', 'wrong');

    expect(response.status).toBe(403);
  });

  it('202s {state: "queued", reason: "manual"} via X-Refresh-Token', async () => {
    const { runtime, runPipeline } = fakeRuntime();
    const app = createApp({
      db,
      config: AppConfigSchema.parse({ storage_path: dbPath }),
      dbPath,
      limit: 5,
      runtime,
      refreshToken: 'secret',
    });

    const response = await request(app).post('/api/refresh').set('X-Refresh-Token', 'secret');

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ state: 'queued', reason: 'manual' });
    expect(runPipeline).toHaveBeenCalledOnce();
  });

  it('202s {state: "queued", reason: "manual"} via Authorization: Bearer', async () => {
    const { runtime, runPipeline } = fakeRuntime();
    const app = createApp({
      db,
      config: AppConfigSchema.parse({ storage_path: dbPath }),
      dbPath,
      limit: 5,
      runtime,
      refreshToken: 'secret',
    });

    const response = await request(app).post('/api/refresh').set('Authorization', 'Bearer secret');

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ state: 'queued', reason: 'manual' });
    expect(runPipeline).toHaveBeenCalledOnce();
  });

  it('a refresh already in flight does not start a second one', async () => {
    const { runtime, runPipeline } = fakeRuntime();
    const app = createApp({
      db,
      config: AppConfigSchema.parse({ storage_path: dbPath }),
      dbPath,
      limit: 5,
      runtime,
      refreshToken: 'secret',
    });

    const first = await request(app).post('/api/refresh').set('X-Refresh-Token', 'secret');
    const second = await request(app).post('/api/refresh').set('X-Refresh-Token', 'secret');

    expect(first.status).toBe(202);
    expect(first.body).toEqual({ state: 'queued', reason: 'manual' });
    // Always 202, even for the already-running response.
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ state: 'running', reason: 'manual' });
    expect(runPipeline).toHaveBeenCalledOnce();
  });
});
