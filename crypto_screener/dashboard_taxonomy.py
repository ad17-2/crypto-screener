from __future__ import annotations

from typing import Any

from .scoring import to_float

FACTOR_LABELS = {
    "momentum_24h": "Momentum",
    "reversal_1d": "Reversal",
    "oi_price_signal": "OI/Price",
    "funding_rate_contrarian": "Funding",
    "ls_ratio_contrarian": "L/S",
    "liquidation_imbalance": "Liquidations",
    "btc_relative_strength": "BTC Relative",
    "technical_trend_4h": "4h Trend",
    "technical_momentum_4h": "4h Momentum",
    "oi_acceleration_signal": "OI Acceleration",
    "funding_persistence_contrarian": "Funding Persistence",
    "taker_flow_24h": "Taker Flow",
    "liquidation_pressure_24h": "Liq Pressure",
}

SYMBOL_SECTORS = {
    "BTC": "BTC / Store of Value",
    "ETH": "Majors / Smart Contract",
    "SOL": "Majors / Smart Contract",
    "BNB": "Exchange / L1",
    "XRP": "Payments",
    "BCH": "Payments",
    "LTC": "Payments",
    "XLM": "Payments",
    "ADA": "L1 / L0",
    "AVAX": "L1 / L0",
    "DOT": "L1 / L0",
    "ATOM": "L1 / L0",
    "NEAR": "L1 / L0",
    "APT": "L1 / L0",
    "SUI": "L1 / L0",
    "SEI": "L1 / L0",
    "TON": "L1 / L0",
    "ICP": "L1 / L0",
    "KAS": "L1 / L0",
    "ARB": "Layer 2",
    "OP": "Layer 2",
    "STRK": "Layer 2",
    "ZK": "Layer 2",
    "MANTA": "Layer 2",
    "METIS": "Layer 2",
    "MATIC": "Layer 2",
    "POL": "Layer 2",
    "LINK": "Oracle / Data",
    "PYTH": "Oracle / Data",
    "API3": "Oracle / Data",
    "AAVE": "DeFi",
    "UNI": "DeFi",
    "CRV": "DeFi",
    "COMP": "DeFi",
    "MKR": "DeFi",
    "ENA": "DeFi",
    "PENDLE": "DeFi",
    "LDO": "DeFi",
    "RUNE": "DeFi",
    "INJ": "DeFi",
    "JUP": "DeFi",
    "DYDX": "Exchange / Perps",
    "HYPE": "Exchange / Perps",
    "OKB": "Exchange / Perps",
    "BGB": "Exchange / Perps",
    "TAO": "AI / Compute",
    "RENDER": "AI / Compute",
    "RNDR": "AI / Compute",
    "FET": "AI / Compute",
    "OCEAN": "AI / Compute",
    "AGIX": "AI / Compute",
    "WLD": "AI / Compute",
    "ARKM": "AI / Compute",
    "AI": "AI / Compute",
    "GRT": "AI / Compute",
    "AIOZ": "AI / Compute",
    "DOGE": "Meme",
    "SHIB": "Meme",
    "PEPE": "Meme",
    "WIF": "Meme",
    "BONK": "Meme",
    "FLOKI": "Meme",
    "MEME": "Meme",
    "BOME": "Meme",
    "TURBO": "Meme",
    "MOG": "Meme",
    "POPCAT": "Meme",
    "FARTCOIN": "Meme",
    "PENGU": "Meme",
    "IMX": "Gaming / Metaverse",
    "SAND": "Gaming / Metaverse",
    "MANA": "Gaming / Metaverse",
    "AXS": "Gaming / Metaverse",
    "GALA": "Gaming / Metaverse",
    "PIXEL": "Gaming / Metaverse",
    "APE": "Gaming / Metaverse",
    "YGG": "Gaming / Metaverse",
    "ONDO": "RWA",
    "OM": "RWA",
    "CFG": "RWA",
    "HNT": "DePIN",
    "IOTX": "DePIN",
    "AKT": "DePIN",
    "FIL": "DePIN / Storage",
    "AR": "DePIN / Storage",
    "STX": "BTC Ecosystem",
    "ORDI": "BTC Ecosystem",
    "SATS": "BTC Ecosystem",
}


