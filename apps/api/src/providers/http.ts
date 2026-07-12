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

// Returns raw status/headers/body uninterpreted; each provider maps its own errors (CoinGecko also retries on 429).
export async function fetchWithTimeout(
  url: string,
  options: { headers?: Record<string, string>; timeoutSeconds: number },
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);
  try {
    const init: RequestInit = { signal: controller.signal };
    if (options.headers) {
      init.headers = options.headers;
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

// Shared status-check + parse step; each provider's getJson() calls this once it has decided
// not to retry (CoinGecko retries 429s around this call rather than through it).
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
