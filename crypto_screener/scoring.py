from __future__ import annotations

import math
from typing import Any


def to_float(value: Any, default: float | None = None) -> float | None:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def safe_log10(value: float | None) -> float:
    if value is None or value <= 0:
        return 0.0
    return math.log10(value)


def pct_change(old: float | None, new: float | None) -> float | None:
    if old is None or old == 0 or new is None:
        return None
    return ((new - old) / old) * 100.0


def spread_bps(bid: float | None, ask: float | None) -> float | None:
    if bid is None or ask is None or bid <= 0 or ask <= 0:
        return None
    mid = (bid + ask) / 2.0
    return ((ask - bid) / mid) * 10000.0


def funding_annualized_pct(rate: float | None) -> float | None:
    if rate is None:
        return None
    # Perpetual funding is commonly 8-hourly; annualization assumes 3 periods/day.
    return rate * 3 * 365 * 100.0


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def stdev(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    avg = mean(values)
    variance = sum((value - avg) ** 2 for value in values) / len(values)
    return math.sqrt(variance)


def zscore_by_key(rows: list[dict[str, Any]], key: str) -> list[float]:
    values = [to_float(row.get(key)) for row in rows]
    valid = [value for value in values if value is not None]
    if not valid:
        return [0.0 for _ in rows]

    avg = mean(valid)
    std = stdev(valid)
    if std == 0:
        return [0.0 for _ in rows]
    return [0.0 if value is None else (value - avg) / std for value in values]


def average_ranks(values: list[float]) -> list[float]:
    indexed = sorted(enumerate(values), key=lambda item: item[1])
    ranks = [0.0] * len(values)
    index = 0
    while index < len(indexed):
        end = index + 1
        while end < len(indexed) and indexed[end][1] == indexed[index][1]:
            end += 1
        avg_rank = (index + 1 + end) / 2.0
        for ranked_index in range(index, end):
            original_index = indexed[ranked_index][0]
            ranks[original_index] = avg_rank
        index = end
    return ranks


def pearson_corr(x_values: list[float], y_values: list[float]) -> float | None:
    if len(x_values) != len(y_values) or len(x_values) < 2:
        return None
    x_avg = mean(x_values)
    y_avg = mean(y_values)
    numerator = sum((x - x_avg) * (y - y_avg) for x, y in zip(x_values, y_values, strict=True))
    x_den = math.sqrt(sum((x - x_avg) ** 2 for x in x_values))
    y_den = math.sqrt(sum((y - y_avg) ** 2 for y in y_values))
    if x_den == 0 or y_den == 0:
        return None
    return numerator / (x_den * y_den)


def spearman_corr(x_values: list[float], y_values: list[float]) -> float | None:
    if len(x_values) != len(y_values) or len(x_values) < 2:
        return None
    return pearson_corr(average_ranks(x_values), average_ranks(y_values))
