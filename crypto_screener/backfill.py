from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .coinglass import CoinGlassClient
from .coinglass_pairs import select_price_pair
from .config import load_config_dict
from .derivatives import candles_per_window, derivatives_snapshot
from .factors import score_snapshot
from .providers import ProviderError
from .scoring import pct_change, to_float
from .storage import save_factor_history_records
from .technicals import technical_snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill compact CoinGlass factor history.")
    parser.add_argument("--config", default="config/default.json", help="Path to JSON config.")
    parser.add_argument("--symbols", help="Comma-separated base symbols. Defaults to report core symbols.")
    parser.add_argument(
        "--interval", default=None, help="CoinGlass interval. Default: config derivatives_history interval."
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="History rows per symbol. Default: config backfill/history limit."
    )
    parser.add_argument("--min-cross-section", type=int, default=3, help="Minimum symbols required per timestamp.")
    parser.add_argument("--request-delay-seconds", type=float, default=None, help="Delay between CoinGlass requests.")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and build records without writing SQLite.")
    return parser.parse_args()


def load_config(path: Path) -> dict[str, Any]:
    return load_config_dict(path)


def run_backfill(config: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    db_path = os.environ.get("CRYPTO_SCREENER_DB_PATH")
    if db_path:
        config["storage_path"] = db_path

    provider_cfg = config.get("providers", {}).get("coinglass", {})
    api_key = os.environ.get(provider_cfg.get("api_key_env", "COINGLASS_API_KEY"), "")
    if not api_key:
        raise ProviderError(f"{provider_cfg.get('api_key_env', 'COINGLASS_API_KEY')} is required for backfill")

    history_cfg = provider_cfg.get("derivatives_history", {})
    technical_cfg = provider_cfg.get("technical_indicators", {})
    interval = args.interval or str(history_cfg.get("interval") or technical_cfg.get("interval") or "4h")
    limit = args.limit or int(history_cfg.get("limit") or technical_cfg.get("limit") or 220)
    request_delay = (
        args.request_delay_seconds
        if args.request_delay_seconds is not None
        else float(history_cfg.get("request_delay_seconds", provider_cfg.get("request_delay_seconds", 2.1)))
    )
    exchanges = [str(item) for item in provider_cfg.get("exchanges", [])]
    quote_asset = str(config.get("universe", {}).get("quote_asset", "USDT"))
    symbols = _symbols_from_args(args.symbols, config)

    client = CoinGlassClient(
        api_key=api_key,
        base_url=provider_cfg.get("base_url", "https://open-api-v4.coinglass.com"),
        timeout_seconds=float(provider_cfg.get("request_timeout_seconds", 12)),
    )
    supported_pairs = client.supported_exchange_pairs()
    _sleep(request_delay)

    rows_by_time: dict[int, list[dict[str, Any]]] = {}
    errors: list[str] = []
    for symbol in symbols:
        try:
            exchange, contract_symbol = select_price_pair(supported_pairs, exchanges, symbol, quote_asset)
            histories = _fetch_histories(
                client, exchanges, exchange, contract_symbol, symbol, interval, limit, request_delay
            )
            symbol_rows = _build_symbol_rows(symbol, exchange, contract_symbol, interval, histories)
            for row in symbol_rows:
                rows_by_time.setdefault(row["_time"], []).append(row)
        except (ProviderError, ValueError) as exc:
            errors.append(f"{symbol}: {exc}")

    records = _score_backfill_rows(rows_by_time, config, args.min_cross_section)
    saved = 0 if args.dry_run else save_factor_history_records(records, config)
    return {
        "symbols_requested": len(symbols),
        "timestamps": len(rows_by_time),
        "records": len(records),
        "saved": saved,
        "interval": interval,
        "limit": limit,
        "errors": errors[:10],
        "dry_run": bool(args.dry_run),
    }


def _fetch_histories(
    client: CoinGlassClient,
    exchanges: list[str],
    exchange: str,
    contract_symbol: str,
    symbol: str,
    interval: str,
    limit: int,
    request_delay: float,
) -> dict[str, list[dict[str, Any]]]:
    price_history = client.price_history(exchange, contract_symbol, interval, limit)
    _sleep(request_delay)
    oi_history = client.open_interest_aggregated_history(symbol, interval, limit)
    _sleep(request_delay)
    funding_history = client.funding_oi_weight_history(symbol, interval, limit)
    _sleep(request_delay)
    liquidation_history = client.liquidation_aggregated_history(exchanges, symbol, interval, limit)
    _sleep(request_delay)
    taker_history = client.aggregated_taker_buy_sell_history(exchanges, symbol, interval, limit)
    _sleep(request_delay)
    return {
        "price": price_history,
        "oi": oi_history,
        "funding": funding_history,
        "liquidation": liquidation_history,
        "taker": taker_history,
    }


def _build_symbol_rows(
    symbol: str,
    exchange: str,
    contract_symbol: str,
    interval: str,
    histories: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    price_rows = _normalize_price_candles(histories.get("price", []))
    if len(price_rows) < 50:
        return []

    rows: list[dict[str, Any]] = []
    window = candles_per_window(interval, 24.0)
    closes = [row["close"] for row in price_rows]
    rolling_volumes = [row["volume_usd"] for row in price_rows]
    for index, candle in enumerate(price_rows):
        if index < 49:
            continue
        time_value = int(candle["time"])
        price_change = pct_change(closes[index - window], closes[index]) if index >= window else None
        previous_volume = sum(rolling_volumes[max(0, index - (window * 2) + 1) : index - window + 1])
        current_volume = sum(rolling_volumes[max(0, index - window + 1) : index + 1])
        volume_change = pct_change(previous_volume, current_volume) if previous_volume > 0 else None
        technical = technical_snapshot(_raw_candles_until(histories.get("price", []), time_value), interval)
        derivatives = derivatives_snapshot(
            oi_history=histories.get("oi", []),
            funding_history=histories.get("funding", []),
            liquidation_history=histories.get("liquidation", []),
            taker_history=histories.get("taker", []),
            interval=interval,
            end_time=time_value,
        )
        row = {
            "_time": time_value,
            "run_id": "backfill-" + _timestamp_id(time_value),
            "generated_at": _iso_from_ms(time_value),
            "symbol": symbol,
            "contract_symbol": contract_symbol,
            "primary_exchange": exchange,
            "data_source": "coinglass_backfill",
            "is_trusted": True,
            "data_quality_score": 100,
            "price_usd": candle["close"],
            "price_change_24h_pct": price_change,
            "quote_volume_usd": current_volume,
            "volume_change_percent_24h": volume_change,
        }
        row.update(technical)
        row.update(derivatives)
        if row.get("oi_change_24h_pct_history") is not None:
            row["oi_change_24h_pct"] = row["oi_change_24h_pct_history"]
        if row.get("funding_avg_24h_pct") is not None:
            row["funding_rate_pct"] = row["funding_avg_24h_pct"]
        if row.get("taker_buy_sell_ratio_24h") is not None:
            row["long_short_ratio"] = row["taker_buy_sell_ratio_24h"]
        if row.get("long_liquidation_usd_24h_history") is not None:
            row["long_liquidation_usd_24h"] = row["long_liquidation_usd_24h_history"]
        if row.get("short_liquidation_usd_24h_history") is not None:
            row["short_liquidation_usd_24h"] = row["short_liquidation_usd_24h_history"]
        rows.append(row)
    return rows


def _score_backfill_rows(
    rows_by_time: dict[int, list[dict[str, Any]]],
    config: dict[str, Any],
    min_cross_section: int,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    now_ms = int(datetime.now(ZoneInfo("Asia/Jakarta")).timestamp() * 1000)
    for time_value in sorted(rows_by_time):
        if time_value > now_ms:
            continue
        rows = rows_by_time[time_value]
        if len(rows) < min_cross_section:
            continue
        scored = score_snapshot(rows, {}, [], config)["rows"]
        for row in scored:
            row.pop("_time", None)
            records.append(row)
    return records


def _symbols_from_args(raw_symbols: str | None, config: dict[str, Any]) -> list[str]:
    if raw_symbols:
        return _dedupe_symbols(raw_symbols.split(","))
    return _dedupe_symbols(config.get("report", {}).get("core_symbols", ["BTC", "ETH", "SOL"]))


def _dedupe_symbols(symbols: list[str]) -> list[str]:
    result: list[str] = []
    for symbol in symbols:
        normalized = str(symbol).strip().upper()
        if normalized and normalized not in result:
            result.append(normalized)
    return result


def _normalize_price_candles(candles: list[dict[str, Any]]) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    for candle in sorted(candles, key=lambda item: to_float(item.get("time"), 0.0) or 0.0):
        time_value = to_float(candle.get("time"))
        open_value = to_float(candle.get("open"))
        high = to_float(candle.get("high"))
        low = to_float(candle.get("low"))
        close = to_float(candle.get("close"))
        volume = to_float(candle.get("volume_usd"), 0.0) or 0.0
        if time_value is None or open_value is None or high is None or low is None or close is None:
            continue
        if min(open_value, high, low, close) <= 0:
            continue
        normalized.append(
            {
                "time": time_value,
                "open": open_value,
                "high": high,
                "low": low,
                "close": close,
                "volume_usd": volume,
            }
        )
    return normalized


def _raw_candles_until(candles: list[dict[str, Any]], end_time: int) -> list[dict[str, Any]]:
    return [candle for candle in candles if (to_float(candle.get("time"), 0.0) or 0.0) <= end_time]


def _timestamp_id(time_ms: int) -> str:
    return datetime.fromtimestamp(time_ms / 1000.0, tz=ZoneInfo("Asia/Jakarta")).strftime("%Y%m%d%H%M")


def _iso_from_ms(time_ms: int) -> str:
    return datetime.fromtimestamp(time_ms / 1000.0, tz=ZoneInfo("Asia/Jakarta")).isoformat(timespec="seconds")


def _sleep(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds)


def main() -> int:
    args = parse_args()
    config = load_config(Path(args.config))
    summary = run_backfill(config, args)
    print(f"symbols_requested={summary['symbols_requested']}")
    print(f"timestamps={summary['timestamps']}")
    print(f"records={summary['records']}")
    print(f"saved={summary['saved']}")
    print(f"interval={summary['interval']}")
    print(f"limit={summary['limit']}")
    print(f"dry_run={summary['dry_run']}")
    if summary["errors"]:
        print("errors=" + json.dumps(summary["errors"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
