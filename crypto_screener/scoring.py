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
    if old in (None, 0) or new is None:
        return None
    return ((new - old) / old) * 100.0


def spread_bps(bid: float | None, ask: float | None) -> float | None:
    if bid is None or ask is None or bid <= 0 or ask <= 0:
        return None
    mid = (bid + ask) / 2.0
    return ((ask - bid) / mid) * 10000.0


def funding_rate_pct(rate: float | None) -> float | None:
    if rate is None:
        return None
    return rate * 100.0


def funding_annualized_pct(rate: float | None) -> float | None:
    if rate is None:
        return None
    # Binance USD-M perpetual funding is normally every 8 hours.
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


def liquidity_score(row: dict[str, Any], min_quote_volume_usd: float) -> float:
    volume = row.get("quote_volume_usd") or 0.0
    if volume <= 0:
        return 0.0
    volume_component = clamp(math.log10(max(volume / min_quote_volume_usd, 1.0)) / 2.0)

    spread = row.get("spread_bps")
    spread_component = 0.5 if spread is None else clamp(1.0 - (spread / 15.0))

    depth = row.get("depth_0_5pct_usd")
    if depth is None:
        depth_component = 0.5
    else:
        depth_component = clamp(math.log10(max(depth / 1_000_000.0, 1.0)) / 2.0)

    return (volume_component * 0.45) + (spread_component * 0.35) + (depth_component * 0.20)


def add_scores(rows: list[dict[str, Any]], min_quote_volume_usd: float) -> list[dict[str, Any]]:
    for row in rows:
        price_24h = row.get("price_change_24h_pct") or 0.0
        oi_24h = row.get("oi_change_24h_pct")
        funding = row.get("funding_rate_pct")
        liq = liquidity_score(row, min_quote_volume_usd)

        oi_up = clamp((oi_24h or 0.0) / 12.0)
        oi_down = clamp(abs(oi_24h or 0.0) / 12.0)
        funding_positive = clamp((funding or 0.0) / 0.05)
        funding_negative = clamp(abs(min(funding or 0.0, 0.0)) / 0.05)
        neutral_funding = 1.0 - clamp(abs(funding or 0.0) / 0.08)

        long_score = 0.0
        if price_24h > 0:
            long_score = (
                42.0 * clamp(price_24h / 8.0)
                + 22.0 * oi_up
                + 20.0 * liq
                + 16.0 * neutral_funding
            )

        short_score = 0.0
        if price_24h < 0:
            short_score = (
                42.0 * clamp(abs(price_24h) / 8.0)
                + 24.0 * oi_up
                + 20.0 * liq
                + 14.0 * (1.0 - funding_negative)
            )

        crowded_long_score = 0.0
        if (funding or 0.0) > 0.015:
            crowded_long_score = (
                40.0 * funding_positive
                + 22.0 * oi_up
                + 18.0 * clamp(max(price_24h, 0.0) / 10.0)
                + 20.0 * liq
            )

        squeeze_risk_score = 0.0
        if (funding or 0.0) < -0.015:
            squeeze_risk_score = (
                42.0 * funding_negative
                + 20.0 * oi_up
                + 18.0 * clamp(max(price_24h, 0.0) / 8.0)
                + 10.0 * oi_down
                + 10.0 * liq
            )

        row["liquidity_score"] = round(liq * 100.0, 2)
        row["long_score"] = round(long_score, 2)
        row["short_score"] = round(short_score, 2)
        row["crowded_long_score"] = round(crowded_long_score, 2)
        row["squeeze_risk_score"] = round(squeeze_risk_score, 2)

    return rows


def reason_for(row: dict[str, Any], side: str) -> str:
    parts: list[str] = []
    price = row.get("price_change_24h_pct")
    oi = row.get("oi_change_24h_pct")
    funding = row.get("funding_rate_pct")
    spread = row.get("spread_bps")

    if price is not None:
        parts.append(f"24h {price:+.2f}%")
    if oi is not None:
        parts.append(f"OI {oi:+.2f}%")
    if funding is not None:
        parts.append(f"funding {funding:+.4f}%")
    if spread is not None:
        parts.append(f"spread {spread:.2f} bps")

    if side == "short" and oi is not None and oi > 0 and price is not None and price < 0:
        parts.append("price down + OI up")
    if side == "long" and oi is not None and oi > 0 and price is not None and price > 0:
        parts.append("price up + OI up")
    if side == "fade-long" and funding is not None and funding > 0.03:
        parts.append("positive funding crowding")
    if side == "squeeze-risk" and funding is not None and funding < -0.03:
        parts.append("negative funding crowding")

    return "; ".join(parts)
