import { ProviderError } from './errors.js';
import { buildUrl, fetchWithTimeout, parseJsonResponse } from './http.js';

// Loosely typed on purpose: fields are read defensively via `toFloat`, not exhaustively modeled.
export type CoinGlassPair = Record<string, unknown>;
export type CoinGlassHistoryRow = Record<string, unknown>;

export interface CoinGlassClient {
  supportedExchangePairs(exchange?: string): Promise<Record<string, CoinGlassPair[]>>;
  futuresPairsMarkets(symbol: string): Promise<CoinGlassPair[]>;
  priceHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  openInterestAggregatedHistory(
    symbol: string,
    interval: string,
    limit: number,
    unit?: string,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  fundingOiWeightHistory(
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  liquidationAggregatedHistory(
    exchangeList: string[],
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  aggregatedTakerBuySellHistory(
    exchangeList: string[],
    symbol: string,
    interval: string,
    limit: number,
    unit?: string,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  globalLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  topLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  topLongShortPositionRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
}

export interface CoinGlassClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutSeconds?: number;
  userAgent?: string;
}

type QueryParams = Record<string, string | number | boolean | undefined>;

export class CoinGlassHttpClient implements CoinGlassClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutSeconds: number;
  private readonly userAgent: string;

  constructor(options: CoinGlassClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://open-api-v4.coinglass.com';
    this.timeoutSeconds = options.timeoutSeconds ?? 12;
    this.userAgent = options.userAgent ?? 'codex-crypto-screener/0.2';
  }

  private async getJson(path: string, params?: QueryParams): Promise<unknown> {
    if (!this.apiKey) {
      throw new ProviderError('CoinGlass API key is not set');
    }

    const url = buildUrl(this.baseUrl, path, params);
    const response = await fetchWithTimeout(url, {
      timeoutSeconds: this.timeoutSeconds,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'CG-API-KEY': this.apiKey,
        'User-Agent': this.userAgent,
      },
    });

    const payload = parseJsonResponse(path, response);

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new ProviderError(`${path} returned non-object JSON payload`);
    }

    const record = payload as Record<string, unknown>;
    const code = String(record.code ?? '0');
    if (code !== '0' && code !== '200') {
      throw new ProviderError(`${path} returned code ${code}: ${String(record.msg)}`);
    }
    return record.data;
  }

  // Coerces a non-array payload to `[]` rather than throwing.
  private async getJsonArray(
    path: string,
    params?: QueryParams,
  ): Promise<Record<string, unknown>[]> {
    const data = await this.getJson(path, params);
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  }

  async supportedExchangePairs(exchange?: string): Promise<Record<string, CoinGlassPair[]>> {
    const data = await this.getJson(
      '/api/futures/supported-exchange-pairs',
      exchange ? { exchange } : undefined,
    );
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return {};
    }
    const result: Record<string, CoinGlassPair[]> = {};
    for (const [exchangeName, pairs] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(pairs)) {
        result[exchangeName] = pairs as CoinGlassPair[];
      }
    }
    return result;
  }

  async futuresPairsMarkets(symbol: string): Promise<CoinGlassPair[]> {
    return this.getJsonArray('/api/futures/pairs-markets', { symbol });
  }

  async priceHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return this.getJsonArray('/api/futures/price/history', {
      exchange,
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
  }

  async openInterestAggregatedHistory(
    symbol: string,
    interval: string,
    limit: number,
    unit = 'usd',
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return this.getJsonArray('/api/futures/open-interest/aggregated-history', {
      symbol,
      interval,
      limit,
      unit,
      start_time: startTime,
      end_time: endTime,
    });
  }

  async fundingOiWeightHistory(
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return this.getJsonArray('/api/futures/funding-rate/oi-weight-history', {
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
  }

  async liquidationAggregatedHistory(
    exchangeList: string[],
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return this.getJsonArray('/api/futures/liquidation/aggregated-history', {
      exchange_list: exchangeList.join(','),
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
  }

  async aggregatedTakerBuySellHistory(
    exchangeList: string[],
    symbol: string,
    interval: string,
    limit: number,
    unit = 'usd',
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return this.getJsonArray('/api/futures/aggregated-taker-buy-sell-volume/history', {
      exchange_list: exchangeList.join(','),
      symbol,
      interval,
      limit,
      unit,
      start_time: startTime,
      end_time: endTime,
    });
  }

  async globalLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return this.getJsonArray('/api/futures/global-long-short-account-ratio/history', {
      exchange,
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
  }

  async topLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return this.getJsonArray('/api/futures/top-long-short-account-ratio/history', {
      exchange,
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
  }

  async topLongShortPositionRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    return this.getJsonArray('/api/futures/top-long-short-position-ratio/history', {
      exchange,
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
  }
}
