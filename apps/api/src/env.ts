import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from './config/index.js';
import { loadConfig } from './config/index.js';

/** No HOST/PORT here: apps/web owns the public $PORT and proxies to this process, which only ever binds 127.0.0.1:API_PORT. */

const rawEnvSchema = z.object({
  CRYPTO_SCREENER_CONFIG: z.string().default('config/default.json'),
  CRYPTO_SCREENER_DB_PATH: z.string().optional(),
  CRYPTO_SCREENER_REPORT_DIR: z.string().default('reports'),
  API_PORT: z.coerce.number().int().default(4000),
  CRYPTO_DASHBOARD_LIMIT: z.coerce.number().int().optional(),
  CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS: z.coerce.number().int().default(0),
  CRYPTO_DASHBOARD_DAILY_REFRESH_TIME: z.string().optional(),
  CRYPTO_DASHBOARD_REFRESH_TIME: z.string().optional(),
  CRYPTO_DASHBOARD_REFRESH_TZ: z.string().default('Asia/Jakarta'),
  CRYPTO_DASHBOARD_RETAIN_RUNS: z.coerce.number().int().default(0),
  CRYPTO_DASHBOARD_REFRESH_TOKEN: z.string().optional(),
  COINGLASS_API_KEY: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
});

export interface DailyRefreshTime {
  hour: number;
  minute: number;
}

export interface AppEnv {
  configPath: string;
  /** `storage_path` already overridden by CRYPTO_SCREENER_DB_PATH, if set. */
  config: AppConfig;
  dbPath: string;
  reportDir: string;
  apiPort: number;
  dashboardLimit: number;
  autoRefreshSeconds: number;
  dailyRefreshTimes: DailyRefreshTime[];
  refreshTimezone: string;
  retainRuns: number;
  /** `null` when unset — callers MUST treat that as always-deny (403), never allow-any. See `isRefreshAllowed`. */
  refreshToken: string | null;
  coinglassApiKey: string | null;
  coingeckoApiKey: string | null;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const raw = rawEnvSchema.parse({
    CRYPTO_SCREENER_CONFIG: source.CRYPTO_SCREENER_CONFIG,
    CRYPTO_SCREENER_DB_PATH: source.CRYPTO_SCREENER_DB_PATH,
    CRYPTO_SCREENER_REPORT_DIR: source.CRYPTO_SCREENER_REPORT_DIR,
    API_PORT: source.API_PORT,
    CRYPTO_DASHBOARD_LIMIT: source.CRYPTO_DASHBOARD_LIMIT,
    CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS: source.CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS,
    CRYPTO_DASHBOARD_DAILY_REFRESH_TIME: source.CRYPTO_DASHBOARD_DAILY_REFRESH_TIME,
    CRYPTO_DASHBOARD_REFRESH_TIME: source.CRYPTO_DASHBOARD_REFRESH_TIME,
    CRYPTO_DASHBOARD_REFRESH_TZ: source.CRYPTO_DASHBOARD_REFRESH_TZ,
    CRYPTO_DASHBOARD_RETAIN_RUNS: source.CRYPTO_DASHBOARD_RETAIN_RUNS,
    CRYPTO_DASHBOARD_REFRESH_TOKEN: source.CRYPTO_DASHBOARD_REFRESH_TOKEN,
    COINGLASS_API_KEY: source.COINGLASS_API_KEY,
    COINGECKO_API_KEY: source.COINGECKO_API_KEY,
  });

  const config = loadConfig(raw.CRYPTO_SCREENER_CONFIG);
  const dbPath = raw.CRYPTO_SCREENER_DB_PATH ?? config.storage_path;

  return {
    configPath: raw.CRYPTO_SCREENER_CONFIG,
    config: { ...config, storage_path: dbPath },
    dbPath,
    reportDir: raw.CRYPTO_SCREENER_REPORT_DIR,
    apiPort: raw.API_PORT,
    dashboardLimit: raw.CRYPTO_DASHBOARD_LIMIT ?? config.report.limit,
    autoRefreshSeconds: raw.CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS,
    dailyRefreshTimes: parseDailyRefreshTimes(
      raw.CRYPTO_DASHBOARD_DAILY_REFRESH_TIME || raw.CRYPTO_DASHBOARD_REFRESH_TIME || '',
    ),
    refreshTimezone: raw.CRYPTO_DASHBOARD_REFRESH_TZ,
    retainRuns: raw.CRYPTO_DASHBOARD_RETAIN_RUNS,
    refreshToken: raw.CRYPTO_DASHBOARD_REFRESH_TOKEN || null,
    coinglassApiKey: raw.COINGLASS_API_KEY || null,
    coingeckoApiKey: raw.COINGECKO_API_KEY || null,
  };
}

/**
 * Default-deny: an unset/empty configured token always forbids. Uses `timingSafeEqual`, not
 * `===`, so response time doesn't leak the token's length/prefix; a length mismatch still runs a
 * same-cost dummy comparison so it isn't distinguishable by timing either.
 */
export function isRefreshAllowed(configuredToken: string | null, suppliedToken: string): boolean {
  if (!configuredToken) {
    return false;
  }
  const configured = Buffer.from(configuredToken, 'utf8');
  const supplied = Buffer.from(suppliedToken, 'utf8');
  if (configured.length !== supplied.length) {
    timingSafeEqual(configured, configured);
    return false;
  }
  return timingSafeEqual(configured, supplied);
}

export function parseDailyRefreshTimes(raw: string): DailyRefreshTime[] {
  const times: DailyRefreshTime[] = [];
  for (const part of raw.split(',')) {
    const parsed = parseDailyRefreshTime(part);
    if (
      parsed &&
      !times.some((time) => time.hour === parsed.hour && time.minute === parsed.minute)
    ) {
      times.push(parsed);
    }
  }
  return times.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

function parseDailyRefreshTime(raw: string): DailyRefreshTime | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`invalid daily refresh time: "${raw}"`);
  }
  const hour = parseStrictInt(value.slice(0, colonIndex));
  const minute = parseStrictInt(value.slice(colonIndex + 1));
  return { hour, minute };
}

/** `Number.parseInt` truncates trailing garbage; this requires the whole string to be an int. */
function parseStrictInt(text: string): number {
  if (!/^[+-]?\d+$/.test(text.trim())) {
    throw new Error(`invalid integer: "${text}"`);
  }
  return Number.parseInt(text, 10);
}
