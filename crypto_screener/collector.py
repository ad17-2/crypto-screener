from __future__ import annotations

import os
import time
from typing import Any

from .binance import BinanceFuturesClient, ProviderError
from .coingecko import CoinGeckoClient
from .coinglass import CoinGlassClient
from .scoring import funding_annualized_pct, funding_rate_pct, pct_change, spread_bps, to_float


def collect_market(config: dict[str, Any]) -> dict[str, Any]:
    status: dict[str, Any] = {}
    rows = collect_binance_usdm(config, status)
    market_context = collect_coingecko_context(config, status)
    enrich_with_coinglass(rows, config, status)
    return {
        "rows": rows,
        "market_context": market_context,
        "provider_status": status,
    }


def collect_binance_usdm(config: dict[str, Any], status: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    provider_cfg = config.get("providers", {}).get("binance", {})
    universe_cfg = config.get("universe", {})
    client = BinanceFuturesClient(
        base_url=provider_cfg.get("base_url", "https://fapi.binance.com"),
        timeout_seconds=float(provider_cfg.get("request_timeout_seconds", 12)),
    )

    exchange_info = client.exchange_info()
    symbols = exchange_info.get("symbols", [])
    quote_asset = universe_cfg.get("quote_asset", "USDT")
    contract_type = universe_cfg.get("contract_type", "PERPETUAL")
    excluded_bases = set(universe_cfg.get("exclude_base_assets", []))

    valid_symbols: dict[str, dict[str, Any]] = {}
    for item in symbols:
        if item.get("status") != "TRADING":
            continue
        if item.get("quoteAsset") != quote_asset:
            continue
        if item.get("contractType") != contract_type:
            continue
        if item.get("baseAsset") in excluded_bases:
            continue
        valid_symbols[item["symbol"]] = item

    tickers = _index_by_symbol(client.ticker_24hr())
    book = _index_by_symbol(client.book_ticker())
    premium = _index_by_symbol(client.premium_index())

    min_volume = float(universe_cfg.get("min_quote_volume_usd", 20_000_000))
    max_spread = float(universe_cfg.get("max_spread_bps", 15))

    rows: list[dict[str, Any]] = []
    for contract_symbol, meta in valid_symbols.items():
        ticker = tickers.get(contract_symbol)
        book_row = book.get(contract_symbol)
        premium_row = premium.get(contract_symbol)
        if not ticker or not book_row or not premium_row:
            continue

        quote_volume = to_float(ticker.get("quoteVolume"), 0.0) or 0.0
        if quote_volume < min_volume:
            continue

        bid = to_float(book_row.get("bidPrice"))
        ask = to_float(book_row.get("askPrice"))
        spread = spread_bps(bid, ask)
        if spread is None or spread > max_spread:
            continue

        mark_price = to_float(premium_row.get("markPrice")) or to_float(ticker.get("lastPrice"))
        funding_rate = to_float(premium_row.get("lastFundingRate"))
        rows.append(
            {
                "symbol": meta.get("baseAsset"),
                "contract_symbol": contract_symbol,
                "base_asset": meta.get("baseAsset"),
                "quote_asset": quote_asset,
                "primary_exchange": "Binance",
                "data_source": "binance",
                "price_usd": to_float(ticker.get("lastPrice")),
                "mark_price": mark_price,
                "price_change_24h_pct": to_float(ticker.get("priceChangePercent")),
                "quote_volume_usd": quote_volume,
                "bid": bid,
                "ask": ask,
                "spread_bps": spread,
                "funding_rate_pct": funding_rate_pct(funding_rate),
                "funding_annualized_pct": funding_annualized_pct(funding_rate),
                "next_funding_time": premium_row.get("nextFundingTime"),
            }
        )

    rows.sort(key=lambda row: row["quote_volume_usd"], reverse=True)
    rows = rows[: int(universe_cfg.get("top_symbols_by_volume", 80))]

    _append_binance_open_interest(rows, client, config)
    _append_binance_depth(rows, client, config)

    if status is not None:
        status["binance"] = {
            "status": "ok",
            "rows": len(rows),
            "note": "public Binance USD-M fallback data",
        }
    return rows


def enrich_with_coinglass(rows: list[dict[str, Any]], config: dict[str, Any], status: dict[str, Any]) -> None:
    provider_cfg = config.get("providers", {}).get("coinglass", {})
    if not provider_cfg.get("enabled", True):
        status["coinglass"] = {"status": "disabled"}
        return

    api_key = os.environ.get(provider_cfg.get("api_key_env", "COINGLASS_API_KEY"), "")
    if not api_key:
        status["coinglass"] = {
            "status": "skipped",
            "reason": f"{provider_cfg.get('api_key_env', 'COINGLASS_API_KEY')} is not set",
        }
        return

    client = CoinGlassClient(
        api_key=api_key,
        base_url=provider_cfg.get("base_url", "https://open-api-v4.coinglass.com"),
        timeout_seconds=float(provider_cfg.get("request_timeout_seconds", 12)),
    )
    exchanges = set(provider_cfg.get("exchanges", []))
    max_symbols = int(provider_cfg.get("max_symbols", 30))
    request_delay = float(provider_cfg.get("request_delay_seconds", 2.1))
    enriched = 0
    errors: list[str] = []

    for row in rows[:max_symbols]:
        symbol = row["symbol"]
        try:
            pairs = client.futures_pairs_markets(symbol)
            aggregate = _aggregate_coinglass_pairs(pairs, exchanges)
            if aggregate:
                row.update(aggregate)
                row["data_source"] = "coinglass+binance"
                enriched += 1
        except ProviderError as exc:
            errors.append(f"{symbol}: {exc}")
        finally:
            if request_delay > 0:
                time.sleep(request_delay)

    status["coinglass"] = {
        "status": "ok" if enriched else "error",
        "rows": enriched,
        "errors": errors[:5],
        "note": "CoinGlass futures pairs-markets enrichment",
    }


def collect_coingecko_context(config: dict[str, Any], status: dict[str, Any]) -> dict[str, Any]:
    provider_cfg = config.get("providers", {}).get("coingecko", {})
    if not provider_cfg.get("enabled", True):
        status["coingecko"] = {"status": "disabled"}
        return {}

    api_key = os.environ.get(provider_cfg.get("api_key_env", "COINGECKO_API_KEY"), "")
    client = CoinGeckoClient(
        base_url=provider_cfg.get("base_url", "https://api.coingecko.com/api/v3"),
        api_key=api_key or None,
        timeout_seconds=float(provider_cfg.get("request_timeout_seconds", 12)),
    )
    context: dict[str, Any] = {}
    errors: list[str] = []
    try:
        global_data = client.global_data()
        context.update(_normalize_coingecko_global(global_data))
    except ProviderError as exc:
        errors.append(str(exc))

    try:
        categories = client.categories()
        limit = int(provider_cfg.get("categories_limit", 12))
        context["categories"] = _normalize_coingecko_categories(categories, limit)
    except ProviderError as exc:
        errors.append(str(exc))

    status["coingecko"] = {
        "status": "ok" if context else "error",
        "errors": errors[:5],
        "note": "global market and category context",
    }
    return context


def _append_binance_open_interest(rows: list[dict[str, Any]], client: BinanceFuturesClient, config: dict[str, Any]) -> None:
    provider_cfg = config.get("providers", {}).get("binance", {})
    oi_period = provider_cfg.get("oi_period", "1h")
    oi_limit = int(provider_cfg.get("oi_limit", 25))
    per_symbol_delay = float(provider_cfg.get("per_symbol_delay_seconds", 0.05))

    for row in rows:
        contract_symbol = row["contract_symbol"]
        try:
            oi_now = client.open_interest(contract_symbol)
            current_oi = to_float(oi_now.get("openInterest"))
            row["open_interest"] = current_oi
            if current_oi is not None and row.get("mark_price") is not None:
                row["open_interest_usd"] = current_oi * row["mark_price"]

            oi_hist = client.open_interest_hist(contract_symbol, oi_period, oi_limit)
            if oi_hist:
                first_value = to_float(oi_hist[0].get("sumOpenInterestValue"))
                last_value = to_float(oi_hist[-1].get("sumOpenInterestValue"))
                row["open_interest_hist_oldest_usd"] = first_value
                row["open_interest_hist_latest_usd"] = last_value
                row["oi_change_24h_pct"] = pct_change(first_value, last_value)
        except ProviderError as exc:
            row["open_interest_error"] = str(exc)
        finally:
            client.polite_pause(per_symbol_delay)


def _append_binance_depth(rows: list[dict[str, Any]], client: BinanceFuturesClient, config: dict[str, Any]) -> None:
    provider_cfg = config.get("providers", {}).get("binance", {})
    depth_symbols = int(provider_cfg.get("depth_symbols", 20))
    depth_limit = int(provider_cfg.get("depth_limit", 500))
    per_symbol_delay = float(provider_cfg.get("per_symbol_delay_seconds", 0.05))

    for row in rows[:depth_symbols]:
        mid = row.get("mark_price") or row.get("price_usd")
        if not mid:
            continue
        try:
            order_book = client.depth(row["contract_symbol"], depth_limit)
            bid_05, ask_05, min_05 = _depth_usd(order_book, mid, 0.005)
            bid_10, ask_10, min_10 = _depth_usd(order_book, mid, 0.010)
            row["bid_depth_0_5pct_usd"] = bid_05
            row["ask_depth_0_5pct_usd"] = ask_05
            row["depth_0_5pct_usd"] = min_05
            row["bid_depth_1pct_usd"] = bid_10
            row["ask_depth_1pct_usd"] = ask_10
            row["depth_1pct_usd"] = min_10
        except ProviderError as exc:
            row["depth_error"] = str(exc)
        finally:
            client.polite_pause(per_symbol_delay)


def _aggregate_coinglass_pairs(pairs: list[dict[str, Any]], exchanges: set[str]) -> dict[str, Any]:
    filtered = [
        pair
        for pair in pairs
        if not exchanges or pair.get("exchange_name") in exchanges
    ]
    if not filtered:
        return {}

    total_volume = sum(to_float(pair.get("volume_usd"), 0.0) or 0.0 for pair in filtered)
    total_oi = sum(to_float(pair.get("open_interest_usd"), 0.0) or 0.0 for pair in filtered)
    long_volume = sum(to_float(pair.get("long_volume_usd"), 0.0) or 0.0 for pair in filtered)
    short_volume = sum(to_float(pair.get("short_volume_usd"), 0.0) or 0.0 for pair in filtered)
    long_liq = sum(to_float(pair.get("long_liquidation_usd_24h"), 0.0) or 0.0 for pair in filtered)
    short_liq = sum(to_float(pair.get("short_liquidation_usd_24h"), 0.0) or 0.0 for pair in filtered)

    return {
        "price_usd": _weighted_average(filtered, "current_price", "volume_usd"),
        "index_price": _weighted_average(filtered, "index_price", "volume_usd"),
        "price_change_24h_pct": _weighted_average(filtered, "price_change_percent_24h", "volume_usd"),
        "quote_volume_usd": total_volume,
        "volume_change_percent_24h": _weighted_average(filtered, "volume_usd_change_percent_24h", "volume_usd"),
        "open_interest_usd": total_oi,
        "oi_change_24h_pct": _weighted_average(filtered, "open_interest_change_percent_24h", "open_interest_usd"),
        "funding_rate_pct": _weighted_average(filtered, "funding_rate", "open_interest_usd"),
        "long_volume_usd_24h": long_volume,
        "short_volume_usd_24h": short_volume,
        "long_short_ratio": (long_volume / short_volume) if short_volume > 0 else None,
        "long_liquidation_usd_24h": long_liq,
        "short_liquidation_usd_24h": short_liq,
        "open_interest_volume_ratio": (total_oi / total_volume) if total_volume > 0 else None,
        "coinglass_exchange_count": len({pair.get("exchange_name") for pair in filtered}),
    }


def _normalize_coingecko_global(global_data: dict[str, Any]) -> dict[str, Any]:
    total_market_cap = global_data.get("total_market_cap", {})
    market_cap_percentage = global_data.get("market_cap_percentage", {})
    return {
        "total_market_cap_usd": to_float(total_market_cap.get("usd")),
        "market_cap_change_24h_pct": to_float(global_data.get("market_cap_change_percentage_24h_usd")),
        "btc_dominance_pct": to_float(market_cap_percentage.get("btc")),
        "eth_dominance_pct": to_float(market_cap_percentage.get("eth")),
        "active_cryptocurrencies": global_data.get("active_cryptocurrencies"),
        "markets": global_data.get("markets"),
    }


def _normalize_coingecko_categories(categories: list[dict[str, Any]], limit: int) -> dict[str, list[dict[str, Any]]]:
    normalized = [
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "market_cap_usd": to_float(item.get("market_cap")),
            "market_cap_change_24h_pct": to_float(item.get("market_cap_change_24h")),
            "volume_24h_usd": to_float(item.get("volume_24h")),
            "top_3_coins": item.get("top_3_coins", []),
        }
        for item in categories
        if to_float(item.get("market_cap_change_24h")) is not None
    ]
    leaders = sorted(normalized, key=lambda item: item["market_cap_change_24h_pct"], reverse=True)[:limit]
    laggards = sorted(normalized, key=lambda item: item["market_cap_change_24h_pct"])[:limit]
    return {"leaders": leaders, "laggards": laggards}


