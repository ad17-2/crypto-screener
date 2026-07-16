import type Database from 'better-sqlite3';
import express, { type Express } from 'express';
import type { AppConfig } from '../config/index.js';
import type { RefreshRuntime } from '../refresh/runtime.js';
import { btcPulseRoute } from './routes/btcPulse.js';
import { dashboardRoute } from './routes/dashboard.js';
import { healthRoute } from './routes/health.js';
import { refreshRoute } from './routes/refresh.js';

/** No `listen()` here (see server.ts) so tests can drive this with supertest; no static UI routes — apps/web owns the UI. */
export interface AppDeps {
  db: Database.Database;
  config: AppConfig;
  dbPath: string;
  limit: number;
  runtime: RefreshRuntime;
  /** `null` means POST /api/refresh is default-deny -- see `isRefreshAllowed` in env.ts. */
  refreshToken: string | null;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // Prevents the Next.js proxy (or any intermediary) from caching a stale refresh_status/run.
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', healthRoute(deps));
  app.get('/api/dashboard', dashboardRoute(deps));
  app.get('/api/btc-pulse', btcPulseRoute());
  app.post('/api/refresh', refreshRoute(deps));

  return app;
}
