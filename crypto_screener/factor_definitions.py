from __future__ import annotations

DIRECTIONAL_FACTORS = [
    "momentum_24h",
    "reversal_1d",
    "oi_price_signal",
    "funding_rate_contrarian",
    "ls_ratio_contrarian",
    "liquidation_imbalance",
    "btc_relative_strength",
    "technical_trend_4h",
    "technical_momentum_4h",
    "oi_acceleration_signal",
    "funding_persistence_contrarian",
    "taker_flow_24h",
    "liquidation_pressure_24h",
]

QUALITY_FACTORS = [
    "liquidity_30d",
    "volume_expansion_24h",
    "volatility_expansion_4h",
]

DEFAULT_PRIORS = {
    "momentum_24h": 0.18,
    "reversal_1d": 0.08,
    "oi_price_signal": 0.20,
    "funding_rate_contrarian": 0.16,
    "ls_ratio_contrarian": 0.12,
    "liquidation_imbalance": 0.10,
    "btc_relative_strength": 0.16,
    "technical_trend_4h": 0.12,
    "technical_momentum_4h": 0.08,
    "oi_acceleration_signal": 0.08,
    "funding_persistence_contrarian": 0.08,
    "taker_flow_24h": 0.07,
    "liquidation_pressure_24h": 0.07,
}
