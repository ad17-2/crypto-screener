import { mkdirSync } from 'node:fs';
import { openDatabase } from './db/index.js';
import { loadEnv } from './env.js';
import { createApp } from './http/app.js';
import { RefreshRuntime } from './refresh/runtime.js';
import { startAutoRefresh } from './refresh/scheduler.js';

/** Binds 127.0.0.1 only -- apps/web owns the public port and proxies /api/* and /health here. */

const env = loadEnv();
mkdirSync(env.reportDir, { recursive: true });

const db = openDatabase(env.dbPath);

const runtime = new RefreshRuntime({
  db,
  settings: {
    configPath: env.configPath,
    dbPath: env.dbPath,
    reportDir: env.reportDir,
    retainRuns: env.retainRuns,
  },
});

const app = createApp({
  db,
  config: env.config,
  dbPath: env.dbPath,
  limit: env.dashboardLimit,
  runtime,
  refreshToken: env.refreshToken,
});

const stopScheduler = startAutoRefresh(runtime, db, {
  dailyRefreshTimes: env.dailyRefreshTimes,
  refreshTimezone: env.refreshTimezone,
  autoRefreshSeconds: env.autoRefreshSeconds,
});

const server = app.listen(env.apiPort, '127.0.0.1', () => {
  console.log(`crypto-screener api listening on 127.0.0.1:${env.apiPort}`);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  stopScheduler();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
