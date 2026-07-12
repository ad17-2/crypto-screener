#!/usr/bin/env node
/**
 * Regenerates the golden regression baselines for parity.test.ts and dashboardPayload.test.ts.
 * See tests/fixtures/README.md for what's frozen and the review discipline.
 *
 *   npx tsx apps/api/scripts/regen-golden.ts parity   -- rewrites parity-run.json's `expected` block
 *   npx tsx apps/api/scripts/regen-golden.ts payload  -- rewrites dashboard-payload.json
 *
 * Prints a diff of every changed leaf; review it before committing.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIfMain } from '../src/cli/support.js';
import { AppConfigSchema } from '../src/config/schema.js';
import { buildDashboardPayload } from '../src/dashboard/payload.js';
import { openDatabase } from '../src/db/client.js';
import { scoreSnapshot } from '../src/pipeline/factors.js';
import type { FactorRecord } from '../src/pipeline/ic.js';
import type { MarketContext, Row } from '../src/pipeline/types.js';
import type { Diff, JNode } from './lib/losslessJson.js';
import { parseLossless, reconcile, serialize } from './lib/losslessJson.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PARITY_FIXTURE_PATH = join(SCRIPT_DIR, '../tests/fixtures/parity-run.json');
const PAYLOAD_FIXTURE_PATH = join(SCRIPT_DIR, '../tests/fixtures/dashboard-payload.json');
const PARITY_SQLITE_PATH = join(SCRIPT_DIR, '../tests/fixtures/parity.sqlite3');

function formatDiffValue(value: unknown): string {
  if (value === undefined) {
    return '<none>';
  }
  const text = JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function printDiffSummary(label: string, diffs: Diff[]): void {
  console.log(`\n${label}: ${diffs.length} change(s) vs. the previous expected values`);
  if (diffs.length === 0) {
    console.log('  (none -- byte-identical regen)');
    return;
  }
  for (const diff of diffs) {
    const tag = diff.kind === 'added' ? 'ADDED' : diff.kind === 'removed' ? 'REMOVED' : 'CHANGED';
    console.log(
      `  [${tag}] ${diff.path}: ${formatDiffValue(diff.old)} -> ${formatDiffValue(diff.new)}`,
    );
  }
}

function findTopLevelEntry(root: JNode, key: string): JNode {
  if (root.kind !== 'obj') {
    throw new Error('regen-golden: fixture root is not a JSON object');
  }
  const entry = root.entries.find((e) => e.key === key);
  if (entry === undefined) {
    throw new Error(`regen-golden: fixture is missing top-level key "${key}"`);
  }
  return entry.value;
}

interface ParityFixtureShape {
  config: unknown;
  market_context: MarketContext;
  input_rows: Row[];
  factor_history: FactorRecord[];
}

/** Rewrites only parity-run.json's `expected` block by splicing serialized text into the original bytes; `_meta`/`config`/`input_rows`/`market_context`/`factor_history` are never touched, not even re-serialized. */
export function regenParity(): void {
  const origText = readFileSync(PARITY_FIXTURE_PATH, 'utf-8');
  const root = parseLossless(origText);
  const oldExpected = findTopLevelEntry(root, 'expected');

  const fixture = JSON.parse(origText) as ParityFixtureShape;
  const config = AppConfigSchema.parse(fixture.config);
  // Deep-cloned, same as parity.test.ts: scoreSnapshot mutates rows in place.
  const rows: Row[] = JSON.parse(JSON.stringify(fixture.input_rows));

  const result = scoreSnapshot(
    rows,
    fixture.market_context,
    fixture.factor_history,
    config,
    undefined,
  );

  const trustedRows = result.rows
    .filter((row) => row.is_trusted !== false)
    .map((row) => ({
      symbol: row.symbol,
      factors: row.factors,
      raw_factors: row.raw_factors,
      scores: row.scores,
    }));

  const newExpected = {
    factor_weights: result.factor_weights,
    regime: result.regime,
    rows: trustedRows,
  };

  // factor_decay needs per-horizon records the fixture doesn't ship (see parity.test.ts) and
  // scoreSnapshot() never produces it -- carried over from the previous fixture untouched.
  const diffs: Diff[] = [];
  const reconciled = reconcile(
    oldExpected,
    newExpected,
    'expected',
    { diffs },
    {
      pinnedPaths: new Set(['expected.factor_weights.factor_decay']),
    },
  );

  const newExpectedText = serialize(reconciled, { style: 'pretty2' }, 1);
  const newText =
    origText.slice(0, oldExpected.span[0]) + newExpectedText + origText.slice(oldExpected.span[1]);
  writeFileSync(PARITY_FIXTURE_PATH, newText);

  printDiffSummary('parity-run.json: expected', diffs);
}

/** Rebuilds the payload from a disposable copy of parity.sqlite3 (never opened read-write) and rewrites dashboard-payload.json in full -- the whole file is the expected output. */
export function regenPayload(): void {
  const origText = readFileSync(PAYLOAD_FIXTURE_PATH, 'utf-8');
  const oldRoot = parseLossless(origText);

  const dir = mkdtempSync(join(tmpdir(), 'crypto-screener-regen-payload-'));
  const dbPath = join(dir, 'crypto_screener.sqlite3');
  copyFileSync(PARITY_SQLITE_PATH, dbPath);
  const db = openDatabase(dbPath);
  try {
    const config = AppConfigSchema.parse({});
    const payload = buildDashboardPayload(db, config, { limit: config.report.limit });

    // refresh_status is added by the HTTP route, not buildDashboardPayload; freshness.age_seconds/
    // age_minutes derive from Date.now(), never equal to the fixture's capture time. Both carried over untouched.
    const diffs: Diff[] = [];
    const reconciled = reconcile(
      oldRoot,
      payload as unknown as Record<string, unknown>,
      '',
      { diffs },
      {
        pinnedPaths: new Set(['refresh_status', 'freshness.age_seconds', 'freshness.age_minutes']),
      },
    );

    const newText = serialize(reconciled, { style: 'compact', sortKeys: true });
    writeFileSync(PAYLOAD_FIXTURE_PATH, newText);

    printDiffSummary('dashboard-payload.json', diffs);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const MODES: Record<string, () => void> = {
  parity: regenParity,
  payload: regenPayload,
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const mode = argv[0];
  if (mode === undefined || !(mode in MODES)) {
    console.error('usage: regen-golden.ts <parity|payload>');
    return 1;
  }
  (MODES[mode] as () => void)();
  return 0;
}

runIfMain(import.meta.url, main);
