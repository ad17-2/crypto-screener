from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from .providers import ProviderError


@dataclass(frozen=True)
class CoinGlassClient:
    api_key: str
    base_url: str = "https://open-api-v4.coinglass.com"
    timeout_seconds: float = 12
    user_agent: str = "codex-crypto-screener/0.2"

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        if not self.api_key:
            raise ProviderError("CoinGlass API key is not set")

        url = self.base_url.rstrip("/") + "/" + path.lstrip("/")
        try:
            response = httpx.get(
                url,
                params=params,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "CG-API-KEY": self.api_key,
                    "User-Agent": self.user_agent,
                },
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as exc:
            body = exc.response.text[:500]
            raise ProviderError(f"{path} returned HTTP {exc.response.status_code}: {body}") from exc
        except httpx.TimeoutException as exc:
            raise ProviderError(f"{path} timed out after {self.timeout_seconds}s") from exc
        except httpx.HTTPError as exc:
            raise ProviderError(f"{path} failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError(f"{path} returned invalid JSON") from exc

        if not isinstance(payload, dict):
            raise ProviderError(f"{path} returned non-object JSON payload")

        code = str(payload.get("code", "0"))
        if code not in {"0", "200"}:
            raise ProviderError(f"{path} returned code {code}: {payload.get('msg')}")
        return payload.get("data")

    def futures_pairs_markets(self, symbol: str) -> list[dict[str, Any]]:
        data = self.get_json("/api/futures/pairs-markets", {"symbol": symbol})
        return data if isinstance(data, list) else []

    def price_history(
        self,
        exchange: str,
        symbol: str,
        interval: str,
        limit: int,
        start_time: int | None = None,
        end_time: int | None = None,
    ) -> list[dict[str, Any]]:
        params = {
            "exchange": exchange,
            "symbol": symbol,
            "interval": interval,
            "limit": limit,
        }
        if start_time is not None:
            params["start_time"] = start_time
        if end_time is not None:
            params["end_time"] = end_time
        data = self.get_json("/api/futures/price/history", params)
        return data if isinstance(data, list) else []

    def supported_coins(self) -> list[str]:
        data = self.get_json("/api/futures/supported-coins")
        return [str(item) for item in data] if isinstance(data, list) else []

    def supported_exchange_pairs(self, exchange: str | None = None) -> dict[str, list[dict[str, Any]]]:
        params = {"exchange": exchange} if exchange else None
        data = self.get_json("/api/futures/supported-exchange-pairs", params)
        if not isinstance(data, dict):
            return {}
        return {str(exchange_name): pairs for exchange_name, pairs in data.items() if isinstance(pairs, list)}

    def open_interest_aggregated_history(
        self,
        symbol: str,
        interval: str,
        limit: int,
        unit: str = "usd",
        start_time: int | None = None,
        end_time: int | None = None,
    ) -> list[dict[str, Any]]:
        params = {"symbol": symbol, "interval": interval, "limit": limit, "unit": unit}
        if start_time is not None:
            params["start_time"] = start_time
        if end_time is not None:
            params["end_time"] = end_time
        data = self.get_json("/api/futures/open-interest/aggregated-history", params)
        return data if isinstance(data, list) else []

    def funding_oi_weight_history(
        self,
        symbol: str,
        interval: str,
        limit: int,
        start_time: int | None = None,
        end_time: int | None = None,
    ) -> list[dict[str, Any]]:
        params = {"symbol": symbol, "interval": interval, "limit": limit}
        if start_time is not None:
            params["start_time"] = start_time
        if end_time is not None:
            params["end_time"] = end_time
        data = self.get_json("/api/futures/funding-rate/oi-weight-history", params)
        return data if isinstance(data, list) else []

    def liquidation_aggregated_history(
        self,
        exchange_list: list[str],
        symbol: str,
        interval: str,
        limit: int,
        start_time: int | None = None,
        end_time: int | None = None,
    ) -> list[dict[str, Any]]:
        params = {
            "exchange_list": ",".join(exchange_list),
            "symbol": symbol,
            "interval": interval,
            "limit": limit,
        }
        if start_time is not None:
            params["start_time"] = start_time
        if end_time is not None:
            params["end_time"] = end_time
        data = self.get_json("/api/futures/liquidation/aggregated-history", params)
        return data if isinstance(data, list) else []

    def aggregated_taker_buy_sell_history(
        self,
        exchange_list: list[str],
        symbol: str,
        interval: str,
        limit: int,
        unit: str = "usd",
        start_time: int | None = None,
        end_time: int | None = None,
    ) -> list[dict[str, Any]]:
        params = {
            "exchange_list": ",".join(exchange_list),
            "symbol": symbol,
            "interval": interval,
            "limit": limit,
            "unit": unit,
        }
        if start_time is not None:
            params["start_time"] = start_time
        if end_time is not None:
            params["end_time"] = end_time
        data = self.get_json("/api/futures/aggregated-taker-buy-sell-volume/history", params)
        return data if isinstance(data, list) else []
