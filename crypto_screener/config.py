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


class FactorsConfig(StrictModel):
    forward_return_hours: float = 24
    ic_window_days: int = 30
    min_observations: int = 30
    min_abs_ic: float = 0.02
    max_abs_weight: float = 0.35
    regime_weighting: RegimeWeightingConfig = Field(default_factory=RegimeWeightingConfig)
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
