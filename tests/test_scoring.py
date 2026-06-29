import unittest

from crypto_screener.factors import factor_weights, score_snapshot
from crypto_screener.scoring import pct_change, spearman_corr, spread_bps, zscore_by_key


class ScoringTests(unittest.TestCase):
    def test_pct_change(self):
        self.assertEqual(pct_change(100, 110), 10.0)
        self.assertEqual(pct_change(100, 90), -10.0)
        self.assertIsNone(pct_change(0, 90))

    def test_spread_bps(self):
        self.assertAlmostEqual(spread_bps(99.95, 100.05), 10.0, places=2)

    def test_zscore_by_key(self):
        rows = [{"value": 10}, {"value": 20}, {"value": 30}]
        zscores = zscore_by_key(rows, "value")
        self.assertAlmostEqual(sum(zscores), 0.0, places=7)
        self.assertLess(zscores[0], zscores[1])
        self.assertLess(zscores[1], zscores[2])

    def test_spearman_corr(self):
        self.assertAlmostEqual(spearman_corr([1, 2, 3], [10, 20, 30]), 1.0)
        self.assertAlmostEqual(spearman_corr([1, 2, 3], [30, 20, 10]), -1.0)

    def test_prior_weights_without_history(self):
        config = {"factors": {"min_observations": 30}}
        weights = factor_weights([], config)
        self.assertEqual(weights["mode"], "prior")
        self.assertGreater(weights["directional"]["momentum_24h"], 0)

    def test_score_snapshot_ranks_long_and_short(self):
        rows = [
            {
                "symbol": "LONG",
                "price_usd": 10,
                "price_change_24h_pct": 5,
                "oi_change_24h_pct": 4,
                "funding_rate_pct": 0.01,
                "quote_volume_usd": 100_000_000,
                "long_liquidation_usd_24h": 1_000_000,
                "short_liquidation_usd_24h": 2_000_000,
            },
            {
                "symbol": "SHORT",
                "price_usd": 10,
                "price_change_24h_pct": -5,
                "oi_change_24h_pct": 5,
                "funding_rate_pct": 0.04,
                "quote_volume_usd": 100_000_000,
                "long_liquidation_usd_24h": 3_000_000,
                "short_liquidation_usd_24h": 500_000,
            },
            {
                "symbol": "BTC",
                "price_usd": 100,
                "price_change_24h_pct": 1,
                "oi_change_24h_pct": 1,
                "funding_rate_pct": 0.01,
                "quote_volume_usd": 200_000_000,
            },
        ]
        scored = score_snapshot(rows, {}, [], {"factors": {}})["rows"]
        long_row = next(row for row in scored if row["symbol"] == "LONG")
        short_row = next(row for row in scored if row["symbol"] == "SHORT")
        self.assertGreater(long_row["long_score"], long_row["short_score"])
        self.assertGreater(short_row["short_score"], short_row["long_score"])


if __name__ == "__main__":
    unittest.main()
