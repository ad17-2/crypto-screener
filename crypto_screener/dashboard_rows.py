from __future__ import annotations

from typing import Any

from .dashboard_taxonomy import factor_label
from .factor_definitions import DIRECTIONAL_FACTORS
from .factor_explanations import reason_for
from .scoring import clamp, to_float


def dashboard_row(
    row: dict[str, Any],
    score_field: str,
    side: str,
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    scores = row.get("scores", {})
    factors = row.get("factors", {})
    score = row.get(score_field)
    setup = setup_label(row, side)
    priority = chart_priority(row, score_field, score)
    return {
        "symbol": row.get("symbol"),
        "side": side,
        "setup": setup,
        "setup_tone": setup_tone(side),
        "score_field": score_field,
        "score": score,
        "priority": priority,
        "confidence_score": row.get("confidence_score"),
        "quality": row.get("data_quality_score", 100),
        "primary_exchange": row.get("primary_exchange"),
        "contract_symbol": row.get("contract_symbol"),
        "price_usd": row.get("price_usd"),
        "price_change_24h_pct": row.get("price_change_24h_pct"),
        "oi_change_24h_pct": row.get("oi_change_24h_pct"),
        "funding_rate_pct": row.get("funding_rate_pct"),
        "long_short_ratio": row.get("long_short_ratio"),
        "quote_volume_usd": row.get("quote_volume_usd"),
        "open_interest_usd": row.get("open_interest_usd"),
        "technical_setup": row.get("technical_setup"),
        "technical_state": technical_state(row),
        "signal_conflict_label": row.get("signal_conflict_label"),
        "signal_conflict_score": row.get("signal_conflict_score"),
        "signal_conflicts": row.get("signal_conflicts", []),
        "regime_alignment_score": row.get("regime_alignment_score"),
        "breadth_alignment_score": row.get("breadth_alignment_score"),
        "data_source": row.get("data_source"),
        "is_trusted": row.get("is_trusted", True),
        "data_quality_flags": row.get("data_quality_flags", []),
        "scores": {
            key: scores.get(key)
            for key in (
                "factor_score",
                "long_score",
                "short_score",
                "crowded_long_score",
                "squeeze_risk_score",
                "confidence_score",
                "signal_conflict_score",
                "regime_alignment_score",
                "breadth_alignment_score",
            )
        },
        "factor_parts": factor_parts(factors),
        "primary_driver": primary_driver(factors),
        "history": history or [],
        "reason": reason_for(row, side),
        "reason_parts": reason_parts(row, side),
        "explanation": token_explanation(row, side, setup),
    }


def setup_label(row: dict[str, Any], side: str) -> str:
    technical_setup = str(row.get("technical_setup") or "")
    if technical_setup and side in {"long", "short"}:
        suffix = "Long" if side == "long" else "Short"
        return f"{technical_setup} {suffix}"
    price_change = to_float(row.get("price_change_24h_pct")) or 0.0
    oi_change = to_float(row.get("oi_change_24h_pct")) or 0.0
    funding = to_float(row.get("funding_rate_pct")) or 0.0
    ls_ratio = to_float(row.get("long_short_ratio"))
    if side == "core":
        return "Core Regime Read"
    if side == "fade-long":
        return "Crowded Long Fade"
    if side == "squeeze-risk":
        return "Short Squeeze Risk"
    if side == "long":
        if price_change > 0 and oi_change > 0:
            return "OI Momentum Long"
        if price_change < 0 and oi_change <= 0:
            return "Reversal Long"
        if funding < 0:
            return "Funding Tailwind Long"
        return "Long Candidate"
    if side == "short":
        if price_change < 0 and oi_change > 0:
            return "OI Breakdown Short"
        if price_change > 0 and oi_change <= 0:
            return "Reversal Short"
        if funding > 0.01 or (ls_ratio is not None and ls_ratio > 1.2):
            return "Crowding Short"
        return "Short Candidate"
    return "Watchlist"


def setup_tone(side: str) -> str:
    if side == "long":
        return "pos"
    if side == "short":
        return "neg"
    if side in {"fade-long", "squeeze-risk"}:
        return "warn"
    return "neutral"


def chart_priority(row: dict[str, Any], score_field: str, score: Any) -> float:
    numeric_score = abs(to_float(score) or 0.0) * (100.0 if score_field == "factor_score" else 1.0)
    quality = to_float(row.get("data_quality_score"))
    quality_multiplier = max(0.0, min(1.0, (100.0 if quality is None else quality) / 100.0))
    if row.get("is_trusted", True) is False:
        quality_multiplier *= 0.35
    confidence = to_float(row.get("confidence_score"))
    confidence_multiplier = 1.0 if confidence is None else 0.65 + (clamp(confidence / 100.0) * 0.35)
    return round(numeric_score * quality_multiplier * confidence_multiplier, 2)


def factor_parts(factors: dict[str, Any]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    for name in DIRECTIONAL_FACTORS:
        value = to_float(factors.get(name))
        if value is None:
            continue
        parts.append(
            {
                "name": name,
                "label": factor_label(name),
                "value": round(value, 4),
                "tone": reason_tone(value),
            }
        )
    return sorted(parts, key=lambda item: abs(item["value"]), reverse=True)


def primary_driver(factors: dict[str, Any]) -> dict[str, Any] | None:
    parts = factor_parts(factors)
    return parts[0] if parts else None


def token_explanation(row: dict[str, Any], side: str, setup: str) -> dict[str, Any]:
    symbol = str(row.get("symbol") or "-")
    driver = primary_driver(row.get("factors", {}))
    driver_text = f"{driver['label']} {driver['value']:+.2f}" if driver else "mixed factors"
    conflict_label = str(row.get("signal_conflict_label") or "unknown")
    quality_flags = row.get("data_quality_flags") or []
    funding = to_float(row.get("funding_rate_pct"), 0.0) or 0.0
    ls_ratio = to_float(row.get("long_short_ratio"))
    direction = "long" if side in {"long", "squeeze-risk"} else "short" if side in {"short", "fade-long"} else "neutral"

    read = f"{symbol} is grouped as {setup} because {driver_text} is the strongest driver, with {conflict_label} signal conflict."
    confirm = [
        "Check the TradingView chart for entry location, invalidation, and nearby liquidity.",
        "Prefer the setup only if 4h trend and momentum agree with the intended direction.",
        "Confirm BTC, market breadth, and market regime have not flipped against the setup.",
    ]
    if direction == "long":
        confirm.append("For longs, avoid chasing after an extended impulse unless pullback structure is clean.")
    elif direction == "short":
        confirm.append("For shorts or fades, avoid pressing into obvious squeeze conditions without confirmation.")

    risks: list[str] = []
    if conflict_label not in {"aligned", "neutral", "unknown"}:
        risks.append(
            f"Signal conflict is {conflict_label}; size the idea as a chart-review candidate, not a blind signal."
        )
    if funding > 0.015 or (ls_ratio is not None and ls_ratio >= 1.3):
        risks.append("Long crowding is elevated; late longs can unwind quickly.")
    if funding < -0.015 or (ls_ratio is not None and ls_ratio <= 0.8):
        risks.append("Short crowding is elevated; squeeze risk can dominate clean bearish reads.")
    if quality_flags:
        risks.append("Data-quality flags are present; ignore the setup until the bad data clears.")
    if not risks:
        risks.append("Main risk is chart invalidation after manual review.")

    return {
        "read": read,
        "confirm": confirm[:4],
        "risk": risks[:4],
    }


def reason_parts(row: dict[str, Any], side: str) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    scores = row.get("scores", {})
    factors = row.get("factors", {})

    append_reason_metric(
        parts, "24h", row.get("price_change_24h_pct"), "{:+.2f}%", "Spot or mark price change over the last 24 hours."
    )
    append_reason_metric(
        parts,
        "OI 24h",
        row.get("oi_change_24h_pct"),
        "{:+.2f}%",
        "Open-interest change over the last 24 hours; rising OI means more futures positioning.",
    )
    append_reason_metric(
        parts,
        "Funding",
        row.get("funding_rate_pct"),
        "{:+.4f}%",
        "Perpetual funding rate; positive usually means longs pay shorts, negative means shorts pay longs.",
    )
    if row.get("long_short_ratio") is not None:
        append_reason_metric(
            parts,
            "L/S",
            row.get("long_short_ratio"),
            "{:.2f}",
            "Long/short volume ratio; above 1 leans long, below 1 leans short.",
            neutral_value=1.0,
        )
    if scores.get("factor_score") is not None:
        append_reason_metric(
            parts,
            "Factor",
            scores.get("factor_score"),
            "{:+.2f}",
            "Weighted directional model score before watchlist-specific ranking.",
        )
    if scores.get("confidence_score") is not None:
        append_reason_metric(
            parts,
            "Confidence",
            scores.get("confidence_score"),
            "{:.0f}",
            "Composite setup confidence using factor strength, data quality, liquidity, and 4h technical alignment.",
            neutral_value=50.0,
        )
    if row.get("technical_setup"):
        parts.append(
            {
                "kind": "context",
                "label": "Tech",
                "value": row.get("technical_setup"),
                "tone": technical_tone(row),
                "help": "4h CoinGlass OHLC technical state used as confirmation context.",
            }
        )
    if row.get("signal_conflict_label") and row.get("signal_conflict_label") not in {"aligned", "neutral"}:
        parts.append(
            {
                "kind": "context",
                "label": "Signals",
                "value": row.get("signal_conflict_label"),
                "tone": "warn" if row.get("signal_conflict_label") != "high-conflict" else "bad",
                "help": "Signal conflict label: highlights when technicals, derivatives, breadth, or regime disagree with the model direction.",
            }
        )
    if row.get("rsi_14") is not None:
        append_reason_metric(
            parts,
            "RSI",
            row.get("rsi_14"),
            "{:.1f}",
            "14-period RSI on the configured CoinGlass candle interval.",
            neutral_value=50.0,
        )

    strongest = sorted(
        (
            (name, numeric_value)
            for name, value in factors.items()
            if name in DIRECTIONAL_FACTORS and (numeric_value := to_float(value)) is not None
        ),
        key=lambda item: abs(item[1]),
        reverse=True,
    )[:2]
    for name, value in strongest:
        if abs(value) >= 0.5:
            parts.append(
                {
                    "kind": "driver",
                    "label": factor_label(name),
                    "value": f"{float(value):+.2f}",
                    "tone": reason_tone(float(value)),
                    "help": "Normalized factor driver. Larger absolute values contributed more to the setup read.",
                }
            )

    if side == "fade-long":
        parts.append(
            {
                "kind": "context",
                "label": "Crowding",
                "value": "long fade",
                "tone": "warn",
                "help": "Crowded-long watchlist: useful for fade ideas, not automatic shorts.",
            }
        )
    if side == "squeeze-risk":
        parts.append(
            {
                "kind": "context",
                "label": "Crowding",
                "value": "short squeeze",
                "tone": "warn",
                "help": "Crowded-short watchlist: useful for squeeze-risk review, not automatic longs.",
            }
        )

    quality_flags = row.get("data_quality_flags") or []
    if quality_flags:
        parts.append(
            {
                "kind": "quality",
                "label": "Excluded",
                "value": ", ".join(str(flag) for flag in quality_flags),
                "tone": "bad",
                "help": "This row failed sanity checks and is excluded from ranking.",
            }
        )

    return parts


def append_reason_metric(
    parts: list[dict[str, Any]],
    label: str,
    value: Any,
    template: str,
    help_text: str,
    neutral_value: float = 0.0,
) -> None:
    numeric = to_float(value)
    if numeric is None:
        return
    parts.append(
        {
            "kind": "metric",
            "label": label,
            "value": template.format(numeric),
            "tone": reason_tone(numeric - neutral_value),
            "help": help_text,
        }
    )


def reason_tone(value: float) -> str:
    if value > 0:
        return "pos"
    if value < 0:
        return "neg"
    return "neutral"


def technical_state(row: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "technical_interval",
        "technical_candle_count",
        "technical_close",
        "ema_20",
        "ema_50",
        "ema_200",
        "distance_ema20_pct",
        "rsi_14",
        "macd_histogram_pct",
        "atr_14_pct",
        "bb_position",
        "bb_width_pct",
        "technical_trend_score",
        "technical_momentum_score",
    ]
    return {key: row.get(key) for key in keys if row.get(key) is not None}


def technical_tone(row: dict[str, Any]) -> str:
    trend = to_float(row.get("technical_trend_score"))
    momentum = to_float(row.get("technical_momentum_score"))
    values = [value for value in (trend, momentum) if value is not None]
    if not values:
        return "neutral"
    return reason_tone(sum(values) / len(values))
