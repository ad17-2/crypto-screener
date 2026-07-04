from __future__ import annotations

import math
from typing import Any

from .scoring import clamp, safe_log10, spearman_corr, to_float, zscore_by_key


DIRECTIONAL_FACTORS = [
    "momentum_24h",
    "reversal_1d",
    "oi_price_signal",
    "funding_rate_contrarian",
    "ls_ratio_contrarian",
    "liquidation_imbalance",
    "btc_relative_strength",
    "technical_trend_4h",
    "technical_momentum_4h",
    "oi_acceleration_signal",
    "funding_persistence_contrarian",
    "taker_flow_24h",
    "liquidation_pressure_24h",
]

QUALITY_FACTORS = [
    "liquidity_30d",
    "volume_expansion_24h",
    "volatility_expansion_4h",
]


DEFAULT_PRIORS = {
    "momentum_24h": 0.18,
    "reversal_1d": 0.08,
    "oi_price_signal": 0.20,
    "funding_rate_contrarian": 0.16,
    "ls_ratio_contrarian": 0.12,
    "liquidation_imbalance": 0.10,
    "btc_relative_strength": 0.16,
    "technical_trend_4h": 0.12,
    "technical_momentum_4h": 0.08,
    "oi_acceleration_signal": 0.08,
    "funding_persistence_contrarian": 0.08,
    "taker_flow_24h": 0.07,
    "liquidation_pressure_24h": 0.07,
}


