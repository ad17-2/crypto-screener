from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .providers import ProviderError


@dataclass(frozen=True)
class CoinGeckoClient:
    base_url: str = "https://api.coingecko.com/api/v3"
    api_key: str | None = None
    timeout_seconds: float = 12
    user_agent: str = "codex-crypto-screener/0.2"
    retry_429: bool = True
    retry_429_initial_delay_seconds: float = 30
    retry_429_max_delay_seconds: float = 300
    retry_429_jitter_seconds: float = 15
    retry_429_max_attempts: int = 0

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = self.base_url.rstrip("/") + "/" + path.lstrip("/")
        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        if self.api_key:
            headers["x-cg-demo-api-key"] = self.api_key

        attempt = 0
        delay = max(0.0, self.retry_429_initial_delay_seconds)
        try:
            while True:
                try:
                    response = httpx.get(url, params=params, headers=headers, timeout=self.timeout_seconds)
                    response.raise_for_status()
                    return response.json()
                except httpx.HTTPStatusError as exc:
                    body = exc.response.text[:500]
                    if not self._should_retry_429(exc.response.status_code, attempt):
                        raise ProviderError(f"{path} returned HTTP {exc.response.status_code}: {body}") from exc
                    attempt += 1
                    sleep_seconds = self._retry_429_delay(exc.response.headers, delay)
                    time.sleep(sleep_seconds)
                    delay = min(max(delay * 2, 1.0), self.retry_429_max_delay_seconds)
        except httpx.TimeoutException as exc:
            raise ProviderError(f"{path} timed out after {self.timeout_seconds}s") from exc
        except httpx.HTTPError as exc:
            raise ProviderError(f"{path} failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError(f"{path} returned invalid JSON") from exc

    def global_data(self) -> dict[str, Any]:
        payload = self.get_json("/global")
        return payload.get("data", {}) if isinstance(payload, dict) else {}

    def categories(self) -> list[dict[str, Any]]:
        payload = self.get_json("/coins/categories", {"order": "market_cap_desc"})
        return payload if isinstance(payload, list) else []

    def _should_retry_429(self, status_code: int, attempt: int) -> bool:
        if status_code != 429 or not self.retry_429:
            return False
        return self.retry_429_max_attempts <= 0 or attempt < self.retry_429_max_attempts

    def _retry_429_delay(self, headers: httpx.Headers, delay: float) -> float:
        retry_after = headers.get("Retry-After")
        if retry_after:
            try:
                return max(0.0, float(retry_after))
            except ValueError:
                pass
        jitter = random.uniform(0.0, max(0.0, self.retry_429_jitter_seconds))
        return min(delay + jitter, self.retry_429_max_delay_seconds)
