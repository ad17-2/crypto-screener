import unittest
from unittest.mock import patch

import httpx

from crypto_screener.coingecko import CoinGeckoClient


class CoinGeckoTests(unittest.TestCase):
    def test_retries_http_429_until_success_with_backoff_and_jitter(self):
        request = httpx.Request("GET", "https://api.coingecko.com/api/v3/global")
        rate_limit = httpx.Response(429, json={"status": {"error_code": 429}}, request=request)
        success = httpx.Response(200, json={"data": {"ok": True}}, request=request)
        client = CoinGeckoClient(
            retry_429_initial_delay_seconds=1,
            retry_429_max_delay_seconds=5,
            retry_429_jitter_seconds=0.5,
            retry_429_max_attempts=0,
        )

        with (
            patch("crypto_screener.coingecko.httpx.get", side_effect=[rate_limit, success]),
            patch("crypto_screener.coingecko.random.uniform", return_value=0.25),
            patch("crypto_screener.coingecko.time.sleep") as sleep,
        ):
            payload = client.global_data()

        self.assertEqual(payload, {"ok": True})
        sleep.assert_called_once_with(1.25)


if __name__ == "__main__":
    unittest.main()
