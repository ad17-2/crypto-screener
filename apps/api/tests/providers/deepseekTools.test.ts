import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepSeekTool, DeepSeekToolInvocation } from '../../src/providers/deepseek.js';
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

function textResponse(text: string) {
  return fakeResponse(200, {
    model: 'deepseek-v4-pro',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 10 } },
  });
}

function toolCallResponse(
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>,
  messageExtra: Record<string, unknown> = {},
) {
  return fakeResponse(200, {
    model: 'deepseek-v4-pro',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.argumentsJson },
          })),
          ...messageExtra,
        },
      },
    ],
    usage: { completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 60 } },
  });
}

describe('DeepSeekHttpClient tool-calling', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    // See providers/deepseek.test.ts's precedent: an ambient DEEPSEEK_API_KEY on a dev laptop or
    // in shared CI secrets would turn these unit tests into live, paid API calls if any path ever
    // fell back to reading the env directly instead of the explicit apiKey passed to buildClient.
    vi.stubEnv('DEEPSEEK_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function buildClient(): DeepSeekHttpClient {
    return new DeepSeekHttpClient({ apiKey: FAKE_KEY });
  }

  const noopTool: DeepSeekTool = { name: 'noop', description: 'no-op', parameters: {} };

  it('with no options, sends a request body with no tools key and behaves exactly like today', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('plain answer'));

    const result = await buildClient().complete('system prompt', 'user prompt');

    expect(result).toEqual({
      text: 'plain answer',
      model: 'deepseek-v4-pro',
      output_tokens: 50,
      reasoning_tokens: 10,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('tools');
    expect(body).toEqual({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
      stream: false,
      reasoning_effort: 'max',
      max_tokens: 8192,
    });
  });

  it('runs one tool round trip: executes the call and feeds tool_call_id-matched content back', async () => {
    fetchMock
      .mockResolvedValueOnce(
        toolCallResponse([{ id: 'call_1', name: 'get_price', argumentsJson: '{"symbol":"BTC"}' }]),
      )
      .mockResolvedValueOnce(textResponse('BTC is at 65000.'));

    const execute = vi.fn(async (call: DeepSeekToolInvocation) => {
      expect(call).toEqual({ name: 'get_price', argumentsJson: '{"symbol":"BTC"}' });
      return '65000';
    });

    const tools: DeepSeekTool[] = [
      {
        name: 'get_price',
        description: 'Gets a price',
        parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
      },
    ];

    const result = await buildClient().complete('system', 'user', { tools, execute });

    expect(result.text).toBe('BTC is at 65000.');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const firstBody = JSON.parse(firstInit.body as string);
    expect(firstBody.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_price',
          description: 'Gets a price',
          parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
        },
      },
    ]);

    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string);
    expect(secondBody.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_price', arguments: '{"symbol":"BTC"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '65000' },
    ]);
  });

  it('enforces maxIterations: throws ProviderError after exactly maxIterations requests', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse([{ id: 'call_x', name: 'noop', argumentsJson: '{}' }]),
    );
    const execute = vi.fn(async () => 'ok');

    const error = await buildClient()
      .complete('system', 'user', { tools: [noopTool], execute, maxIterations: 3 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain('exhausted 3 tool iterations');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('enforces budgetMs: stops before issuing another request once the wall-clock budget is gone', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => {
      // Simulate the request itself consuming wall-clock time, without a real sleep -- fake
      // timers make Date.now() advance so the budget check on the *next* iteration trips.
      vi.advanceTimersByTime(200);
      return toolCallResponse([{ id: 'call_x', name: 'noop', argumentsJson: '{}' }]);
    });
    const execute = vi.fn(async () => 'ok');

    const promise = buildClient().complete('system', 'user', {
      tools: [noopTool],
      execute,
      maxIterations: 10,
      budgetMs: 150,
    });

    await expect(promise).rejects.toThrow(/exceeded tool-loop budget/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sums output_tokens and reasoning_tokens across all iterations', async () => {
    fetchMock
      .mockResolvedValueOnce(
        toolCallResponse([{ id: 'call_1', name: 'noop', argumentsJson: '{}' }]),
      )
      .mockResolvedValueOnce(textResponse('done'));
    const execute = vi.fn(async () => 'ok');

    const result = await buildClient().complete('system', 'user', { tools: [noopTool], execute });

    expect(result.output_tokens).toBe(150); // 100 (tool_calls response) + 50 (final response)
    expect(result.reasoning_tokens).toBe(70); // 60 + 10
  });

  it('does not forward reasoning_content on the assistant tool-call message', async () => {
    fetchMock
      .mockResolvedValueOnce(
        toolCallResponse([{ id: 'call_1', name: 'noop', argumentsJson: '{}' }], {
          reasoning_content: 'internal chain of thought, never surfaced',
        }),
      )
      .mockResolvedValueOnce(textResponse('done'));
    const execute = vi.fn(async () => 'ok');

    await buildClient().complete('system', 'user', { tools: [noopTool], execute });

    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string);
    const assistantMessage = secondBody.messages[2];
    expect(assistantMessage).not.toHaveProperty('reasoning_content');
  });

  it('feeds an execute() rejection back as tool content instead of aborting the loop', async () => {
    fetchMock
      .mockResolvedValueOnce(
        toolCallResponse([{ id: 'call_1', name: 'flaky', argumentsJson: '{}' }]),
      )
      .mockResolvedValueOnce(textResponse('recovered'));
    const execute = vi.fn(async () => {
      throw new Error('boom');
    });

    const result = await buildClient().complete('system', 'user', {
      tools: [{ name: 'flaky', description: 'always fails', parameters: {} }],
      execute,
    });

    expect(result.text).toBe('recovered');
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string);
    expect(secondBody.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'tool error: boom',
    });
  });
});
