import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Candle, fetchKlines, klinesRoute } from '../../src/http/routes/klines.js';

// Only Date is faked -- supertest/superagent rely on real timers for the underlying HTTP call.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function buildApp(
  fetchCandles: (symbol: string, interval: string, limit: number) => Promise<Candle[]>,
) {
  const app = express();
  app.get('/api/klines', klinesRoute(fetchCandles as Parameters<typeof klinesRoute>[0]));
  return app;
}

const SAMPLE_CANDLES: Candle[] = [
  { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
  { time: 1_752_638_400, open: 64200, high: 64700, low: 64100, close: 64600 },
];

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function httpErrorResponse(status: number): Response {
  return { ok: false, status, json: () => Promise.resolve(undefined) } as unknown as Response;
}

describe('GET /api/klines', () => {
  it('returns candles on a fresh fetch', async () => {
    const fetchCandles = vi.fn().mockResolvedValue(SAMPLE_CANDLES);
    const app = buildApp(fetchCandles);

    const response = await request(app).get('/api/klines?symbol=BTC&interval=1h&limit=200');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(SAMPLE_CANDLES);
    expect(fetchCandles).toHaveBeenCalledWith('BTC', '1h', 200);
  });

  it('uppercases a lowercase symbol before calling through', async () => {
    const fetchCandles = vi.fn().mockResolvedValue(SAMPLE_CANDLES);
    const app = buildApp(fetchCandles);

    await request(app).get('/api/klines?symbol=btc&interval=1h');

    expect(fetchCandles).toHaveBeenCalledWith('BTC', '1h', 200);
  });

  it('400s on a missing symbol', async () => {
    const fetchCandles = vi.fn();
    const app = buildApp(fetchCandles);

    const response = await request(app).get('/api/klines?interval=1h');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_symbol' });
    expect(fetchCandles).not.toHaveBeenCalled();
  });

  it('400s on a symbol with characters outside [A-Z0-9]', async () => {
    const fetchCandles = vi.fn();
    const app = buildApp(fetchCandles);

    const response = await request(app).get('/api/klines?symbol=BTC%2FUSDT&interval=1h');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_symbol' });
    expect(fetchCandles).not.toHaveBeenCalled();
  });

  it('400s on an interval outside the whitelist', async () => {
    const fetchCandles = vi.fn();
    const app = buildApp(fetchCandles);

    const response = await request(app).get('/api/klines?symbol=BTC&interval=5m');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_interval' });
    expect(fetchCandles).not.toHaveBeenCalled();
  });

  it('defaults to the 1h interval when none is given', async () => {
    const fetchCandles = vi.fn().mockResolvedValue(SAMPLE_CANDLES);
    const app = buildApp(fetchCandles);

    await request(app).get('/api/klines?symbol=BTC');

    expect(fetchCandles).toHaveBeenCalledWith('BTC', '1h', 200);
  });

  it('clamps a limit above the max down to 500', async () => {
    const fetchCandles = vi.fn().mockResolvedValue(SAMPLE_CANDLES);
    const app = buildApp(fetchCandles);

    await request(app).get('/api/klines?symbol=BTC&interval=1h&limit=99999');

    expect(fetchCandles).toHaveBeenCalledWith('BTC', '1h', 500);
  });

  it('falls back to the default limit on a non-numeric value', async () => {
    const fetchCandles = vi.fn().mockResolvedValue(SAMPLE_CANDLES);
    const app = buildApp(fetchCandles);

    await request(app).get('/api/klines?symbol=BTC&interval=1h&limit=not-a-number');

    expect(fetchCandles).toHaveBeenCalledWith('BTC', '1h', 200);
  });

  it('serves the cached candles without refetching within 30s', async () => {
    const fetchCandles = vi.fn().mockResolvedValue(SAMPLE_CANDLES);
    const app = buildApp(fetchCandles);

    await request(app).get('/api/klines?symbol=BTC&interval=1h');
    vi.setSystemTime(new Date('2026-07-16T00:00:20.000Z')); // +20s, still under the 30s window
    const second = await request(app).get('/api/klines?symbol=BTC&interval=1h');

    expect(second.status).toBe(200);
    expect(second.body).toEqual(SAMPLE_CANDLES);
    expect(fetchCandles).toHaveBeenCalledOnce();
  });

  it('serves the stale cached candles on fetch failure if the cache is under 5min old', async () => {
    const fetchCandles = vi
      .fn()
      .mockResolvedValueOnce(SAMPLE_CANDLES)
      .mockRejectedValueOnce(new Error('boom'));
    const app = buildApp(fetchCandles);

    await request(app).get('/api/klines?symbol=BTC&interval=1h');
    vi.setSystemTime(new Date('2026-07-16T00:02:00.000Z')); // +2min: past 30s, under the 5min ceiling
    const second = await request(app).get('/api/klines?symbol=BTC&interval=1h');

    expect(second.status).toBe(200);
    expect(second.body).toEqual(SAMPLE_CANDLES);
    expect(fetchCandles).toHaveBeenCalledTimes(2);
  });

  it('503s on fetch failure with no cache yet', async () => {
    const fetchCandles = vi.fn().mockRejectedValue(new Error('boom'));
    const app = buildApp(fetchCandles);

    const response = await request(app).get('/api/klines?symbol=BTC&interval=1h');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'klines_unavailable' });
  });

  it('503s on fetch failure once the cache has passed the 5min ceiling', async () => {
    const fetchCandles = vi
      .fn()
      .mockResolvedValueOnce(SAMPLE_CANDLES)
      .mockRejectedValue(new Error('boom'));
    const app = buildApp(fetchCandles);

    await request(app).get('/api/klines?symbol=BTC&interval=1h');
    vi.setSystemTime(new Date('2026-07-16T00:06:00.000Z')); // +6min: past the 5min ceiling
    const second = await request(app).get('/api/klines?symbol=BTC&interval=1h');

    expect(second.status).toBe(503);
    expect(second.body).toEqual({ error: 'klines_unavailable' });
  });

  it('caches each symbol+interval+limit combo independently', async () => {
    const fetchCandles = vi.fn().mockResolvedValue(SAMPLE_CANDLES);
    const app = buildApp(fetchCandles);

    await request(app).get('/api/klines?symbol=BTC&interval=1h');
    await request(app).get('/api/klines?symbol=ETH&interval=1h');
    await request(app).get('/api/klines?symbol=BTC&interval=4h');

    expect(fetchCandles).toHaveBeenCalledTimes(3);
  });
});