def _weighted_average(rows: list[dict[str, Any]], value_key: str, weight_key: str) -> float | None:
    weighted_sum = 0.0
    total_weight = 0.0
    for row in rows:
        value = to_float(row.get(value_key))
        weight = to_float(row.get(weight_key), 0.0) or 0.0
        if value is None or weight <= 0:
            continue
        weighted_sum += value * weight
        total_weight += weight
    return weighted_sum / total_weight if total_weight > 0 else None


def _index_by_symbol(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {item["symbol"]: item for item in items if "symbol" in item}


def _depth_usd(order_book: dict[str, Any], mid: float, band_pct: float) -> tuple[float, float, float]:
    bid_floor = mid * (1.0 - band_pct)
    ask_ceiling = mid * (1.0 + band_pct)

    bid_depth = 0.0
    for price_raw, qty_raw in order_book.get("bids", []):
        price = to_float(price_raw)
        qty = to_float(qty_raw)
        if price is None or qty is None:
            continue
        if price >= bid_floor:
            bid_depth += price * qty

    ask_depth = 0.0
    for price_raw, qty_raw in order_book.get("asks", []):
        price = to_float(price_raw)
        qty = to_float(qty_raw)
        if price is None or qty is None:
            continue
        if price <= ask_ceiling:
            ask_depth += price * qty

    return bid_depth, ask_depth, min(bid_depth, ask_depth)
