import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from crypto_screener.cli import main


class CliTests(unittest.TestCase):
    def test_cli_summary_output_and_no_report_flags_stay_stable(self):
        payload = {
            "run_id": "run-cli",
            "rows": [
                {"symbol": "LONG", "factor_score": 0.5, "long_score": 10, "is_trusted": True},
                {"symbol": "SHORT", "factor_score": -0.5, "short_score": 11, "is_trusted": True},
                {
                    "symbol": "FADE",
                    "factor_score": 0.1,
                    "crowded_long_score": 12,
                    "funding_rate_pct": 0.02,
                    "is_trusted": True,
                },
                {
                    "symbol": "SQUEEZE",
                    "factor_score": -0.1,
                    "squeeze_risk_score": 13,
                    "funding_rate_pct": -0.02,
                    "is_trusted": True,
                },
            ],
            "regime": {"bias": "risk-on", "label": "momentum"},
            "factor_weights": {"mode": "prior"},
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            stdout = io.StringIO()
            argv = [
                "crypto-screener",
                "--config",
                "config/default.json",
                "--out-dir",
                tmpdir,
                "--no-save",
                "--no-reports",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch("crypto_screener.cli.run_pipeline", return_value=(payload, {})) as run_pipeline,
                redirect_stdout(stdout),
            ):
                exit_code = main()

        self.assertEqual(exit_code, 0)
        run_pipeline.assert_called_once()
        self.assertEqual(run_pipeline.call_args.args[1], Path(tmpdir))
        self.assertIs(run_pipeline.call_args.kwargs["save"], False)
        self.assertIs(run_pipeline.call_args.kwargs["write_report_files"], False)
        self.assertEqual(
            stdout.getvalue().splitlines(),
            [
                "run_id=run-cli",
                "screened_symbols=4",
                "bias=risk-on",
                "factor_regime=momentum",
                "weight_mode=prior",
                "long_candidates=1",
                "short_candidates=1",
                "crowded_longs=1",
                "squeeze_risks=1",
                "reports=skipped",
            ],
        )


if __name__ == "__main__":
    unittest.main()
