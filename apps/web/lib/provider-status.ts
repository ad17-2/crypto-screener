import { arr, rec } from './payload';

/**
 * Whether CoinGecko's `/global` endpoint failed on the run behind this payload -- distinguishes
 * "the provider genuinely returned nothing this run" from a real null/zero value, the same
 * dash-means-two-different-things ambiguity refresh-status.ts resolves for the whole-pipeline
 * refresh state.
 *
 * Market cap 24h, BTC dominance and ETH dominance (MarketStage.tsx) are the only stat tiles
 * sourced from `/global` (see normalizeCoingeckoGlobal in apps/api/src/pipeline/collector.ts).
 * `provider_status.coingecko.status` alone isn't enough to gate them: collectCoingeckoContext
 * marks the whole provider "ok" as soon as ANY of its three calls (global, categories, sector
 * membership) succeeds, so a lone `/global` failure can still read "ok" overall. Instead this
 * checks `errors` (plain strings from collectProviderError in apps/api/src/providers/errors.ts)
 * for the literal "/global" path segment that apps/api/src/providers/coingecko.ts's globalData()
 * passes to getJson() -- a path constant this codebase controls, not CoinGecko's message wording.
 */
export function coingeckoGlobalUnavailable(providerStatus: unknown): boolean {
  const coingecko = rec(providerStatus, 'coingecko');
  if (coingecko === null) return false;
  return arr(coingecko, 'errors').some(
    (entry) => typeof entry === 'string' && entry.includes('/global'),
  );
}
