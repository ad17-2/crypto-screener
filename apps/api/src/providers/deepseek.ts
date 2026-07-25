import { ProviderError } from './errors.js';
import { fetchWithTimeout } from './http.js';

/**
 * DeepSeek chat-completions (https://api.deepseek.com/chat/completions), OpenAI-compatible --
 * powers the display-only "Tonight's read" briefing (see pipeline/briefing.ts). Unlike
 * CoinGlass/CoinGecko this issues exactly one request per refresh, so there is no 429-retry
 * wrapping here: fetchWithRetry429 exists to survive a burst across hundreds of sequential
 * per-symbol calls, which doesn't apply to a single completion call.
 */

const PATH = '/chat/completions';
const ERROR_BODY_PREVIEW_LENGTH = 300;

function toFloat(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface DeepSeekCompletion {
  text: string;
  model: string;
  output_tokens: number | null;
  reasoning_tokens: number | null;
}

export interface DeepSeekTool {
  name: string;
  description: string;
  /** JSON Schema for the function parameters. */
  parameters: Record<string, unknown>;
}

export interface DeepSeekToolInvocation {
  name: string;
  /** Raw JSON string of arguments as returned by the model; may be malformed. */
  argumentsJson: string;
}

export interface DeepSeekToolOptions {
  tools: DeepSeekTool[];
  /** Returns the tool result to feed back. Must never throw -- return an error string instead. */
  execute: (call: DeepSeekToolInvocation) => Promise<string>;
  /** Hard ceiling on model<->tool round trips. */
  maxIterations?: number;
  /** Overall wall-clock budget for the WHOLE loop in ms, checked before each request. */
  budgetMs?: number;
}

const DEFAULT_MAX_TOOL_ITERATIONS = 4;
const DEFAULT_TOOL_BUDGET_MS = 300_000;

export interface DeepSeekClient {
  complete(
    system: string,
    user: string,
    options?: DeepSeekToolOptions,
  ): Promise<DeepSeekCompletion>;
}

export interface DeepSeekClientOptions {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  reasoningEffort?: 'high' | 'max';
  timeoutSeconds?: number;
  maxOutputTokens?: number;
}

export class DeepSeekHttpClient implements DeepSeekClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly reasoningEffort: 'high' | 'max';
  private readonly timeoutSeconds: number;
  private readonly maxOutputTokens: number;

  constructor(options: DeepSeekClientOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.deepseek.com';
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'deepseek-v4-pro';
    this.reasoningEffort = options.reasoningEffort ?? 'max';
    // Max-effort reasoning is slow -- see config/schema.ts's request_timeout_seconds default (180s).
    this.timeoutSeconds = options.timeoutSeconds ?? 180;
    this.maxOutputTokens = options.maxOutputTokens ?? 8192;
  }

  async complete(
    system: string,
    user: string,
    options?: DeepSeekToolOptions,
  ): Promise<DeepSeekCompletion> {
    if (!this.apiKey) {
      throw new ProviderError('DeepSeek API key is not set');
    }

    if (options) {
      return this.completeWithTools(system, user, options);
    }

    const record = await this.postChatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);

    const choices = Array.isArray(record.choices) ? record.choices : [];
    const message = asRecord(choices[0]).message;
    // reasoning_content (chain-of-thought) lives alongside `content` here but is never read -- it
    // must not be stored or rendered.
    const content = asRecord(message).content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ProviderError(`${PATH} returned no completion text`);
    }

    const usage = asRecord(record.usage);
    const usageDetails = asRecord(usage.completion_tokens_details);

    return {
      text: content,
      model: typeof record.model === 'string' ? record.model : this.model,
      output_tokens: toFloat(usage.completion_tokens),
      reasoning_tokens: toFloat(usageDetails.reasoning_tokens),
    };
  }

  // Issues one POST and returns the parsed response body, uninterpreted. Shared by the plain
  // single-shot path and the tool loop below; when `tools` is omitted/empty the request body is
  // byte-identical to the pre-tool-calling shape (no `tools` key at all).
  private async postChatCompletion(
    messages: Array<Record<string, unknown>>,
    tools?: DeepSeekTool[],
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}${PATH}`;
    const bodyObj: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      reasoning_effort: this.reasoningEffort,
      max_tokens: this.maxOutputTokens,
    };
    if (tools && tools.length > 0) {
      bodyObj.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    const response = await fetchWithTimeout(url, {
      timeoutSeconds: this.timeoutSeconds,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'codex-crypto-screener/0.2',
        // Never log/echo this header -- see providers/deepseek.ts callers.
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(bodyObj),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError(
        `${PATH} returned HTTP ${response.status}: ${response.text.slice(0, ERROR_BODY_PREVIEW_LENGTH)}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw new ProviderError(`${PATH} returned invalid JSON`);
    }

    return asRecord(payload);
  }

  // Drives the model<->tool round-trip loop. `messages` starts as [system, user] and grows with
  // one assistant message (verbatim, minus reasoning_content) plus one `tool` message per call on
  // every iteration that requests tool calls, until a response comes back with plain text.
  private async completeWithTools(
    system: string,
    user: string,
    options: DeepSeekToolOptions,
  ): Promise<DeepSeekCompletion> {
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    const budgetMs = options.budgetMs ?? DEFAULT_TOOL_BUDGET_MS;
    const startedAt = Date.now();

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    let outputTokens: number | null = null;
    let reasoningTokens: number | null = null;
    let model = this.model;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (Date.now() - startedAt >= budgetMs) {
        throw new ProviderError('exceeded tool-loop budget');
      }

      const record = await this.postChatCompletion(messages, options.tools);

      const choices = Array.isArray(record.choices) ? record.choices : [];
      const choice = asRecord(choices[0]);
      const message = asRecord(choice.message);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      const usage = asRecord(record.usage);
      const usageDetails = asRecord(usage.completion_tokens_details);
      const iterationOutputTokens = toFloat(usage.completion_tokens);
      const iterationReasoningTokens = toFloat(usageDetails.reasoning_tokens);
      if (iterationOutputTokens !== null) {
        outputTokens = (outputTokens ?? 0) + iterationOutputTokens;
      }
      if (iterationReasoningTokens !== null) {
        reasoningTokens = (reasoningTokens ?? 0) + iterationReasoningTokens;
      }
      model = typeof record.model === 'string' ? record.model : model;

      if (choice.finish_reason === 'tool_calls' || toolCalls.length > 0) {
        // Append the assistant message verbatim (retaining tool_calls + their ids) so the next
        // request's history matches what the model actually produced -- except reasoning_content
        // (chain-of-thought), which must never be stored or rendered; see the comment in
        // complete() above.
        const assistantMessage: Record<string, unknown> = { ...message };
        delete assistantMessage.reasoning_content;
        messages.push(assistantMessage);

        for (const rawCall of toolCalls) {
          const call = asRecord(rawCall);
          const toolCallId = typeof call.id === 'string' ? call.id : '';
          const fn = asRecord(call.function);
          const invocation: DeepSeekToolInvocation = {
            name: typeof fn.name === 'string' ? fn.name : '',
            argumentsJson: typeof fn.arguments === 'string' ? fn.arguments : '',
          };

          let toolContent: string;
          try {
            toolContent = await options.execute(invocation);
          } catch (error) {
            // execute() is documented as never throwing, but the loop must survive it anyway --
            // feed the failure back to the model as a tool result instead of aborting.
            const errorMessage = error instanceof Error ? error.message : String(error);
            toolContent = `tool error: ${errorMessage}`;
          }

          messages.push({ role: 'tool', tool_call_id: toolCallId, content: toolContent });
        }

        continue;
      }

      const content = message.content;
      if (typeof content === 'string' && content.trim().length > 0) {
        return {
          text: content,
          model,
          output_tokens: outputTokens,
          reasoning_tokens: reasoningTokens,
        };
      }

      throw new ProviderError(`${PATH} returned no completion text`);
    }

    throw new ProviderError(`exhausted ${maxIterations} tool iterations`);
  }
}
