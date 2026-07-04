import unittest

from crypto_screener.derivatives import derivatives_snapshot


class DerivativesTests(unittest.TestCase):
    def test_derivatives_snapshot_builds_historical_features(self):
        interval = "4h"
        oi_history = []
        funding_history = []
        liquidation_history = []
        taker_history = []
        for index in range(40):
            time_value = index * 14_400_000
            oi_close = 1_000_000 + (index * 20_000)
            oi_history.append({"time": time_value, "close": oi_close})
            funding_history.append({"time": time_value, "close": 0.01})
            liquidation_history.append(
                {
                    "time": time_value,
                    "aggregated_long_liquidation_usd": 100 + index,
                    "aggregated_short_liquidation_usd": 200 + index,
                }
            )
            taker_history.append(
                {
                    "time": time_value,
                    "aggregated_buy_volume_usd": 1_100 + index,
                    "aggregated_sell_volume_usd": 900 + index,
                }
            )

        snapshot = derivatives_snapshot(oi_history, funding_history, liquidation_history, taker_history, interval)

        self.assertEqual(snapshot["derivatives_interval"], "4h")
        self.assertEqual(snapshot["derivatives_oi_count"], 40)
        self.assertGreater(snapshot["oi_change_24h_pct_history"], 0)
        self.assertAlmostEqual(snapshot["funding_persistence_24h"], 1.0)
        self.assertGreater(snapshot["liquidation_imbalance_24h_pct"], 0)
        self.assertGreater(snapshot["taker_buy_sell_ratio_24h"], 1)
        self.assertIn("derivatives_confirmation_score", snapshot)

    def test_derivatives_snapshot_filters_future_rows(self):
        snapshot = derivatives_snapshot(
            oi_history=[
                {"time": 1, "close": 100},
                {"time": 2, "close": 105},
                {"time": 3, "close": 120},
            ],
            funding_history=[],
            liquidation_history=[],
            taker_history=[],
            interval="4h",
            end_time=2,
        )

        self.assertEqual(snapshot["derivatives_oi_count"], 2)
        self.assertNotIn("oi_change_24h_pct_history", snapshot)


if __name__ == "__main__":
    unittest.main()
