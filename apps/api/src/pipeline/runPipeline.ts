import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/index.js';
import { previousRunMembership, watchlistDiff } from '../dashboard/runDiff.js';
import { annotateWatchlistMembership } from '../dashboard/watchlists.js';
import {
  loadLatestRegimeState,
  loadPriceLookback,
  openDatabase,
  saveSnapshot,
} from '../db/index.js';
import { formatJakartaIso } from '../db/time.js';
import type { SnapshotPayload } from '../db/types.js';
import type { DeepSeekClient } from '../providers/deepseek.js';
import { DeepSeekHttpClient } from '../providers/deepseek.js';
import { writeReports } from '../reports/writeReports.js';
import { buildBriefingPayload, generateBriefing } from './briefing.js';
import { collectMarket } from './collector.js';
import { scoreSnapshot } from './factors.js';
import type { RunPayload } from './models.js';
import { pctChange, toFloat } from './scoring.js';

export interface RunPipelineOptions {
  save?: boolean;
  writeReportFiles?: boolean;
}

// Mirrors collector.ts's CollectDeps pattern: optional so production constructs the real client,
// while tests inject a mock.
export interface RunPipelineDeps {
  deepseekClient?: DeepSeekClient;
}

export interface RunPipelineResult {
  payload: RunPayload;
  paths: Record<string, string>;
}

const DEEPSEEK_ERROR_PREVIEW_LENGTH = 300;

/**
 * Turns this run's own scored rows/context into a display-only "Tonight's read" briefing via one
 * DeepSeek call. Never throws: a missing key or a failed/slow call is recorded in
 * provider_status.deepseek and the refresh continues -- this must never block or fail a refresh.
 */
async function attachBriefing(
  db: Database.Database,
  payload: RunPayload,
  config: AppConfig,
  client: DeepSeekClient | undefined,
): Promise<void> {
  const providerCfg = config.providers.deepseek;
  if (!providerCfg.enabled) {
    payload.provider_status.deepseek = { status: 'disabled' };
    return;
  }

  const apiKeyEnv = providerCfg.api_key_env || 'DEEPSEEK_API_KEY';
  const apiKey = (process.env[apiKeyEnv] ?? '').trim();
  if (!client && !apiKey) {
    // Graceful dark mode -- this env var is the activation switch for the whole feature.
    payload.provider_status.deepseek = { status: 'disabled', note: 'DEEPSEEK_API_KEY not set' };
    return;
  }

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

    // `payload.run_id` can't collide with an already-saved run (saveSnapshot hasn't run yet), so
    // this finds the same "previous run" baseline dashboard/payload.ts would compute post-save.
    const previousMembership = previousRunMembership(db, payload.run_id, payload.generated_at);
    const currentMembership = new Map<string, 'long' | 'short'>();
    for (const row of payload.rows) {
      const symbol = typeof row.symbol === 'string' ? row.symbol : null;
      const side = row.watchlist_side;
      if (symbol !== null && (side === 'long' || side === 'short')) {
        currentMembership.set(symbol, side);
      }
    }
    const diff = watchlistDiff(previousMembership, currentMembership);

    const briefingPayload = buildBriefingPayload(
      payload.rows,
      diff,
      payload.market_context,
      payload.regime,
      payload.generated_at,
    );
    const briefing = await generateBriefing(deepseekClient, briefingPayload, payload.generated_at);
    payload.market_context.briefing = briefing;
    payload.provider_status.deepseek = {
      status: 'ok',
      note: `model=${briefing.model} reasoning_tokens=${briefing.reasoning_tokens ?? 'n/a'}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    payload.provider_status.deepseek = {
      status: 'error',
      errors: [message.slice(0, DEEPSEEK_ERROR_PREVIEW_LENGTH)],
    };
  }
}

// reports/writeReports.ts keeps an independent copy of this same formatting for its report-file stem -- keep them in sync.
function compactJakartaStamp(generatedAtIso: string): string {
  const [datePart, timePart] = generatedAtIso.slice(0, 19).split('T');
  return `${(datePart ?? '').replace(/-/g, '')}-${(timePart ?? '').replace(/:/g, '')}`;
}

export async function runPipeline(
  config: AppConfig,
  outDir: string,
  options: RunPipelineOptions = {},
  deps: RunPipelineDeps = {},
): Promise<RunPipelineResult> {
  const save = options.save ?? true;
  const writeReportFiles = options.writeReportFiles ?? true;

  const generatedAtIso = formatJakartaIso(new Date());
  // randomUUID()'s version nibble falls after the first 8 hex chars, so slicing 8 stays uniformly random.
  const runId = `${compactJakartaStamp(generatedAtIso)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const db = openDatabase(config.storage_path);
  try {
    const collected = await collectMarket(config);

    const lookbackHours = config.factors.reversal_lookback_hours;
    const lookbackPrices = loadPriceLookback(db, lookbackHours);
    for (const row of collected.rows) {
      const currentPrice = toFloat(row.price_usd);
      const pastPrice = lookbackPrices[String(row.symbol ?? '')];
      row.price_change_72h_pct =
        currentPrice !== null && pastPrice !== undefined && pastPrice > 0
          ? pctChange(pastPrice, currentPrice)
          : null;
    }

    const latestRegimeState = loadLatestRegimeState(db);
    // Fresh literal (same exemption as `regime` below): RegimeStateSummary has no index signature.
    const priorMarketState = latestRegimeState ? { ...latestRegimeState } : null;
    // `[]`: the factor-history engine that used to consume this argument was deleted; see
    // scoreSnapshot's doc comment in factors.ts.
    const scored = scoreSnapshot(
      collected.rows,
      collected.market_context,
      [],
      config,
      priorMarketState,
    );

    const payload: RunPayload = {
      run_id: runId,
      generated_at: generatedAtIso,
      rows: scored.rows,
      market_context: scored.market_context ?? collected.market_context,
      provider_status: collected.provider_status,
      // Fresh literal: InferredRegime has no index signature, so assigning it directly to
      // RunPayload's Record<string, unknown> field is rejected even though it's unknown-compatible.
      regime: { ...scored.regime },
    };

    // Persisted membership is a point-in-time record of what the screener said under
    // then-current config -- it deliberately does NOT track later config/predicate changes (the
    // dashboard keeps recomputing live from market_rows on every request; that drift between the
    // persisted record and a re-derived one is accepted and wanted, since forward-validation needs
    // to know what was actually shown at the time, not what today's code would show in hindsight).
    annotateWatchlistMembership(payload.rows, config);

    // Display-only: attachBriefing never throws, so a DeepSeek outage or timeout can never fail or
    // delay-block a refresh beyond its own request_timeout_seconds.
    await attachBriefing(db, payload, config, deps.deepseekClient);

    if (save) {
      // Row and MarketRow are the same open row shape, differing only in whether `symbol` is
      // required -- always true here (collectMarket/scoreSnapshot populate it), but the cast hides
      // that from the type checker.
      saveSnapshot(db, payload as unknown as SnapshotPayload, config);
    }
    const paths = writeReportFiles ? writeReports(payload, config, outDir) : {};
    return { payload, paths };
  } finally {
    db.close();
  }
}