def score_snapshot(
    rows: list[dict[str, Any]],
    market_context: dict[str, Any],
    history_records: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    trusted_rows = [row for row in rows if row.get("is_trusted", True)]
    raw_factors = [_raw_factors(row, trusted_rows, market_context) for row in trusted_rows]
    normalized = _normalize_factors(raw_factors)
    weights = factor_weights(history_records, config)

    for row, raw, factors in zip(trusted_rows, raw_factors, normalized):
        row["raw_factors"] = raw
        row["factors"] = factors
        _apply_scores(row, factors, weights)

    for row in rows:
        if row.get("is_trusted", True):
            continue
        row["raw_factors"] = {}
        row["factors"] = {}
        _apply_excluded_scores(row)

    return {
        "rows": rows,
        "factor_weights": weights,
        "regime": infer_regime(weights, trusted_rows, market_context),
    }


def _raw_factors(
    row: dict[str, Any],
    rows: list[dict[str, Any]],
    market_context: dict[str, Any],
) -> dict[str, float | None]:
    price_change = to_float(row.get("price_change_24h_pct"))
    oi_change = to_float(row.get("oi_change_24h_pct"))
    funding = to_float(row.get("funding_rate_pct"))
    ls_ratio = to_float(row.get("long_short_ratio"))
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

    btc_change = _btc_change(rows, market_context)
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
    if ls_ratio is not None and ls_ratio > 0:
        ls_contrarian = -math.log(ls_ratio)

    oi_acceleration_signal = None
    if oi_acceleration is not None and price_change is not None:
        oi_acceleration_signal = math.copysign(max(oi_acceleration, 0.0), price_change)

    return {
        "momentum_24h": price_change,
        "reversal_1d": -price_change if price_change is not None else None,
        "oi_price_signal": oi_price,
        "funding_rate_contrarian": -funding if funding is not None else None,
        "ls_ratio_contrarian": ls_contrarian,
        "liquidation_imbalance": ((short_liq - long_liq) / liq_total) * 100.0 if liq_total > 0 else None,
        "btc_relative_strength": price_change - btc_change if price_change is not None and btc_change is not None else None,
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
        zscores = zscore_by_key(raw_rows, key)
        for index, score in enumerate(zscores):
            normalized[index][key] = score
    return normalized


def factor_weights(history_records: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    factor_cfg = config.get("factors", {})
    priors = factor_cfg.get("priors", DEFAULT_PRIORS)
    min_observations = int(factor_cfg.get("min_observations", 30))
    max_abs_weight = float(factor_cfg.get("max_abs_weight", 0.35))
    min_abs_ic = float(factor_cfg.get("min_abs_ic", 0.02))

    factor_stats: dict[str, dict[str, Any]] = {}
    raw_weights: dict[str, float] = {}

    for factor in DIRECTIONAL_FACTORS:
        pairs = [
            (to_float(record.get("factors", {}).get(factor)), to_float(record.get("forward_return_pct")))
            for record in history_records
        ]
        valid_pairs = [(x, y) for x, y in pairs if x is not None and y is not None]
        observations = len(valid_pairs)
        ic = spearman_corr([x for x, _ in valid_pairs], [y for _, y in valid_pairs]) if observations >= 3 else None
        if observations >= min_observations and ic is not None and abs(ic) >= min_abs_ic:
            raw = clamp(ic, -max_abs_weight, max_abs_weight)
            mode = "ic"
        else:
            raw = float(priors.get(factor, 0.0))
            mode = "prior"
        raw_weights[factor] = raw
        factor_stats[factor] = {
            "ic": ic,
            "observations": observations,
            "mode": mode,
            "raw_weight": raw,
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
    }


def infer_regime(
    weights: dict[str, Any],
    rows: list[dict[str, Any]],
    market_context: dict[str, Any],
) -> dict[str, Any]:
    directional = weights.get("directional", {})
    momentum_weight = directional.get("momentum_24h", 0.0) + directional.get("oi_price_signal", 0.0)
    reversal_weight = directional.get("reversal_1d", 0.0)
    crowding_weight = directional.get("funding_rate_contrarian", 0.0) + directional.get("ls_ratio_contrarian", 0.0)

    avg_funding = _avg([to_float(row.get("funding_rate_pct")) for row in rows])
    btc_change = _btc_change(rows, market_context)
    market_cap_change = to_float(market_context.get("market_cap_change_24h_pct"))

    if abs(momentum_weight) >= abs(reversal_weight) * 1.4 and momentum_weight > 0:
        label = "momentum"
    elif abs(reversal_weight) > abs(momentum_weight) and reversal_weight > 0:
        label = "reversal"
    elif crowding_weight > 0.2:
        label = "crowding-contrarian"
    else:
        label = "mixed"

    bias_score = 0.0
    if btc_change is not None:
        bias_score += clamp(btc_change / 3.0, -1.0, 1.0)
    if market_cap_change is not None:
        bias_score += clamp(market_cap_change / 3.0, -1.0, 1.0)
    if avg_funding is not None:
        bias_score -= clamp(abs(avg_funding) / 0.06, 0.0, 1.0) * 0.35

    if bias_score >= 0.75:
        bias = "risk-on"
    elif bias_score <= -0.75:
        bias = "risk-off"
    else:
        bias = "mixed"

    return {
        "label": label,
        "bias": bias,
        "bias_score": round(bias_score, 3),
        "btc_change_24h_pct": btc_change,
        "avg_funding_rate_pct": avg_funding,
        "market_cap_change_24h_pct": market_cap_change,
    }


def _apply_scores(row: dict[str, Any], factors: dict[str, float], weights: dict[str, Any]) -> None:
    directional_weights = weights.get("directional", {})
    directional_score = sum(factors.get(name, 0.0) * weight for name, weight in directional_weights.items())
    liquidity_quality = _quality_percentile(factors.get("liquidity_30d", 0.0))

    funding = to_float(row.get("funding_rate_pct"), 0.0) or 0.0
    ls_ratio = to_float(row.get("long_short_ratio"))
    oi_change = to_float(row.get("oi_change_24h_pct"), 0.0) or 0.0
    price_change = to_float(row.get("price_change_24h_pct"), 0.0) or 0.0

    long_crowding = clamp(max(funding, 0.0) / 0.08)
    if ls_ratio is not None:
        long_crowding += clamp((ls_ratio - 1.3) / 0.7)
    short_crowding = clamp(abs(min(funding, 0.0)) / 0.08)
    if ls_ratio is not None and ls_ratio > 0:
        short_crowding += clamp((0.8 - ls_ratio) / 0.5)

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

    row["scores"] = {
        "factor_score": round(directional_score, 4),
        "liquidity_quality": round(liquidity_quality, 2),
        "long_score": round(max(long_score, 0.0), 2),
        "short_score": round(max(short_score, 0.0), 2),
        "crowded_long_score": round(crowded_long_score, 2),
        "squeeze_risk_score": round(squeeze_risk_score, 2),
        "confidence_score": round(_confidence_score(row, factors, directional_score, liquidity_quality), 0),
    }
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
    }
    row.update(row["scores"])


def reason_for(row: dict[str, Any], side: str) -> str:
    parts: list[str] = []
    factors = row.get("factors", {})
    scores = row.get("scores", {})
    quality_flags = row.get("data_quality_flags") or []

    _append_metric(parts, "24h", row.get("price_change_24h_pct"), "{:+.2f}%")
    _append_metric(parts, "OI", row.get("oi_change_24h_pct"), "{:+.2f}%")
    _append_metric(parts, "funding", row.get("funding_rate_pct"), "{:+.4f}%")
    if row.get("long_short_ratio") is not None:
        parts.append(f"L/S {float(row['long_short_ratio']):.2f}")
    if scores.get("factor_score") is not None:
        parts.append(f"factor {scores['factor_score']:+.2f}")
    if scores.get("confidence_score") is not None:
        parts.append(f"confidence {scores['confidence_score']:.0f}")
    if row.get("technical_setup"):
        parts.append(f"tech {row['technical_setup']}")

    strongest = sorted(
        ((name, value) for name, value in factors.items() if name in DIRECTIONAL_FACTORS),
        key=lambda item: abs(item[1]),
        reverse=True,
    )[:2]
    for name, value in strongest:
        if abs(value) >= 0.5:
            parts.append(f"{name} {value:+.2f}")

    if side == "fade-long":
        parts.append("crowded long conditions")
    if side == "squeeze-risk":
        parts.append("crowded short conditions")
    if quality_flags:
        parts.append("excluded: " + ", ".join(str(flag) for flag in quality_flags))
    return "; ".join(parts)


def _btc_change(rows: list[dict[str, Any]], market_context: dict[str, Any]) -> float | None:
    for row in rows:
        if row.get("symbol") == "BTC":
            return to_float(row.get("price_change_24h_pct"))
    return to_float(market_context.get("btc_price_change_24h_pct"))


def _avg(values: list[float | None]) -> float | None:
    valid = [value for value in values if value is not None]
    return sum(valid) / len(valid) if valid else None


def _append_metric(parts: list[str], label: str, value: Any, fmt: str) -> None:
    numeric = to_float(value)
    if numeric is not None:
        parts.append(f"{label} {fmt.format(numeric)}")


def _quality_percentile(zscore: float) -> float:
    # Smooth z-score to a 0-100 quality range without scipy.
    return 100.0 / (1.0 + math.exp(-zscore))


def _confidence_score(
    row: dict[str, Any],
    factors: dict[str, float],
    directional_score: float,
    liquidity_quality: float,
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
    driver_count = sum(1 for name in DIRECTIONAL_FACTORS if abs(factors.get(name, 0.0)) >= 0.5)
    confirmation = clamp(driver_count / 3.0)

    confidence = (
        factor_strength * 0.27
        + liquidity * 0.18
        + quality * 0.20
        + technical_alignment * 0.17
        + derivatives_alignment * 0.10
        + confirmation * 0.08
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
