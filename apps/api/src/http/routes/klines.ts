import type { RequestHandler } from 'express';

const FETCH_TIMEOUT_MS = 5_000;
const FRESH_CACHE_MS = 30_000;
const STALE_CACHE_MAX_MS = 5 * 60_000;

/** Only what the coin-detail chart offers a switcher for -- see apps/web/lib/klines.ts's CHART_INTERVALS. */
const ALLOWED_INTERVALS = ['15m', '1h', '4h'] as const;
type KlineInterval = (typeof ALLOWED_INTERVALS)[number];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

// Screener symbols are bare bases ("BTC", "1000PEPE") -- this is appended with "USDT" below, so it
// must never carry through anything but letters/digits into the upstream URL.
const SYMBOL_PATTERN = /^[A-Z0-9]{1,20}$/;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function firstQueryValue(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' ? candidate : undefined;
}

function isKlineInterval(value: string): value is KlineInterval {
  return (ALLOWED_INTERVALS as readonly string[]).includes(value);
}

/** Missing or non-numeric falls back to DEFAULT_LIMIT; anything else is clamped to [1, MAX_LIMIT]. */
function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

// Binance kline entry: [openTime, open, high, low, close, volume, closeTime, ...] -- openTime is
// milliseconds; Lightweight Charts (the web chart's renderer) wants seconds.
function parseKlineEntry(entry: unknown): Candle | null {
  if (!Array.isArray(entry)) return null;
  const [openTimeMs, open, high, low, close] = entry;
  const time = Math.floor(Number(openTimeMs) / 1000);
  const o = Number(open);
  const h = Number(high);
  const l = Number(low);
  const c = Number(close);
  if (![time, o, h, l, c].every((value) => Number.isFinite(value))) return null;
  return { time, open: o, high: h, low: l, close: c };
}

/**
 * Fetches one candle series from Binance's geo-unblocked market-data mirror (same host apps/api's
 * btcPulse.ts already relies on -- see its comment on api.binance.com's HTTP 451 from Railway).
 * `symbol` is expected pre-sanitized (see klinesRoute's SYMBOL_PATTERN check) since it's
 * interpolated directly into the upstream URL. Exported so the ms->s transform is testable
 * directly against an injected fetch-like function, separate from the route's cache/whitelist/503
 * behavior.
 */
export async function fetchKlines(
  symbol: string,
  interval: KlineInterval,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}USDT&interval=${interval}&limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`binance klines returned HTTP ${response.status}`);
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new Error('binance klines returned a non-array body');
    }
    const candles: Candle[] = [];
    for (const entry of body) {
      const candle = parseKlineEntry(entry);
      if (candle) candles.push(candle);
    }
    return candles;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`klines request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

interface CacheEntry {
  candles: Candle[];
  cachedAtMs: number;
}

/**
 * GET /api/klines?symbol=&interval=&limit= -- read-through proxy for the coin-detail chart's
 * candles, keyed per symbol+interval+limit combo (a coin's 1h candles don't need refetching on
 * every rail click). Same fresh/stale-on-failure/503 shape as btcPulseRoute, just keyed instead of
 * single-valued. `fetchCandles` is injectable for tests -- defaults to the live fetchKlines.
 */
export function klinesRoute(
  fetchCandles: (
    symbol: string,
    interval: KlineInterval,
    limit: number,
  ) => Promise<Candle[]> = fetchKlines,
): RequestHandler {
  const cache = new Map<string, CacheEntry>();

  return async (req, res) => {
    const symbol = (firstQueryValue(req.query.symbol) ?? '').toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol)) {
      res.status(400).json({ error: 'invalid_symbol' });
      return;
    }

    const intervalRaw = firstQueryValue(req.query.interval) ?? '1h';
    if (!isKlineInterval(intervalRaw)) {
      res.status(400).json({ error: 'invalid_interval' });
      return;
    }

    const limit = parseLimit(firstQueryValue(req.query.limit));
    const key = `${symbol}:${intervalRaw}:${limit}`;
    const cached = cache.get(key);

    if (cached && Date.now() - cached.cachedAtMs < FRESH_CACHE_MS) {
      res.json(cached.candles);
      return;
    }

    try {
      const candles = await fetchCandles(symbol, intervalRaw, limit);
      cache.set(key, { candles, cachedAtMs: Date.now() });
      res.json(candles);
    } catch {
      if (cached && Date.now() - cached.cachedAtMs < STALE_CACHE_MAX_MS) {
        res.json(cached.candles);
        return;
      }
      res.status(503).json({ error: 'klines_unavailable' });
    }
  };
}
