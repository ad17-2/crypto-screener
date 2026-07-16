import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoinGlassClientOptions } from '../../src/providers/coinglass.js';
import { CoinGlassHttpClient } from '../../src/providers/coinglass.js';
import { ProviderError } from '../../src/providers/errors.js';

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  };
}

describe('CoinGlassHttpClient 429 retry', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function buildClient(overrides: Partial<CoinGlassClientOptions> = {}): CoinGlassHttpClient {
    return new CoinGlassHttpClient({
      apiKey: 'test-key',
      // Near-zero so retry delays never block the test run for real.
      retry429InitialDelaySeconds: 0,
      retry429MaxDelaySeconds: 0,
      retry429JitterSeconds: 0,
      retry429MaxAttempts: 3,
      ...overrides,
    });
  }

  it('retries once on 429 then succeeds on 200', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(429, {}, {}))
      .mockResolvedValueOnce(fakeResponse(200, { code: '0', data: [{ symbol: 'BTC' }] }));

    const client = buildClient();
    const result = await client.futuresPairsMarkets('BTC');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ symbol: 'BTC' }]);
  });

  it('throws a ProviderError mentioning 429 once maxAttempts is exhausted', async () => {
    fetchMock.mockResolvedValue(fakeResponse(429, {}, {}));
    const client = buildClient({ retry429MaxAttempts: 2 });

    await expect(client.futuresPairsMarkets('BTC')).rejects.toThrow(ProviderError);
    await expect(client.futuresPairsMarkets('BTC')).rejects.toThrow(/429/);
    // 1 initial attempt + 2 retries per call = 3 fetches; called twice above = 6.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('uses the Retry-After header value as the delay, not the configured initial delay', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(fakeResponse(429, {}, { 'Retry-After': '7' }))
      .mockResolvedValueOnce(fakeResponse(200, { code: '0', data: [] }));

    // Configured initial/max delay is deliberately huge so the assertion below only passes if
    // the Retry-After header (7s), not the configured delay, drove the wait.
    const client = buildClient({ retry429InitialDelaySeconds: 999, retry429MaxDelaySeconds: 999 });
    const promise = client.futuresPairsMarkets('BTC');

    await vi.advanceTimersByTimeAsync(6999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });

  it('caps a Retry-After larger than retry429MaxDelaySeconds at the configured max', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(fakeResponse(429, {}, { 'Retry-After': '500' }))
      .mockResolvedValueOnce(fakeResponse(200, { code: '0', data: [] }));

    const client = buildClient({ retry429InitialDelaySeconds: 0, retry429MaxDelaySeconds: 20 });
    const promise = client.futuresPairsMarkets('BTC');

    await vi.advanceTimersByTimeAsync(19999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });

  it('honors an HTTP-date Retry-After, waiting until that time instead of the configured delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00Z'));
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse(429, {}, { 'Retry-After': new Date('2026-07-16T00:00:09Z').toUTCString() }),
      )
      .mockResolvedValueOnce(fakeResponse(200, { code: '0', data: [] }));

    // Configured initial/max delay is deliberately huge so the assertion below only passes if
    // the HTTP-date header (9s from "now"), not the configured delay, drove the wait.
    const client = buildClient({ retry429InitialDelaySeconds: 999, retry429MaxDelaySeconds: 999 });
    const promise = client.futuresPairsMarkets('BTC');

    await vi.advanceTimersByTimeAsync(8999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });

  it('does not retry when retry429 is disabled, throwing immediately on the first 429', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(429, {}, {}));
    const client = buildClient({ retry429: false });

    await expect(client.futuresPairsMarkets('BTC')).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
