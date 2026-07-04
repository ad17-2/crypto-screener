from __future__ import annotations

import time
from typing import Any

from .coinglass import CoinGlassClient
from .derivatives import derivatives_snapshot
from .providers import ProviderError
from .technicals import technical_snapshot


def append_coinglass_technicals(
    rows: list[dict[str, Any]],
    client: CoinGlassClient,
    provider_cfg: dict[str, Any],
    status: dict[str, Any] | None,
) -> None:
    technical_cfg = provider_cfg.get("technical_indicators", {})
    if not technical_cfg.get("enabled", True):
        if status is not None:
            status["technicals"] = {"status": "disabled"}
        return

    interval = str(technical_cfg.get("interval", "4h"))
    limit = int(technical_cfg.get("limit", 220))
    max_symbols = int(technical_cfg.get("max_symbols", 40))
    request_delay = float(technical_cfg.get("request_delay_seconds", provider_cfg.get("request_delay_seconds", 2.1)))
    enriched = 0
    errors: list[str] = []

    for row in rows[:max_symbols]:
        exchange = str(row.get("primary_exchange") or "")
        contract_symbol = str(row.get("contract_symbol") or "")
        if not exchange or not contract_symbol:
            continue
        try:
            candles = client.price_history(exchange, contract_symbol, interval, limit)
            snapshot = technical_snapshot(candles, interval)
            if snapshot:
                row.update(snapshot)
                enriched += 1
        except ProviderError as exc:
            errors.append(f"{row.get('symbol', contract_symbol)}: {exc}")
        finally:
            _sleep_between_requests(request_delay)

    if status is not None:
        status["technicals"] = {
            "status": "ok" if enriched else "error",
            "rows": enriched,
            "candidate_symbols": min(max_symbols, len(rows)),
            "interval": interval,
            "errors": errors[:5],
            "note": "CoinGlass futures price OHLC technical indicators",
        }


def append_coinglass_derivatives_history(
    rows: list[dict[str, Any]],
    client: CoinGlassClient,
    provider_cfg: dict[str, Any],
    status: dict[str, Any] | None,
) -> None:
    history_cfg = provider_cfg.get("derivatives_history", {})
    if not history_cfg.get("enabled", True):
        if status is not None:
            status["derivatives_history"] = {"status": "disabled"}
        return

    interval = str(history_cfg.get("interval", "4h"))
    limit = int(history_cfg.get("limit", 220))
    max_symbols = int(history_cfg.get("max_symbols", 30))
    request_delay = float(history_cfg.get("request_delay_seconds", provider_cfg.get("request_delay_seconds", 2.1)))
    exchanges = [str(item) for item in provider_cfg.get("exchanges", [])]
    enriched = 0
    errors: list[str] = []

    for row in rows[:max_symbols]:
        symbol = str(row.get("symbol") or "")
        if not symbol:
            continue
        try:
            oi_history = client.open_interest_aggregated_history(symbol, interval, limit)
            _sleep_between_requests(request_delay)
            funding_history = client.funding_oi_weight_history(symbol, interval, limit)
            _sleep_between_requests(request_delay)
            liquidation_history = client.liquidation_aggregated_history(exchanges, symbol, interval, limit)
            _sleep_between_requests(request_delay)
            taker_history = client.aggregated_taker_buy_sell_history(exchanges, symbol, interval, limit)

            snapshot = derivatives_snapshot(
                oi_history=oi_history,
                funding_history=funding_history,
                liquidation_history=liquidation_history,
                taker_history=taker_history,
                interval=interval,
            )
            if snapshot:
                row.update(snapshot)
                enriched += 1
        except ProviderError as exc:
            errors.append(f"{symbol}: {exc}")
        finally:
            _sleep_between_requests(request_delay)

    if status is not None:
        status["derivatives_history"] = {
            "status": "ok" if enriched else "error",
            "rows": enriched,
            "candidate_symbols": min(max_symbols, len(rows)),
            "interval": interval,
            "errors": errors[:5],
            "note": "CoinGlass historical OI/funding/liquidation/taker features",
        }


def _sleep_between_requests(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds)
