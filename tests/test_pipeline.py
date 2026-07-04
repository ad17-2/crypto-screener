import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from crypto_screener.pipeline import run_pipeline


class PipelineTests(unittest.TestCase):
    def test_pipeline_can_save_sqlite_without_report_files(self):
        config = {"storage_path": ":memory:"}
        collected = {
            "rows": [{"symbol": "BTC"}],
            "market_context": {"btc_dominance_pct": 55},
            "provider_status": {"coinglass": {"status": "ok"}},
        }
        scored = {
            "rows": [{"symbol": "BTC", "scores": {}, "factors": {}}],
            "factor_weights": {"mode": "prior"},
            "regime": {"bias": "risk-on"},
        }

        with (
            tempfile.TemporaryDirectory() as tmpdir,
            patch("crypto_screener.pipeline.collect_market", return_value=collected),
            patch("crypto_screener.pipeline.load_labeled_factor_records", return_value=[]),
            patch("crypto_screener.pipeline.score_snapshot", return_value=scored),
            patch("crypto_screener.pipeline.save_snapshot") as save_snapshot,
            patch("crypto_screener.pipeline.write_reports") as write_reports,
        ):
            payload, paths = run_pipeline(
                config,
                Path(tmpdir),
                save=True,
                write_report_files=False,
            )

        self.assertEqual(payload["rows"], scored["rows"])
        self.assertEqual(paths, {})
        save_snapshot.assert_called_once()
        write_reports.assert_not_called()


if __name__ == "__main__":
    unittest.main()
