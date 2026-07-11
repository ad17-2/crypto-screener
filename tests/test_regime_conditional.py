from __future__ import annotations

import unittest
from collections.abc import Callable

from crypto_screener.factor_definitions import DEFAULT_PRIORS
from crypto_screener.factors import factor_weights


def _strong_positive(period_idx: int, sym_idx: int, rank: float, n_symbols: int) -> tuple[float, float]:
    forward = rank
    if sym_idx == int(period_idx % n_symbols):
        forward = float((rank + 1) % n_symbols)
    return forward, rank


def _weak_ic(period_idx: int, sym_idx: int, rank: float, n_symbols: int) -> tuple[float, float]:
    return float((sym_idx + period_idx) % n_symbols), rank


def _regime_labeled_records(
    factor: str,
    regime_specs: list[tuple[str, int, Callable[[int, int, float, int], tuple[float, float]]]],
    *,
    n_symbols: int = 5,
) -> list[dict]:
    records: list[dict] = []
    period_idx = 0
    for regime, n_periods, forward_fn in regime_specs:
        for _ in range(n_periods):
            period_idx += 1
            generated_at = f"2024-01-{period_idx:02d}T12:00:00+07:00"
            for sym_idx in range(n_symbols):
                rank = float(sym_idx)
                forward_return_pct, factor_value = forward_fn(period_idx, sym_idx, rank, n_symbols)
                records.append(
                    {
                        "symbol": f"S{sym_idx}",
                        "generated_at": generated_at,
                        "forward_return_pct": forward_return_pct,
                        "factors": {factor: factor_value},
                        "regime": regime,
                    }
                )
    return records


class RegimeConditionalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = {
            "factors": {
                "ic_min_periods": 10,
                "ic_min_cross_section": 5,
                "min_abs_t": 2.0,
                "min_abs_ic": 0.02,
                "regime_min_periods": 8,
                "regime_conditional_prior_strength": 12.0,
                "priors": DEFAULT_PRIORS,
            }
        }

    def test_regime_a_uses_regime_ic_weight(self) -> None:
        records = _regime_labeled_records(
            "momentum_24h",
            [("A", 15, _strong_positive), ("B", 15, _weak_ic)],
        )
        weights = factor_weights(records, self.config, current_regime="A")
        momentum = weights["stats"]["momentum_24h"]

        self.assertEqual(momentum["regime_mode"], "regime-ic")
        self.assertGreater(momentum["regime_k"] or 0.0, 0.0)
        self.assertNotEqual(momentum["weight"], momentum["base_weight"])

    def test_regime_b_falls_back_to_pooled(self) -> None:
        records = _regime_labeled_records(
            "momentum_24h",
            [("A", 15, _strong_positive), ("B", 15, _weak_ic)],
        )
        weights = factor_weights(records, self.config, current_regime="B")
        momentum = weights["stats"]["momentum_24h"]

        self.assertEqual(momentum["regime_mode"], "pooled")
        self.assertEqual(momentum["regime_k"], 0.0)
        self.assertEqual(momentum["weight"], momentum["base_weight"])

    def test_thin_regime_bucket_falls_back_to_pooled(self) -> None:
        records = _regime_labeled_records(
            "momentum_24h",
            [("A", 15, _strong_positive), ("thin", 5, _strong_positive)],
        )
        weights = factor_weights(records, self.config, current_regime="thin")
        momentum = weights["stats"]["momentum_24h"]

        self.assertEqual(momentum["regime_mode"], "pooled")
        self.assertEqual(momentum["regime_k"], 0.0)
        self.assertEqual(weights["directional"]["momentum_24h"], weights["base_directional"]["momentum_24h"])

    def test_current_regime_none_matches_pooled_directional(self) -> None:
        records = _regime_labeled_records(
            "momentum_24h",
            [("A", 15, _strong_positive), ("B", 15, _weak_ic)],
        )
        weights = factor_weights(records, self.config, current_regime=None)

        self.assertFalse(weights["regime_adjusted"])
        self.assertEqual(weights["directional"], weights["base_directional"])


if __name__ == "__main__":
    unittest.main()
