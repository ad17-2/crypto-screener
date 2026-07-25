import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoinGeckoClientOptions } from '../../src/providers/coingecko.js';
import { CoinGeckoHttpClient } from '../../src/providers/coingecko.js';

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  };
}

describe('CoinGeckoHttpClient 429 retry', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function buildClient(overrides: Partial<CoinGeckoClientOptions> = {}): CoinGeckoHttpClient {
    return new CoinGeckoHttpClient({
      // Near-zero so retry delays never block the test run for real.
      retry429InitialDelaySeconds: 0,
      retry429MaxDelaySeconds: 0,
      retry429JitterSeconds: 0,
      ...overrides,
    });
  }

  it('retries once on 429 then succeeds on 200', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(429, {}, {}))
      .mockResolvedValueOnce(fakeResponse(200, { data: { active_cryptocurrencies: 1 } }));

    const client = buildClient();
    const result = await client.globalData();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ active_cryptocurrencies: 1 });
  });

  it('caps a Retry-After larger than retry429MaxDelaySeconds at the configured max', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(fakeResponse(429, {}, { 'Retry-After': '500' }))
      .mockResolvedValueOnce(fakeResponse(200, { data: {} }));

    const client = buildClient({ retry429InitialDelaySeconds: 0, retry429MaxDelaySeconds: 20 });
    const promise = client.globalData();

    await vi.advanceTimersByTimeAsync(19999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({});
  });

  it('honors an HTTP-date Retry-After, waiting until that time instead of the configured delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00Z'));
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse(429, {}, { 'Retry-After': new Date('2026-07-16T00:00:09Z').toUTCString() }),
      )
      .mockResolvedValueOnce(fakeResponse(200, { data: {} }));

    // Configured initial/max delay is deliberately huge so the assertion below only passes if
    // the HTTP-date header (9s from "now"), not the configured delay, drove the wait.
    const client = buildClient({ retry429InitialDelaySeconds: 999, retry429MaxDelaySeconds: 999 });
    const promise = client.globalData();

    await vi.advanceTimersByTimeAsync(8999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({});
  });
});

describe('CoinGeckoHttpClient 400/10010 throttle retry', () => {
  const fetchMock = vi.fn();
  const throttleBody = {
    error_code: 10010,
    error_message:
      'If you are using Pro API key, please change your root URL from api.coingecko.com to pro-api.coingecko.com',
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function buildClient(overrides: Partial<CoinGeckoClientOptions> = {}): CoinGeckoHttpClient {
    return new CoinGeckoHttpClient({
      // Near-zero so the (separate) 429 retry delay never blocks these tests.
      retry429InitialDelaySeconds: 0,
      retry429MaxDelaySeconds: 0,
      retry429JitterSeconds: 0,
      ...overrides,
    });
  }

  async function flushDelay() {
    // THROTTLE_RETRY_DELAY_SECONDS (coingecko.ts) is a plain sleep(), not gated by any retry429
    // config -- advance real time under fake timers to release it.
    await vi.advanceTimersByTimeAsync(2000);
  }

  it('retries a 400 carrying error_code 10010 and returns data once it succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(400, throttleBody))
      .mockResolvedValueOnce(fakeResponse(200, { data: { active_cryptocurrencies: 1 } }));

    const client = buildClient();
    const promise = client.globalData();
    await flushDelay();
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ active_cryptocurrencies: 1 });
  });

  it('does not retry a 400 without error_code 10010, failing fast', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(400, { error_code: 10011, error_message: 'some other client error' }),
    );

    const client = buildClient();
    await expect(client.globalData()).rejects.toThrow(/HTTP 400/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws once the bounded 10010 retry (at most twice) is exhausted', async () => {
    fetchMock.mockResolvedValue(fakeResponse(400, throttleBody));

    const client = buildClient();
    // Attach the rejection assertion synchronously, before the awaits below let the delayed
    // retries run -- otherwise the eventual rejection is briefly unhandled and vitest warns.
    const rejection = expect(client.globalData()).rejects.toThrow(/HTTP 400/);
    await flushDelay();
    await flushDelay();
    await rejection;

    // 1 initial call + at most 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
