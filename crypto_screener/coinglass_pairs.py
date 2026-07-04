from __future__ import annotations

import re
from typing import Any


def quote_matches(pair: dict[str, Any], quote_asset: str) -> bool:
    expected = quote_asset.upper()
    return (
        str(pair.get("quote_asset") or "").upper() == expected
        or str(pair.get("settlement_currency") or "").upper() == expected
    )


def pair_symbol_matches_quote(pair: dict[str, Any], quote_asset: str) -> bool:
    expected = quote_asset.upper()
    symbol = str(pair.get("symbol") or "").upper()
    instrument_id = str(pair.get("instrument_id") or "").upper()
    return symbol.endswith(f"/{expected}") or expected in instrument_id


def is_likely_perpetual_instrument(instrument_id: str) -> bool:
    lowered = instrument_id.lower()
    if "perp" in lowered or "swap" in lowered:
        return True
    return re.search(r"[_-]\d{6,8}$", instrument_id) is None


def is_likely_perpetual_pair(pair: dict[str, Any]) -> bool:
    return is_likely_perpetual_instrument(str(pair.get("instrument_id") or ""))


def base_from_pair(pair: dict[str, Any], quote_asset: str = "USDT") -> str:
    symbol = str(pair.get("symbol") or "")
    if "/" in symbol:
        return symbol.split("/", 1)[0].upper()
    instrument_id = str(pair.get("instrument_id") or "").upper()
    return re.sub(r"[^A-Z0-9].*$", "", instrument_id).replace(quote_asset.upper(), "")


def select_price_pair(
    supported_pairs: dict[str, list[dict[str, Any]]],
    exchanges: list[str],
    symbol: str,
    quote_asset: str,
) -> tuple[str, str]:
    expected_symbol = symbol.upper()
    for exchange in exchanges:
        for pair in supported_pairs.get(exchange, []):
            base = str(pair.get("base_asset") or "").upper()
            instrument_id = str(pair.get("instrument_id") or "")
            if base != expected_symbol:
                continue
            if not quote_matches(pair, quote_asset):
                continue
            if not is_likely_perpetual_instrument(instrument_id):
                continue
            return exchange, instrument_id or f"{expected_symbol}{quote_asset.upper()}"
    raise ValueError("no supported configured price pair")
