from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

from .factor_definitions import DEFAULT_PRIORS, DIRECTIONAL_FACTORS, QUALITY_FACTORS
from .independence import factor_correlations
from .market import market_sensing_summary, market_structure_summary
from .regime import classify_regime
from .scoring import clamp, mean, median, robust_zscore_by_key, safe_log10, spearman_corr, stdev, to_float


def score_snapshot(
    rows: list[dict[str, Any]],
    market_context: dict[str, Any],
    history_records: list[dict[str, Any]],
    config: dict[str, Any],
    prior_market_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    trusted_rows = [row for row in rows if row.get("is_trusted", True)]
    enriched_context = dict(market_context or {})
    enriched_context.update(market_structure_summary(trusted_rows, enriched_context))
    enriched_context.update(market_sensing_summary(trusted_rows, enriched_context, prior_market_state))
    valid_atr = [value for value in (to_float(row.get("atr_14_pct")) for row in trusted_rows) if value is not None]
    enriched_context["median_atr_pct"] = median(valid_atr) if valid_atr else None
    raw_factors = [_raw_factors(row, trusted_rows, enriched_context) for row in trusted_rows]
    normalized = _normalize_factors(raw_factors)
    base_weights = factor_weights(history_records, config)
    prior_state = (prior_market_state or {}).get("regime_state")
    base_regime = infer_regime(base_weights, trusted_rows, enriched_context, prior_state, config)
    weights = apply_regime_weighting(base_weights, base_regime, config)
    regime = infer_regime(weights, trusted_rows, enriched_context, prior_state, config)

    for row, raw, factors in zip(trusted_rows, raw_factors, normalized, strict=True):
        row["raw_factors"] = raw
        row["factors"] = factors
        _apply_scores(row, factors, weights, regime, enriched_context, config)

    for row in rows:
        if row.get("is_trusted", True):
            continue
        row["raw_factors"] = {}
        row["factors"] = {}
        _apply_excluded_scores(row)

    correlation_rows = [{"factors": factors} for factors in normalized]
    factor_correlation_flags = factor_correlations(correlation_rows, DIRECTIONAL_FACTORS)
    weights["factor_correlations"] = factor_correlation_flags

    return {
        "rows": rows,
        "market_context": enriched_context,
        "factor_weights": weights,
        "factor_correlations": factor_correlation_flags,
        "regime": regime,
    }


def _raw_factors(
    row: dict[str, Any],
    rows: list[dict[str, Any]],
    market_context: dict[str, Any],
) -> dict[str, float | None]:
    price_change = to_float(row.get("price_change_24h_pct"))
    oi_change = to_float(row.get("oi_change_24h_pct"))
    funding = to_float(row.get("funding_rate_pct"))
    ls = to_float(row.get("long_short_account_ratio"))
    if ls is None:
        ls = to_float(row.get("long_short_ratio"))
    long_liq = to_float(row.get("long_liquidation_usd_24h"), 0.0) or 0.0
    short_liq = to_float(row.get("short_liquidation_usd_24h"), 0.0) or 0.0
    quote_volume = to_float(row.get("quote_volume_usd"), 0.0) or 0.0
    depth = to_float(row.get("depth_0_5pct_usd"), 0.0) or 0.0
    spread = to_float(row.get("spread_bps"))
    volume_change = to_float(row.get("volume_change_percent_24h"))
    technical_trend = to_float(row.get("technical_trend_score"))
    technical_momentum = to_float(row.get("technical_momentum_score"))
    atr_pct = to_float(row.get("atr_14_pct"))
    oi_acceleration = to_float(row.get("oi_acceleration_4h_pct"))
    funding_avg = to_float(row.get("funding_avg_24h_pct"))
    taker_imbalance = to_float(row.get("taker_imbalance_24h_pct"))
    liquidation_imbalance_24h = to_float(row.get("liquidation_imbalance_24h_pct"))

    liq_total = long_liq + short_liq

    liquidity = safe_log10(quote_volume)
    if depth > 0:
        liquidity += safe_log10(depth) * 0.25
    if spread is not None:
        liquidity -= min(max(spread, 0.0), 50.0) / 50.0

    oi_price = None
    if price_change is not None and oi_change is not None:
        oi_price = math.copysign(max(oi_change, 0.0), price_change)

    ls_contrarian = None
    if ls is not None and ls > 0:
        ls_contrarian = -math.log(ls)

    oi_acceleration_signal = None
    if oi_acceleration is not None and price_change is not None:
        oi_acceleration_signal = math.copysign(max(oi_acceleration, 0.0), price_change)

    price_change_72h = to_float(row.get("price_change_72h_pct"))
    reversal = None
    if price_change_72h is not None:
        denom = atr_pct if atr_pct is not None else to_float(market_context.get("median_atr_pct"))
        reversal = -price_change_72h / max(denom or 1.0, 1.0)

    return {
        "momentum_24h": price_change,
        "reversal_3d": reversal,
        "oi_price_signal": oi_price,
        "funding_rate_contrarian": -funding if funding is not None else None,
        "ls_ratio_contrarian": ls_contrarian,
        "liquidation_imbalance": ((short_liq - long_liq) / liq_total) * 100.0 if liq_total > 0 else None,
        "technical_trend_4h": technical_trend,
        "technical_momentum_4h": technical_momentum,
        "oi_acceleration_signal": oi_acceleration_signal,
        "funding_persistence_contrarian": -funding_avg if funding_avg is not None else None,
        "taker_flow_24h": taker_imbalance,
        "liquidation_pressure_24h": liquidation_imbalance_24h,
        "liquidity_30d": liquidity if quote_volume > 0 else None,
        "volume_expansion_24h": volume_change,
        "volatility_expansion_4h": atr_pct,
    }


def _normalize_factors(raw_rows: list[dict[str, float | None]]) -> list[dict[str, float]]:
    keys = DIRECTIONAL_FACTORS + QUALITY_FACTORS
    normalized: list[dict[str, float]] = [dict() for _ in raw_rows]
    for key in keys:
        zscores = robust_zscore_by_key(raw_rows, key)
        for index, score in enumerate(zscores):
            normalized[index][key] = score
    return normalized


def _cross_sectional_ic(records: list[dict[str, Any]], factor: str, min_cross_section: int) -> dict[str, Any]:
    # Per-section rank IC already neutralizes cross-time market drift; no explicit demeaning needed.
    grouped: dict[Any, list[tuple[float, float]]] = {}
    n_obs = 0
    for record in records:
        factor_value = to_float(record.get("factors", {}).get(factor))
        forward_return = to_float(record.get("forward_return_pct"))
        if factor_value is None or forward_return is None:
            continue
        n_obs += 1
        grouped.setdefault(record.get("generated_at"), []).append((factor_value, forward_return))

    ic_series: list[float] = []
    for pairs in grouped.values():
        if len(pairs) < min_cross_section:
            continue
        x_values = [x for x, _ in pairs]
        y_values = [y for _, y in pairs]
        ic = spearman_corr(x_values, y_values)
        if ic is not None:
            ic_series.append(ic)

    n_periods = len(ic_series)
    mean_ic = mean(ic_series) if ic_series else None
    t_stat = None
    if n_periods >= 2 and mean_ic is not None:
        ic_stdev = stdev(ic_series)
        if ic_stdev > 0:
            t_stat = mean_ic / (ic_stdev / math.sqrt(n_periods))

    return {
        "mean_ic": mean_ic,
        "t_stat": t_stat,
        "n_periods": n_periods,
        "n_obs": n_obs,
    }


def _sign_value(value: float) -> int:
    return (value > 0) - (value < 0)


def walk_forward(history_records: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    factor_cfg = config.get("factors", {})
    train_fraction = float(factor_cfg.get("walk_forward_train_fraction", 0.6))
    min_train_periods = int(factor_cfg.get("walk_forward_min_train_periods", 15))
    min_oos_periods = int(factor_cfg.get("walk_forward_min_oos_periods", 10))
    robust_min_ic = float(factor_cfg.get("walk_forward_robust_min_ic", 0.02))
    ic_min_cross_section = int(factor_cfg.get("ic_min_cross_section", 5))
    ic_min_periods = int(factor_cfg.get("ic_min_periods", 10))
    min_abs_t = float(factor_cfg.get("min_abs_t", 2.0))
    min_abs_ic = float(factor_cfg.get("min_abs_ic", 0.02))

    timestamps = sorted(
        {str(generated_at) for record in history_records if (generated_at := record.get("generated_at")) is not None}
    )
    n_ts = len(timestamps)
    split_index = max(min_train_periods, math.floor(train_fraction * n_ts))
    train_timestamps = set(timestamps[:split_index])
    test_timestamps = set(timestamps[split_index:])

    train_records = [record for record in history_records if record.get("generated_at") in train_timestamps]
    test_records = [record for record in history_records if record.get("generated_at") in test_timestamps]

    factors_result: dict[str, Any] = {}
    for factor in DIRECTIONAL_FACTORS:
        is_ic = _cross_sectional_ic(train_records, factor, ic_min_cross_section)
        oos_ic = _cross_sectional_ic(test_records, factor, ic_min_cross_section)
        is_mean = is_ic["mean_ic"]
        oos_mean = oos_ic["mean_ic"]
        is_t = is_ic["t_stat"]

        if is_ic["n_periods"] < ic_min_periods or oos_ic["n_periods"] < min_oos_periods:
            verdict = "insufficient-data"
        elif is_t is not None and abs(is_t) >= min_abs_t and is_mean is not None and abs(is_mean) >= min_abs_ic:
            if (
                oos_mean is not None
                and _sign_value(oos_mean) == _sign_value(is_mean)
                and abs(oos_mean) >= robust_min_ic
            ):
                verdict = "robust"
            else:
                verdict = "overfit"
        else:
            verdict = "insufficient-data"

        factors_result[factor] = {
            "verdict": verdict,
            "is_ic": round(is_mean, 4) if is_mean is not None else None,
            "is_t_stat": round(is_t, 3) if is_t is not None else None,
            "is_n_periods": is_ic["n_periods"],
            "oos_ic": round(oos_mean, 4) if oos_mean is not None else None,
            "oos_t_stat": round(oos_ic["t_stat"], 3) if oos_ic["t_stat"] is not None else None,
            "oos_n_periods": oos_ic["n_periods"],
        }

    return {
        "split_index": split_index,
        "n_timestamps": n_ts,
        "train_periods": split_index,
        "factors": factors_result,
    }


def factor_weights(history_records: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    factor_cfg = config.get("factors", {})
    priors = factor_cfg.get("priors", DEFAULT_PRIORS)
    max_abs_weight = float(factor_cfg.get("max_abs_weight", 0.35))
    min_abs_ic = float(factor_cfg.get("min_abs_ic", 0.02))
    ic_min_periods = int(factor_cfg.get("ic_min_periods", 10))
    min_abs_t = float(factor_cfg.get("min_abs_t", 2.0))
    ic_prior_strength = float(factor_cfg.get("ic_prior_strength", 10))
    ic_min_cross_section = int(factor_cfg.get("ic_min_cross_section", 5))
    walk_forward_gating = bool(factor_cfg.get("walk_forward_gating", False))
    overfit_penalty = float(factor_cfg.get("walk_forward_overfit_penalty", 0.0))
    wf = walk_forward(history_records, config)

    factor_stats: dict[str, dict[str, Any]] = {}
    raw_weights: dict[str, float] = {}

    for factor in DIRECTIONAL_FACTORS:
        cs_ic = _cross_sectional_ic(history_records, factor, ic_min_cross_section)
        mean_ic = cs_ic["mean_ic"]
        t_stat = cs_ic["t_stat"]
        n_periods = cs_ic["n_periods"]
        observations = cs_ic["n_obs"]
        prior_signed = float(priors.get(factor, 0.0))
        k = n_periods / (n_periods + ic_prior_strength) if n_periods > 0 else 0.0
        use_observed = (
            n_periods >= ic_min_periods
            and t_stat is not None
            and abs(t_stat) >= min_abs_t
            and mean_ic is not None
            and abs(mean_ic) >= min_abs_ic
        )
        k_effective = k if use_observed else 0.0
        if walk_forward_gating and wf["factors"].get(factor, {}).get("verdict") == "overfit":
            k_effective *= overfit_penalty
        if use_observed and mean_ic is not None and k_effective > 0:
            raw = (1.0 - k_effective) * prior_signed + k_effective * clamp(mean_ic, -max_abs_weight, max_abs_weight)
            mode = "ic"
        else:
            raw = prior_signed
            mode = "prior"
        raw_weights[factor] = raw
        wf_factor = wf["factors"].get(factor, {})
        factor_stats[factor] = {
            "ic": mean_ic,
            "observations": observations,
            "n_periods": n_periods,
            "t_stat": t_stat,
            "credibility_k": k_effective,
            "mode": mode,
            "raw_weight": raw,
            "robustness": wf_factor.get("verdict"),
            "oos_ic": wf_factor.get("oos_ic"),
        }

    abs_total = sum(abs(value) for value in raw_weights.values()) or 1.0
    normalized = {factor: raw_weights[factor] / abs_total for factor in DIRECTIONAL_FACTORS}
    for factor, value in normalized.items():
        factor_stats[factor]["weight"] = value

    return {
        "directional": normalized,
        "stats": factor_stats,
        "history_records": len(history_records),
        "mode": "ic" if any(item["mode"] == "ic" for item in factor_stats.values()) else "prior",
        "validation": validation_metrics(history_records, config),
        "walk_forward": wf,
    }


def factor_decay(
    records_by_horizon: dict[float, list[dict[str, Any]]],
    config: dict[str, Any],
) -> dict[str, Any]:
    factor_cfg = config.get("factors", {})
    ic_min_cross_section = int(factor_cfg.get("ic_min_cross_section", 5))
    ic_min_periods = int(factor_cfg.get("ic_min_periods", 10))
    horizons = sorted(records_by_horizon.keys())
    result: dict[str, Any] = {}

    for factor in DIRECTIONAL_FACTORS:
        curve: list[dict[str, Any]] = []
        for horizon in horizons:
            ic_result = _cross_sectional_ic(records_by_horizon[horizon], factor, ic_min_cross_section)
            mean_ic = ic_result["mean_ic"]
            t_stat = ic_result["t_stat"]
            n_periods = ic_result["n_periods"]
            curve.append(
                {
                    "horizon_hours": horizon,
                    "mean_ic": round(mean_ic, 4) if mean_ic is not None else None,
                    "t_stat": round(t_stat, 3) if t_stat is not None else None,
                    "n_periods": n_periods,
                    "insufficient": n_periods < ic_min_periods,
                }
            )

        sufficient_points = [point for point in curve if not point["insufficient"]]
        sufficient = bool(sufficient_points)
        peak_abs_ic = None
        peak_horizon_hours = None
        half_life_hours = None
        first_sign_flip_hours = None
        holds_hours = None

        if sufficient_points:
            peak_point = max(sufficient_points, key=lambda point: abs(point["mean_ic"] or 0.0))
            peak_mean_ic = peak_point["mean_ic"]
            peak_abs_ic = abs(peak_mean_ic or 0.0)
            peak_horizon_hours = peak_point["horizon_hours"]

            if peak_abs_ic > 0:
                for point in curve:
                    if point["horizon_hours"] <= peak_horizon_hours or point["insufficient"]:
                        continue
                    mean_ic = point["mean_ic"]
                    if mean_ic is not None and abs(mean_ic) < 0.5 * peak_abs_ic:
                        half_life_hours = point["horizon_hours"]
                        break

            if peak_mean_ic not in (None, 0.0):
                peak_positive = peak_mean_ic > 0
                for point in curve:
                    if point["horizon_hours"] <= peak_horizon_hours or point["insufficient"]:
                        continue
                    mean_ic = point["mean_ic"]
                    if mean_ic in (None, 0.0):
                        continue
                    if (mean_ic > 0) != peak_positive:
                        first_sign_flip_hours = point["horizon_hours"]
                        break

            hold_candidates = [value for value in (half_life_hours, first_sign_flip_hours) if value is not None]
            holds_hours = min(hold_candidates) if hold_candidates else None

        result[factor] = {
            "curve": curve,
            "peak_abs_ic": round(peak_abs_ic, 4) if peak_abs_ic is not None else None,
            "peak_horizon_hours": peak_horizon_hours,
            "half_life_hours": half_life_hours,
            "first_sign_flip_hours": first_sign_flip_hours,
            "holds_hours": holds_hours,
            "sufficient": sufficient,
        }

    return result


def validation_metrics(history_records: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    factor_cfg = config.get("factors", {})
    horizon_hours = float(factor_cfg.get("forward_return_hours", 24))
    records = [record for record in history_records if to_float(record.get("forward_return_pct")) is not None]
    if not records:
        return {
            "status": "insufficient",
            "horizon_hours": horizon_hours,
            "observations": 0,
            "model": {},
            "factors": {},
        }

    model_pairs = [
        (to_float(record.get("scores", {}).get("factor_score")), to_float(record.get("forward_return_pct")))
        for record in records
    ]
    model_valid = [(score, forward) for score, forward in model_pairs if score is not None and forward is not None]
    factor_results = {
        factor: _directional_validation(
            [
                (to_float(record.get("factors", {}).get(factor)), to_float(record.get("forward_return_pct")))
                for record in records
            ]
        )
        for factor in DIRECTIONAL_FACTORS
    }

    return {
        "status": "ok" if len(records) >= int(factor_cfg.get("min_observations", 30)) else "limited",
        "horizon_hours": horizon_hours,
        "observations": len(records),
        "model": _directional_validation(model_valid),
        "factors": factor_results,
    }


def apply_regime_weighting(
    weights: dict[str, Any],
    regime: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, Any]:
    regime_cfg = config.get("factors", {}).get("regime_weighting", {})
    if regime_cfg.get("enabled", True) is False:
        return weights

    directional = weights.get("directional", {})
    multipliers = _regime_multipliers(regime, config)
    max_multiplier = float(regime_cfg.get("max_factor_multiplier", 1.35))
    adjusted_raw = {
        factor: float(directional.get(factor, 0.0)) * min(max(multipliers.get(factor, 1.0), 0.35), max_multiplier)
        for factor in DIRECTIONAL_FACTORS
    }
    abs_total = sum(abs(value) for value in adjusted_raw.values()) or 1.0
    adjusted = {factor: adjusted_raw[factor] / abs_total for factor in DIRECTIONAL_FACTORS}
    result = {
        **weights,
        "base_directional": dict(directional),
        "directional": adjusted,
        "regime_adjusted": True,
        "regime_adjustment": {
            "label": regime.get("label", "neutral"),
            "bias": regime.get("bias", "mixed"),
            "breadth_label": regime.get("breadth_label", "unknown"),
            "multipliers": {factor: round(multipliers.get(factor, 1.0), 3) for factor in DIRECTIONAL_FACTORS},
        },
    }
    result["stats"] = {
        factor: {
            **details,
            "base_weight": directional.get(factor, 0.0),
            "weight": adjusted.get(factor, 0.0),
            "regime_multiplier": round(multipliers.get(factor, 1.0), 3),
        }
        for factor, details in weights.get("stats", {}).items()
    }
    return result


def _directional_validation(pairs: Sequence[tuple[float | None, float | None]]) -> dict[str, Any]:
    valid = [
        (signal, forward) for signal, forward in pairs if signal is not None and forward is not None and signal != 0
    ]
    if not valid:
        return {
            "observations": 0,
            "hit_rate": None,
            "avg_forward_return_pct": None,
        }
    hits = sum(1 for signal, forward in valid if signal * forward > 0)
    avg_forward = sum(forward for _, forward in valid) / len(valid)
    positive = [(signal, forward) for signal, forward in valid if signal > 0]
    negative = [(signal, forward) for signal, forward in valid if signal < 0]
    return {
        "observations": len(valid),
        "hit_rate": round((hits / len(valid)) * 100.0, 2),
        "avg_forward_return_pct": round(avg_forward, 3),
        "long_observations": len(positive),
        "long_hit_rate": _hit_rate(positive, 1.0),
        "short_observations": len(negative),
        "short_hit_rate": _hit_rate(negative, -1.0),
    }


def _hit_rate(pairs: list[tuple[float, float]], expected_direction: float) -> float | None:
    if not pairs:
        return None
    hits = sum(1 for _, forward in pairs if forward * expected_direction > 0)
    return round((hits / len(pairs)) * 100.0, 2)


def _regime_multipliers(regime: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, float]:
    multipliers = {factor: 1.0 for factor in DIRECTIONAL_FACTORS}
    label = str(regime.get("label") or "neutral")
    bias = str(regime.get("bias") or "mixed")
    breadth_score = to_float(regime.get("breadth_score"), 0.0) or 0.0
    regime_cfg = (config or {}).get("factors", {}).get("regime", {})

    # Placeholder state nudges until Phase 5 makes weighting data-driven.
    if label == "btc-led":
        _multiply(
            multipliers,
            ["momentum_24h", "technical_trend_4h"],
            float(regime_cfg.get("nudge_btc_led", 1.12)),
        )
    elif label == "alts-strong":
        _multiply(
            multipliers,
            ["momentum_24h", "oi_price_signal", "taker_flow_24h"],
            float(regime_cfg.get("nudge_alts_strong", 1.10)),
        )
    elif label == "chaos":
        _multiply(
            multipliers,
            ["momentum_24h", "technical_trend_4h", "reversal_3d"],
            float(regime_cfg.get("nudge_chaos_trend", 0.88)),
        )
        _multiply(
            multipliers,
            ["funding_rate_contrarian", "ls_ratio_contrarian", "liquidation_imbalance"],
            float(regime_cfg.get("nudge_chaos_contrarian", 1.12)),
        )

    if bias == "risk-on":
        _multiply(multipliers, ["momentum_24h", "oi_price_signal", "technical_trend_4h"], 1.08)
        _multiply(multipliers, ["reversal_3d"], 0.92)
    elif bias == "risk-off":
        _multiply(multipliers, ["momentum_24h", "oi_price_signal", "technical_trend_4h", "taker_flow_24h"], 1.08)

    if abs(breadth_score) >= 0.35:
        _multiply(multipliers, ["momentum_24h", "oi_price_signal", "technical_trend_4h"], 1.06)
    return multipliers


def _multiply(multipliers: dict[str, float], factors: list[str], value: float) -> None:
    for factor in factors:
        if factor in multipliers:
            multipliers[factor] *= value


def infer_regime(
    weights: dict[str, Any],
    rows: list[dict[str, Any]],
    market_context: dict[str, Any],
    prior_state: str | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    avg_funding = _avg([to_float(row.get("funding_rate_pct")) for row in rows])
    btc_change = _btc_change(rows, market_context)
    market_cap_change = to_float(market_context.get("market_cap_change_24h_pct"))
    breadth = market_context.get("breadth", {})
    sector_rotation = market_context.get("sector_rotation", {})
    breadth_score = to_float(breadth.get("score"))

    classified = classify_regime(market_context, prior_state, config or {})
    label = classified["state"]

    bias_score = 0.0
    if btc_change is not None:
        bias_score += clamp(btc_change / 3.0, -1.0, 1.0)
    if market_cap_change is not None:
        bias_score += clamp(market_cap_change / 3.0, -1.0, 1.0)
    if breadth_score is not None:
        bias_score += clamp(breadth_score, -1.0, 1.0) * 0.65
    if avg_funding is not None:
        bias_score -= clamp(abs(avg_funding) / 0.06, 0.0, 1.0) * 0.35

    if bias_score >= 0.95:
        bias = "risk-on"
    elif bias_score <= -0.95:
        bias = "risk-off"
    else:
        bias = "mixed"

    btc_dominance_delta_pct = to_float(market_context.get("btc_dominance_delta_pct"))
    eth_btc_performance_pct = to_float(market_context.get("eth_btc_performance_pct"))

    return {
        "label": label,
        "regime_state": label,
        "regime_scores": classified["scores"],
        "raw_regime_state": classified["raw_state"],
        "bias": bias,
        "bias_score": round(bias_score, 3),
        "btc_change_24h_pct": btc_change,
        "btc_dominance_delta_pct": btc_dominance_delta_pct,
        "eth_btc_performance_pct": eth_btc_performance_pct,
        "avg_funding_rate_pct": avg_funding,
        "market_cap_change_24h_pct": market_cap_change,
        "breadth_score": breadth_score,
        "breadth_label": breadth.get("label", "unknown"),
        "sector_rotation_label": sector_rotation.get("label", "unknown"),
    }


def _apply_scores(
    row: dict[str, Any],
    factors: dict[str, float],
    weights: dict[str, Any],
    regime: dict[str, Any],
    market_context: dict[str, Any],
    config: dict[str, Any],
) -> None:
    directional_weights = weights.get("directional", {})
    directional_score = sum(factors.get(name, 0.0) * weight for name, weight in directional_weights.items())
    liquidity_quality = _quality_percentile(factors.get("liquidity_30d", 0.0))
    conflicts = _signal_conflict_summary(row, factors, directional_score, regime, market_context)

    funding = to_float(row.get("funding_rate_pct"), 0.0) or 0.0
    ls = to_float(row.get("long_short_account_ratio"))
    if ls is None:
        ls = to_float(row.get("long_short_ratio"))
    oi_change = to_float(row.get("oi_change_24h_pct"), 0.0) or 0.0
    price_change = to_float(row.get("price_change_24h_pct"), 0.0) or 0.0

    long_crowding = clamp(max(funding, 0.0) / 0.08)
    if ls is not None:
        long_crowding += clamp((ls - 1.3) / 0.7)
    short_crowding = clamp(abs(min(funding, 0.0)) / 0.08)
    if ls is not None and ls > 0:
        short_crowding += clamp((0.8 - ls) / 0.5)

    long_score = max(0.0, directional_score) * 55.0 + liquidity_quality * 0.25 - long_crowding * 10.0
    short_score = max(0.0, -directional_score) * 55.0 + liquidity_quality * 0.25 - short_crowding * 8.0
    crowded_long_score = (
        long_crowding * 35.0
        + clamp(max(oi_change, 0.0) / 12.0) * 25.0
        + clamp(max(price_change, 0.0) / 10.0) * 15.0
        + liquidity_quality * 0.25
    )
    squeeze_risk_score = (
        short_crowding * 38.0
        + clamp(max(oi_change, 0.0) / 12.0) * 24.0
        + clamp(max(price_change, 0.0) / 8.0) * 13.0
        + liquidity_quality * 0.25
    )
    score_cfg = config.get("factors", {}).get("regime_weighting", {})
    adjustment_strength = float(score_cfg.get("score_adjustment_strength", 0.08))
    conflict_penalty_strength = float(score_cfg.get("conflict_penalty_strength", 0.18))
    alignment = conflicts.get("regime_alignment_score", 0.0)
    conflict_score = conflicts.get("signal_conflict_score", 0.0)
    setup_multiplier = max(
        0.70,
        1.0 + (alignment * adjustment_strength) - ((conflict_score / 100.0) * conflict_penalty_strength),
    )
    if directional_score > 0:
        long_score *= setup_multiplier
    elif directional_score < 0:
        short_score *= setup_multiplier

    row["scores"] = {
        "factor_score": round(directional_score, 4),
        "liquidity_quality": round(liquidity_quality, 2),
        "long_score": round(max(long_score, 0.0), 2),
        "short_score": round(max(short_score, 0.0), 2),
        "crowded_long_score": round(crowded_long_score, 2),
        "squeeze_risk_score": round(squeeze_risk_score, 2),
        "confidence_score": round(_confidence_score(row, factors, directional_score, liquidity_quality, conflicts), 0),
        "signal_conflict_score": round(conflict_score, 0),
        "regime_alignment_score": round(alignment, 3),
        "breadth_alignment_score": round(conflicts.get("breadth_alignment_score", 0.0), 3),
    }
    row.update(conflicts)
    row.update(row["scores"])


def _apply_excluded_scores(row: dict[str, Any]) -> None:
    row["scores"] = {
        "factor_score": 0.0,
        "liquidity_quality": 0.0,
        "long_score": 0.0,
        "short_score": 0.0,
        "crowded_long_score": 0.0,
        "squeeze_risk_score": 0.0,
        "confidence_score": 0.0,
        "signal_conflict_score": 0.0,
        "regime_alignment_score": 0.0,
        "breadth_alignment_score": 0.0,
    }
    row["signal_conflict_label"] = "excluded"
    row["signal_conflicts"] = []
    row.update(row["scores"])


def _btc_change(rows: list[dict[str, Any]], market_context: dict[str, Any]) -> float | None:
    for row in rows:
        if row.get("symbol") == "BTC":
            return to_float(row.get("price_change_24h_pct"))
    return to_float(market_context.get("btc_price_change_24h_pct"))


def _avg(values: list[float | None]) -> float | None:
    valid = [value for value in values if value is not None]
    return sum(valid) / len(valid) if valid else None


def _quality_percentile(zscore: float) -> float:
    # Smooth z-score to a 0-100 quality range without scipy.
    return 100.0 / (1.0 + math.exp(-zscore))


def _signal_conflict_summary(
    row: dict[str, Any],
    factors: dict[str, float],
    directional_score: float,
    regime: dict[str, Any],
    market_context: dict[str, Any],
) -> dict[str, Any]:
    direction = _direction(directional_score, threshold=0.03)
    if direction == 0:
        return {
            "signal_conflict_label": "neutral",
            "signal_conflict_score": 0.0,
            "signal_conflicts": [],
            "regime_alignment_score": 0.0,
            "breadth_alignment_score": 0.0,
        }

    checks = [
        (
            "technical",
            "4h technicals",
            _avg_signal([row.get("technical_trend_score"), row.get("technical_momentum_score")]),
            0.20,
        ),
        ("derivatives", "derivatives confirmation", row.get("derivatives_confirmation_score"), 0.20),
        ("funding", "funding contrarian", factors.get("funding_rate_contrarian"), 0.35),
        ("positioning", "OI/price", factors.get("oi_price_signal"), 0.35),
        ("taker", "taker flow", factors.get("taker_flow_24h"), 0.35),
    ]
    conflicts: list[dict[str, Any]] = []
    for code, label, value, threshold in checks:
        conflict = _conflict_item(code, label, value, direction, threshold)
        if conflict:
            conflicts.append(conflict)

    regime_alignment = _regime_alignment(direction, regime)
    if regime_alignment < -0.25:
        conflicts.append(
            {
                "code": "regime_bias",
                "label": "regime bias",
                "severity": round(abs(regime_alignment), 3),
                "detail": f"{regime.get('bias', 'mixed')} conflicts with model direction",
            }
        )

    breadth_score = to_float(market_context.get("breadth", {}).get("score"))
    breadth_alignment = 0.0 if breadth_score is None else clamp(breadth_score * direction, -1.0, 1.0)
    if breadth_alignment < -0.25:
        conflicts.append(
            {
                "code": "market_breadth",
                "label": "market breadth",
                "severity": round(abs(breadth_alignment), 3),
                "detail": f"{market_context.get('breadth', {}).get('label', 'breadth')} conflicts with model direction",
            }
        )

    conflict_score = min(100.0, sum(18.0 + (item["severity"] * 22.0) for item in conflicts))
    return {
        "signal_conflict_label": _conflict_label(conflicts),
        "signal_conflict_score": round(conflict_score, 2),
        "signal_conflicts": conflicts,
        "regime_alignment_score": round(regime_alignment, 3),
        "breadth_alignment_score": round(breadth_alignment, 3),
    }


def _confidence_score(
    row: dict[str, Any],
    factors: dict[str, float],
    directional_score: float,
    liquidity_quality: float,
    conflicts: dict[str, Any],
) -> float:
    data_quality = to_float(row.get("data_quality_score"), 100.0) or 100.0
    trend = to_float(row.get("technical_trend_score"))
    momentum = to_float(row.get("technical_momentum_score"))
    derivatives = to_float(row.get("derivatives_confirmation_score"))
    factor_strength = clamp(abs(directional_score) / 1.25)
    liquidity = clamp(liquidity_quality / 100.0)
    quality = clamp(data_quality / 100.0)
    technical_alignment = _technical_alignment(directional_score, trend, momentum)
    derivatives_alignment = _signal_alignment(directional_score, derivatives)
    breadth_alignment = (conflicts.get("breadth_alignment_score", 0.0) + 1.0) / 2.0
    conflict_penalty = clamp((conflicts.get("signal_conflict_score", 0.0) or 0.0) / 100.0)
    driver_count = sum(1 for name in DIRECTIONAL_FACTORS if abs(factors.get(name, 0.0)) >= 0.5)
    confirmation = clamp(driver_count / 3.0)

    confidence = (
        factor_strength * 0.24
        + liquidity * 0.18
        + quality * 0.20
        + technical_alignment * 0.17
        + derivatives_alignment * 0.09
        + breadth_alignment * 0.05
        + confirmation * 0.07
        - conflict_penalty * 0.12
    ) * 100.0
    if row.get("is_trusted", True) is False:
        confidence *= 0.35
    return clamp(confidence, 0.0, 100.0)


def _technical_alignment(
    directional_score: float,
    trend_score: float | None,
    momentum_score: float | None,
) -> float:
    technical_values = [value for value in (trend_score, momentum_score) if value is not None]
    if not technical_values:
        return 0.5
    if directional_score == 0:
        return 0.5
    direction = 1.0 if directional_score > 0 else -1.0
    aligned = sum(clamp((value * direction + 1.0) / 2.0) for value in technical_values)
    return aligned / len(technical_values)


def _signal_alignment(directional_score: float, signal: float | None) -> float:
    if signal is None or directional_score == 0:
        return 0.5
    direction = 1.0 if directional_score > 0 else -1.0
    return clamp((signal * direction + 1.0) / 2.0)


def _direction(value: float | None, threshold: float = 0.0) -> int:
    numeric = to_float(value, 0.0) or 0.0
    if numeric > threshold:
        return 1
    if numeric < -threshold:
        return -1
    return 0


def _avg_signal(values: list[Any]) -> float | None:
    numeric = [value for value in (to_float(item) for item in values) if value is not None]
    return sum(numeric) / len(numeric) if numeric else None


def _conflict_item(
    code: str,
    label: str,
    value: Any,
    direction: int,
    threshold: float,
) -> dict[str, Any] | None:
    numeric = to_float(value)
    if numeric is None or abs(numeric) < threshold:
        return None
    alignment = clamp(numeric * direction, -1.0, 1.0)
    if alignment >= -threshold:
        return None
    return {
        "code": code,
        "label": label,
        "severity": round(abs(alignment), 3),
        "detail": f"{label} points {'long' if numeric > 0 else 'short'}",
    }


def _regime_alignment(direction: int, regime: dict[str, Any]) -> float:
    bias = str(regime.get("bias") or "mixed")
    bias_score = to_float(regime.get("bias_score"))
    if bias_score is not None and abs(bias_score) >= 0.25:
        return clamp(bias_score * direction, -1.0, 1.0)
    if bias == "risk-on":
        return 0.6 * direction
    if bias == "risk-off":
        return -0.6 * direction
    return 0.0


def _conflict_label(conflicts: list[dict[str, Any]]) -> str:
    if not conflicts:
        return "aligned"
    if len(conflicts) == 1 and (conflicts[0].get("severity") or 0.0) < 0.55:
        return "minor-conflict"
    if any((item.get("severity") or 0.0) >= 0.75 for item in conflicts) or len(conflicts) >= 3:
        return "high-conflict"
    return "mixed-signals"
