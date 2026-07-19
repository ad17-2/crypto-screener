import { ProviderError } from './errors.js';

// Non-blocking rate-limit delay; must stay setTimeout-based, not a blocking sleep.
export function sleep(seconds: number): Promise<void> {
  if (seconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

// Returns raw status/headers/body uninterpreted; each provider maps its own errors and may retry
// via fetchWithRetry429 (below).
export async function fetchWithTimeout(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeoutSeconds: number;
    // Only DeepSeek (providers/deepseek.ts) currently sets these -- every other provider is GET-only.
    method?: string;
    body?: string;
  },
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);
  try {
    const init: RequestInit = { signal: controller.signal };
    if (options.headers) {
      init.headers = options.headers;
    }
    if (options.method) {
      init.method = options.method;
    }
    if (options.body !== undefined) {
      init.body = options.body;
    }
    const response = await fetch(url, init);
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderError(`${url} timed out after ${options.timeoutSeconds}s`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`${url} failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface Retry429Options {
  enabled: boolean;
  initialDelaySeconds: number;
  maxDelaySeconds: number;
  jitterSeconds: number;
  maxAttempts: number;
}

function shouldRetry429(statusCode: number, attempt: number, retry: Retry429Options): boolean {
  if (statusCode !== 429 || !retry.enabled) {
    return false;
  }
  return retry.maxAttempts <= 0 || attempt < retry.maxAttempts;
}

function retry429Delay(headers: Headers, delay: number, retry: Retry429Options): number {
  const retryAfter = headers.get('Retry-After');
  if (retryAfter) {
    // RFC 7231 allows delay-seconds or an HTTP-date. Both are capped at the configured max so a
    // misbehaving header can't reintroduce the unbounded hang this bounded retry exists to prevent.
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds)) {
      return Math.min(Math.max(0, seconds), retry.maxDelaySeconds);
    }
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(0, (dateMs - Date.now()) / 1000), retry.maxDelaySeconds);
    }
  }
  const jitter = Math.random() * Math.max(0, retry.jitterSeconds);
  return Math.min(delay + jitter, retry.maxDelaySeconds);
}

// Retries only HTTP 429s. maxAttempts <= 0 means unlimited — the bound is the caller's choice:
// CoinGlass bounds it (a refresh issues ~700 sequential requests; see config/schema.ts), while
// CoinGecko runs unlimited on its two O(1) calls.
export async function fetchWithRetry429(
  url: string,
  options: { headers?: Record<string, string>; timeoutSeconds: number },
  retry: Retry429Options,
): Promise<HttpResponse> {
  let attempt = 0;
  let delay = Math.max(0, retry.initialDelaySeconds);

  for (;;) {
    const response = await fetchWithTimeout(url, options);

    if (response.status >= 400 && shouldRetry429(response.status, attempt, retry)) {
      attempt += 1;
      await sleep(retry429Delay(response.headers, delay, retry));
      delay = Math.min(Math.max(delay * 2, 1.0), retry.maxDelaySeconds);
      continue;
    }

    return response;
  }
}

// Shared status-check + parse step; each provider's getJson() calls this once fetchWithRetry429
// has finished retrying (or immediately, if retries are disabled).
export function parseJsonResponse(path: string, response: HttpResponse): unknown {
  if (response.status >= 400) {
    throw new ProviderError(
      `${path} returned HTTP ${response.status}: ${response.text.slice(0, 500)}`,
    );
  }
  try {
    return JSON.parse(response.text);
  } catch {
    throw new ProviderError(`${path} returned invalid JSON`);
  }
}

export function buildUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined | null>,
): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  if (!params) {
    return url;
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      query.set(key, String(value));
    }
  }
  const search = query.toString();
  return search ? `${url}?${search}` : url;
}
