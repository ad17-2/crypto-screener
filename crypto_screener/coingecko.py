from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from .binance import ProviderError


@dataclass(frozen=True)
class CoinGeckoClient:
    base_url: str = "https://api.coingecko.com/api/v3"
    api_key: str | None = None
    timeout_seconds: float = 12
    user_agent: str = "codex-crypto-screener/0.2"

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        query = ""
        if params:
            query = "?" + urllib.parse.urlencode(params)
        url = self.base_url.rstrip("/") + "/" + path.lstrip("/") + query
        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        if self.api_key:
            headers["x-cg-demo-api-key"] = self.api_key
        request = urllib.request.Request(url, headers=headers)

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

    def global_data(self) -> dict[str, Any]:
        payload = self.get_json("/global")
        return payload.get("data", {}) if isinstance(payload, dict) else {}

    def categories(self) -> list[dict[str, Any]]:
        payload = self.get_json("/coins/categories", {"order": "market_cap_desc"})
        return payload if isinstance(payload, list) else []
