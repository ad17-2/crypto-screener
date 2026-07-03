import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from crypto_screener.coingecko import CoinGeckoClient


class _FakeResponse:
    def __init__(self, payload):
        self.body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.body


class CoinGeckoTests(unittest.TestCase):
    def test_retries_http_429_until_success_with_backoff_and_jitter(self):
        error = urllib.error.HTTPError(
            url="https://api.coingecko.com/api/v3/global",
            code=429,
            msg="Too Many Requests",
            hdrs={},
            fp=io.BytesIO(b'{"status":{"error_code":429}}'),
        )
        client = CoinGeckoClient(
            retry_429_initial_delay_seconds=1,
            retry_429_max_delay_seconds=5,
            retry_429_jitter_seconds=0.5,
            retry_429_max_attempts=0,
        )

        with (
            patch("crypto_screener.coingecko.urllib.request.urlopen", side_effect=[error, _FakeResponse({"data": {"ok": True}})]),
            patch("crypto_screener.coingecko.random.uniform", return_value=0.25),
            patch("crypto_screener.coingecko.time.sleep") as sleep,
        ):
            payload = client.global_data()

        self.assertEqual(payload, {"ok": True})
        sleep.assert_called_once_with(1.25)


if __name__ == "__main__":
    unittest.main()
