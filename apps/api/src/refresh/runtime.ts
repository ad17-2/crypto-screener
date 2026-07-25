import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { labelClosedWindows, pruneOldRuns } from '../db/index.js';
import { formatJakartaIso } from '../db/time.js';
import type { PruneResult } from '../db/types.js';
import {
  computeWeeklyReviewMetrics,
  hasLabeledRowsInWindow,
  loadLatestWeeklyReview,
  loadWeeklyReviewInputs,
  saveWeeklyReview,
} from '../db/weeklyReview.js';
import type { RunPipelineResult } from '../pipeline/runPipeline.js';
import { runPipeline as runPipelineDefault } from '../pipeline/runPipeline.js';
import { pyRound } from '../pipeline/scoring.js';
import {
  generateWeeklyReviewNarrative,
  shouldGenerateWeeklyReview,
} from '../pipeline/weeklyReview.js';
import type { DeepSeekClient } from '../providers/deepseek.js';
import { DeepSeekHttpClient } from '../providers/deepseek.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REVIEW_WINDOW_DAYS = 7;

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
      // Non-blocking post-save steps (outcome labeling, the weekly review) never fail the refresh --
      // this is where a failure or a noteworthy outcome from either shows up instead.
      notes: string[];
      // The mode runPipeline actually resolved to (pipeline/runPipeline.ts's own mode decision,
      // read back off provider_status.refresh_mode) -- not necessarily what the caller requested,
      // since a light override with no usable cache degrades to full. null when provider_status
      // never carried the field (e.g. a mocked runPipelineFn in a test).
      refresh_mode: 'light' | 'full' | null;
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
    options: { save?: boolean; writeReportFiles?: boolean; mode?: 'light' | 'full' },
  ) => Promise<RunPipelineResult>;
  // Mirrors runPipeline.ts's own deepseekClient dep: optional so production constructs the real
  // client (inside attachWeeklyReview below), while tests inject a mock.
  deepseekClient?: DeepSeekClient;
}

/** Explicit "+00:00" suffix, not "Z" -- do not swap for a bare toISOString(). */
function isoSecondsUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

interface LabelingAttemptResult {
  written: number;
  error: string | null;
}

