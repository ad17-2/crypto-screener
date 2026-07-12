import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/index.js';
import { buildSections, buildWatchlists } from '../dashboard/payload.js';
import {
  loadLabeledFactorRecords,
  loadLabeledRecordsByHorizon,
  loadLatestRegimeState,
  loadPriceLookback,
  openDatabase,
  recommendationsFromWatchlists,
  saveRecommendations,
  saveSnapshot,
} from '../db/index.js';
import { formatJakartaIso } from '../db/time.js';
import type { SnapshotPayload } from '../db/types.js';
import { writeReports } from '../reports/writeReports.js';
import { collectMarket } from './collector.js';
import { scoreSnapshot } from './factors.js';
import type { FactorRecord } from './ic.js';
import type { RunPayload } from './models.js';
import { pctChange, toFloat } from './scoring.js';
import { factorDecay } from './validation.js';

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

    const historyRecords = loadLabeledFactorRecords(db, {
      forwardReturnHours: config.factors.forward_return_hours,
      icWindowDays: config.factors.ic_window_days,
    });

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
    // LabeledFactorRecordWithRegime and FactorRecord are the same open record shape; the cast is
    // safe only because every field FactorRecord reads is present on LabeledFactorRecordWithRegime.
    const scored = scoreSnapshot(
      collected.rows,
      collected.market_context,
      historyRecords as unknown as FactorRecord[],
      config,
      priorMarketState,
    );

    const decayHorizons = config.factors.decay_horizons;
    const recordsByHorizon = loadLabeledRecordsByHorizon(db, decayHorizons, {
      icWindowDays: config.factors.ic_window_days,
    });
    const decay = factorDecay(recordsByHorizon as unknown as Map<number, FactorRecord[]>, config);

    const payload: RunPayload = {
      run_id: runId,
      generated_at: generatedAtIso,
      rows: scored.rows,
      market_context: scored.market_context ?? collected.market_context,
      provider_status: collected.provider_status,
      factor_weights: { ...scored.factor_weights, factor_decay: decay },
      // Fresh literal: InferredRegime has no index signature, so assigning it directly to
      // RunPayload's Record<string, unknown> field is rejected even though it's unknown-compatible.
      regime: { ...scored.regime },
    };

    if (save) {
      // Row and MarketRow are the same open row shape, differing only in whether `symbol` is
      // required -- always true here (collectMarket/scoreSnapshot populate it), but the cast hides
      // that from the type checker.
      saveSnapshot(db, payload as unknown as SnapshotPayload, config);

      // `{}` history is safe here -- see recommendationsFromWatchlists.
      const sections = buildSections(payload.rows, config.report.limit, {}, payload.regime);
      const watchlists = buildWatchlists(sections, config.report.limit);
      saveRecommendations(
        db,
        recommendationsFromWatchlists(watchlists, payload.run_id, payload.generated_at),
      );
    }
    const paths = writeReportFiles ? writeReports(payload, config, outDir) : {};
    return { payload, paths };
  } finally {
    db.close();
  }
}
