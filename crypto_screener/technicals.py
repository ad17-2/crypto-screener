from __future__ import annotations

from typing import Any

from .scoring import clamp, mean, stdev, to_float


def technical_snapshot(candles: list[dict[str, Any]], interval: str) -> dict[str, Any]:
    series = _normalize_candles(candles)
    closes = [item["close"] for item in series]
    highs = [item["high"] for item in series]
    lows = [item["low"] for item in series]
    if len(closes) < 50:
        return {}

    close = closes[-1]
    ema_20 = _last_ema(closes, 20)
    ema_50 = _last_ema(closes, 50)
    ema_200 = _last_ema(closes, 200)
    rsi_14 = _rsi(closes, 14)
    macd = _macd(closes)
    atr_14 = _atr(highs, lows, closes, 14)
    bollinger = _bollinger(closes, 20)

    distance_ema20_pct = _pct_distance(close, ema_20)
    atr_14_pct = (atr_14 / close * 100.0) if atr_14 is not None and close > 0 else None
    macd_hist = macd.get("histogram")
    macd_hist_pct = (macd_hist / close * 100.0) if macd_hist is not None and close > 0 else None
    trend_score = _trend_score(close, ema_20, ema_50, ema_200)
    momentum_score = _momentum_score(rsi_14, macd_hist_pct)

    return {
        "technical_interval": interval,
        "technical_candle_count": len(series),
        "technical_close": close,
        "ema_20": ema_20,
        "ema_50": ema_50,
        "ema_200": ema_200,
        "distance_ema20_pct": distance_ema20_pct,
        "rsi_14": rsi_14,
        "macd_line": macd.get("line"),
        "macd_signal": macd.get("signal"),
        "macd_histogram": macd.get("histogram"),
        "macd_histogram_pct": macd_hist_pct,
        "atr_14": atr_14,
        "atr_14_pct": atr_14_pct,
        "bb_mid": bollinger.get("mid"),
        "bb_upper": bollinger.get("upper"),
        "bb_lower": bollinger.get("lower"),
        "bb_position": bollinger.get("position"),
        "bb_width_pct": bollinger.get("width_pct"),
        "technical_trend_score": trend_score,
        "technical_momentum_score": momentum_score,
        "technical_setup": _technical_setup(
            trend_score, rsi_14, bollinger.get("position"), distance_ema20_pct, bollinger.get("width_pct")
        ),
    }


def _normalize_candles(candles: list[dict[str, Any]]) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    for candle in sorted(candles, key=lambda item: to_float(item.get("time"), 0.0) or 0.0):
        open_value = to_float(candle.get("open"))
        high = to_float(candle.get("high"))
        low = to_float(candle.get("low"))
        close = to_float(candle.get("close"))
        if open_value is None or high is None or low is None or close is None:
            continue
        if min(open_value, high, low, close) <= 0:
            continue
        normalized.append(
            {
                "open": open_value,
                "high": high,
                "low": low,
                "close": close,
            }
        )
    return normalized


