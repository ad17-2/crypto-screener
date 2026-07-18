import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOutcomesCliArgs, runOutcomes } from '../../src/cli/outcomes.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import { openDatabase, saveFactorHistoryRecords } from '../../src/db/index.js';
import { formatJakartaIso } from '../../src/db/time.js';
import type { FactorHistoryRecordInput } from '../../src/db/types.js';

describe('parseOutcomesCliArgs', () => {
  it('defaults horizons to [24, 72], leaves symbols undefined, and dry-run off', () => {
    const args = parseOutcomesCliArgs(['--config', 'config/default.json']);
    expect(args.config).toBe('config/default.json');
    expect(args.horizons).toEqual([24, 72]);
    expect(args.symbols).toBeUndefined();
    expect(args.dryRun).toBe(false);
  });

  it('parses --horizons as a comma-separated number list', () => {
    const args = parseOutcomesCliArgs(['--horizons', '24,72,168']);
    expect(args.horizons).toEqual([24, 72, 168]);
  });

  it('parses --symbols as an uppercased comma-separated list', () => {
    const args = parseOutcomesCliArgs(['--symbols', 'btc, eth']);
    expect(args.symbols).toEqual(['BTC', 'ETH']);
  });

  it('parses --dry-run', () => {
    const args = parseOutcomesCliArgs(['--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('rejects a non-numeric --horizons value', () => {
    expect(() => parseOutcomesCliArgs(['--horizons', '24,not-a-number'])).toThrow(
      /invalid value for --horizons/,
    );
  });
});

describe('runOutcomes', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crypto-screener-outcomes-cli-'));
    dbPath = join(dir, 'screener.sqlite3');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(): void {
    const db = openDatabase(dbPath);
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const atHours = (h: number) => formatJakartaIso(new Date(t0.getTime() + h * 3_600_000));
    const records: FactorHistoryRecordInput[] = [
      { run_id: 't0', generated_at: atHours(0), symbol: 'SYM', price_usd: 100, is_trusted: true },
      { run_id: 't24', generated_at: atHours(24), symbol: 'SYM', price_usd: 110, is_trusted: true },
    ];
    saveFactorHistoryRecords(db, records);
    db.close();
  }

  it('writes outcome_labels rows for a real (non-dry-run) invocation', () => {
    seed();
    const config = AppConfigSchema.parse({ storage_path: dbPath });
    const summary = runOutcomes(config, {
      config: 'unused',
      horizons: [24],
      symbols: undefined,
      dryRun: false,
    });

    expect(summary.dry_run).toBe(false);
    expect(summary.written).toBeGreaterThan(0);

    const db = openDatabase(dbPath);
    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM outcome_labels').get() as { count: number }
    ).count;
    db.close();
    expect(count).toBe(summary.written);
  });

  it('--dry-run computes labels but writes nothing', () => {
    seed();
    const config = AppConfigSchema.parse({ storage_path: dbPath });
    const summary = runOutcomes(config, {
      config: 'unused',
      horizons: [24],
      symbols: undefined,
      dryRun: true,
    });

    expect(summary.dry_run).toBe(true);
    expect(summary.written).toBe(0);
    expect(summary.labeled[24]).toBeGreaterThan(0);

    const db = openDatabase(dbPath);
    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM outcome_labels').get() as { count: number }
    ).count;
    db.close();
    expect(count).toBe(0);
  });
});
