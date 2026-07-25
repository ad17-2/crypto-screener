import type { HttpResponse, Retry429Options } from './http.js';
import { buildUrl, fetchWithRetry429, parseJsonResponse, sleep } from './http.js';

// CoinGecko's error_code 10010 nominally means "wrong root URL for your key tier" -- but a
// production incident (2026-07-25, run 20260725-133739) showed it firing for a transient
// quota/throttle condition too: the identical /global call, same key, same root URL, returned 200
// seconds later. So it's treated as retryable, matched on the structured error_code alone -- never
// the message string, which is CoinGecko's wording to change, not ours to depend on.
const COINGECKO_THROTTLE_ERROR_CODE = 10010;

// Small and hardcoded rather than threaded through CoinGeckoClientOptions/config: this pipeline
// runs on a ~27-minute budget, so a 400 retry has to stay short and bounded no matter what the
// existing (and deliberately unlimited, see retry429MaxAttempts default below) 429 retry is
// configured to do.
const THROTTLE_RETRY_MAX_ATTEMPTS = 2;
const THROTTLE_RETRY_DELAY_SECONDS = 2;

function isCoinGeckoThrottleError(response: HttpResponse): boolean {
  if (response.status !== 400) return false;
  try {
    const body: unknown = JSON.parse(response.text);
    return (
      typeof body === 'object' &&
      body !== null &&
      (body as Record<string, unknown>).error_code === COINGECKO_THROTTLE_ERROR_CODE
    );
  } catch {
    return false;
  }
}

export interface CoinGeckoClient {
  globalData(): Promise<Record<string, unknown>>;
  categories(): Promise<Record<string, unknown>[]>;
  categoryMembers(categoryId: string): Promise<string[]>;
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

    const requestOptions = { timeoutSeconds: this.timeoutSeconds, headers };
    const retry429Options: Retry429Options = {
      enabled: this.retry429,
      initialDelaySeconds: this.retry429InitialDelaySeconds,
      maxDelaySeconds: this.retry429MaxDelaySeconds,
      jitterSeconds: this.retry429JitterSeconds,
      maxAttempts: this.retry429MaxAttempts,
    };

    let response = await fetchWithRetry429(url, requestOptions, retry429Options);

    // shouldRetry429 (http.ts) can't express this: it retries on status code alone, and this
    // client's 429 retry is deliberately unlimited, which is the wrong bound for a status that is
    // normally a genuine client error. So a 10010-flavored 400 gets its own small, separately
    // bounded retry layered on top, rather than folding into fetchWithRetry429's policy.
    for (
      let attempt = 0;
      attempt < THROTTLE_RETRY_MAX_ATTEMPTS && isCoinGeckoThrottleError(response);
      attempt += 1
    ) {
      await sleep(THROTTLE_RETRY_DELAY_SECONDS);
      response = await fetchWithRetry429(url, requestOptions, retry429Options);
    }

    return parseJsonResponse(path, response);
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

  // Coin membership for one category, cheap: one call per sector rather than one per coin. See
  // pipeline/collector.ts's collectCoingeckoContext (screener_sector_members) and
  // pipeline/market.ts's screenerSectorRotation for the consumer.
  async categoryMembers(categoryId: string): Promise<string[]> {
    const payload = await this.getJson('/coins/markets', {
      vs_currency: 'usd',
      category: categoryId,
      per_page: 250,
      page: 1,
    });
    if (!Array.isArray(payload)) {
      return [];
    }
    const symbols: string[] = [];
    for (const item of payload as Record<string, unknown>[]) {
      const symbol = item.symbol;
      if (typeof symbol === 'string' && symbol.length > 0) {
        symbols.push(symbol.toUpperCase());
      }
    }
    return symbols;
  }
}
