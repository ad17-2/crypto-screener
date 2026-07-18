import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/providers/errors.js';
import type { FearGreedClientOptions } from '../../src/providers/feargreed.js';
import { FearGreedHttpClient } from '../../src/providers/feargreed.js';

function fakeResponse(status: number, body: unknown) {
  return {
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

describe('FearGreedHttpClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function buildClient(overrides: Partial<FearGreedClientOptions> = {}): FearGreedHttpClient {
    return new FearGreedHttpClient(overrides);
  }

  it("parses today's string value into a number, plus the yesterday value", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, {
        data: [
          { value: '25', value_classification: 'Extreme Fear', timestamp: '111' },
          { value: '27', value_classification: 'Fear', timestamp: '222' },
        ],
        metadata: { error: null },
      }),
    );

    const result = await buildClient().latest();

    expect(result).toEqual({ value: 25, classification: 'Extreme Fear', yesterdayValue: 27 });
  });

  it('omits yesterdayValue (null) without failing when the second entry is absent', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, {
        data: [{ value: '60', value_classification: 'Greed', timestamp: '111' }],
        metadata: { error: null },
      }),
    );

    const result = await buildClient().latest();

    expect(result).toEqual({ value: 60, classification: 'Greed', yesterdayValue: null });
  });

  it('resolves classification as null when value_classification is missing or non-string', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, {
        data: [
          { value: '42', timestamp: '111' },
          { value: '27', value_classification: 'Fear', timestamp: '222' },
        ],
        metadata: { error: null },
      }),
    );

    const result = await buildClient().latest();

    expect(result).toEqual({ value: 42, classification: null, yesterdayValue: 27 });
  });

  it('treats a non-null metadata.error as a failure', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, {
        data: [{ value: '25', value_classification: 'Extreme Fear' }],
        metadata: { error: 'rate limited' },
      }),
    );

    await expect(buildClient().latest()).rejects.toBeInstanceOf(ProviderError);
  });

  it('treats a missing data array as a failure', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, { metadata: { error: null } }));

    await expect(buildClient().latest()).rejects.toBeInstanceOf(ProviderError);
  });

  it('treats an empty data array as a failure', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, { data: [], metadata: { error: null } }));

    await expect(buildClient().latest()).rejects.toBeInstanceOf(ProviderError);
  });

  it("treats a non-numeric today's value as a failure", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, {
        data: [{ value: 'not-a-number', value_classification: 'Extreme Fear' }],
        metadata: { error: null },
      }),
    );

    await expect(buildClient().latest()).rejects.toBeInstanceOf(ProviderError);
  });

  it('respects the configured request_timeout_seconds when the request hangs', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    const client = buildClient({ timeoutSeconds: 5 });
    const promise = client.latest();
    const assertion = expect(promise).rejects.toThrow(/timed out after 5s/);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
