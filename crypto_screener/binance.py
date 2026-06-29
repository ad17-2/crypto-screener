from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class ProviderError(RuntimeError):
    """Raised when a market-data provider cannot return usable data."""


@dataclass(frozen=True)
class BinanceFuturesClient:
    base_url: str = "https://fapi.binance.com"
    timeout_seconds: float = 12
    user_agent: str = "codex-crypto-screener/0.1"

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        query = ""
        if params:
            query = "?" + urllib.parse.urlencode(params)
        url = self.base_url.rstrip("/") + path + query
        request = urllib.request.Request(url, headers={"User-Agent": self.user_agent})

        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:500]
            raise ProviderError(f"{path} returned HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:
            raise ProviderError(f"{path} failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise ProviderError(f"{path} timed out after {self.timeout_seconds}s") from exc

    def exchange_info(self) -> dict[str, Any]:
        return self.get_json("/fapi/v1/exchangeInfo")

    def ticker_24hr(self) -> list[dict[str, Any]]:
        return self.get_json("/fapi/v1/ticker/24hr")

    def book_ticker(self) -> list[dict[str, Any]]:
        return self.get_json("/fapi/v1/ticker/bookTicker")

    def premium_index(self) -> list[dict[str, Any]]:
        return self.get_json("/fapi/v1/premiumIndex")

    def open_interest(self, symbol: str) -> dict[str, Any]:
        return self.get_json("/fapi/v1/openInterest", {"symbol": symbol})

    def open_interest_hist(self, symbol: str, period: str, limit: int) -> list[dict[str, Any]]:
        return self.get_json(
            "/futures/data/openInterestHist",
            {"symbol": symbol, "period": period, "limit": limit},
        )

    def depth(self, symbol: str, limit: int) -> dict[str, Any]:
        return self.get_json("/fapi/v1/depth", {"symbol": symbol, "limit": limit})

    def polite_pause(self, seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)
