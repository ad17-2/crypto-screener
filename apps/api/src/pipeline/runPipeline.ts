import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/index.js';
import { annotateWatchlistMembership } from '../dashboard/watchlists.js';
import {
  loadLatestRegimeState,
  loadPriceLookback,
  openDatabase,
  saveSnapshot,
} from '../db/index.js';
import { formatJakartaIso } from '../db/time.js';
import type { SnapshotPayload } from '../db/types.js';
import { writeReports } from '../reports/writeReports.js';
import { collectMarket } from './collector.js';
import { scoreSnapshot } from './factors.js';
import type { RunPayload } from './models.js';
import { pctChange, toFloat } from './scoring.js';

export interface RunPipelineOptions {
  save?: boolean;
  writeReportFiles?: boolean;
}

export interface RunPipelineResult {
  payload: RunPayload;
  paths: Record<string, string>;
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
