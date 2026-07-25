import type Database from 'better-sqlite3';
import { stableStringify } from './json.js';

/**
 * Backs the light/full refresh split (pipeline/runPipeline.ts, pipeline/collector.ts): a FULL run
 * harvests every CoinGlass history-derived enrichment field it fetched and saves it here, keyed by
 * symbol; a LIGHT run overlays those cached fields instead of refetching the ~584 CoinGlass history
 * calls that cannot have changed since the last 4h bar close (Hobbyist tier locks history to 4h
 * candles). Single-row table (id=1, see schema.ts) -- one full run's harvest replaces the previous
 * one outright, it never accumulates.
 */

/** Bump when the cached row shape changes incompatibly; loadEnrichmentCache degrades to null (a full run) rather than serving a light run fields shaped for an older version. */
export const CACHE_VERSION = 1;

export interface EnrichmentCacheBlob {
  rows: Record<string, Record<string, unknown>>;
}

interface EnrichmentCacheDbRow {
  cache_version: number;
  bar_ts_ms: number;
  payload_json: string;
}

/** INSERT OR REPLACE on id=1 -- see schema.ts's CHECK(id = 1); there is only ever one row. */
export function saveEnrichmentCache(
  db: Database.Database,
  barTsMs: number,
  blob: EnrichmentCacheBlob,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO enrichment_cache (id, cache_version, bar_ts_ms, harvested_at, payload_json)
    VALUES (1, ?, ?, ?, ?)
  `).run(CACHE_VERSION, barTsMs, new Date().toISOString(), stableStringify(blob));
}

/**
 * Null on anything that would make the cache unsafe to trust for a light run -- absent, a version
 * this build doesn't understand, or corrupt/malformed JSON -- rather than throwing. A light run's
 * whole reason to exist is skipping most of a refresh's CoinGlass calls; degrading silently to "no
 * cache" (which runPipeline.ts's mode decision then reads as "run full") is always safe, while
 * throwing here would take down a refresh that a plain full run could have completed fine.
 */
export function loadEnrichmentCache(
  db: Database.Database,
): { barTsMs: number; blob: EnrichmentCacheBlob } | null {
  const row = db
    .prepare('SELECT cache_version, bar_ts_ms, payload_json FROM enrichment_cache WHERE id = 1')
    .get() as EnrichmentCacheDbRow | undefined;
  if (row === undefined || row.cache_version !== CACHE_VERSION) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const rows = (parsed as { rows?: unknown }).rows;
    if (typeof rows !== 'object' || rows === null || Array.isArray(rows)) {
      return null;
    }
    return {
      barTsMs: row.bar_ts_ms,
      blob: { rows: rows as Record<string, Record<string, unknown>> },
    };
  } catch {
    return null;
  }
}
