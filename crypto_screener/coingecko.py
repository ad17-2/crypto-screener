from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

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
        query = ""
        if params:
            query = "?" + urllib.parse.urlencode(params)
        url = self.base_url.rstrip("/") + "/" + path.lstrip("/") + query
        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        if self.api_key:
            headers["x-cg-demo-api-key"] = self.api_key
        request = urllib.request.Request(url, headers=headers)

        attempt = 0
        delay = max(0.0, self.retry_429_initial_delay_seconds)
        try:
            while True:
                try:
                    with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                        return json.load(response)
                except urllib.error.HTTPError as exc:
                    body = exc.read().decode("utf-8", errors="replace")[:500]
                    if not self._should_retry_429(exc, attempt):
                        raise ProviderError(f"{path} returned HTTP {exc.code}: {body}") from exc
                    attempt += 1
                    sleep_seconds = self._retry_429_delay(exc, delay)
                    time.sleep(sleep_seconds)
                    delay = min(max(delay * 2, 1.0), self.retry_429_max_delay_seconds)
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

    def _should_retry_429(self, exc: urllib.error.HTTPError, attempt: int) -> bool:
        if exc.code != 429 or not self.retry_429:
            return False
        return self.retry_429_max_attempts <= 0 or attempt < self.retry_429_max_attempts

    def _retry_429_delay(self, exc: urllib.error.HTTPError, delay: float) -> float:
        retry_after = exc.headers.get("Retry-After")
        if retry_after:
            try:
                return max(0.0, float(retry_after))
            except ValueError:
                pass
        jitter = random.uniform(0.0, max(0.0, self.retry_429_jitter_seconds))
        return min(delay + jitter, self.retry_429_max_delay_seconds)
