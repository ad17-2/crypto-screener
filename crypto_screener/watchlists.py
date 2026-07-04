from __future__ import annotations

from collections.abc import Callable
from typing import Any

WATCHLIST_LABELS = {
    "chart_next": "Top Setups",
    "regime_fit": "Regime Fit",
    "long": "Longs",
    "short": "Shorts",
    "squeeze_risks": "Squeeze Risk",
    "crowded_longs": "Long Fades",
    "core": "Core",
}

WATCHLIST_ORDER = (
    "chart_next",
    "regime_fit",
    "long",
    "short",
    "squeeze_risks",
    "crowded_longs",
    "core",
)


def top_by(
    rows: list[dict[str, Any]],
    field: str,
    limit: int,
    minimum: float = 0.01,
    predicate: Callable[[dict[str, Any]], bool] | None = None,
    trusted_only: bool = True,
) -> list[dict[str, Any]]:
    candidates = rows
    if trusted_only:
        candidates = [row for row in rows if row.get("is_trusted", True)]
    ranked = sorted(candidates, key=lambda item: item.get(field) or 0, reverse=True)
    if predicate is not None:
        ranked = [row for row in ranked if predicate(row)]
    return [row for row in ranked if (row.get(field) or 0) >= minimum][:limit]


def is_long_candidate(row: dict[str, Any]) -> bool:
    return (row.get("factor_score") or 0) > 0


def is_short_candidate(row: dict[str, Any]) -> bool:
    return (row.get("factor_score") or 0) < 0


def is_crowded_long(row: dict[str, Any]) -> bool:
    funding = row.get("funding_rate_pct") or 0.0
    ls_ratio = row.get("long_short_ratio")
    return funding > 0.015 or (ls_ratio is not None and ls_ratio >= 1.3)


def is_crowded_short(row: dict[str, Any]) -> bool:
    funding = row.get("funding_rate_pct") or 0.0
    ls_ratio = row.get("long_short_ratio")
    return funding < -0.015 or (ls_ratio is not None and ls_ratio <= 0.8)
