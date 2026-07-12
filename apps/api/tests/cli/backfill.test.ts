import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackfillCliArgs, BackfillHistories } from '../../src/cli/backfill.js';
import { buildSymbolRows, runBackfill, scoreBackfillRows } from '../../src/cli/backfill.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import {
  loadLabeledFactorRecords,
  openDatabase,
  saveFactorHistoryRecords,
} from '../../src/db/index.js';
import type { FactorHistoryRecordInput } from '../../src/db/types.js';
import { rawFactors } from '../../src/pipeline/factors.js';
import type { Row } from '../../src/pipeline/types.js';
import { ProviderError } from '../../src/providers/errors.js';

function syntheticHistories(basePrice: number): BackfillHistories {
  const price: Record<string, unknown>[] = [];
  const oi: Record<string, unknown>[] = [];
  const funding: Record<string, unknown>[] = [];
  const liquidation: Record<string, unknown>[] = [];
  const taker: Record<string, unknown>[] = [];
  const start = 1_700_000_000_000;
  const step = 14_400_000;
  for (let index = 0; index < 70; index += 1) {
    const timeValue = start + index * step;
    const close = basePrice + index;
    price.push({
      time: timeValue,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume_usd: 1_000_000 + index * 10_000,
    });
    oi.push({ time: timeValue, close: 5_000_000 + index * 50_000 });
    funding.push({ time: timeValue, close: 0.01 });
    liquidation.push({
      time: timeValue,
      aggregated_long_liquidation_usd: 1000 + index,
      aggregated_short_liquidation_usd: 1500 + index,
    });
    taker.push({
      time: timeValue,
      aggregated_buy_volume_usd: 2000 + index,
      aggregated_sell_volume_usd: 1600 + index,
    });
  }
  return { price, oi, funding, liquidation, taker };
}

describe('backfill: buildSymbolRows + scoreBackfillRows write only compact factor_history', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crypto-screener-backfill-'));
    dbPath = join(dir, 'screener.sqlite3');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never writes runs/market_rows, only factor_history, and stays idempotent on re-save', () => {
    const rowsByTime = new Map<number, Row[]>();
    const symbols: Array<[number, string]> = [
      [0, 'BTC'],
      [1, 'ETH'],
      [2, 'SOL'],
    ];
    for (const [offset, symbol] of symbols) {
      const histories = syntheticHistories(100 + offset * 10);
      for (const row of buildSymbolRows(symbol, 'OKX', `${symbol}-USDT-SWAP`, '4h', histories)) {
        const timeValue = row._time as number;
        const existing = rowsByTime.get(timeValue);
        if (existing) {
          existing.push(row);
        } else {
          rowsByTime.set(timeValue, [row]);
        }
      }
    }

    const config = AppConfigSchema.parse({
      storage_path: dbPath,
      factors: { forward_return_hours: 24, ic_window_days: 5000, min_observations: 3 },
    });
    const records = scoreBackfillRows(rowsByTime, config, 3);
    expect(records.length).toBeGreaterThan(0);

    const db1 = openDatabase(dbPath);
    const firstSaved = saveFactorHistoryRecords(
      db1,
      records as unknown as FactorHistoryRecordInput[],
    );
    db1.close();

    const db2 = openDatabase(dbPath);
    const secondSaved = saveFactorHistoryRecords(
      db2,
      records as unknown as FactorHistoryRecordInput[],
    );
    const labels = loadLabeledFactorRecords(db2, { forwardReturnHours: 24, icWindowDays: 5000 });

    const runsCount = (db2.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number })
      .count;
    const marketRowsCount = (
      db2.prepare('SELECT COUNT(*) AS count FROM market_rows').get() as { count: number }
    ).count;
    const historyCount = (
      db2.prepare('SELECT COUNT(*) AS count FROM factor_history').get() as { count: number }
    ).count;
    const factorsJson = (
      db2.prepare('SELECT factors_json FROM factor_history LIMIT 1').get() as {
        factors_json: string;
      }
    ).factors_json;
    db2.close();

    expect(firstSaved).toBe(records.length);
    expect(secondSaved).toBe(records.length);
    expect(runsCount).toBe(0);
    expect(marketRowsCount).toBe(0);
    expect(historyCount).toBe(records.length);
    expect(factorsJson).toContain('oi_acceleration_signal');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('never aliases taker flow onto long_short_ratio, so ls_ratio_contrarian cannot be derived from taker_flow_24h', () => {
    const histories = syntheticHistories(100);
    const rows = buildSymbolRows('BTC', 'OKX', 'BTC-USDT-SWAP', '4h', histories);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.long_short_account_ratio).toBeUndefined();
      expect(row.long_short_ratio).toBeUndefined();
      // taker_buy_sell_ratio_24h is real (derivativesSnapshot sets it) -- the bug was aliasing
      // it onto long_short_ratio, making ls_ratio_contrarian a copy of taker_flow_24h.
      expect(row.taker_buy_sell_ratio_24h).not.toBeUndefined();
      expect(rawFactors(row, rows, {}).ls_ratio_contrarian).toBeNull();
    }
  });
});

describe('runBackfill: CRYPTO_SCREENER_DB_PATH ordering contract', () => {
  it('applies CRYPTO_SCREENER_DB_PATH to config.storage_path BEFORE COINGLASS_API_KEY validation', async () => {
    const config = AppConfigSchema.parse({
      storage_path: 'local.sqlite3',
      providers: { coinglass: { api_key_env: 'MISSING_TEST_KEY' } },
    });
    const args: BackfillCliArgs = {
      config: 'config/default.json',
      symbols: 'BTC',
      interval: '4h',
      limit: 60,
      minCrossSection: 3,
      requestDelaySeconds: 0,
      dryRun: true,
    };

    const originalDbPath = process.env.CRYPTO_SCREENER_DB_PATH;
    const originalKey = process.env.MISSING_TEST_KEY;
    process.env.CRYPTO_SCREENER_DB_PATH = '/data/crypto.sqlite3';
    delete process.env.MISSING_TEST_KEY;

    try {
      await expect(runBackfill(config, args)).rejects.toThrow(ProviderError);
    } finally {
      if (originalDbPath === undefined) {
        delete process.env.CRYPTO_SCREENER_DB_PATH;
      } else {
        process.env.CRYPTO_SCREENER_DB_PATH = originalDbPath;
      }
      if (originalKey !== undefined) {
        process.env.MISSING_TEST_KEY = originalKey;
      }
    }

    expect(config.storage_path).toBe('/data/crypto.sqlite3');
  });
});
