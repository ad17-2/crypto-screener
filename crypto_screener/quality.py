from __future__ import annotations

from typing import Any

from .scoring import pct_change, to_float

DEFAULT_QUALITY_CONFIG = {
    "max_abs_price_change_24h_pct": 300,
    "max_abs_oi_change_24h_pct": 300,
    "max_abs_volume_change_24h_pct": 1000,
    "max_abs_funding_rate_pct": 2,
    "max_price_deviation_from_index_pct": 25,
    "min_quote_volume_usd": 10_000_000,
    "min_coinglass_exchange_count": 2,
}


def apply_data_quality(rows: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    quality_cfg = {**DEFAULT_QUALITY_CONFIG, **config.get("data_quality", {})}
    flagged = 0
    excluded = 0

    for row in rows:
        flags = data_quality_flags(row, quality_cfg)
        row["data_quality_flags"] = flags
        row["is_trusted"] = len(flags) == 0
        row["data_quality_score"] = max(0, 100 - (len(flags) * 25))
        if flags:
            flagged += 1
        if not row["is_trusted"]:
            excluded += 1

    return {
        "status": "ok",
        "rows": len(rows),
        "flagged": flagged,
        "excluded": excluded,
        "note": "rows with critical sanity flags are excluded from factor ranking",
    }


def data_quality_flags(row: dict[str, Any], config: dict[str, Any]) -> list[str]:
    flags: list[str] = []

    _flag_required_text(flags, row, "symbol", "missing_symbol")
    _flag_required_text(flags, row, "contract_symbol", "missing_contract_symbol")
    _flag_contract_symbol(flags, row)
    _flag_positive(flags, row, "price_usd", "invalid_price")
    _flag_minimum(
        flags,
        row,
        "quote_volume_usd",
        config["min_quote_volume_usd"],
        "stale_low_quote_volume",
    )
    _flag_abs_threshold(
        flags,
        row,
        "price_change_24h_pct",
        config["max_abs_price_change_24h_pct"],
        "extreme_24h_price_change",
    )
    _flag_abs_threshold(
        flags,
        row,
        "oi_change_24h_pct",
        config["max_abs_oi_change_24h_pct"],
        "extreme_24h_oi_change",
    )
    _flag_abs_threshold(
        flags,
        row,
        "volume_change_percent_24h",
        config["max_abs_volume_change_24h_pct"],
        "extreme_24h_volume_change",
    )
    _flag_abs_threshold(
        flags,
        row,
        "funding_rate_pct",
        config["max_abs_funding_rate_pct"],
        "extreme_funding_rate",
    )

    open_interest = to_float(row.get("open_interest_usd"))
    if open_interest is not None and open_interest < 0:
        flags.append(f"invalid_open_interest:{open_interest:.2f}")

    index_price = to_float(row.get("index_price"))
    current_price = to_float(row.get("price_usd"))
    index_deviation = pct_change(index_price, current_price)
    if index_deviation is not None and abs(index_deviation) > float(config["max_price_deviation_from_index_pct"]):
        flags.append(f"price_deviates_from_index:{index_deviation:+.2f}%")

    if row.get("data_source") == "coinglass":
        exchange_count = to_float(row.get("coinglass_exchange_count"), 0.0) or 0.0
        if exchange_count < float(config["min_coinglass_exchange_count"]):
            flags.append(f"thin_coinglass_exchange_coverage:{exchange_count:.0f}")

    return flags


def _flag_required_text(flags: list[str], row: dict[str, Any], key: str, label: str) -> None:
    if not str(row.get(key) or "").strip():
        flags.append(label)


def _flag_contract_symbol(flags: list[str], row: dict[str, Any]) -> None:
    symbol = str(row.get("symbol") or "").strip()
    contract_symbol = str(row.get("contract_symbol") or "").strip()
    quote_asset = str(row.get("quote_asset") or "").strip()
    if symbol and not symbol.replace("-", "").isalnum():
        flags.append(f"weird_symbol:{symbol}")
    if contract_symbol and quote_asset and not _contract_symbol_matches_quote(row, contract_symbol, quote_asset):
        flags.append(f"weird_contract_symbol:{contract_symbol}")


def _contract_symbol_matches_quote(row: dict[str, Any], contract_symbol: str, quote_asset: str) -> bool:
    if contract_symbol.endswith(quote_asset):
        return True
    return row.get("data_source") == "coinglass" and quote_asset in contract_symbol.upper()


def _flag_positive(flags: list[str], row: dict[str, Any], key: str, label: str) -> None:
    value = to_float(row.get(key))
    if value is None:
        flags.append(f"{label}:missing")
    elif value <= 0:
        flags.append(f"{label}:{value:.2f}")


def _flag_minimum(
    flags: list[str],
    row: dict[str, Any],
    key: str,
    threshold: float,
    label: str,
) -> None:
    value = to_float(row.get(key))
    if value is None:
        flags.append(f"{label}:missing")
    elif value < float(threshold):
        flags.append(f"{label}:{value:.2f}")


def _flag_abs_threshold(
    flags: list[str],
    row: dict[str, Any],
    key: str,
    threshold: float,
    label: str,
) -> None:
    value = to_float(row.get(key))
    if value is not None and abs(value) > float(threshold):
        flags.append(f"{label}:{value:+.2f}%")
