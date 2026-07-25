import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/index.js';
import { previousRunMembership, watchlistDiff } from '../dashboard/runDiff.js';
import { annotateWatchlistMembership } from '../dashboard/watchlists.js';
import {
  loadEnrichmentCache,
  loadLatestRegimeState,
  loadPriceLookback,
  openDatabase,
  saveEnrichmentCache,
  saveSnapshot,
  updateRunContext,
} from '../db/index.js';
import { formatJakartaIso } from '../db/time.js';
import type { SnapshotPayload } from '../db/types.js';
import type { DeepSeekClient } from '../providers/deepseek.js';
import { DeepSeekHttpClient } from '../providers/deepseek.js';
import { writeReports } from '../reports/writeReports.js';
import { buildBriefingPayload, generateBriefing } from './briefing.js';
import { collectMarket } from './collector.js';
import { scoreSnapshot } from './factors.js';
import { fourHourBarStartMs } from './fourHourBar.js';
import { annotateMacroReactions } from './macroReaction.js';
import type { RunPayload } from './models.js';
import { pctChange, toFloat } from './scoring.js';

export interface RunPipelineOptions {
  save?: boolean;
  writeReportFiles?: boolean;
  // FULL refetches all CoinGlass 4h history, as today; LIGHT reuses the last full run's
  // history-derived enrichment fields (db/enrichmentCache.ts) and only fetches fresh
  // pairs-markets + delta symbols. See the mode decision below for how an override interacts with
  // cache freshness.
  mode?: 'light' | 'full';
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
 * Mirrors attachBriefing's own two early-return gates (enabled config, then client-or-API-key)
 * WITHOUT calling attachBriefing itself -- its early-return branches have the side effect of
 * settling provider_status.deepseek to 'disabled', which must fire exactly once, from attachBriefing,
 * not from this pre-check. runPipeline calls this before saveSnapshot purely to decide whether the
 * about-to-be-committed run should carry a 'pending' marker (see the call site below) for a briefing
 * that will actually be attempted once attachBriefing itself runs, after the commit.
 */
function briefingWillRun(config: AppConfig, client: DeepSeekClient | undefined): boolean {
  const providerCfg = config.providers.deepseek;
  if (!providerCfg.enabled) {
    return false;
  }
  const apiKeyEnv = providerCfg.api_key_env || 'DEEPSEEK_API_KEY';
  const apiKey = (process.env[apiKeyEnv] ?? '').trim();
  return client !== undefined || apiKey !== '';
}

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

