const QUALITY_FLAG_LABELS: Record<string, string> = {
  extreme_24h_price_change: 'Price 24h',
  extreme_24h_oi_change: 'OI 24h',
  extreme_24h_volume_change: 'Volume 24h',
  extreme_funding_rate: 'Funding',
  thin_coinglass_exchange_coverage: 'Thin coverage',
  price_deviates_from_index: 'Price vs Index',
  price_deviates_from_binance: 'Price vs Binance',
  stale_low_quote_volume: 'Low volume',
  invalid_price: 'Invalid price',
  invalid_open_interest: 'Invalid OI',
  weird_symbol: 'Symbol',
  weird_contract_symbol: 'Contract',
};

export function QualityFlagChip({ flag }: { flag: string }) {
  const [rawLabel, rawValue = ''] = flag.split(':');
  const label = (rawLabel && QUALITY_FLAG_LABELS[rawLabel]) || (rawLabel ?? '').replace(/_/g, ' ');
  const tone =
    (rawLabel ?? '').includes('extreme') ||
    (rawLabel ?? '').includes('invalid') ||
    (rawLabel ?? '').includes('deviates')
      ? 'bad'
      : 'warn';
  return (
    <span className={`quality-flag-chip ${tone}`} title={flag}>
      {label}
      {rawValue ? <strong> {rawValue}</strong> : null}
    </span>
  );
}
