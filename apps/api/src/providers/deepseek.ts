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

export interface DeepSeekClient {
  complete(system: string, user: string): Promise<DeepSeekCompletion>;
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

  async complete(system: string, user: string): Promise<DeepSeekCompletion> {
    if (!this.apiKey) {
      throw new ProviderError('DeepSeek API key is not set');
    }

    const url = `${this.baseUrl.replace(/\/+$/, '')}${PATH}`;
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      reasoning_effort: this.reasoningEffort,
      max_tokens: this.maxOutputTokens,
    });

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
      body,
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

    const record = asRecord(payload);
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
}
