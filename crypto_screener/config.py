from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TechnicalIndicatorsConfig(StrictModel):
    enabled: bool = True
    interval: str = "4h"
    limit: int = 220
    max_symbols: int = 40
    request_delay_seconds: float = 2.1


class LongShortRatioConfig(StrictModel):
    enabled: bool = True
    interval: str = "4h"
    limit: int = 30
    max_symbols: int = 0
    ratio_exchange: str = "Binance"
    include_top_trader: bool = True
    request_delay_seconds: float = 2.1


class DerivativesHistoryConfig(StrictModel):
    enabled: bool = True
    interval: str = "4h"
    limit: int = 220
    max_symbols: int = 25
    request_delay_seconds: float = 2.1


class CoinGlassConfig(StrictModel):
    enabled: bool = True
    base_url: str = "https://open-api-v4.coinglass.com"
    api_key_env: str = "COINGLASS_API_KEY"
    candidate_symbols: int = 80
    min_exchange_count: int = 2
    request_delay_seconds: float = 2.1
    request_timeout_seconds: float = 12
    exchanges: list[str] = Field(default_factory=list)
    technical_indicators: TechnicalIndicatorsConfig = Field(default_factory=TechnicalIndicatorsConfig)
    derivatives_history: DerivativesHistoryConfig = Field(default_factory=DerivativesHistoryConfig)
    long_short_ratio: LongShortRatioConfig = Field(default_factory=LongShortRatioConfig)


class CoinGeckoConfig(StrictModel):
    enabled: bool = True
    base_url: str = "https://api.coingecko.com/api/v3"
    api_key_env: str = "COINGECKO_API_KEY"
    categories_limit: int = 12
    request_timeout_seconds: float = 12
    retry_429: bool = True
    retry_429_initial_delay_seconds: float = 30
    retry_429_max_delay_seconds: float = 300
    retry_429_jitter_seconds: float = 15
    retry_429_max_attempts: int = 0


class SoSoValueConfig(StrictModel):
    enabled: bool = False
    api_key_env: str = "SOSOVALUE_API_KEY"
    note: str | None = None


class ProvidersConfig(StrictModel):
    coinglass: CoinGlassConfig = Field(default_factory=CoinGlassConfig)
    coingecko: CoinGeckoConfig = Field(default_factory=CoinGeckoConfig)
    sosovalue: SoSoValueConfig = Field(default_factory=SoSoValueConfig)


class UniverseConfig(StrictModel):
    quote_asset: str = "USDT"
    contract_type: str = "PERPETUAL"
    top_symbols_by_volume: int = 80
    min_quote_volume_usd: float = 20_000_000
    exclude_base_assets: list[str] = Field(default_factory=list)


class DataQualityConfig(StrictModel):
    max_abs_price_change_24h_pct: float = 300
    max_abs_oi_change_24h_pct: float = 300
    max_abs_volume_change_24h_pct: float = 1000
    max_abs_funding_rate_pct: float = 2
    max_price_deviation_from_index_pct: float = 25
    min_quote_volume_usd: float = 10_000_000
    min_coinglass_exchange_count: int = 2


class RegimeWeightingConfig(StrictModel):
    enabled: bool = True
    max_factor_multiplier: float = 1.35
    score_adjustment_strength: float = 0.08
    conflict_penalty_strength: float = 0.18


class RegimeConfig(StrictModel):
    dispersion_threshold_pct: float = 8.0
    hysteresis_margin: float = 0.15
    breadth_weak_threshold: float = 0.15
    breadth_strong_threshold: float = 0.25
    dominance_delta_scale_pct: float = 0.5
    eth_btc_scale_pct: float = 2.0
    nudge_btc_led: float = 1.12
    nudge_alts_strong: float = 1.10
    nudge_chaos_trend: float = 0.88
    nudge_chaos_contrarian: float = 1.12


class FactorsConfig(StrictModel):
    forward_return_hours: float = 24
    decay_horizons: list[float] = Field(default_factory=lambda: [4.0, 8.0, 12.0, 24.0, 48.0, 72.0])
    reversal_lookback_hours: float = 72
    ic_window_days: int = 30
    min_observations: int = 30
    min_abs_ic: float = 0.02
    max_abs_weight: float = 0.35
    ic_min_periods: int = 10
    min_abs_t: float = 2.0
    ic_prior_strength: int = 10
    ic_min_cross_section: int = 5
    walk_forward_train_fraction: float = 0.6
    walk_forward_min_train_periods: int = 15
    walk_forward_min_oos_periods: int = 10
    walk_forward_robust_min_ic: float = 0.02
    walk_forward_overfit_penalty: float = 0.0
    walk_forward_gating: bool = False
    regime_weighting: RegimeWeightingConfig = Field(default_factory=RegimeWeightingConfig)
    regime: RegimeConfig = Field(default_factory=RegimeConfig)
    priors: dict[str, float] = Field(default_factory=dict)


class ReportConfig(StrictModel):
    limit: int = 12
    core_symbols: list[str] = Field(default_factory=lambda: ["BTC", "ETH", "SOL"])


class AppConfig(StrictModel):
    version: int = 2
    storage_path: str = "data/crypto_screener.sqlite3"
    universe: UniverseConfig = Field(default_factory=UniverseConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    data_quality: DataQualityConfig = Field(default_factory=DataQualityConfig)
    factors: FactorsConfig = Field(default_factory=FactorsConfig)
    report: ReportConfig = Field(default_factory=ReportConfig)

    def to_runtime_dict(self) -> dict:
        return self.model_dump(mode="json")


def load_config(path: Path) -> AppConfig:
    with path.open("r", encoding="utf-8") as handle:
        return AppConfig.model_validate(json.load(handle))


def load_config_dict(path: Path) -> dict:
    return load_config(path).to_runtime_dict()
