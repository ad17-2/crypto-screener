import unittest

from crypto_screener.collector import (
    _aggregate_coinglass_pairs,
    _append_coinglass_derivatives_history,
    _append_coinglass_technicals,
    _coinglass_candidate_stats,
    _rank_coinglass_candidates,
)


class CollectorTests(unittest.TestCase):
    def test_coinglass_candidate_stats_filter_and_rank_supported_pairs(self):
        supported_pairs = {
            "MEXC": [
                {"base_asset": "BTC", "quote_asset": "USDT", "instrument_id": "BTCUSDT", "max_leverage": "125"},
                {"base_asset": "USDT", "quote_asset": "USDT", "instrument_id": "USDTUSDT", "max_leverage": "1"},
                {"base_asset": "OLD", "quote_asset": "USDT", "instrument_id": "OLD-USDT-260101", "max_leverage": "10"},
            ],
            "OKX": [
                {"base_asset": "BTC", "quote_asset": "USDT", "instrument_id": "BTC-USDT-SWAP", "max_leverage": "100"},
                {"base_asset": "ETH", "quote_asset": "USDT", "instrument_id": "ETH-USDT-SWAP", "max_leverage": "100"},
            ],
            "Bybit": [
                {"base_asset": "ETH", "quote_asset": "USDT", "instrument_id": "ETHUSDT", "max_leverage": "100"},
            ],
        }

        stats = _coinglass_candidate_stats(
            supported_pairs=supported_pairs,
            exchanges={"MEXC", "OKX", "Bybit"},
            quote_asset="USDT",
            min_exchange_count=2,
            excluded_bases={"USDT"},
        )
        ranked = _rank_coinglass_candidates(stats, ["ETH"], 2)

        self.assertEqual(set(stats), {"BTC", "ETH"})
        self.assertEqual(ranked, ["ETH", "BTC"])

    def test_aggregate_coinglass_pairs_builds_primary_row(self):
        pairs = [
            {
                "symbol": "BTC/USDT",
                "instrument_id": "BTC-USDT-SWAP",
                "exchange_name": "OKX",
                "current_price": 100,
                "index_price": 101,
                "price_change_percent_24h": 2,
                "volume_usd": 200,
                "volume_usd_change_percent_24h": 5,
                "open_interest_usd": 1000,
                "open_interest_change_percent_24h": 4,
                "funding_rate": 0.01,
                "long_volume_usd": 60,
                "short_volume_usd": 40,
                "long_liquidation_usd_24h": 10,
                "short_liquidation_usd_24h": 20,
            },
            {
                "symbol": "BTC/USDT",
                "instrument_id": "BTCUSDT",
                "exchange_name": "Bybit",
                "current_price": 110,
                "index_price": 109,
                "price_change_percent_24h": 3,
                "volume_usd": 100,
                "volume_usd_change_percent_24h": 7,
                "open_interest_usd": 500,
                "open_interest_change_percent_24h": 6,
                "funding_rate": 0.02,
                "long_volume_usd": 90,
                "short_volume_usd": 60,
                "long_liquidation_usd_24h": 30,
                "short_liquidation_usd_24h": 40,
            },
        ]

        row = _aggregate_coinglass_pairs(
            pairs,
            {"OKX", "Bybit"},
            {"instrument_count": 2, "exchanges": {"OKX", "Bybit"}},
            "USDT",
        )

        self.assertEqual(row["symbol"], "BTC")
        self.assertEqual(row["data_source"], "coinglass")
        self.assertEqual(row["primary_exchange"], "OKX")
        self.assertEqual(row["quote_volume_usd"], 300)
        self.assertEqual(row["open_interest_usd"], 1500)
        self.assertAlmostEqual(row["long_short_ratio"], 1.5)
        self.assertEqual(row["coinglass_exchange_count"], 2)

    def test_append_coinglass_technicals_enriches_rows(self):
        rows = [
            {
                "symbol": "BTC",
                "primary_exchange": "OKX",
                "contract_symbol": "BTC-USDT-SWAP",
            }
        ]
        status = {}
        client = FakeCoinGlassClient()

        _append_coinglass_technicals(
            rows,
            client,
            {
                "technical_indicators": {
                    "enabled": True,
                    "interval": "4h",
                    "limit": 80,
                    "max_symbols": 1,
                    "request_delay_seconds": 0,
                }
            },
            status,
        )

        self.assertEqual(client.calls, [("OKX", "BTC-USDT-SWAP", "4h", 80)])
        self.assertEqual(status["technicals"]["status"], "ok")
        self.assertEqual(rows[0]["technical_interval"], "4h")
        self.assertIn("rsi_14", rows[0])

    def test_append_coinglass_derivatives_history_enriches_rows(self):
        rows = [{"symbol": "BTC"}]
        status = {}
        client = FakeCoinGlassClient()

        _append_coinglass_derivatives_history(
            rows,
            client,
            {
                "exchanges": ["OKX", "Bybit"],
                "derivatives_history": {
                    "enabled": True,
                    "interval": "4h",
                    "limit": 40,
                    "max_symbols": 1,
                    "request_delay_seconds": 0,
                },
            },
            status,
        )

        self.assertEqual(status["derivatives_history"]["status"], "ok")
        self.assertEqual(rows[0]["derivatives_interval"], "4h")
        self.assertIn("oi_change_24h_pct_history", rows[0])
        self.assertIn("taker_imbalance_24h_pct", rows[0])


class FakeCoinGlassClient:
    def __init__(self):
        self.calls = []

    def price_history(self, exchange, symbol, interval, limit):
        self.calls.append((exchange, symbol, interval, limit))
        candles = []
        for index in range(limit):
            close = 100.0 + (index * 0.4)
            candles.append(
                {
                    "time": index,
                    "open": close - 0.2,
                    "high": close + 0.5,
                    "low": close - 0.5,
                    "close": close,
                }
            )
        return candles

    def open_interest_aggregated_history(self, symbol, interval, limit):
        return [{"time": index, "close": 1000 + index} for index in range(limit)]

    def funding_oi_weight_history(self, symbol, interval, limit):
        return [{"time": index, "close": 0.01} for index in range(limit)]

    def liquidation_aggregated_history(self, exchanges, symbol, interval, limit):
        return [
            {
                "time": index,
                "aggregated_long_liquidation_usd": 100,
                "aggregated_short_liquidation_usd": 200,
            }
            for index in range(limit)
        ]

    def aggregated_taker_buy_sell_history(self, exchanges, symbol, interval, limit):
        return [
            {
                "time": index,
                "aggregated_buy_volume_usd": 120,
                "aggregated_sell_volume_usd": 100,
            }
            for index in range(limit)
        ]


if __name__ == "__main__":
    unittest.main()
