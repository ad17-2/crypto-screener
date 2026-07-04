from __future__ import annotations

from typing import Any

from .scoring import clamp, mean, pct_change, stdev, to_float


INTERVAL_HOURS = {
    "1m": 1.0 / 60.0,
    "3m": 3.0 / 60.0,
    "5m": 5.0 / 60.0,
    "15m": 15.0 / 60.0,
    "30m": 0.5,
    "1h": 1.0,
    "4h": 4.0,
    "6h": 6.0,
    "8h": 8.0,
    "12h": 12.0,
    "1d": 24.0,
    "1w": 24.0 * 7.0,
}


def interval_hours(interval: str) -> float:
    return INTERVAL_HOURS.get(interval, 24.0)


def candles_per_window(interval: str, hours: float) -> int:
    return max(1, round(hours / interval_hours(interval)))


def derivatives_snapshot(
    oi_history: list[dict[str, Any]],
    funding_history: list[dict[str, Any]],
    liquidation_history: list[dict[str, Any]],
    taker_history: list[dict[str, Any]],
    interval: str,
    end_time: int | None = None,
) -> dict[str, Any]:
    oi_rows = _series_until(_normalize_close_series(oi_history), end_time)
    funding_rows = _series_until(_normalize_close_series(funding_history), end_time)
    liquidation_rows = _series_until(_normalize_liquidations(liquidation_history), end_time)
    taker_rows = _series_until(_normalize_taker(taker_history), end_time)

    if not any((oi_rows, funding_rows, liquidation_rows, taker_rows)):
        return {}

    window = candles_per_window(interval, 24.0)
    oi_closes = [row["close"] for row in oi_rows]
    funding_closes = [row["close"] for row in funding_rows]
    liq_window = liquidation_rows[-window:]
    taker_window = taker_rows[-window:]

    oi_change_1 = _pct_change_steps(oi_closes, 1)
    oi_change_window = _pct_change_steps(oi_closes, window)
    oi_previous_change = _pct_change_steps(oi_closes[:-1], 1)
    oi_acceleration = (
        oi_change_1 - oi_previous_change
        if oi_change_1 is not None and oi_previous_change is not None
        else None
    )
    oi_zscore = _latest_zscore(oi_closes, 30)

    funding_avg = mean(funding_closes[-window:]) if funding_closes else None
    funding_abs_avg = mean([abs(value) for value in funding_closes[-window:]]) if funding_closes else None
    funding_persistence = _sign_persistence(funding_closes[-window:])

    long_liq = sum(row["long"] for row in liq_window)
    short_liq = sum(row["short"] for row in liq_window)
    liq_total = long_liq + short_liq
    liq_imbalance = ((short_liq - long_liq) / liq_total * 100.0) if liq_total > 0 else None

    buy_volume = sum(row["buy"] for row in taker_window)
    sell_volume = sum(row["sell"] for row in taker_window)
    taker_total = buy_volume + sell_volume
    taker_ratio = (buy_volume / sell_volume) if sell_volume > 0 else None
    taker_imbalance = ((buy_volume - sell_volume) / taker_total * 100.0) if taker_total > 0 else None

    confirmation = _derivatives_confirmation(oi_acceleration, taker_imbalance, liq_imbalance)

    result = {
        "derivatives_interval": interval,
        "derivatives_oi_count": len(oi_rows),
        "derivatives_funding_count": len(funding_rows),
        "derivatives_liquidation_count": len(liquidation_rows),
        "derivatives_taker_count": len(taker_rows),
        "oi_change_4h_pct_history": oi_change_1,
        "oi_change_24h_pct_history": oi_change_window,
        "oi_acceleration_4h_pct": oi_acceleration,
        "oi_zscore_30": oi_zscore,
        "funding_avg_24h_pct": funding_avg,
        "funding_abs_avg_24h_pct": funding_abs_avg,
        "funding_persistence_24h": funding_persistence,
        "long_liquidation_usd_24h_history": long_liq if liq_window else None,
        "short_liquidation_usd_24h_history": short_liq if liq_window else None,
        "liquidation_total_24h_usd": liq_total if liq_window else None,
        "liquidation_imbalance_24h_pct": liq_imbalance,
        "taker_buy_volume_usd_24h": buy_volume if taker_window else None,
        "taker_sell_volume_usd_24h": sell_volume if taker_window else None,
        "taker_buy_sell_ratio_24h": taker_ratio,
        "taker_imbalance_24h_pct": taker_imbalance,
        "derivatives_confirmation_score": confirmation,
    }
    return {key: value for key, value in result.items() if value is not None}


def _normalize_close_series(rows: list[dict[str, Any]]) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    for row in sorted(rows, key=lambda item: to_float(item.get("time"), 0.0) or 0.0):
        time = to_float(row.get("time"))
        close = to_float(row.get("close"))
        if time is None or close is None:
            continue
        normalized.append({"time": time, "close": close})
    return normalized


def _normalize_liquidations(rows: list[dict[str, Any]]) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    for row in sorted(rows, key=lambda item: to_float(item.get("time"), 0.0) or 0.0):
        time = to_float(row.get("time"))
        long_value = to_float(row.get("aggregated_long_liquidation_usd"), 0.0) or 0.0
        short_value = to_float(row.get("aggregated_short_liquidation_usd"), 0.0) or 0.0
        if time is None:
            continue
        normalized.append({"time": time, "long": long_value, "short": short_value})
    return normalized


def _normalize_taker(rows: list[dict[str, Any]]) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    for row in sorted(rows, key=lambda item: to_float(item.get("time"), 0.0) or 0.0):
        time = to_float(row.get("time"))
        buy = to_float(row.get("aggregated_buy_volume_usd"), 0.0) or 0.0
        sell = to_float(row.get("aggregated_sell_volume_usd"), 0.0) or 0.0
        if time is None:
            continue
        normalized.append({"time": time, "buy": buy, "sell": sell})
    return normalized


def _series_until(rows: list[dict[str, float]], end_time: int | None) -> list[dict[str, float]]:
    if end_time is None:
        return rows
    return [row for row in rows if row["time"] <= end_time]


def _pct_change_steps(values: list[float], steps: int) -> float | None:
    if len(values) <= steps:
        return None
    return pct_change(values[-steps - 1], values[-1])


def _latest_zscore(values: list[float], window: int) -> float | None:
    if len(values) < max(3, window):
        return None
    sample = values[-window:]
    deviation = stdev(sample)
    if deviation == 0:
        return 0.0
    return (sample[-1] - mean(sample)) / deviation


def _sign_persistence(values: list[float]) -> float | None:
    if not values:
        return None
    signs = [1.0 if value > 0 else -1.0 if value < 0 else 0.0 for value in values]
    return mean(signs)


def _derivatives_confirmation(
    oi_acceleration: float | None,
    taker_imbalance: float | None,
    liquidation_imbalance: float | None,
) -> float | None:
    components: list[float] = []
    if oi_acceleration is not None:
        components.append(clamp(oi_acceleration / 8.0, -1.0, 1.0))
    if taker_imbalance is not None:
        components.append(clamp(taker_imbalance / 20.0, -1.0, 1.0))
    if liquidation_imbalance is not None:
        components.append(clamp(liquidation_imbalance / 60.0, -1.0, 1.0))
    return mean(components) if components else None