def _last_ema(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    alpha = 2.0 / (period + 1.0)
    ema = mean(values[:period])
    for value in values[period:]:
        ema = (value * alpha) + (ema * (1.0 - alpha))
    return ema


def _ema_series(values: list[float], period: int) -> list[float]:
    if len(values) < period:
        return []
    alpha = 2.0 / (period + 1.0)
    ema = mean(values[:period])
    result = [ema]
    for value in values[period:]:
        ema = (value * alpha) + (ema * (1.0 - alpha))
        result.append(ema)
    return result


def _rsi(values: list[float], period: int) -> float | None:
    if len(values) <= period:
        return None
    gains: list[float] = []
    losses: list[float] = []
    for previous, current in zip(values, values[1:], strict=False):
        delta = current - previous
        gains.append(max(delta, 0.0))
        losses.append(abs(min(delta, 0.0)))
    avg_gain = mean(gains[:period])
    avg_loss = mean(losses[:period])
    for gain, loss in zip(gains[period:], losses[period:], strict=True):
        avg_gain = ((avg_gain * (period - 1)) + gain) / period
        avg_loss = ((avg_loss * (period - 1)) + loss) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def _macd(values: list[float]) -> dict[str, float | None]:
    ema_12 = _ema_series(values, 12)
    ema_26 = _ema_series(values, 26)
    if not ema_12 or not ema_26:
        return {"line": None, "signal": None, "histogram": None}
    aligned_ema_12 = ema_12[-len(ema_26) :]
    line = [fast - slow for fast, slow in zip(aligned_ema_12, ema_26, strict=True)]
    signal_series = _ema_series(line, 9)
    if not signal_series:
        return {"line": line[-1], "signal": None, "histogram": None}
    signal = signal_series[-1]
    latest_line = line[-1]
    return {"line": latest_line, "signal": signal, "histogram": latest_line - signal}


def _atr(highs: list[float], lows: list[float], closes: list[float], period: int) -> float | None:
    if len(closes) <= period:
        return None
    ranges: list[float] = []
    for index in range(1, len(closes)):
        high = highs[index]
        low = lows[index]
        previous_close = closes[index - 1]
        ranges.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
    atr = mean(ranges[:period])
    for value in ranges[period:]:
        atr = ((atr * (period - 1)) + value) / period
    return atr


def _bollinger(values: list[float], period: int) -> dict[str, float | None]:
    if len(values) < period:
        return {"mid": None, "upper": None, "lower": None, "position": None, "width_pct": None}
    window = values[-period:]
    mid = mean(window)
    std = stdev(window)
    upper = mid + (std * 2.0)
    lower = mid - (std * 2.0)
    width = upper - lower
    close = values[-1]
    position = ((close - lower) / width) if width > 0 else None
    width_pct = (width / mid * 100.0) if mid > 0 else None
    return {"mid": mid, "upper": upper, "lower": lower, "position": position, "width_pct": width_pct}


def _pct_distance(value: float, reference: float | None) -> float | None:
    if reference is None or reference == 0:
        return None
    return ((value - reference) / reference) * 100.0


def _trend_score(close: float, ema_20: float | None, ema_50: float | None, ema_200: float | None) -> float | None:
    if ema_20 is None or ema_50 is None:
        return None
    score = 0.0
    score += 0.35 if close >= ema_20 else -0.35
    score += 0.35 if ema_20 >= ema_50 else -0.35
    if ema_200 is not None:
        score += 0.30 if ema_50 >= ema_200 else -0.30
    return clamp(score, -1.0, 1.0)


def _momentum_score(rsi_14: float | None, macd_hist_pct: float | None) -> float | None:
    if rsi_14 is None and macd_hist_pct is None:
        return None
    rsi_component = 0.0 if rsi_14 is None else clamp((rsi_14 - 50.0) / 25.0, -1.0, 1.0)
    macd_component = 0.0 if macd_hist_pct is None else clamp(macd_hist_pct / 0.35, -1.0, 1.0)
    return clamp((rsi_component * 0.45) + (macd_component * 0.55), -1.0, 1.0)


def _technical_setup(
    trend_score: float | None,
    rsi_14: float | None,
    bb_position: float | None,
    distance_ema20_pct: float | None,
    bb_width_pct: float | None,
) -> str:
    if rsi_14 is not None and bb_position is not None:
        if rsi_14 >= 72 and bb_position >= 0.9:
            return "Upside Exhaustion"
        if rsi_14 <= 28 and bb_position <= 0.1:
            return "Downside Exhaustion"
    if bb_width_pct is not None and bb_width_pct <= 4.0:
        return "Compression Watch"
    if trend_score is not None and trend_score >= 0.55:
        if distance_ema20_pct is not None and distance_ema20_pct < 0:
            return "Pullback Into Uptrend"
        return "Trend Continuation"
    if trend_score is not None and trend_score <= -0.55:
        if distance_ema20_pct is not None and distance_ema20_pct > 0:
            return "Rally Into Downtrend"
        return "Downtrend Continuation"
    return "Mixed Technicals"