def factor_label(name: str) -> str:
    return FACTOR_LABELS.get(name, name.replace("_", " ").title())


def sector_for_symbol(symbol: Any) -> str:
    raw = str(symbol or "").upper().replace("-", "").replace("_", "")
    if raw.startswith("1000") and len(raw) > 4:
        raw = raw[4:]
    return SYMBOL_SECTORS.get(raw, "Other")


def sector_breadth(rows: list[dict[str, Any]]) -> dict[str, Any]:
    trusted = [row for row in rows if row.get("is_trusted", True)]
    groups: dict[str, dict[str, Any]] = {}
    for row in trusted:
        sector = sector_for_symbol(row.get("symbol"))
        group = groups.setdefault(
            sector,
            {
                "sector": sector,
                "count": 0,
                "advancers": 0,
                "decliners": 0,
                "return_sum": 0.0,
                "return_count": 0,
                "factor_sum": 0.0,
                "factor_count": 0,
                "oi_sum": 0.0,
                "oi_count": 0,
                "symbols": [],
            },
        )
        group["count"] += 1
        symbol = row.get("symbol")
        if symbol:
            group["symbols"].append(str(symbol))
        price_change = to_float(row.get("price_change_24h_pct"))
        if price_change is not None:
            group["return_sum"] += price_change
            group["return_count"] += 1
            if price_change > 0:
                group["advancers"] += 1
            elif price_change < 0:
                group["decliners"] += 1
        factor_score = to_float(row.get("factor_score"))
        if factor_score is not None:
            group["factor_sum"] += factor_score
            group["factor_count"] += 1
        oi_change = to_float(row.get("oi_change_24h_pct"))
        if oi_change is not None:
            group["oi_sum"] += oi_change
            group["oi_count"] += 1

    if not groups:
        return {"status": "empty", "label": "unknown", "groups": []}

    formatted: list[dict[str, Any]] = []
    for group in groups.values():
        return_count = group["return_count"]
        count = group["count"]
        formatted.append(
            {
                "sector": group["sector"],
                "count": count,
                "advancer_pct": round((group["advancers"] / return_count) * 100.0, 1) if return_count else None,
                "avg_return_24h_pct": round(group["return_sum"] / return_count, 3) if return_count else None,
                "avg_factor_score": round(group["factor_sum"] / group["factor_count"], 3)
                if group["factor_count"]
                else None,
                "avg_oi_change_24h_pct": round(group["oi_sum"] / group["oi_count"], 3) if group["oi_count"] else None,
                "symbols": sorted(group["symbols"])[:8],
            }
        )
    formatted.sort(key=lambda item: (item["count"], item.get("avg_return_24h_pct") or 0.0), reverse=True)
    positive_groups = sum(1 for item in formatted if (item.get("avg_return_24h_pct") or 0.0) > 0)
    return {
        "status": "ok",
        "label": _sector_breadth_label(positive_groups, len(formatted)),
        "sample_size": len(trusted),
        "groups": formatted,
        "leaders": sorted(formatted, key=lambda item: item.get("avg_return_24h_pct") or -999.0, reverse=True)[:5],
        "laggards": sorted(formatted, key=lambda item: item.get("avg_return_24h_pct") or 999.0)[:5],
    }


def _sector_breadth_label(positive_groups: int, total_groups: int) -> str:
    if total_groups <= 0:
        return "unknown"
    ratio = positive_groups / total_groups
    if ratio >= 0.70:
        return "broad-sector-bid"
    if ratio <= 0.30:
        return "broad-sector-offer"
    return "mixed-sector-rotation"
