#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from 'node:util';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import {
  isCrowdedLong,
  isCrowdedShort,
  isLongCandidate,
  isShortCandidate,
  topBy,
} from '../dashboard/watchlists.js';
import { runPipeline } from '../pipeline/runPipeline.js';
import { pyStr } from '../pipeline/scoring.js';
import { parseNumberFlag, runIfMain } from './support.js';

export interface ScreenerCliArgs {
  config: string;
  outDir: string;
  topSymbols?: number | undefined;
  reportLimit?: number | undefined;
  minQuoteVolumeUsd?: number | undefined;
  coinglassCandidateSymbols?: number | undefined;
  noSave: boolean;
  noReports: boolean;
}

/** `--coinglass-candidate-symbols` and its `--max-coinglass-symbols` alias share one destination. */
export function parseCliArgs(argv: string[]): ScreenerCliArgs {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'config/default.json' },
      'out-dir': { type: 'string', default: 'reports' },
      'top-symbols': { type: 'string' },
      'report-limit': { type: 'string' },
      'min-quote-volume-usd': { type: 'string' },
      'coinglass-candidate-symbols': { type: 'string' },
      'max-coinglass-symbols': { type: 'string' },
      'no-save': { type: 'boolean', default: false },
      'no-reports': { type: 'boolean', default: false },
    },
    strict: true,
  });

  return {
    config: values.config as string,
    outDir: values['out-dir'] as string,
    topSymbols: parseNumberFlag(values['top-symbols'] as string | undefined, '--top-symbols'),
    reportLimit: parseNumberFlag(values['report-limit'] as string | undefined, '--report-limit'),
    minQuoteVolumeUsd: parseNumberFlag(
      values['min-quote-volume-usd'] as string | undefined,
      '--min-quote-volume-usd',
    ),
    coinglassCandidateSymbols: parseNumberFlag(
      (values['coinglass-candidate-symbols'] as string | undefined) ??
        (values['max-coinglass-symbols'] as string | undefined),
      '--coinglass-candidate-symbols',
    ),
    noSave: values['no-save'] as boolean,
    noReports: values['no-reports'] as boolean,
  };
}

/** `config` is already fully defaulted by zod, so this mutates the relevant fields directly. */
export function applyOverrides(config: AppConfig, args: ScreenerCliArgs): AppConfig {
  if (args.topSymbols !== undefined) {
    config.universe.top_symbols_by_volume = args.topSymbols;
  }
  if (args.reportLimit !== undefined) {
    config.report.limit = args.reportLimit;
  }
  if (args.minQuoteVolumeUsd !== undefined) {
    config.universe.min_quote_volume_usd = args.minQuoteVolumeUsd;
  }
  if (args.coinglassCandidateSymbols !== undefined) {
    config.providers.coinglass.candidate_symbols = args.coinglassCandidateSymbols;
  }
  return config;
}

/**
 * stdout format is locked by tests/cli/screener.test.ts: fixed keys/order, `reports=skipped` if
 * no files were written, else one `{label}={path}` line per report file in `paths` insertion order.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);
  const config = applyOverrides(loadConfig(args.config), args);

  const { payload, paths } = await runPipeline(config, args.outDir, {
    save: !args.noSave,
    writeReportFiles: !args.noReports,
  });
  const rows = payload.rows;
  const limit = config.report.limit;

  const longCount = topBy(rows, 'long_score', limit, { predicate: isLongCandidate }).length;
  const shortCount = topBy(rows, 'short_score', limit, { predicate: isShortCandidate }).length;
  const fadeCount = topBy(rows, 'crowded_long_score', limit, { predicate: isCrowdedLong }).length;
  const squeezeCount = topBy(rows, 'squeeze_risk_score', limit, {
    predicate: isCrowdedShort,
  }).length;

  const regime = payload.regime ?? {};
  const factorWeights = payload.factor_weights ?? {};

  console.log(`run_id=${payload.run_id}`);
  console.log(`screened_symbols=${rows.length}`);
  console.log(`bias=${pyStr(regime.bias)}`);
  console.log(`factor_regime=${pyStr(regime.label)}`);
  console.log(`weight_mode=${pyStr(factorWeights.mode)}`);
  console.log(`long_candidates=${longCount}`);
  console.log(`short_candidates=${shortCount}`);
  console.log(`crowded_longs=${fadeCount}`);
  console.log(`squeeze_risks=${squeezeCount}`);
  if (Object.keys(paths).length === 0) {
    console.log('reports=skipped');
  }
  for (const [label, path] of Object.entries(paths)) {
    console.log(`${label}=${path}`);
  }
  return 0;
}

runIfMain(import.meta.url, main);
