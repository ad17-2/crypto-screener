import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRefreshAllowed, loadEnv, parseDailyRefreshTimes } from '../src/env';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_CONFIG_PATH = join(REPO_ROOT, 'config/default.json');

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { CRYPTO_SCREENER_CONFIG: DEFAULT_CONFIG_PATH, ...overrides };
}

describe('loadEnv', () => {
  it('applies documented defaults when nothing is set', () => {
    const env = loadEnv(baseEnv());

    expect(env.reportDir).toBe('reports');
    expect(env.apiPort).toBe(4000);
    expect(env.autoRefreshSeconds).toBe(0);
    expect(env.dailyRefreshTimes).toEqual([]);
    expect(env.refreshTimezone).toBe('Asia/Jakarta');
    expect(env.retainRuns).toBe(0);
    expect(env.refreshToken).toBeNull();
    expect(env.coinglassApiKey).toBeNull();
    expect(env.coingeckoApiKey).toBeNull();
    expect(env.dashboardLimit).toBe(12);
    expect(env.dbPath).toBe(env.config.storage_path);
  });

  it('CRYPTO_SCREENER_DB_PATH overrides config.storage_path', () => {
    const env = loadEnv(baseEnv({ CRYPTO_SCREENER_DB_PATH: '/data/custom.sqlite3' }));

    expect(env.dbPath).toBe('/data/custom.sqlite3');
    expect(env.config.storage_path).toBe('/data/custom.sqlite3');
  });

  it('CRYPTO_DASHBOARD_LIMIT overrides the config default', () => {
    const env = loadEnv(baseEnv({ CRYPTO_DASHBOARD_LIMIT: '25' }));
    expect(env.dashboardLimit).toBe(25);
  });

  it('prefers CRYPTO_DASHBOARD_DAILY_REFRESH_TIME over CRYPTO_DASHBOARD_REFRESH_TIME', () => {
    const env = loadEnv(
      baseEnv({
        CRYPTO_DASHBOARD_DAILY_REFRESH_TIME: '09:00',
        CRYPTO_DASHBOARD_REFRESH_TIME: '23:00',
      }),
    );
    expect(env.dailyRefreshTimes).toEqual([{ hour: 9, minute: 0 }]);
  });

  it('falls back to CRYPTO_DASHBOARD_REFRESH_TIME when DAILY_REFRESH_TIME is unset', () => {
    const env = loadEnv(baseEnv({ CRYPTO_DASHBOARD_REFRESH_TIME: '23:00' }));
    expect(env.dailyRefreshTimes).toEqual([{ hour: 23, minute: 0 }]);
  });

  it('reads an explicitly set refresh token', () => {
    const env = loadEnv(baseEnv({ CRYPTO_DASHBOARD_REFRESH_TOKEN: 'secret' }));
    expect(env.refreshToken).toBe('secret');
  });
});

describe('parseDailyRefreshTimes', () => {
  it('dedupes and sorts ascending', () => {
    expect(parseDailyRefreshTimes('09:00,03:30,09:00,18:15')).toEqual([
      { hour: 3, minute: 30 },
      { hour: 9, minute: 0 },
      { hour: 18, minute: 15 },
    ]);
  });

  it('returns an empty array for a blank string', () => {
    expect(parseDailyRefreshTimes('')).toEqual([]);
  });

  it('throws on a malformed entry', () => {
    expect(() => parseDailyRefreshTimes('09:00,not-a-time')).toThrow();
    expect(() => parseDailyRefreshTimes('09:xx')).toThrow();
  });
});

describe('isRefreshAllowed', () => {
  it('always denies when no token is configured (default-deny)', () => {
    expect(isRefreshAllowed(null, '')).toBe(false);
    expect(isRefreshAllowed(null, 'anything')).toBe(false);
  });

  it('allows only an exact match once a token is configured', () => {
    expect(isRefreshAllowed('secret', 'secret')).toBe(true);
    expect(isRefreshAllowed('secret', 'wrong')).toBe(false);
  });
});
