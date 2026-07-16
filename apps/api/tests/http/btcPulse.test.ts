import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { btcPulseRoute } from '../../src/http/routes/btcPulse.js';

// Only Date is faked -- supertest/superagent rely on real timers for the underlying HTTP call.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function buildApp(fetchPrice: () => Promise<number>) {
  const app = express();
  app.get('/api/btc-pulse', btcPulseRoute(fetchPrice));
  return app;
}

describe('GET /api/btc-pulse', () => {
  it('returns a fresh price on first fetch', async () => {
    const fetchPrice = vi.fn().mockResolvedValue(64709.99);
    const app = buildApp(fetchPrice);

    const response = await request(app).get('/api/btc-pulse');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      price_usd: 64709.99,
      fetched_at: '2026-07-16T00:00:00.000Z',
      source: 'binance',
    });
    expect(fetchPrice).toHaveBeenCalledOnce();
  });

  it('serves the cached price without refetching within 30s', async () => {
    const fetchPrice = vi.fn().mockResolvedValue(64709.99);
    const app = buildApp(fetchPrice);

    await request(app).get('/api/btc-pulse');
    vi.setSystemTime(new Date('2026-07-16T00:00:20.000Z')); // +20s, still under the 30s window
    const second = await request(app).get('/api/btc-pulse');

    expect(second.status).toBe(200);
    expect(second.body.fetched_at).toBe('2026-07-16T00:00:00.000Z');
    expect(fetchPrice).toHaveBeenCalledOnce();
  });

  it('serves the stale cached price on fetch failure if the cache is under 5min old', async () => {
    const fetchPrice = vi
      .fn()
      .mockResolvedValueOnce(64709.99)
      .mockRejectedValueOnce(new Error('boom'));
    const app = buildApp(fetchPrice);

    await request(app).get('/api/btc-pulse');
    vi.setSystemTime(new Date('2026-07-16T00:02:00.000Z')); // +2min: past 30s, under the 5min ceiling
    const second = await request(app).get('/api/btc-pulse');

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      price_usd: 64709.99,
      fetched_at: '2026-07-16T00:00:00.000Z',
      source: 'binance',
    });
    expect(fetchPrice).toHaveBeenCalledTimes(2);
  });

  it('503s on fetch failure with no cache yet', async () => {
    const fetchPrice = vi.fn().mockRejectedValue(new Error('boom'));
    const app = buildApp(fetchPrice);

    const response = await request(app).get('/api/btc-pulse');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'btc_pulse_unavailable' });
  });

  it('503s on fetch failure once the cache has passed the 5min ceiling', async () => {
    const fetchPrice = vi.fn().mockResolvedValueOnce(64709.99).mockRejectedValue(new Error('boom'));
    const app = buildApp(fetchPrice);

    await request(app).get('/api/btc-pulse');
    vi.setSystemTime(new Date('2026-07-16T00:06:00.000Z')); // +6min: past the 5min ceiling
    const second = await request(app).get('/api/btc-pulse');

    expect(second.status).toBe(503);
    expect(second.body).toEqual({ error: 'btc_pulse_unavailable' });
  });
});
