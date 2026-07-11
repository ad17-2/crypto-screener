import type { CoinGlassPair } from '../providers/coinglass.js';

export function quoteMatches(pair: CoinGlassPair, quoteAsset: string): boolean {
  const expected = quoteAsset.toUpperCase();
  return (
    String(pair.quote_asset ?? '').toUpperCase() === expected ||
    String(pair.settlement_currency ?? '').toUpperCase() === expected
  );
}

export function pairSymbolMatchesQuote(pair: CoinGlassPair, quoteAsset: string): boolean {
  const expected = quoteAsset.toUpperCase();
  const symbol = String(pair.symbol ?? '').toUpperCase();
  const instrumentId = String(pair.instrument_id ?? '').toUpperCase();
  return symbol.endsWith(`/${expected}`) || instrumentId.includes(expected);
}

// Non-perpetual only if the id ends in a dated-contract suffix (_YYMMDD/_YYYYMMDD, 6-8 digits) with no "perp"/"swap".
export function isLikelyPerpetualInstrument(instrumentId: string): boolean {
  const lowered = instrumentId.toLowerCase();
  if (lowered.includes('perp') || lowered.includes('swap')) {
    return true;
  }
  return !/[_-]\d{6,8}$/.test(instrumentId);
}

export function isLikelyPerpetualPair(pair: CoinGlassPair): boolean {
  return isLikelyPerpetualInstrument(String(pair.instrument_id ?? ''));
}

export function baseFromPair(pair: CoinGlassPair, quoteAsset = 'USDT'): string {
  const symbol = String(pair.symbol ?? '');
  if (symbol.includes('/')) {
    return (symbol.split('/', 1)[0] as string).toUpperCase();
  }
  const instrumentId = String(pair.instrument_id ?? '').toUpperCase();
  const stripped = instrumentId.replace(/[^A-Z0-9].*$/, '');
  return stripped.split(quoteAsset.toUpperCase()).join('');
}

export function selectPricePair(
  supportedPairs: Record<string, CoinGlassPair[]>,
  exchanges: string[],
  symbol: string,
  quoteAsset: string,
): [exchange: string, contractSymbol: string] {
  const expectedSymbol = symbol.toUpperCase();
  for (const exchange of exchanges) {
    for (const pair of supportedPairs[exchange] ?? []) {
      const base = String(pair.base_asset ?? '').toUpperCase();
      const instrumentId = String(pair.instrument_id ?? '');
      if (base !== expectedSymbol) {
        continue;
      }
      if (!quoteMatches(pair, quoteAsset)) {
        continue;
      }
      if (!isLikelyPerpetualInstrument(instrumentId)) {
        continue;
      }
      return [exchange, instrumentId || `${expectedSymbol}${quoteAsset.toUpperCase()}`];
    }
  }
  throw new Error('no supported configured price pair');
}
