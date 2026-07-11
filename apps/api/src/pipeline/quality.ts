import type { DataQualityConfig } from '../config/index.js';
import { pctChange, toFloat } from './scoring.js';
import type { Row } from './types.js';

// Rows failing checks are flagged (is_trusted: false), never dropped here -- exclusion happens later, in the ranking stage.
export const DEFAULT_QUALITY_CONFIG: DataQualityConfig = {
  max_abs_price_change_24h_pct: 300,
  max_abs_oi_change_24h_pct: 300,
  max_abs_volume_change_24h_pct: 1000,
  max_abs_funding_rate_pct: 2,
  max_price_deviation_from_index_pct: 25,
  min_quote_volume_usd: 10_000_000,
  min_coinglass_exchange_count: 2,
};

export interface DataQualityStatus {
  status: string;
  rows: number;
  flagged: number;
  excluded: number;
  note: string;
}

/** Mutates every row in place with the quality fields. */
export function applyDataQuality(
  rows: Row[],
  config: { data_quality?: Partial<DataQualityConfig> },
): DataQualityStatus {
  const qualityConfig: DataQualityConfig = {
    ...DEFAULT_QUALITY_CONFIG,
    ...(config.data_quality ?? {}),
  };
  let flagged = 0;
  let excluded = 0;

  for (const row of rows) {
    const flags = dataQualityFlags(row, qualityConfig);
    row.data_quality_flags = flags;
    row.is_trusted = flags.length === 0;
    row.data_quality_score = Math.max(0, 100 - flags.length * 25);
    if (flags.length > 0) {
      flagged += 1;
    }
    if (!row.is_trusted) {
      excluded += 1;
    }
  }

  return {
    status: 'ok',
    rows: rows.length,
    flagged,
    excluded,
    note: 'rows with critical sanity flags are excluded from factor ranking',
  };
}

export function dataQualityFlags(row: Row, config: DataQualityConfig): string[] {
  const flags: string[] = [];

  flagRequiredText(flags, row, 'symbol', 'missing_symbol');
  flagRequiredText(flags, row, 'contract_symbol', 'missing_contract_symbol');
  flagContractSymbol(flags, row);
  flagPositive(flags, row, 'price_usd', 'invalid_price');
  flagMinimum(
    flags,
    row,
    'quote_volume_usd',
    config.min_quote_volume_usd,
    'stale_low_quote_volume',
  );
  flagAbsThreshold(
    flags,
    row,
    'price_change_24h_pct',
    config.max_abs_price_change_24h_pct,
    'extreme_24h_price_change',
  );
  flagAbsThreshold(
    flags,
    row,
    'oi_change_24h_pct',
    config.max_abs_oi_change_24h_pct,
    'extreme_24h_oi_change',
  );
  flagAbsThreshold(
    flags,
    row,
    'volume_change_percent_24h',
    config.max_abs_volume_change_24h_pct,
    'extreme_24h_volume_change',
  );
  flagAbsThreshold(
    flags,
    row,
    'funding_rate_pct',
    config.max_abs_funding_rate_pct,
    'extreme_funding_rate',
  );

  const openInterest = toFloat(row.open_interest_usd);
  if (openInterest !== null && openInterest < 0) {
    flags.push(`invalid_open_interest:${formatFixed(openInterest, 2)}`);
  }

  const indexPrice = toFloat(row.index_price);
  const currentPrice = toFloat(row.price_usd);
  const indexDeviation = pctChange(indexPrice, currentPrice);
  if (
    indexDeviation !== null &&
    Math.abs(indexDeviation) > config.max_price_deviation_from_index_pct
  ) {
    flags.push(`price_deviates_from_index:${formatSigned(indexDeviation, 2)}%`);
  }

  if (row.data_source === 'coinglass') {
    const exchangeCount = toFloat(row.coinglass_exchange_count, 0.0) ?? 0.0;
    if (exchangeCount < config.min_coinglass_exchange_count) {
      flags.push(`thin_coinglass_exchange_coverage:${formatFixed(exchangeCount, 0)}`);
    }
  }

  return flags;
}

function flagRequiredText(flags: string[], row: Row, key: string, label: string): void {
  const raw = row[key];
  const text = raw === null || raw === undefined ? '' : String(raw);
  if (!text.trim()) {
    flags.push(label);
  }
}

function flagContractSymbol(flags: string[], row: Row): void {
  const symbol = String(row.symbol ?? '').trim();
  const contractSymbol = String(row.contract_symbol ?? '').trim();
  const quoteAsset = String(row.quote_asset ?? '').trim();
  if (symbol && !isAlnum(symbol.split('-').join(''))) {
    flags.push(`weird_symbol:${symbol}`);
  }
  if (
    contractSymbol &&
    quoteAsset &&
    !contractSymbolMatchesQuote(row, contractSymbol, quoteAsset)
  ) {
    flags.push(`weird_contract_symbol:${contractSymbol}`);
  }
}

function contractSymbolMatchesQuote(row: Row, contractSymbol: string, quoteAsset: string): boolean {
  if (contractSymbol.endsWith(quoteAsset)) {
    return true;
  }
  return row.data_source === 'coinglass' && contractSymbol.toUpperCase().includes(quoteAsset);
}

function flagPositive(flags: string[], row: Row, key: string, label: string): void {
  const value = toFloat(row[key]);
  if (value === null) {
    flags.push(`${label}:missing`);
  } else if (value <= 0) {
    flags.push(`${label}:${formatFixed(value, 2)}`);
  }
}

function flagMinimum(
  flags: string[],
  row: Row,
  key: string,
  threshold: number,
  label: string,
): void {
  const value = toFloat(row[key]);
  if (value === null) {
    flags.push(`${label}:missing`);
  } else if (value < threshold) {
    flags.push(`${label}:${formatFixed(value, 2)}`);
  }
}

function flagAbsThreshold(
  flags: string[],
  row: Row,
  key: string,
  threshold: number,
  label: string,
): void {
  const value = toFloat(row[key]);
  if (value !== null && Math.abs(value) > threshold) {
    flags.push(`${label}:${formatSigned(value, 2)}%`);
  }
}

function isAlnum(text: string): boolean {
  return text.length > 0 && /^[\p{L}\p{N}]+$/u.test(text);
}

function formatFixed(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function formatSigned(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return value >= 0 ? `+${fixed}` : fixed;
}