describe('fetchKlines', () => {
  it('requests the symbol+USDT pair, interval, and limit from the Binance mirror', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

    await fetchKlines('BTC', '1h', 200, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200',
    );
  });

  it('converts Binance kline arrays (ms open time) into seconds-based candles', async () => {
    const raw = [
      [
        1_752_624_000_000, // openTime, ms
        '64000.10',
        '64500.50',
        '63800.00',
        '64200.25',
        '1234.5', // volume
        1_752_637_199_999, // closeTime
        '79000000.0',
        4200,
        '600.0',
        '38500000.0',
        '0',
      ],
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(raw));

    const result = await fetchKlines('BTC', '1h', 200, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual([
      { time: 1_752_624_000, open: 64000.1, high: 64500.5, low: 63800, close: 64200.25 },
    ]);
  });

  it('drops malformed entries instead of throwing', async () => {
    const raw = [
      [1_752_624_000_000, '64000', '64500', '63800', '64200'],
      'not-an-array',
      [1_752_638_400_000, 'nan', '64700', '64100', '64600'],
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(raw));

    const result = await fetchKlines('BTC', '1h', 200, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual([
      { time: 1_752_624_000, open: 64000, high: 64500, low: 63800, close: 64200 },
    ]);
  });

  it('throws on a non-2xx upstream response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(httpErrorResponse(451));

    await expect(
      fetchKlines('BTC', '1h', 200, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('HTTP 451');
  });

  it('throws when the upstream body is not an array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: -1121, msg: 'bad symbol' }));

    await expect(
      fetchKlines('BTC', '1h', 200, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('non-array body');
  });
});
