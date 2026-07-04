import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from crypto_screener.backfill import _build_symbol_rows, _score_backfill_rows, run_backfill
from crypto_screener.providers import ProviderError
from crypto_screener.storage import load_labeled_factor_records, save_factor_history_records


class BackfillTests(unittest.TestCase):
    def test_backfill_records_write_only_compact_factor_history(self):
        rows_by_time = {}
        for offset, symbol in enumerate(["BTC", "ETH", "SOL"]):
            histories = synthetic_histories(100 + offset * 10)
            for row in _build_symbol_rows(symbol, "OKX", f"{symbol}-USDT-SWAP", "4h", histories):
                rows_by_time.setdefault(row["_time"], []).append(row)

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "screener.sqlite3"
            config = {
                "storage_path": str(db_path),
                "factors": {
                    "forward_return_hours": 24,
                    "ic_window_days": 5000,
                    "min_observations": 3,
                },
            }
            records = _score_backfill_rows(rows_by_time, config, min_cross_section=3)
            first_saved = save_factor_history_records(records, config)
            second_saved = save_factor_history_records(records, config)
            labels = load_labeled_factor_records(config)

            conn = sqlite3.connect(db_path)
            try:
                runs_count = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
                market_rows_count = conn.execute("SELECT COUNT(*) FROM market_rows").fetchone()[0]
                history_count = conn.execute("SELECT COUNT(*) FROM factor_history").fetchone()[0]
                factors_json = conn.execute("SELECT factors_json FROM factor_history LIMIT 1").fetchone()[0]
            finally:
                conn.close()

        self.assertEqual(first_saved, len(records))
        self.assertEqual(second_saved, len(records))
        self.assertEqual(runs_count, 0)
        self.assertEqual(market_rows_count, 0)
        self.assertEqual(history_count, len(records))
        self.assertIn("oi_acceleration_signal", factors_json)
        self.assertGreater(len(labels), 0)

    def test_backfill_honors_railway_db_path_env_before_provider_validation(self):
        config = {
            "storage_path": "local.sqlite3",
            "providers": {"coinglass": {"api_key_env": "MISSING_TEST_KEY"}},
        }
        with (
            patch.dict("os.environ", {"CRYPTO_SCREENER_DB_PATH": "/data/crypto.sqlite3"}, clear=False),
            self.assertRaises(ProviderError),
        ):
            run_backfill(config, argparse_namespace())

        self.assertEqual(config["storage_path"], "/data/crypto.sqlite3")


def synthetic_histories(base_price):
    price = []
    oi = []
    funding = []
    liquidation = []
    taker = []
    start = 1_700_000_000_000
    step = 14_400_000
    for index in range(70):
        time_value = start + (index * step)
        close = base_price + index
        price.append(
            {
                "time": time_value,
                "open": close - 0.5,
                "high": close + 1,
                "low": close - 1,
                "close": close,
                "volume_usd": 1_000_000 + index * 10_000,
            }
        )
        oi.append({"time": time_value, "close": 5_000_000 + index * 50_000})
        funding.append({"time": time_value, "close": 0.01})
        liquidation.append(
            {
                "time": time_value,
                "aggregated_long_liquidation_usd": 1000 + index,
                "aggregated_short_liquidation_usd": 1500 + index,
            }
        )
        taker.append(
            {
                "time": time_value,
                "aggregated_buy_volume_usd": 2000 + index,
                "aggregated_sell_volume_usd": 1600 + index,
            }
        )
    return {"price": price, "oi": oi, "funding": funding, "liquidation": liquidation, "taker": taker}


def argparse_namespace():
    class Args:
        symbols = "BTC"
        interval = "4h"
        limit = 60
        min_cross_section = 3
        request_delay_seconds = 0
        dry_run = True

    return Args()


if __name__ == "__main__":
    unittest.main()
