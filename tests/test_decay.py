from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from crypto_screener.factors import factor_decay
from crypto_screener.storage import (
    load_labeled_factor_records,
    load_labeled_records_by_horizon,
    save_factor_history_records,
)

_TZ = ZoneInfo("Asia/Jakarta")


def _perfect_ic_records(
    factor: str,
    n_periods: int,
    *,
    n_symbols: int = 5,
    sign: float = 1.0,
) -> list[dict]:
    records: list[dict] = []
    for period_idx in range(n_periods):
        generated_at = f"2024-01-{period_idx + 1:02d}T12:00:00+07:00"
        for sym_idx in range(n_symbols):
            rank = float(sym_idx)
            records.append(
                {
                    "symbol": f"S{sym_idx}",
                    "generated_at": generated_at,
                    "forward_return_pct": rank * sign,
                    "factors": {factor: rank * sign},
                }
            )
    return records


def _weak_ic_records(
    factor: str,
    n_periods: int,
    *,
    n_symbols: int = 5,
    sign: float = 1.0,
) -> list[dict]:
    records: list[dict] = []
    for period_idx in range(n_periods):
        generated_at = f"2024-01-{period_idx + 1:02d}T12:00:00+07:00"
        for sym_idx in range(n_symbols):
            rank = float(sym_idx)
            records.append(
                {
                    "symbol": f"S{sym_idx}",
                    "generated_at": generated_at,
                    "forward_return_pct": sign * float((sym_idx + period_idx) % n_symbols),
                    "factors": {factor: rank},
                }
            )
    return records


def _negatively_correlated_records(factor: str, n_periods: int, *, n_symbols: int = 5) -> list[dict]:
    records: list[dict] = []
    for period_idx in range(n_periods):
        generated_at = f"2024-01-{period_idx + 1:02d}T12:00:00+07:00"
        for sym_idx in range(n_symbols):
            rank = float(sym_idx)
            records.append(
                {
                    "symbol": f"S{sym_idx}",
                    "generated_at": generated_at,
                    "forward_return_pct": -rank,
                    "factors": {factor: rank},
                }
            )
    return records


def _mirror_records(n_periods: int, *, n_symbols: int = 5) -> list[dict]:
    records: list[dict] = []
    for period_idx in range(n_periods):
        generated_at = f"2024-01-{period_idx + 1:02d}T12:00:00+07:00"
        for sym_idx in range(n_symbols):
            rank = float(sym_idx)
            records.append(
                {
                    "symbol": f"S{sym_idx}",
                    "generated_at": generated_at,
                    "forward_return_pct": rank,
                    "factors": {
                        "momentum_24h": rank,
                        "reversal_3d": -rank,
                    },
                }
            )
    return records


class FactorDecayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = {
            "factors": {
                "ic_min_periods": 10,
                "ic_min_cross_section": 5,
            }
        }

    def test_insufficient_flag_at_ic_min_periods_boundary(self) -> None:
        records_by_horizon = {
            4.0: _perfect_ic_records("momentum_24h", 9),
            24.0: _perfect_ic_records("momentum_24h", 10),
        }
        decay = factor_decay(records_by_horizon, self.config)
        curve = decay["momentum_24h"]["curve"]
        by_horizon = {point["horizon_hours"]: point for point in curve}

        self.assertTrue(by_horizon[4.0]["insufficient"])
        self.assertFalse(by_horizon[24.0]["insufficient"])
        self.assertEqual(len(curve), 2)

    def test_half_life_detected_after_peak(self) -> None:
        records_by_horizon = {
            4.0: _perfect_ic_records("momentum_24h", 12),
            8.0: _perfect_ic_records("momentum_24h", 12),
            24.0: _weak_ic_records("momentum_24h", 12),
        }
        decay = factor_decay(records_by_horizon, self.config)
        summary = decay["momentum_24h"]

        self.assertEqual(summary["peak_horizon_hours"], 4.0)
        self.assertGreater(summary["peak_abs_ic"] or 0.0, 0.5)
        self.assertEqual(summary["half_life_hours"], 24.0)

    def test_first_sign_flip_detected(self) -> None:
        records_by_horizon = {
            4.0: _perfect_ic_records("momentum_24h", 12, sign=1.0),
            24.0: _negatively_correlated_records("momentum_24h", 12),
        }
        decay = factor_decay(records_by_horizon, self.config)
        summary = decay["momentum_24h"]

        self.assertGreater(summary["curve"][0]["mean_ic"] or 0.0, 0.0)
        self.assertLess(summary["curve"][1]["mean_ic"] or 0.0, 0.0)
        self.assertEqual(summary["first_sign_flip_hours"], 24.0)

    def test_pre_peak_opposite_sign_not_flagged_as_flip(self) -> None:
        records_by_horizon = {
            4.0: _weak_ic_records("momentum_24h", 12, sign=-1.0),
            8.0: _perfect_ic_records("momentum_24h", 12),
            24.0: _negatively_correlated_records("momentum_24h", 12),
        }
        decay = factor_decay(records_by_horizon, self.config)
        summary = decay["momentum_24h"]
        curve_by_horizon = {point["horizon_hours"]: point for point in summary["curve"]}

        self.assertEqual(summary["peak_horizon_hours"], 8.0)
        self.assertLess(curve_by_horizon[4.0]["mean_ic"] or 0.0, 0.0)
        self.assertGreater(curve_by_horizon[8.0]["mean_ic"] or 0.0, 0.0)
        self.assertEqual(summary["first_sign_flip_hours"], 24.0)

    def test_mirror_factors_have_opposite_signed_curves(self) -> None:
        records = _mirror_records(12)
        records_by_horizon = {4.0: records, 24.0: records}
        decay = factor_decay(records_by_horizon, self.config)

        momentum_curve = {point["horizon_hours"]: point for point in decay["momentum_24h"]["curve"]}
        reversal_curve = {point["horizon_hours"]: point for point in decay["reversal_3d"]["curve"]}
        for horizon in (4.0, 24.0):
            momentum_ic = momentum_curve[horizon]["mean_ic"]
            reversal_ic = reversal_curve[horizon]["mean_ic"]
            self.assertIsNotNone(momentum_ic)
            self.assertIsNotNone(reversal_ic)
            self.assertAlmostEqual(momentum_ic, -reversal_ic, places=3)

    def test_all_horizons_insufficient_marks_factor_not_sufficient(self) -> None:
        records_by_horizon = {
            4.0: _perfect_ic_records("momentum_24h", 9),
            24.0: _perfect_ic_records("momentum_24h", 9),
        }
        decay = factor_decay(records_by_horizon, self.config)
        summary = decay["momentum_24h"]

        self.assertFalse(summary["sufficient"])
        self.assertIsNone(summary["holds_hours"])

    def test_load_labeled_records_by_horizon_matches_default_loader(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "screener.sqlite3"
            config = {
                "storage_path": str(db_path),
                "factors": {
                    "forward_return_hours": 24,
                    "ic_window_days": 5000,
                },
            }
            base = datetime(2024, 1, 1, 12, tzinfo=_TZ)
            records = []
            for index in range(80):
                generated_at = (base + timedelta(hours=4 * index)).isoformat(timespec="seconds")
                price = 100.0 + index
                records.append(
                    {
                        "run_id": f"run-{index:03d}",
                        "generated_at": generated_at,
                        "symbol": "BTC",
                        "price_usd": price,
                        "factors": {"momentum_24h": float(index % 7)},
                        "scores": {},
                    }
                )
            save_factor_history_records(records, config)

            default_records = load_labeled_factor_records(config)
            by_horizon = load_labeled_records_by_horizon(config, [24.0])
            default_without_regime = [
                {key: value for key, value in record.items() if key != "regime"} for record in default_records
            ]
            self.assertEqual(by_horizon[24.0], default_without_regime)


if __name__ == "__main__":
    unittest.main()
