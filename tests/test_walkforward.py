from __future__ import annotations

import unittest

from crypto_screener.factor_definitions import DEFAULT_PRIORS
from crypto_screener.factors import factor_weights, walk_forward


def _split_ic_records(
    factor: str,
    n_periods: int,
    train_fn,
    test_fn,
    *,
    n_symbols: int = 5,
) -> list[dict]:
    split_index = max(15, int(0.6 * n_periods))
    records: list[dict] = []
    for period_idx in range(n_periods):
        generated_at = f"2024-01-{period_idx + 1:02d}T12:00:00+07:00"
        forward_fn = train_fn if period_idx < split_index else test_fn
        for sym_idx in range(n_symbols):
            rank = float(sym_idx)
            forward_return_pct, factor_value = forward_fn(period_idx, sym_idx, rank, n_symbols)
            records.append(
                {
                    "symbol": f"S{sym_idx}",
                    "generated_at": generated_at,
                    "forward_return_pct": forward_return_pct,
                    "factors": {factor: factor_value},
                }
            )
    return records


def _strong_positive(period_idx: int, sym_idx: int, rank: float, n_symbols: int) -> tuple[float, float]:
    forward = rank
    if sym_idx == int(period_idx % n_symbols):
        forward = float((rank + 1) % n_symbols)
    return forward, rank


def _strong_negative(period_idx: int, sym_idx: int, rank: float, n_symbols: int) -> tuple[float, float]:
    forward, factor_value = _strong_positive(period_idx, sym_idx, rank, n_symbols)
    return -forward, factor_value


def _weak_ic(period_idx: int, sym_idx: int, rank: float, n_symbols: int) -> tuple[float, float]:
    return float((sym_idx + period_idx) % n_symbols), rank


class WalkForwardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = {
            "factors": {
                "ic_min_periods": 10,
                "ic_min_cross_section": 5,
                "min_abs_t": 2.0,
                "min_abs_ic": 0.02,
                "walk_forward_train_fraction": 0.6,
                "walk_forward_min_train_periods": 15,
                "walk_forward_min_oos_periods": 10,
                "walk_forward_robust_min_ic": 0.02,
                "walk_forward_overfit_penalty": 0.0,
                "walk_forward_gating": False,
                "priors": DEFAULT_PRIORS,
            }
        }

    def test_robust_factor_flagged_robust(self) -> None:
        records = _split_ic_records("momentum_24h", 30, _strong_positive, _strong_positive)
        result = walk_forward(records, self.config)
        summary = result["factors"]["momentum_24h"]

        self.assertEqual(summary["verdict"], "robust")
        self.assertGreater(summary["is_ic"] or 0.0, 0.0)
        self.assertGreater(summary["oos_ic"] or 0.0, 0.0)

    def test_overfit_factor_flagged_overfit(self) -> None:
        records = _split_ic_records("momentum_24h", 30, _strong_positive, _strong_negative)
        result = walk_forward(records, self.config)
        summary = result["factors"]["momentum_24h"]

        self.assertEqual(summary["verdict"], "overfit")
        self.assertGreater(summary["is_ic"] or 0.0, 0.0)
        self.assertLess(summary["oos_ic"] or 0.0, 0.0)

    def test_insufficient_when_no_insample_signal(self) -> None:
        records = _split_ic_records("momentum_24h", 30, _weak_ic, _weak_ic)
        result = walk_forward(records, self.config)
        summary = result["factors"]["momentum_24h"]

        self.assertEqual(summary["verdict"], "insufficient-data")

    def test_insufficient_when_too_few_periods(self) -> None:
        records = _split_ic_records("momentum_24h", 20, _strong_positive, _strong_positive)
        result = walk_forward(records, self.config)

        for factor_summary in result["factors"].values():
            self.assertEqual(factor_summary["verdict"], "insufficient-data")

    def test_gating_off_is_noop(self) -> None:
        records = _split_ic_records("momentum_24h", 30, _strong_positive, _weak_ic)
        weights = factor_weights(records, self.config)
        momentum = weights["stats"]["momentum_24h"]

        self.assertEqual(weights["walk_forward"]["factors"]["momentum_24h"]["verdict"], "overfit")
        self.assertEqual(momentum["mode"], "ic")
        self.assertGreater(momentum["credibility_k"] or 0.0, 0.0)

        gated_config = {
            "factors": {
                **self.config["factors"],
                "walk_forward_gating": True,
                "walk_forward_overfit_penalty": 0.0,
            }
        }
        gated_weights = factor_weights(records, gated_config)
        self.assertNotEqual(
            weights["directional"]["momentum_24h"],
            gated_weights["directional"]["momentum_24h"],
        )

    def test_gating_on_pulls_overfit_to_prior(self) -> None:
        overfit_records = _split_ic_records("momentum_24h", 30, _strong_positive, _weak_ic)
        robust_records = _split_ic_records("momentum_24h", 30, _strong_positive, _strong_positive)

        config_off = self.config
        config_on = {
            "factors": {
                **self.config["factors"],
                "walk_forward_gating": True,
                "walk_forward_overfit_penalty": 0.0,
            }
        }

        overfit_on = factor_weights(overfit_records, config_on)
        momentum_on = overfit_on["stats"]["momentum_24h"]

        self.assertEqual(momentum_on["mode"], "prior")
        self.assertAlmostEqual(momentum_on["raw_weight"], DEFAULT_PRIORS["momentum_24h"])

        robust_off = factor_weights(robust_records, config_off)
        robust_on = factor_weights(robust_records, config_on)
        self.assertEqual(
            robust_off["directional"]["momentum_24h"],
            robust_on["directional"]["momentum_24h"],
        )


if __name__ == "__main__":
    unittest.main()
