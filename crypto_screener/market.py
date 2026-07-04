from __future__ import annotations

from typing import Any

from .scoring import clamp, to_float


def market_structure_summary(rows: list[dict[str, Any]], market_context: dict[str, Any]) -> dict[str, Any]:
    trusted_rows = [row for row in rows if row.get("is_trusted", True)]
    breadth = breadth_summary(trusted_rows, market_context)
    sector_rotation = sector_rotation_summary(market_context)
    return {
        "breadth": breadth,
        "sector_rotation": sector_rotation,
    }


def breadth_summary(rows: list[dict[str, Any]], market_context: dict[str, Any]) -> dict[str, Any]:
    price_changes = [value for value in (to_float(row.get("price_change_24h_pct")) for row in rows) if value is not None]
    oi_changes = [value for value in (to_float(row.get("oi_change_24h_pct")) for row in rows) if value is not None]
    funding_values = [value for value in (to_float(row.get("funding_rate_pct")) for row in rows) if value is not None]
    weighted_return = _volume_weighted_return(rows)
    category_score = _category_momentum_score(market_context)

    if not price_changes:
        return {
            "status": "empty",
            "label": "unknown",
            "score": 0.0,
            "advancers": 0,
            "decliners": 0,
            "sample_size": 0,
        }

    advancers = sum(1 for value in price_changes if value > 0)
    decliners = sum(1 for value in price_changes if value < 0)
    unchanged = len(price_changes) - advancers - decliners
    advancer_pct = (advancers / len(price_changes)) * 100.0
    decliner_pct = (decliners / len(price_changes)) * 100.0
    price_breadth_score = ((advancer_pct - decliner_pct) / 100.0)
    avg_return = sum(price_changes) / len(price_changes)
    avg_return_score = clamp(avg_return / 4.0, -1.0, 1.0)
    weighted_return_score = clamp((weighted_return if weighted_return is not None else avg_return) / 4.0, -1.0, 1.0)

    oi_expanders = sum(1 for value in oi_changes if value > 0)
    oi_expander_pct = (oi_expanders / len(oi_changes)) * 100.0 if oi_changes else None
    oi_confirmation_score = 0.0
    if oi_expander_pct is not None:
        oi_confirmation_score = price_breadth_score * clamp((oi_expander_pct - 50.0) / 50.0, -1.0, 1.0)

    score_parts = [
        price_breadth_score * 0.40,
        avg_return_score * 0.18,
        weighted_return_score * 0.18,
        oi_confirmation_score * 0.10,
    ]
    if category_score is not None:
        score_parts.append(category_score * 0.14)
    score = clamp(sum(score_parts), -1.0, 1.0)

    return {
        "status": "ok",
        "label": _breadth_label(score, advancer_pct),
        "score": round(score, 3),
        "advancers": advancers,
        "decliners": decliners,
        "unchanged": unchanged,
        "sample_size": len(price_changes),
        "advancer_pct": round(advancer_pct, 2),
        "decliner_pct": round(decliner_pct, 2),
        "avg_return_24h_pct": round(avg_return, 3),
        "volume_weighted_return_24h_pct": round(weighted_return, 3) if weighted_return is not None else None,
        "oi_expander_pct": round(oi_expander_pct, 2) if oi_expander_pct is not None else None,
        "avg_funding_rate_pct": round(sum(funding_values) / len(funding_values), 5) if funding_values else None,
        "category_momentum_score": round(category_score, 3) if category_score is not None else None,
    }


def sector_rotation_summary(market_context: dict[str, Any]) -> dict[str, Any]:
    categories = market_context.get("categories", {})
    leaders = categories.get("leaders", []) or []
    laggards = categories.get("laggards", []) or []
    leader_values = _category_changes(leaders[:5])
    laggard_values = _category_changes(laggards[:5])
    if not leader_values and not laggard_values:
        return {"status": "empty", "label": "unknown"}

    leader_avg = sum(leader_values) / len(leader_values) if leader_values else None
    laggard_avg = sum(laggard_values) / len(laggard_values) if laggard_values else None
    spread = (leader_avg - laggard_avg) if leader_avg is not None and laggard_avg is not None else None
    combined = leader_values + laggard_values
    positive_pct = (sum(1 for value in combined if value > 0) / len(combined)) * 100.0 if combined else None

    return {
        "status": "ok",
        "label": _sector_label(leader_avg, laggard_avg, positive_pct),
        "leader_avg_24h_pct": round(leader_avg, 3) if leader_avg is not None else None,
        "laggard_avg_24h_pct": round(laggard_avg, 3) if laggard_avg is not None else None,
        "leader_laggard_spread_pct": round(spread, 3) if spread is not None else None,
        "positive_category_pct": round(positive_pct, 2) if positive_pct is not None else None,
    }


def _volume_weighted_return(rows: list[dict[str, Any]]) -> float | None:
    weighted_sum = 0.0
    total_volume = 0.0
    for row in rows:
        change = to_float(row.get("price_change_24h_pct"))
        volume = to_float(row.get("quote_volume_usd"), 0.0) or 0.0
        if change is None or volume <= 0:
            continue
        weighted_sum += change * volume
        total_volume += volume
    return weighted_sum / total_volume if total_volume > 0 else None


def _category_momentum_score(market_context: dict[str, Any]) -> float | None:
    categories = market_context.get("categories", {})
    values = _category_changes((categories.get("leaders", []) or [])[:5])
    values.extend(_category_changes((categories.get("laggards", []) or [])[:5]))
    if not values:
        return None
    avg = sum(values) / len(values)
    return clamp(avg / 4.0, -1.0, 1.0)


def _category_changes(categories: list[dict[str, Any]]) -> list[float]:
    return [
        value
        for value in (to_float(item.get("market_cap_change_24h_pct")) for item in categories)
        if value is not None
    ]


def _breadth_label(score: float, advancer_pct: float) -> str:
    if score >= 0.35 and advancer_pct >= 60.0:
        return "broad-risk-on"
    if score >= 0.15:
        return "selective-risk-on"
    if score <= -0.35 and advancer_pct <= 40.0:
        return "broad-risk-off"
    if score <= -0.15:
        return "selective-risk-off"
    return "mixed"


def _sector_label(leader_avg: float | None, laggard_avg: float | None, positive_pct: float | None) -> str:
    if positive_pct is not None and positive_pct >= 70.0:
        return "broad-sector-bid"
    if positive_pct is not None and positive_pct <= 30.0:
        return "broad-sector-offer"
    if leader_avg is not None and leader_avg > 1.0 and laggard_avg is not None and laggard_avg < -1.0:
        return "rotation-dispersed"
    if leader_avg is not None and leader_avg > 0:
        return "selective-sector-bid"
    if laggard_avg is not None and laggard_avg < 0:
        return "selective-sector-offer"
    return "mixed"
