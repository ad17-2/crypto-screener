from __future__ import annotations

from typing import Any

from .factor_definitions import DIRECTIONAL_FACTORS
from .scoring import to_float


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
    if row.get("signal_conflict_label") and row.get("signal_conflict_label") != "aligned":
        parts.append(f"signals {row['signal_conflict_label']}")
    if row.get("technical_setup"):
        parts.append(f"tech {row['technical_setup']}")

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
            parts.append(f"{name} {value:+.2f}")

    if side == "fade-long":
        parts.append("crowded long conditions")
    if side == "squeeze-risk":
        parts.append("crowded short conditions")
    if quality_flags:
        parts.append("excluded: " + ", ".join(str(flag) for flag in quality_flags))
    return "; ".join(parts)


def _append_metric(parts: list[str], label: str, value: Any, fmt: str) -> None:
    numeric = to_float(value)
    if numeric is not None:
        parts.append(f"{label} {fmt.format(numeric)}")
