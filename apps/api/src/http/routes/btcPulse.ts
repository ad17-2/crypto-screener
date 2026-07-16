import type { BtcPulse } from '@crypto-screener/contracts';
import type { RequestHandler } from 'express';

const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
const FETCH_TIMEOUT_MS = 5_000;
const FRESH_CACHE_MS = 30_000;
const STALE_CACHE_MAX_MS = 5 * 60_000;

interface BinanceTickerResponse {
  price: string;
}

// Same AbortController idiom as providers/http.ts's fetchWithTimeout, kept local since that
// module's error type (ProviderError) is provider-pipeline-coupled and doesn't belong here.
async function fetchBtcPriceFromBinance(): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(BINANCE_TICKER_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`binance ticker returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as BinanceTickerResponse;
    const price = Number(body.price);
    if (!Number.isFinite(price)) {
      throw new Error('binance ticker returned a non-numeric price');
    }
    return price;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${BINANCE_TICKER_URL} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Near-live BTC spot price for dashboard staleness detection (batch runs land 4x/day).
 * In-memory cache: reused as-is if <30s old; on fetch failure, the stale value is still served
 * (200, with its original fetched_at) if <5min old, else 503 { error: 'btc_pulse_unavailable' }.
 * `fetchPrice` is injectable for tests -- defaults to the live Binance fetch.
 */
export function btcPulseRoute(
  fetchPrice: () => Promise<number> = fetchBtcPriceFromBinance,
): RequestHandler {
  let cached: BtcPulse | null = null;
  let cachedAtMs = 0;

  return async (_req, res) => {
    if (cached && Date.now() - cachedAtMs < FRESH_CACHE_MS) {
      res.json(cached);
      return;
    }

    try {
      const price = await fetchPrice();
      cachedAtMs = Date.now();
      cached = {
        price_usd: price,
        fetched_at: new Date(cachedAtMs).toISOString(),
        source: 'binance',
      };
      res.json(cached);
    } catch {
      if (cached && Date.now() - cachedAtMs < STALE_CACHE_MAX_MS) {
        res.json(cached);
        return;
      }
      res.status(503).json({ error: 'btc_pulse_unavailable' });
    }
  };
}
