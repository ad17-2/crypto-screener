import { ProviderError } from './errors.js';
import { buildUrl, fetchWithTimeout, parseJsonResponse } from './http.js';

/**
 * alternative.me Fear & Greed Index (https://alternative.me/crypto/fear-and-greed-index/) --
 * keyless and free, so unlike CoinGecko/CoinGlass there is no api key or 429-retry config here.
 */

function toFloat(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface FearGreedSnapshot {
  value: number;
  /** null when value_classification is missing, non-string, or blank. */
  classification: string | null;
  /** null when yesterday's entry is absent or its value is unparseable -- never a failure on its own. */
  yesterdayValue: number | null;
}

export interface FearGreedClient {
  latest(): Promise<FearGreedSnapshot>;
}

export interface FearGreedClientOptions {
  baseUrl?: string;
  timeoutSeconds?: number;
  userAgent?: string;
}

const PATH = '/fng/';

export class FearGreedHttpClient implements FearGreedClient {
  private readonly baseUrl: string;
  private readonly timeoutSeconds: number;
  private readonly userAgent: string;

  constructor(options: FearGreedClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://api.alternative.me';
    this.timeoutSeconds = options.timeoutSeconds ?? 10;
    this.userAgent = options.userAgent ?? 'codex-crypto-screener/0.2';
  }

  async latest(): Promise<FearGreedSnapshot> {
    const url = buildUrl(this.baseUrl, PATH, { limit: 2 });
    const response = await fetchWithTimeout(url, {
      timeoutSeconds: this.timeoutSeconds,
      headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
    });
    const payload = parseJsonResponse(PATH, response);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new ProviderError(`${PATH} returned an unexpected payload shape`);
    }
    const record = payload as Record<string, unknown>;

    const metadata = record.metadata;
    const metadataError =
      typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).error
        : undefined;
    if (metadataError !== null && metadataError !== undefined) {
      throw new ProviderError(`${PATH} returned metadata.error: ${String(metadataError)}`);
    }

    const data = Array.isArray(record.data) ? (record.data as Record<string, unknown>[]) : [];
    if (data.length === 0) {
      throw new ProviderError(`${PATH} returned no data`);
    }

    const today = data[0] ?? {};
    const value = toFloat(today.value);
    if (value === null) {
      throw new ProviderError(`${PATH} returned an unparseable value`);
    }
    const trimmedClassification =
      typeof today.value_classification === 'string' ? today.value_classification.trim() : '';
    const classification = trimmedClassification.length > 0 ? trimmedClassification : null;

    const yesterday = data[1];
    const yesterdayValue = yesterday ? toFloat(yesterday.value) : null;

    return { value, classification, yesterdayValue };
  }
}
