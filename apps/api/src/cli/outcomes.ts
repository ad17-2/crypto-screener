#!/usr/bin/env node
import { parseArgs as nodeParseArgs } from 'node:util';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import type { OutcomeLabelSummary } from '../db/index.js';
import { buildOutcomeLabels, openDatabase, saveOutcomeLabelRecords } from '../db/index.js';
import { runIfMain } from './support.js';

const DEFAULT_HORIZONS = [24, 72];

export interface OutcomesCliArgs {
  config: string;
  horizons: number[];
  symbols?: string[] | undefined;
  dryRun: boolean;
}

function parseHorizons(raw: string | undefined): number[] {
  if (!raw) {
    return DEFAULT_HORIZONS;
  }
  const horizons = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const parsed = Number(part);
      if (Number.isNaN(parsed)) {
        throw new Error(`invalid value for --horizons: "${raw}"`);
      }
      return parsed;
    });
  return horizons.length > 0 ? horizons : DEFAULT_HORIZONS;
}

function parseSymbols(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const symbols = raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);
  return symbols.length > 0 ? symbols : undefined;
}

export function parseOutcomesCliArgs(argv: string[]): OutcomesCliArgs {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'config/default.json' },
      horizons: { type: 'string' },
      symbols: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });

  return {
    config: values.config as string,
    horizons: parseHorizons(values.horizons as string | undefined),
    symbols: parseSymbols(values.symbols as string | undefined),
    dryRun: values['dry-run'] as boolean,
  };
}

export interface OutcomesSummary extends OutcomeLabelSummary {
  written: number;
  dry_run: boolean;
}

/** Labels are computed either way (read-only); `--dry-run` only skips the write. */
export function runOutcomes(config: AppConfig, args: OutcomesCliArgs): OutcomesSummary {
  const db = openDatabase(config.storage_path);
  try {
    const { records, summary } = buildOutcomeLabels(db, {
      horizons: args.horizons,
      symbols: args.symbols,
    });
    const written = args.dryRun ? 0 : saveOutcomeLabelRecords(db, records);
    return { ...summary, written, dry_run: args.dryRun };
  } finally {
    db.close();
  }
}

function formatCounts(counts: Record<number, number>): string {
  return JSON.stringify(counts);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseOutcomesCliArgs(argv);
  const config = loadConfig(args.config);
  const summary = runOutcomes(config, args);

  console.log(`horizons=${summary.horizons.join(',')}`);
  console.log(`base_rows_considered=${summary.base_rows_considered}`);
  console.log(`base_rows_skipped_untrusted=${summary.base_rows_skipped_untrusted}`);
  console.log(`base_rows_trusted_missing_flag=${summary.base_rows_trusted_missing_flag}`);
  console.log(`labeled=${formatCounts(summary.labeled)}`);
  console.log(`skipped_no_forward_match=${formatCounts(summary.skipped_no_forward_match)}`);
  console.log(`null_residual=${formatCounts(summary.null_residual)}`);
  console.log(`null_residual_missing_beta=${formatCounts(summary.null_residual_missing_beta)}`);
  console.log(
    `null_residual_missing_btc_match=${formatCounts(summary.null_residual_missing_btc_match)}`,
  );
  console.log(`written=${summary.written}`);
  console.log(`dry_run=${summary.dry_run ? 'True' : 'False'}`);
  return 0;
}

runIfMain(import.meta.url, main);
