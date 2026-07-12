import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import { openDatabase } from '../../src/db/client.js';

const { collectMarketMock, scoreSnapshotMock, saveSnapshotMock, writeReportsMock } = vi.hoisted(
  () => ({
    collectMarketMock: vi.fn(),
    scoreSnapshotMock: vi.fn(),
    saveSnapshotMock: vi.fn(),
    writeReportsMock: vi.fn(),
  }),
);

// db/index.js's read-path functions are left real, only saveSnapshot is stubbed -- with
// storage_path=":memory:" below they run against a genuine, freshly-empty in-memory db.
vi.mock('../../src/pipeline/collector.js', () => ({ collectMarket: collectMarketMock }));
vi.mock('../../src/pipeline/factors.js', () => ({ scoreSnapshot: scoreSnapshotMock }));
vi.mock('../../src/reports/writeReports.js', () => ({ writeReports: writeReportsMock }));
vi.mock('../../src/db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/index.js')>();
  return { ...actual, saveSnapshot: saveSnapshotMock };
});

const { runPipeline } = await import('../../src/pipeline/runPipeline.js');

describe('runPipeline', () => {
  it('save=true + writeReportFiles=false calls saveSnapshot once and skips writeReports', async () => {
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    const collected = {
      rows: [{ symbol: 'BTC' }],
      market_context: { btc_dominance_pct: 55 },
      provider_status: { coinglass: { status: 'ok' } },
    };
    // market_context omitted here on purpose: exercises the fallback to collected.market_context.
    const scored = {
      rows: [{ symbol: 'BTC', scores: {}, factors: {} }],
      factor_weights: { mode: 'prior' },
      regime: { bias: 'risk-on' },
    };

    collectMarketMock.mockResolvedValueOnce(collected);
    scoreSnapshotMock.mockReturnValueOnce(scored);

    const { payload, paths } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: true,
      writeReportFiles: false,
    });

    expect(payload.rows).toEqual(scored.rows);
    expect(payload.market_context).toEqual(collected.market_context);
    expect(paths).toEqual({});
    expect(saveSnapshotMock).toHaveBeenCalledOnce();
    expect(writeReportsMock).not.toHaveBeenCalled();
  });

  it('persists one recommendations row per watchlist a row lands in, on a real db file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crypto-screener-run-pipeline-'));
    const dbPath = join(dir, 'screener.sqlite3');
    try {
      const config = AppConfigSchema.parse({ storage_path: dbPath });
      const collected = {
        rows: [{ symbol: 'BTC' }],
        market_context: { btc_dominance_pct: 55 },
        provider_status: { coinglass: { status: 'ok' } },
      };
      const scored = {
        rows: [
          {
            symbol: 'BTC',
            factor_score: 0.8,
            long_score: 5,
            is_trusted: true,
            scores: { factor_score: 0.8, round_trip_cost_pct: 0.05 },
          },
        ],
        factor_weights: { mode: 'prior' },
        regime: { bias: 'risk-on' },
      };
      collectMarketMock.mockResolvedValueOnce(collected);
      scoreSnapshotMock.mockReturnValueOnce(scored);

      const { payload } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
        save: true,
        writeReportFiles: false,
      });

      // A fresh connection to the same file, not the pipeline's own (closed) handle.
      const db = openDatabase(dbPath);
      try {
        const rows = db
          .prepare(
            'SELECT symbol, watchlist, priority, factor_score, round_trip_cost_pct FROM recommendations WHERE run_id = ?',
          )
          .all(payload.run_id) as Array<{
          symbol: string;
          watchlist: string;
          priority: number;
          factor_score: number;
          round_trip_cost_pct: number;
        }>;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.map((row) => row.watchlist)).toEqual(expect.arrayContaining(['core', 'long']));
        for (const row of rows) {
          expect(row.symbol).toBe('BTC');
          expect(row.factor_score).toBe(0.8);
          expect(row.round_trip_cost_pct).toBe(0.05);
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
