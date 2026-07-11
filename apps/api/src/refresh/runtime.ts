import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { pruneOldRuns } from '../db/index.js';
import type { PruneResult } from '../db/types.js';
import type { RunPipelineResult } from '../pipeline/runPipeline.js';
import { runPipeline as runPipelineDefault } from '../pipeline/runPipeline.js';
import { pyRound } from '../pipeline/scoring.js';

/**
 * Re-entrancy is guarded by a plain boolean flag, checked and set synchronously with no `await`
 * between the check and the set — do not add one, or a second caller could interleave past a stale `false`.
 */

export type RefreshStatus =
  | { state: 'idle' }
  | { state: 'running'; reason: string; started_at: string }
  | {
      state: 'ok';
      reason: string;
      run_id: string;
      generated_at: string;
      finished_at: string;
      duration_seconds: number;
      paths: Record<string, string>;
      retention: PruneResult | null;
    }
  | { state: 'error'; reason: string; error: string; finished_at: string };

/** Immediate return value of `refreshAsync`, distinct from the polled `RefreshStatus`. */
export interface RefreshAsyncResult {
  state: string;
  reason: string;
  [key: string]: unknown;
}

export interface RefreshRuntimeSettings {
  configPath: string;
  dbPath: string;
  reportDir: string;
  retainRuns: number;
}

export interface RefreshRuntimeDeps {
  db: Database.Database;
  settings: RefreshRuntimeSettings;
  loadConfig?: (path: string) => AppConfig;
  runPipeline?: (
    config: AppConfig,
    outDir: string,
    options: { save?: boolean; writeReportFiles?: boolean },
  ) => Promise<RunPipelineResult>;
}

/** Explicit "+00:00" suffix, not "Z" -- do not swap for a bare toISOString(). */
function isoSecondsUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

export class RefreshRuntime {
  private readonly db: Database.Database;
  private readonly settings: RefreshRuntimeSettings;
  private readonly loadConfigFn: (path: string) => AppConfig;
  private readonly runPipelineFn: (
    config: AppConfig,
    outDir: string,
    options: { save?: boolean; writeReportFiles?: boolean },
  ) => Promise<RunPipelineResult>;
  private busy = false;
  private status: RefreshStatus = { state: 'idle' };

  constructor(deps: RefreshRuntimeDeps) {
    this.db = deps.db;
    this.settings = deps.settings;
    this.loadConfigFn = deps.loadConfig ?? loadConfig;
    this.runPipelineFn = deps.runPipeline ?? runPipelineDefault;
  }

  getStatus(): RefreshStatus {
    return this.status;
  }

  async refresh(reason: string): Promise<RefreshStatus> {
    if (this.busy) {
      return { ...this.status, state: 'running' } as RefreshStatus;
    }
    this.busy = true;
    const startedAt = new Date();
    this.status = {
      state: 'running',
      reason,
      started_at: isoSecondsUtc(startedAt),
    };
    try {
      const config = this.loadRuntimeConfig();
      const { payload, paths } = await this.runPipelineFn(config, this.settings.reportDir, {
        save: true,
        writeReportFiles: false,
      });
      const retention =
        this.settings.retainRuns > 0 ? pruneOldRuns(this.db, this.settings.retainRuns) : null;
      const finishedAt = new Date();
      this.status = {
        state: 'ok',
        reason,
        run_id: payload.run_id,
        generated_at: payload.generated_at,
        finished_at: isoSecondsUtc(finishedAt),
        duration_seconds: pyRound((finishedAt.getTime() - startedAt.getTime()) / 1000, 2),
        paths,
        retention,
      };
    } catch (error) {
      this.status = {
        state: 'error',
        reason,
        error: error instanceof Error ? error.message : String(error),
        finished_at: isoSecondsUtc(new Date()),
      };
    } finally {
      this.busy = false;
    }
    return this.status;
  }

  refreshAsync(reason: string): RefreshAsyncResult {
    if (this.busy) {
      return { ...this.status, state: 'running' } as RefreshAsyncResult;
    }
    void this.refresh(reason);
    return { state: 'queued', reason };
  }

  /** Reloads config fresh each refresh (the file may change on disk) and overrides storage_path with the runtime DB path. */
  private loadRuntimeConfig(): AppConfig {
    const config = this.loadConfigFn(this.settings.configPath);
    return { ...config, storage_path: this.settings.dbPath };
  }
}
