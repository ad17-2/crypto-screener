import { ProviderError } from './errors.js';
import { buildUrl, fetchWithTimeout, sleep } from './http.js';

export interface CoinGeckoClient {
  globalData(): Promise<Record<string, unknown>>;
  categories(): Promise<Record<string, unknown>[]>;
}

export interface CoinGeckoClientOptions {
  baseUrl?: string;
  apiKey?: string | null;
  timeoutSeconds?: number;
  userAgent?: string;
  retry429?: boolean;
  retry429InitialDelaySeconds?: number;
  retry429MaxDelaySeconds?: number;
  retry429JitterSeconds?: number;
  retry429MaxAttempts?: number;
}

type QueryParams = Record<string, string | number | boolean | undefined>;

export class CoinGeckoHttpClient implements CoinGeckoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutSeconds: number;
  private readonly userAgent: string;
  private readonly retry429: boolean;
  private readonly retry429InitialDelaySeconds: number;
  private readonly retry429MaxDelaySeconds: number;
  private readonly retry429JitterSeconds: number;
  private readonly retry429MaxAttempts: number;

  constructor(options: CoinGeckoClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://api.coingecko.com/api/v3';
    this.apiKey = options.apiKey ?? null;
    this.timeoutSeconds = options.timeoutSeconds ?? 12;
    this.userAgent = options.userAgent ?? 'codex-crypto-screener/0.2';
    this.retry429 = options.retry429 ?? true;
    this.retry429InitialDelaySeconds = options.retry429InitialDelaySeconds ?? 30;
    this.retry429MaxDelaySeconds = options.retry429MaxDelaySeconds ?? 300;
    this.retry429JitterSeconds = options.retry429JitterSeconds ?? 15;
    this.retry429MaxAttempts = options.retry429MaxAttempts ?? 0;
  }

  private async getJson(path: string, params?: QueryParams): Promise<unknown> {
    const url = buildUrl(this.baseUrl, path, params);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    if (this.apiKey) {
      headers['x-cg-demo-api-key'] = this.apiKey;
    }

    let attempt = 0;
    let delay = Math.max(0, this.retry429InitialDelaySeconds);

    for (;;) {
      const response = await fetchWithTimeout(url, {
        timeoutSeconds: this.timeoutSeconds,
        headers,
      });

      if (response.status >= 400) {
        if (!this.shouldRetry429(response.status, attempt)) {
          throw new ProviderError(
            `${path} returned HTTP ${response.status}: ${response.text.slice(0, 500)}`,
          );
        }
        attempt += 1;
        await sleep(this.retry429Delay(response.headers, delay));
        delay = Math.min(Math.max(delay * 2, 1.0), this.retry429MaxDelaySeconds);
        continue;
      }

      try {
        return JSON.parse(response.text);
      } catch {
        throw new ProviderError(`${path} returned invalid JSON`);
      }
    }
  }

  private shouldRetry429(statusCode: number, attempt: number): boolean {
    if (statusCode !== 429 || !this.retry429) {
      return false;
    }
    return this.retry429MaxAttempts <= 0 || attempt < this.retry429MaxAttempts;
  }

  private retry429Delay(headers: Headers, delay: number): number {
    const retryAfter = headers.get('Retry-After');
    if (retryAfter) {
      const parsed = Number.parseFloat(retryAfter);
      if (!Number.isNaN(parsed)) {
        return Math.max(0, parsed);
      }
    }
    const jitter = Math.random() * Math.max(0, this.retry429JitterSeconds);
    return Math.min(delay + jitter, this.retry429MaxDelaySeconds);
  }

  async globalData(): Promise<Record<string, unknown>> {
    const payload = await this.getJson('/global');
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return {};
    }
    const data = (payload as Record<string, unknown>).data;
    return typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  }

  async categories(): Promise<Record<string, unknown>[]> {
    const payload = await this.getJson('/coins/categories', { order: 'market_cap_desc' });
    return Array.isArray(payload) ? (payload as Record<string, unknown>[]) : [];
  }
}
