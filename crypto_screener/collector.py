from __future__ import annotations

import os
import re
import time
from typing import Any

from .coingecko import CoinGeckoClient
from .coinglass import CoinGlassClient
from .providers import ProviderError
from .quality import apply_data_quality
from .scoring import funding_annualized_pct, to_float


def collect_market(config: dict[str, Any]) -> dict[str, Any]:
    status: dict[str, Any] = {}
    rows = collect_coinglass_futures(config, status)
    market_context = collect_coingecko_context(config, status)
    status["data_quality"] = apply_data_quality(rows, config)
    return {
        "rows": rows,
        "market_context": market_context,
        "provider_status": status,
    }


def collect_coinglass_futures(config: dict[str, Any], status: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    provider_cfg = config.get("providers", {}).get("coinglass", {})
    universe_cfg = config.get("universe", {})
    if not provider_cfg.get("enabled", True):
        raise ProviderError("CoinGlass provider is required for futures collection")

    api_key_env = provider_cfg.get("api_key_env", "COINGLASS_API_KEY")
    api_key = os.environ.get(api_key_env, "")
    if not api_key:
        raise ProviderError(f"{api_key_env} is required for CoinGlass-only futures collection")

    client = CoinGlassClient(
        api_key=api_key,
        base_url=provider_cfg.get("base_url", "https://open-api-v4.coinglass.com"),
        timeout_seconds=float(provider_cfg.get("request_timeout_seconds", 12)),
    )
    exchanges = set(provider_cfg.get("exchanges", []))
    request_delay = float(provider_cfg.get("request_delay_seconds", 2.1))
    top_symbols = int(universe_cfg.get("top_symbols_by_volume", 80))
    candidate_limit = int(provider_cfg.get("candidate_symbols", top_symbols))
    min_volume = float(universe_cfg.get("min_quote_volume_usd", 20_000_000))
    quote_asset = str(universe_cfg.get("quote_asset", "USDT"))
    min_exchange_count = int(provider_cfg.get("min_exchange_count", 2))
    excluded_bases = {str(item).upper() for item in universe_cfg.get("exclude_base_assets", [])}
    core_symbols = [str(item).upper() for item in config.get("report", {}).get("core_symbols", ["BTC", "ETH", "SOL"])]

    supported_pairs = client.supported_exchange_pairs()
    candidate_stats = _coinglass_candidate_stats(
        supported_pairs=supported_pairs,
        exchanges=exchanges,
        quote_asset=quote_asset,
        min_exchange_count=min_exchange_count,
        excluded_bases=excluded_bases,
    )
    candidates = _rank_coinglass_candidates(candidate_stats, core_symbols, candidate_limit)

    rows: list[dict[str, Any]] = []
    errors: list[str] = []
    for symbol in candidates:
        try:
            pairs = client.futures_pairs_markets(symbol)
            aggregate = _aggregate_coinglass_pairs(pairs, exchanges, candidate_stats.get(symbol, {}), quote_asset)
            if aggregate and (aggregate.get("quote_volume_usd") or 0.0) >= min_volume:
                rows.append(aggregate)
        except ProviderError as exc:
            errors.append(f"{symbol}: {exc}")
        finally:
            if request_delay > 0:
                time.sleep(request_delay)

    rows.sort(key=lambda row: row.get("quote_volume_usd") or 0.0, reverse=True)
    rows = rows[:top_symbols]

    if status is not None:
        status["coinglass"] = {
            "status": "ok" if rows else "error",
            "rows": len(rows),
            "candidate_symbols": len(candidates),
            "supported_symbols": len(candidate_stats),
            "errors": errors[:5],
            "note": "CoinGlass futures pairs-markets primary data",
        }
    return rows


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
        retry_429=bool(provider_cfg.get("retry_429", True)),
        retry_429_initial_delay_seconds=float(provider_cfg.get("retry_429_initial_delay_seconds", 30)),
        retry_429_max_delay_seconds=float(provider_cfg.get("retry_429_max_delay_seconds", 300)),
        retry_429_jitter_seconds=float(provider_cfg.get("retry_429_jitter_seconds", 15)),
        retry_429_max_attempts=int(provider_cfg.get("retry_429_max_attempts", 0)),
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


def _coinglass_candidate_stats(
    supported_pairs: dict[str, list[dict[str, Any]]],
    exchanges: set[str],
    quote_asset: str,
    min_exchange_count: int,
    excluded_bases: set[str],
) -> dict[str, dict[str, Any]]:
    stats: dict[str, dict[str, Any]] = {}
    for exchange_name, pairs in supported_pairs.items():
        if exchanges and exchange_name not in exchanges:
            continue
        for pair in pairs:
            base_asset = str(pair.get("base_asset") or "").upper()
            if not base_asset or base_asset in excluded_bases:
                continue
            if not _quote_matches(pair, quote_asset):
                continue
            if not _is_likely_perpetual(pair):
                continue
            item = stats.setdefault(
                base_asset,
                {
                    "symbol": base_asset,
                    "exchanges": set(),
                    "instrument_count": 0,
                    "max_leverage": 0.0,
                },
            )
            item["exchanges"].add(exchange_name)
            item["instrument_count"] += 1
            item["max_leverage"] = max(item["max_leverage"], to_float(pair.get("max_leverage"), 0.0) or 0.0)

    return {
        symbol: item
        for symbol, item in stats.items()
        if len(item["exchanges"]) >= min_exchange_count
    }


def _rank_coinglass_candidates(
    candidate_stats: dict[str, dict[str, Any]],
    core_symbols: list[str],
    limit: int,
) -> list[str]:
    ranked = sorted(
        candidate_stats,
        key=lambda symbol: (
            len(candidate_stats[symbol].get("exchanges", [])),
            candidate_stats[symbol].get("instrument_count", 0),
            candidate_stats[symbol].get("max_leverage", 0.0),
            symbol,
        ),
        reverse=True,
    )
    ordered: list[str] = []
    for symbol in core_symbols + ranked:
        if symbol in candidate_stats and symbol not in ordered:
            ordered.append(symbol)
        if len(ordered) >= limit:
            break
    return ordered


def _aggregate_coinglass_pairs(
    pairs: list[dict[str, Any]],
    exchanges: set[str],
    symbol_stats: dict[str, Any],
    quote_asset: str,
) -> dict[str, Any]:
    filtered = [
        pair
        for pair in pairs
        if (not exchanges or pair.get("exchange_name") in exchanges)
        and _pair_symbol_matches_quote(pair, quote_asset)
    ]
    if not filtered:
        return {}

    primary = max(filtered, key=lambda pair: to_float(pair.get("volume_usd"), 0.0) or 0.0)
    symbol = _base_from_pair(primary)
    total_volume = sum(to_float(pair.get("volume_usd"), 0.0) or 0.0 for pair in filtered)
    total_oi = sum(to_float(pair.get("open_interest_usd"), 0.0) or 0.0 for pair in filtered)
    long_volume = sum(to_float(pair.get("long_volume_usd"), 0.0) or 0.0 for pair in filtered)
    short_volume = sum(to_float(pair.get("short_volume_usd"), 0.0) or 0.0 for pair in filtered)
    long_liq = sum(to_float(pair.get("long_liquidation_usd_24h"), 0.0) or 0.0 for pair in filtered)
    short_liq = sum(to_float(pair.get("short_liquidation_usd_24h"), 0.0) or 0.0 for pair in filtered)
    funding = _weighted_average(filtered, "funding_rate", "open_interest_usd")

    return {
        "symbol": symbol,
        "contract_symbol": primary.get("instrument_id") or f"{symbol}{quote_asset}",
        "base_asset": symbol,
        "quote_asset": quote_asset,
        "primary_exchange": primary.get("exchange_name"),
        "data_source": "coinglass",
        "price_usd": _weighted_average(filtered, "current_price", "volume_usd"),
        "index_price": _weighted_average(filtered, "index_price", "volume_usd"),
        "price_change_24h_pct": _weighted_average(filtered, "price_change_percent_24h", "volume_usd"),
        "quote_volume_usd": total_volume,
        "volume_change_percent_24h": _weighted_average(filtered, "volume_usd_change_percent_24h", "volume_usd"),
        "open_interest_usd": total_oi,
        "oi_change_24h_pct": _weighted_average(filtered, "open_interest_change_percent_24h", "open_interest_usd"),
        "funding_rate_pct": funding,
        "funding_annualized_pct": funding_annualized_pct(funding / 100.0) if funding is not None else None,
        "next_funding_time": primary.get("next_funding_time"),
        "long_volume_usd_24h": long_volume,
        "short_volume_usd_24h": short_volume,
        "long_short_ratio": (long_volume / short_volume) if short_volume > 0 else None,
        "long_liquidation_usd_24h": long_liq,
        "short_liquidation_usd_24h": short_liq,
        "open_interest_volume_ratio": (total_oi / total_volume) if total_volume > 0 else None,
        "coinglass_exchange_count": len({pair.get("exchange_name") for pair in filtered}),
        "coinglass_instrument_count": symbol_stats.get("instrument_count"),
        "coinglass_supported_exchange_count": len(symbol_stats.get("exchanges", [])),
    }


def _quote_matches(pair: dict[str, Any], quote_asset: str) -> bool:
    return (
        str(pair.get("quote_asset") or "").upper() == quote_asset
        or str(pair.get("settlement_currency") or "").upper() == quote_asset
    )


def _pair_symbol_matches_quote(pair: dict[str, Any], quote_asset: str) -> bool:
    symbol = str(pair.get("symbol") or "").upper()
    instrument_id = str(pair.get("instrument_id") or "").upper()
    return symbol.endswith(f"/{quote_asset}") or quote_asset in instrument_id


def _is_likely_perpetual(pair: dict[str, Any]) -> bool:
    instrument_id = str(pair.get("instrument_id") or "")
    lowered = instrument_id.lower()
    if "perp" in lowered or "swap" in lowered:
        return True
    return re.search(r"[_-]\d{6,8}$", instrument_id) is None


def _base_from_pair(pair: dict[str, Any]) -> str:
    symbol = str(pair.get("symbol") or "")
    if "/" in symbol:
        return symbol.split("/", 1)[0].upper()
    instrument_id = str(pair.get("instrument_id") or "")
    return re.sub(r"[^A-Z0-9].*$", "", instrument_id.upper()).replace("USDT", "")


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
