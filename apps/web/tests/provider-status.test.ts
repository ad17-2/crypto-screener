import { describe, expect, it } from 'vitest';
import { coingeckoGlobalUnavailable } from '../lib/provider-status';

describe('coingeckoGlobalUnavailable', () => {
  it('returns false when CoinGecko is ok with no errors', () => {
    const providerStatus = {
      coingecko: { status: 'ok', errors: [], note: 'global market and category context' },
    };
    expect(coingeckoGlobalUnavailable(providerStatus)).toBe(false);
  });

  it('returns false when CoinGecko is ok and errors only reference other endpoints', () => {
    const providerStatus = {
      coingecko: {
        status: 'ok',
        errors: ['/coins/categories returned HTTP 500: server error'],
        note: 'global market and category context',
      },
    };
    expect(coingeckoGlobalUnavailable(providerStatus)).toBe(false);
  });

  it('returns true when the errors list carries a /global failure, even if overall status is ok', () => {
    // Matches the measured incident: collectCoingeckoContext (apps/api/src/pipeline/collector.ts)
    // marks status "ok" as soon as ANY of its three calls succeeds, so a lone /global failure with
    // categories/sector-membership still succeeding leaves status "ok" -- only the errors list
    // records it.
    const providerStatus = {
      coingecko: {
        status: 'ok',
        errors: [
          '/global returned HTTP 400: {"error_code":10010,"error_message":"If you are using Pro API key, please change your root URL from api.coingecko.com to pro-api.coingecko.com"}',
        ],
        note: 'global market and category context',
      },
    };
    expect(coingeckoGlobalUnavailable(providerStatus)).toBe(true);
  });

  it('returns true when overall status is error and errors mentions /global', () => {
    const providerStatus = {
      coingecko: {
        status: 'error',
        errors: ['/global returned HTTP 400: {"error_code":10010,"error_message":"..."}'],
        note: 'global market and category context',
      },
    };
    expect(coingeckoGlobalUnavailable(providerStatus)).toBe(true);
  });

  it('returns true for a timeout error string, which carries the full URL rather than the bare path', () => {
    const providerStatus = {
      coingecko: {
        status: 'ok',
        errors: ['https://api.coingecko.com/api/v3/global timed out after 12s'],
        note: 'global market and category context',
      },
    };
    expect(coingeckoGlobalUnavailable(providerStatus)).toBe(true);
  });

  it('returns false when the coingecko key is absent entirely -- older payloads render as today', () => {
    expect(coingeckoGlobalUnavailable({})).toBe(false);
  });

  it('returns false for a null provider_status', () => {
    expect(coingeckoGlobalUnavailable(null)).toBe(false);
  });

  it('returns false for a disabled provider (no errors field at all)', () => {
    const providerStatus = { coingecko: { status: 'disabled' } };
    expect(coingeckoGlobalUnavailable(providerStatus)).toBe(false);
  });

  it('returns false when provider_status itself is not an object', () => {
    expect(coingeckoGlobalUnavailable('not-an-object')).toBe(false);
  });
});
