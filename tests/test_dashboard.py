import tempfile
import unittest
from pathlib import Path

from crypto_screener.dashboard import build_dashboard_payload
from crypto_screener.storage import connect, save_snapshot


class DashboardTests(unittest.TestCase):
    def test_dashboard_reads_latest_run_from_sqlite(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "screener.sqlite3"
            config = {"storage_path": str(db_path)}
            payload = {
                "run_id": "run-1",
                "generated_at": "2026-07-02T09:00:00+07:00",
                "market_context": {
                    "market_cap_change_24h_pct": 1.2,
                    "btc_dominance_pct": 55.5,
                    "categories": {"leaders": [], "laggards": []},
                },
                "provider_status": {"binance": {"status": "ok", "rows": 2}},
                "regime": {"bias": "risk-on", "label": "momentum"},
                "factor_weights": {"mode": "prior"},
                "rows": [
                    {
                        "symbol": "BTC",
                        "price_usd": 100,
                        "price_change_24h_pct": 1,
                        "oi_change_24h_pct": 2,
                        "funding_rate_pct": 0.01,
                        "quote_volume_usd": 100_000_000,
                        "data_source": "binance",
                        "is_trusted": True,
                        "data_quality_score": 100,
                        "factor_score": 0.2,
                        "long_score": 30,
                        "short_score": 0,
                        "crowded_long_score": 0,
                        "squeeze_risk_score": 0,
                        "scores": {"factor_score": 0.2, "long_score": 30},
                        "factors": {"momentum_24h": 1.0},
                    },
                    {
                        "symbol": "ODD",
                        "price_usd": 1,
                        "price_change_24h_pct": 400,
                        "oi_change_24h_pct": 10,
                        "funding_rate_pct": 0.01,
                        "quote_volume_usd": 100_000_000,
                        "data_source": "binance",
                        "is_trusted": False,
                        "data_quality_score": 75,
                        "data_quality_flags": ["extreme_24h_price_change:+400.00%"],
                        "factor_score": 0,
                        "long_score": 0,
                        "short_score": 0,
                        "crowded_long_score": 0,
                        "squeeze_risk_score": 0,
                        "scores": {},
                        "factors": {},
                    },
                ],
            }

            save_snapshot(payload, config)
            dashboard = build_dashboard_payload(db_path, limit=5)

        self.assertEqual(dashboard["status"], "ok")
        self.assertEqual(dashboard["regime"]["bias"], "risk-on")
        self.assertEqual(dashboard["quality"]["trusted_count"], 1)
        self.assertEqual(dashboard["quality"]["excluded_count"], 1)
        self.assertEqual(dashboard["sections"]["long"][0]["symbol"], "BTC")
        self.assertEqual(dashboard["runs"][0]["coinglass_status"], "-")

    def test_existing_runs_table_gets_dashboard_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "legacy.sqlite3"
            raw = connect(db_path)
            raw.execute("DROP TABLE runs")
            raw.execute(
                """
                CREATE TABLE runs (
                    run_id TEXT PRIMARY KEY,
                    generated_at TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    context_json TEXT NOT NULL,
                    provider_status_json TEXT NOT NULL
                )
                """
            )
            raw.commit()
            raw.close()

            with connect(db_path) as conn:
                columns = {row["name"] for row in conn.execute("PRAGMA table_info(runs)")}

        self.assertIn("regime_json", columns)
        self.assertIn("factor_weights_json", columns)


if __name__ == "__main__":
    unittest.main()
