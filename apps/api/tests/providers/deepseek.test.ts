import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepSeekClientOptions } from '../../src/providers/deepseek.js';
import { DeepSeekHttpClient } from '../../src/providers/deepseek.js';
import { ProviderError } from '../../src/providers/errors.js';

function fakeResponse(status: number, body: unknown) {
  return {
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

const FAKE_KEY = 'sk-test-fake-key';

describe('DeepSeekHttpClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function buildClient(overrides: Partial<DeepSeekClientOptions> = {}): DeepSeekHttpClient {
    return new DeepSeekHttpClient({ apiKey: FAKE_KEY, ...overrides });
  }

  it('extracts choices[0].message.content, ignores reasoning_content, and maps usage', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, {
        model: 'deepseek-v4-pro',
        choices: [
          {
            message: {
              content: '  Tonight the tape is quiet.  ',
              reasoning_content: 'internal chain of thought, never surfaced',
            },
          },
        ],
        usage: { completion_tokens: 512, completion_tokens_details: { reasoning_tokens: 400 } },
      }),
    );

    const result = await buildClient().complete('system prompt', 'user prompt');

    expect(result).toEqual({
      text: '  Tonight the tape is quiet.  ',
      model: 'deepseek-v4-pro',
      output_tokens: 512,
      reasoning_tokens: 400,
    });
  });

  it('resolves output_tokens/reasoning_tokens as null when usage is absent', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, { model: 'deepseek-v4-pro', choices: [{ message: { content: 'hi' } }] }),
    );

    const result = await buildClient().complete('s', 'u');

    expect(result.output_tokens).toBeNull();
    expect(result.reasoning_tokens).toBeNull();
  });

  it('sends model/reasoning_effort/max_tokens and the messages array in the request body', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, { model: 'deepseek-v4-pro', choices: [{ message: { content: 'ok' } }] }),
    );

    await buildClient({
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      maxOutputTokens: 4096,
    }).complete('system text', 'user text');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'user text' },
      ],
      stream: false,
      reasoning_effort: 'high',
      max_tokens: 4096,
    });
  });

  it('sends the resolved key as an Authorization: Bearer header', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, { model: 'deepseek-v4-pro', choices: [{ message: { content: 'ok' } }] }),
    );

    await buildClient().complete('s', 'u');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('rejects with ProviderError on a non-2xx response, previewing status + first 300 chars of body', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(500, { error: 'x'.repeat(400) }));

    const error = await buildClient()
      .complete('s', 'u')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain('HTTP 500');
    expect((error as Error).message).not.toContain(FAKE_KEY);
  });

  it('rejects with ProviderError when choices[0].message.content is missing', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, { model: 'deepseek-v4-pro', choices: [] }));

    await expect(buildClient().complete('s', 'u')).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects with ProviderError when choices[0].message.content is empty/whitespace', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, { model: 'deepseek-v4-pro', choices: [{ message: { content: '   ' } }] }),
    );

    await expect(buildClient().complete('s', 'u')).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects with ProviderError when no apiKey is set, without making a request', async () => {
    await expect(buildClient({ apiKey: '' }).complete('s', 'u')).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('respects the configured timeoutSeconds when the request hangs', async () => {
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
    const promise = client.complete('s', 'u');
    const assertion = expect(promise).rejects.toThrow(/timed out after 5s/);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
