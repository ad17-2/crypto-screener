// btc_relative_strength and reversal_1d are RETIRED (collinear with momentum_24h / -momentum_24h) -- never re-add.
export const DIRECTIONAL_FACTORS: string[] = [
  'momentum_24h',
  'reversal_3d',
  'oi_price_signal',
  'funding_rate_contrarian',
  'ls_ratio_contrarian',
  'liquidation_imbalance',
  'technical_trend_4h',
  'technical_momentum_4h',
  'oi_acceleration_signal',
  'funding_persistence_contrarian',
  'taker_flow_24h',
  'liquidation_pressure_24h',
];

export const QUALITY_FACTORS: string[] = [
  'liquidity_30d',
  'volume_expansion_24h',
  'volatility_expansion_4h',
];

export const DEFAULT_PRIORS: Record<string, number> = {
  momentum_24h: 0.3,
  reversal_3d: 0.08,
  oi_price_signal: 0.2,
  funding_rate_contrarian: 0.16,
  ls_ratio_contrarian: 0.12,
  liquidation_imbalance: 0.1,
  technical_trend_4h: 0.12,
  technical_momentum_4h: 0.08,
  oi_acceleration_signal: 0.08,
  funding_persistence_contrarian: 0.08,
  taker_flow_24h: 0.07,
  liquidation_pressure_24h: 0.07,
};