/** Try/caught here, not inside labelClosedWindows itself -- that function stays a plain throwing library call (same as buildOutcomeLabels), consistent with the CLI it's shared with. */
function attemptLabeling(db: Database.Database, now: Date): LabelingAttemptResult {
  try {
    const result = labelClosedWindows(db, now);
    return { written: result.written, error: null };
  } catch (error) {
    return { written: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

interface WeeklyReviewAttemptResult {
  generated: boolean;
  narrated: boolean;
  n: number;
  error: string | null;
}

/**
 * Post-save weekly review: gate -> compute metrics -> best-effort DeepSeek narration -> persist.
 * Mirrors runPipeline.ts's attachBriefing -- narration is display-only and never blocks the write;
 * a narration failure or a missing API key still persists the computed metrics (facts beat prose).
 * Never throws: any failure (including the gate/metrics steps) is reported via `.error`, not thrown.
 */
async function attachWeeklyReview(
  db: Database.Database,
  config: AppConfig,
  now: Date,
  client: DeepSeekClient | undefined,
): Promise<WeeklyReviewAttemptResult> {
  try {
    const latest = loadLatestWeeklyReview(db);
    const weekEnd = formatJakartaIso(now);
    const weekStart = formatJakartaIso(new Date(now.getTime() - REVIEW_WINDOW_DAYS * MS_PER_DAY));
    const hasRows = hasLabeledRowsInWindow(db, weekStart, weekEnd);

    if (!shouldGenerateWeeklyReview(latest, hasRows, now)) {
      return { generated: false, narrated: false, n: 0, error: null };
    }

    const inputs = loadWeeklyReviewInputs(db, weekStart, weekEnd);
    const metrics = computeWeeklyReviewMetrics(inputs, weekStart, weekEnd);

    let narrative: string | null = null;
    let model: string | null = null;
    let narrated = false;

    const providerCfg = config.providers.deepseek;
    if (providerCfg.enabled) {
      const apiKeyEnv = providerCfg.api_key_env || 'DEEPSEEK_API_KEY';
      const apiKey = (process.env[apiKeyEnv] ?? '').trim();
      // Graceful dark mode, same activation switch as attachBriefing: no key, no narration attempt.
      if (client || apiKey) {
        try {
          const deepseekClient =
            client ??
            new DeepSeekHttpClient({
              baseUrl: providerCfg.base_url,
              apiKey,
              model: providerCfg.model,
              reasoningEffort: providerCfg.reasoning_effort,
              timeoutSeconds: providerCfg.request_timeout_seconds,
              maxOutputTokens: providerCfg.max_output_tokens,
            });
          const result = await generateWeeklyReviewNarrative(deepseekClient, metrics);
          narrative = result.text;
          model = result.model;
          narrated = true;
        } catch {
          // Narration failure -- narrative/model stay null; metrics are still persisted below.
        }
      }
    }

    saveWeeklyReview(db, {
      generated_at: weekEnd,
      week_start: weekStart,
      week_end: weekEnd,
      metrics,
      narrative,
      model,
    });

    return { generated: true, narrated, n: inputs.length, error: null };
  } catch (error) {
    return {
      generated: false,
      narrated: false,
      n: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export class RefreshRuntime {
  private readonly db: Database.Database;
  private readonly settings: RefreshRuntimeSettings;
  private readonly loadConfigFn: (path: string) => AppConfig;
  private readonly runPipelineFn: (
    config: AppConfig,
    outDir: string,
    options: { save?: boolean; writeReportFiles?: boolean; mode?: 'light' | 'full' },
  ) => Promise<RunPipelineResult>;
  private readonly deepseekClient: DeepSeekClient | undefined;
  private busy = false;
  private status: RefreshStatus = { state: 'idle' };

  constructor(deps: RefreshRuntimeDeps) {
    this.db = deps.db;
    this.settings = deps.settings;
    this.loadConfigFn = deps.loadConfig ?? loadConfig;
    this.runPipelineFn = deps.runPipeline ?? runPipelineDefault;
    this.deepseekClient = deps.deepseekClient;
  }

  getStatus(): RefreshStatus {
    return this.status;
  }

  async refresh(reason: string, mode?: 'light' | 'full'): Promise<RefreshStatus> {
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
      // exactOptionalPropertyTypes is on: `mode` must be omitted entirely when no override was
      // requested, not set to `mode: undefined` (that's a distinct, disallowed assignment under an
      // optional property's type).
      const pipelineOptions: { save: boolean; writeReportFiles: boolean; mode?: 'light' | 'full' } =
        mode === undefined
          ? { save: true, writeReportFiles: false }
          : { save: true, writeReportFiles: false, mode };
      const { payload, paths } = await this.runPipelineFn(
        config,
        this.settings.reportDir,
        pipelineOptions,
      );
      // What runPipeline actually resolved to (pipeline/collector.ts stamps this onto
      // provider_status), not necessarily the `mode` requested above -- a light override with no
      // usable cache degrades to full inside runPipeline itself. Optional-chained: a mocked
      // runPipelineFn (tests) may resolve a payload with no provider_status at all.
      const resolvedMode = payload.provider_status?.refresh_mode;
      const refreshMode: 'light' | 'full' | null =
        resolvedMode === 'light' || resolvedMode === 'full' ? resolvedMode : null;
      const retention =
        this.settings.retainRuns > 0 ? pruneOldRuns(this.db, this.settings.retainRuns) : null;

      // Post-save housekeeping across runs, same site as retention above (not runPipeline.ts,
      // which builds one run's payload and is tested against that alone) -- bounded and
      // display-adjacent, so neither step is allowed to fail this refresh; see attemptLabeling /
      // attachWeeklyReview's own doc comments for why each is safe to run unconditionally here.
      const notes: string[] = [];
      const labelingResult = attemptLabeling(this.db, new Date());
      if (labelingResult.error !== null) {
        notes.push(`outcome_labeling: error - ${labelingResult.error}`);
      } else if (labelingResult.written > 0) {
        notes.push(`outcome_labeling: wrote ${labelingResult.written} row(s)`);
      }

      const weeklyReviewResult = await attachWeeklyReview(
        this.db,
        config,
        new Date(),
        this.deepseekClient,
      );
      if (weeklyReviewResult.error !== null) {
        notes.push(`weekly_review: error - ${weeklyReviewResult.error}`);
      } else if (weeklyReviewResult.generated) {
        notes.push(
          `weekly_review: generated (n=${weeklyReviewResult.n}, narrated=${weeklyReviewResult.narrated})`,
        );
      }

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
        notes,
        refresh_mode: refreshMode,
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

  refreshAsync(reason: string, mode?: 'light' | 'full'): RefreshAsyncResult {
    if (this.busy) {
      return { ...this.status, state: 'running' } as RefreshAsyncResult;
    }
    void this.refresh(reason, mode);
    // Echoes the requested override, not a resolved mode -- runPipeline hasn't run yet at this
    // point (refresh() above continues in the background), so there's nothing resolved to report.
    return { state: 'queued', reason, mode: mode ?? null };
  }

  /** Reloads config fresh each refresh (the file may change on disk) and overrides storage_path with the runtime DB path. */
  private loadRuntimeConfig(): AppConfig {
    const config = this.loadConfigFn(this.settings.configPath);
    return { ...config, storage_path: this.settings.dbPath };
  }
}