    // attachBriefing now runs AFTER saveSnapshot (see the reorder comment at the call site below),
    // so payload.run_id's own rows are already committed to factor_history by this point --
    // previousRunMembership's `run_id != currentRunId` filter is what keeps this run from being
    // picked as its own "previous" baseline, not the absence of a saved row. This still finds the
    // same "previous run" baseline dashboard/payload.ts would compute; the briefing result itself
    // lands via updateRunContext below, once generateBriefing returns.
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
    const briefing = await generateBriefing(deepseekClient, briefingPayload, payload.generated_at, {
      db,
      rows: payload.rows,
      newToList: diff.newToList,
    });
    payload.market_context.briefing = briefing;
    const toolsNote = briefing.used_tools ? `tools=${briefing.tool_calls}` : 'tools=fallback';
    const reasonNote = briefing.tool_error ? ` (${briefing.tool_error})` : '';
    payload.provider_status.deepseek = {
      status: 'ok',
      note: `model=${briefing.model} reasoning_tokens=${briefing.reasoning_tokens ?? 'n/a'} ${toolsNote}${reasonNote}`,
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
  const pipelineStartMs = Date.now();
  const save = options.save ?? true;
  const writeReportFiles = options.writeReportFiles ?? true;

  const generatedAtIso = formatJakartaIso(new Date());
  // randomUUID()'s version nibble falls after the first 8 hex chars, so slicing 8 stays uniformly random.
  const runId = `${compactJakartaStamp(generatedAtIso)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const db = openDatabase(config.storage_path);
  try {
    const cached = loadEnrichmentCache(db);
    const barTsMs = fourHourBarStartMs(Date.now());
    const cacheUsable = cached !== null && cached.barTsMs === barTsMs;
    // mode='light' without a cache for the CURRENT 4h bar would either crash on a null cachedRows
    // or silently ship unenriched rows for symbols the cache never covered -- so a forced light
    // override degrades to full whenever the cache isn't usable. mode='full' always wins outright
    // (e.g. a manual "resync everything" refresh); with no override, cache freshness alone decides.
    const mode: 'light' | 'full' =
      options.mode === 'full' ? 'full' : cacheUsable ? 'light' : 'full';

    const collectStartMs = Date.now();
    const collected = await collectMarket(config, {
      enrichmentCache: {
        mode,
        barTsMs,
        cachedRows: cacheUsable && cached ? cached.blob.rows : null,
        save: save ? (blob) => saveEnrichmentCache(db, barTsMs, blob) : undefined,
      },
    });
    const collectMs = Date.now() - collectStartMs;

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

    const scoreStartMs = Date.now();
    const latestRegimeState = loadLatestRegimeState(db);
    // Fresh literal (same exemption as `regime` below): RegimeStateSummary has no index signature.
    const priorMarketState = latestRegimeState ? { ...latestRegimeState } : null;
    const scored = scoreSnapshot(
      collected.rows,
      collected.market_context,
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

    // Screener-native sector rotation is now computed inside scoreSnapshot (pipeline/factors.ts),
    // which needs residual_change_24h_pct before breadth can score it -- see scoreSnapshot for the
    // object/non-empty guard and the screener_sectors assignment (an empty or missing map there
    // leaves screener_sectors absent entirely, which the dashboard already treats the same as
    // "empty" by falling back to the CoinGecko categories list). collectCoingeckoContext
    // (collector.ts) stashes the raw sector->member-symbol map under
    // market_context.screener_sector_members purely as transient plumbing; delete it now so it
    // never ships as a second persisted market_context key.
    delete payload.market_context.screener_sector_members;

    // Persisted membership is a point-in-time record of what the screener said under
    // then-current config -- it deliberately does NOT track later config/predicate changes (the
    // dashboard keeps recomputing live from market_rows on every request; that drift between the
    // persisted record and a re-derived one is accepted and wanted, since forward-validation needs
    // to know what was actually shown at the time, not what today's code would show in hindsight).
    annotateWatchlistMembership(payload.rows, config);

    // Display-only, guarded internally (never throws): enriches recently-printed macro events
    // with BTC's reaction, BEFORE attachBriefing so the briefing payload can see it too.
    annotateMacroReactions(payload.rows, payload.market_context, payload.generated_at);
    const scoreMs = Date.now() - scoreStartMs;

    // attachBriefing itself now runs AFTER saveSnapshot below (see the comment at that call site
    // for why), so the run this saveSnapshot is about to commit would otherwise carry no
    // `provider_status.deepseek` key at all for however long the briefing takes -- indistinguishable
    // from "briefing was never going to run" to a reader. Stamping 'pending' here, before the
    // commit, makes that transient window visible instead of silent. willRunBriefing mirrors
    // attachBriefing's own gate rather than calling it early, so its 'disabled' side effect (see
    // attachBriefing itself) still fires exactly once, from attachBriefing, after the commit.
    const willRunBriefing = briefingWillRun(config, deps.deepseekClient);
    if (willRunBriefing) {
      payload.provider_status.deepseek = {
        status: 'pending',
        note: 'briefing generates after publish',
      };
    }

    // Transient plumbing only (enrichment.ts stashes it on the BTC row so annotateMacroReactions
    // above can compute a reaction without a second candle fetch) -- must never persist into
    // factor_history/market_rows or the written report files, so strip it now that its one
    // consumer (annotateMacroReactions) has already run. Confirmed by grep: neither
    // buildBriefingPayload nor generateBriefing (pipeline/briefing.ts) reads price_history_bars, so
    // moving attachBriefing after saveSnapshot doesn't need this strip to move too.
    for (const row of payload.rows) {
      if ('price_history_bars' in row) {
        delete row.price_history_bars;
      }
    }

    // total_ms here is only "as of this point" -- collect/score/save, not the briefing that's about
    // to run after saveSnapshot -- and gets refreshed below once briefing_ms is known. save_ms
    // starts as a placeholder (the actual saveSnapshot call, wrapped below, hasn't happened yet) and
    // is corrected the moment it has; `timings` is the same object referenced from
    // payload.provider_status.timings throughout, so mutating its fields below updates payload too.
    const timings: {
      collect_ms: number;
      score_ms: number;
      save_ms: number;
      total_ms: number;
      briefing_ms?: number;
    } = {
      collect_ms: collectMs,
      score_ms: scoreMs,
      save_ms: 0,
      total_ms: Date.now() - pipelineStartMs,
    };
    payload.provider_status.timings = timings;

    const saveStartMs = Date.now();
    if (save) {
      // Row and MarketRow are the same open row shape, differing only in whether `symbol` is
      // required -- always true here (collectMarket/scoreSnapshot populate it), but the cast hides
      // that from the type checker.
      saveSnapshot(db, payload as unknown as SnapshotPayload, config);
    }
    timings.save_ms = Date.now() - saveStartMs;

    // Reordered from before saveSnapshot to after it: a slow DeepSeek briefing (BRIEFING_TOOL_BUDGET_MS
    // budget arithmetic in pipeline/briefing.ts puts the worst case at ~8 min) used to delay the
    // moment this run's rows became visible on the dashboard by that same ~8 min. The invariant this
    // trades away: the row saveSnapshot just committed above can now be briefly visible with no
    // briefing yet -- carrying the 'pending' marker set above instead of the finished text. That's
    // safe because the briefing is a strictly display-only, additive field: dashboard/runDiff.ts
    // never reads runs.context_json (factor_history only), buildDashboardPayload re-prepares its
    // SELECT on every request (so the updateRunContext write below is picked up on the very next
    // poll), and apps/web's MarketStage renders nothing when market_context.briefing is absent
    // (parseBriefing returns null) -- so "briefing not there yet" reads identically to "briefing
    // disabled" today, never as broken. attachBriefing itself still never throws: a missing key or a
    // failed/slow call is recorded in provider_status.deepseek and the refresh continues either way.
    const briefingStartMs = Date.now();
    await attachBriefing(db, payload, config, deps.deepseekClient);
    timings.briefing_ms = Date.now() - briefingStartMs;
    timings.total_ms = Date.now() - pipelineStartMs;

    if (save) {
      // The row from saveSnapshot's INSERT above already exists by construction (this whole branch
      // is guarded on the same `save`), so a plain UPDATE is enough -- no upsert needed. Carries the
      // briefing attachBriefing just attached (or the settled non-pending status/timings when no
      // briefing ran) into the same two columns saveSnapshot itself writes.
      updateRunContext(db, runId, payload.market_context, payload.provider_status);
    }

    const paths = writeReportFiles ? writeReports(payload, config, outDir) : {};
    return { payload, paths };
  } finally {
    db.close();
  }
}
