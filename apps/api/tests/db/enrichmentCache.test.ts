import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_VERSION,
  loadEnrichmentCache,
  saveEnrichmentCache,
} from '../../src/db/enrichmentCache.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  ({ dir, db } = setupTempDb('crypto-screener-enrichment-cache-'));
});

afterEach(() => {
  teardownTempDb(dir, db);
});

describe('enrichmentCache', () => {
  it('returns null when no cache has ever been saved', () => {
    expect(loadEnrichmentCache(db)).toBeNull();
  });

  it('round-trips a saved blob: same barTsMs and rows come back out', () => {
    const barTsMs = 1_753_400_000_000;
    const blob = {
      rows: {
        BTC: { technical_interval: '4h', rsi_14: 55.5, ema_20: 60000 },
        ETH: { technical_interval: '4h', rsi_14: 48.2 },
      },
    };

    saveEnrichmentCache(db, barTsMs, blob);
    const loaded = loadEnrichmentCache(db);

    expect(loaded).not.toBeNull();
    expect(loaded?.barTsMs).toBe(barTsMs);
    expect(loaded?.blob).toEqual(blob);
  });

  it('a second save replaces the first outright (single-row table, not accumulating)', () => {
    saveEnrichmentCache(db, 1_000, { rows: { BTC: { rsi_14: 1 } } });
    saveEnrichmentCache(db, 2_000, { rows: { ETH: { rsi_14: 2 } } });

    const loaded = loadEnrichmentCache(db);
    expect(loaded?.barTsMs).toBe(2_000);
    expect(loaded?.blob).toEqual({ rows: { ETH: { rsi_14: 2 } } });

    const rowCount = (
      db.prepare('SELECT COUNT(*) AS count FROM enrichment_cache').get() as { count: number }
    ).count;
    expect(rowCount).toBe(1);
  });

  it('returns null when the stored cache_version does not match CACHE_VERSION', () => {
    db.prepare(
      `INSERT OR REPLACE INTO enrichment_cache (id, cache_version, bar_ts_ms, harvested_at, payload_json)
       VALUES (1, ?, ?, ?, ?)`,
    ).run(CACHE_VERSION + 1, 1_000, new Date().toISOString(), JSON.stringify({ rows: {} }));

    expect(loadEnrichmentCache(db)).toBeNull();
  });

  it('returns null (never throws) when payload_json is corrupt', () => {
    db.prepare(
      `INSERT OR REPLACE INTO enrichment_cache (id, cache_version, bar_ts_ms, harvested_at, payload_json)
       VALUES (1, ?, ?, ?, ?)`,
    ).run(CACHE_VERSION, 1_000, new Date().toISOString(), '{not valid json');

    expect(() => loadEnrichmentCache(db)).not.toThrow();
    expect(loadEnrichmentCache(db)).toBeNull();
  });

  it('returns null when payload_json parses to something other than {rows: {...}}', () => {
    db.prepare(
      `INSERT OR REPLACE INTO enrichment_cache (id, cache_version, bar_ts_ms, harvested_at, payload_json)
       VALUES (1, ?, ?, ?, ?)`,
    ).run(CACHE_VERSION, 1_000, new Date().toISOString(), JSON.stringify([1, 2, 3]));

    expect(loadEnrichmentCache(db)).toBeNull();
  });
});
