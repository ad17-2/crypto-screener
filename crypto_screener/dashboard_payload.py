from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .factors import DIRECTIONAL_FACTORS, reason_for
from .report import top_by
from .scoring import to_float
from .storage import connect


FACTOR_LABELS = {
    "momentum_24h": "Momentum",
    "reversal_1d": "Reversal",
    "oi_price_signal": "OI/Price",
    "funding_rate_contrarian": "Funding",
    "ls_ratio_contrarian": "L/S",
    "liquidation_imbalance": "Liquidations",
    "btc_relative_strength": "BTC Relative",
}

WATCHLIST_LABELS = {
    "chart_next": "Chart Next",
    "long": "Longs",
    "short": "Shorts",
    "squeeze_risks": "Squeeze Risk",
    "crowded_longs": "Long Fades",
    "core": "Core",
}


def build_dashboard_payload(db_path: Path, run_id: str | None = None, limit: int = 12) -> dict[str, Any]:
    if not db_path.exists():
        return {
            "status": "empty",
            "database": str(db_path),
            "runs": [],
            "refresh_status": None,
        }

    with connect(db_path) as conn:
        runs = _recent_runs(conn)
        selected = _selected_run(conn, run_id)
        if selected is None:
            return {
                "status": "empty",
                "database": str(db_path),
                "runs": runs,
                "refresh_status": None,
            }

        rows = [
            _loads_json(row["row_json"], {})
            for row in conn.execute(
                """
                SELECT row_json
                FROM market_rows
                WHERE run_id = ?
                """,
                (selected["run_id"],),
            ).fetchall()
        ]
        history = _history_by_symbol(
            conn,
            [str(row.get("symbol")) for row in rows if row.get("symbol")],
            selected["generated_at"],
        )

    context = _loads_json(selected["context_json"], {})
    provider_status = _loads_json(selected["provider_status_json"], {})
    regime = _loads_json(selected["regime_json"], {})
    factor_weights = _loads_json(selected["factor_weights_json"], {})
    sections = _sections(rows, limit, history)

    return {
        "status": "ok",
        "database": str(db_path),
        "run": {
            "run_id": selected["run_id"],
            "generated_at": selected["generated_at"],
            "row_count": len(rows),
        },
        "runs": runs,
        "regime": regime,
        "market_context": context,
        "provider_status": provider_status,
        "factor_weights": factor_weights,
        "quality": _quality_summary(rows),
        "sections": sections,
        "watchlists": _watchlists(sections, limit),
    }


def _recent_runs(conn, limit: int = 30) -> list[dict[str, Any]]:
    db_rows = conn.execute(
        """
        SELECT run_id, generated_at, provider_status_json, regime_json
        FROM runs
        ORDER BY generated_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    if not db_rows:
        return []

    run_ids = [row["run_id"] for row in db_rows]
    placeholders = ",".join("?" for _ in run_ids)
    counts = {
        row["run_id"]: row["row_count"]
        for row in conn.execute(
            f"""
            SELECT run_id, COUNT(*) AS row_count
            FROM market_rows
            WHERE run_id IN ({placeholders})
            GROUP BY run_id
            """,
            run_ids,
        ).fetchall()
    }
    flagged: dict[str, int] = {run_id: 0 for run_id in run_ids}
    for row in conn.execute(
        f"""
        SELECT run_id, row_json
        FROM market_rows
        WHERE run_id IN ({placeholders})
        """,
        run_ids,
    ).fetchall():
        item = _loads_json(row["row_json"], {})
        if item.get("data_quality_flags"):
            flagged[row["run_id"]] = flagged.get(row["run_id"], 0) + 1

    runs: list[dict[str, Any]] = []
    for row in db_rows:
        regime = _loads_json(row["regime_json"], {})
        providers = _loads_json(row["provider_status_json"], {})
        runs.append(
            {
                "run_id": row["run_id"],
                "generated_at": row["generated_at"],
                "row_count": counts.get(row["run_id"], 0),
                "excluded_count": flagged.get(row["run_id"], 0),
                "bias": regime.get("bias", "unknown"),
                "factor_regime": regime.get("label", "unknown"),
                "coinglass_status": providers.get("coinglass", {}).get("status", "-"),
            }
        )
    return runs


def _selected_run(conn, run_id: str | None):
    if run_id:
        return conn.execute(
            """
            SELECT run_id, generated_at, context_json, provider_status_json, regime_json, factor_weights_json
            FROM runs
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
    return conn.execute(
        """
        SELECT run_id, generated_at, context_json, provider_status_json, regime_json, factor_weights_json
        FROM runs
        ORDER BY generated_at DESC
        LIMIT 1
        """
    ).fetchone()


def _sections(
    rows: list[dict[str, Any]],
    limit: int,
    history: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    history = history or {}
    core_symbols = ["BTC", "ETH", "SOL"]
    core_by_symbol = {row.get("symbol"): row for row in rows if row.get("symbol") in core_symbols}
    return {
        "core": [
            _dashboard_row(core_by_symbol[symbol], "factor_score", "core", history.get(symbol, []))
            for symbol in core_symbols
            if symbol in core_by_symbol
        ],
        "long": [
            _dashboard_row(row, "long_score", "long", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "long_score", limit, predicate=lambda item: (item.get("factor_score") or 0) > 0)
        ],
        "short": [
            _dashboard_row(row, "short_score", "short", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "short_score", limit, predicate=lambda item: (item.get("factor_score") or 0) < 0)
        ],
        "crowded_longs": [
            _dashboard_row(row, "crowded_long_score", "fade-long", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "crowded_long_score", limit, predicate=_is_crowded_long)
        ],
        "squeeze_risks": [
            _dashboard_row(row, "squeeze_risk_score", "squeeze-risk", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "squeeze_risk_score", limit, predicate=_is_crowded_short)
        ],
    }


def _watchlists(sections: dict[str, list[dict[str, Any]]], limit: int) -> list[dict[str, Any]]:
    chart_next = _chart_next_rows(sections, limit)
    ordered = [
        ("chart_next", chart_next),
        ("long", sections.get("long", [])),
        ("short", sections.get("short", [])),
        ("squeeze_risks", sections.get("squeeze_risks", [])),
        ("crowded_longs", sections.get("crowded_longs", [])),
        ("core", sections.get("core", [])),
    ]
    return [
        {
            "id": key,
            "label": WATCHLIST_LABELS[key],
            "rows": rows,
        }
        for key, rows in ordered
    ]


def _chart_next_rows(sections: dict[str, list[dict[str, Any]]], limit: int) -> list[dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}
    for key in ("long", "short", "squeeze_risks", "crowded_longs", "core"):
        for row in sections.get(key, []):
            symbol = str(row.get("symbol") or "")
            current = candidates.get(symbol)
            if current is None or (row.get("priority") or 0) > (current.get("priority") or 0):
                candidates[symbol] = row
    return sorted(candidates.values(), key=lambda item: item.get("priority") or 0, reverse=True)[: max(limit, 12)]


def _dashboard_row(row: dict[str, Any], score_field: str, side: str, history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    scores = row.get("scores", {})
    factors = row.get("factors", {})
    score = row.get(score_field)
    setup = _setup_label(row, side)
    priority = _chart_priority(row, score_field, score)
    return {
        "symbol": row.get("symbol"),
        "side": side,
        "setup": setup,
        "setup_tone": _setup_tone(side),
        "score_field": score_field,
        "score": score,
        "priority": priority,
        "quality": row.get("data_quality_score", 100),
        "primary_exchange": row.get("primary_exchange"),
        "contract_symbol": row.get("contract_symbol"),
        "price_usd": row.get("price_usd"),
        "price_change_24h_pct": row.get("price_change_24h_pct"),
        "oi_change_24h_pct": row.get("oi_change_24h_pct"),
        "funding_rate_pct": row.get("funding_rate_pct"),
        "long_short_ratio": row.get("long_short_ratio"),
        "quote_volume_usd": row.get("quote_volume_usd"),
        "open_interest_usd": row.get("open_interest_usd"),
        "data_source": row.get("data_source"),
        "is_trusted": row.get("is_trusted", True),
        "data_quality_flags": row.get("data_quality_flags", []),
        "scores": {
            key: scores.get(key)
            for key in ("factor_score", "long_score", "short_score", "crowded_long_score", "squeeze_risk_score")
        },
        "factor_parts": _factor_parts(factors),
        "primary_driver": _primary_driver(factors),
        "history": history or [],
        "reason": reason_for(row, side),
        "reason_parts": _reason_parts(row, side),
    }


def _history_by_symbol(conn, symbols: list[str], generated_at: str, limit: int = 16) -> dict[str, list[dict[str, Any]]]:
    unique_symbols = sorted({symbol for symbol in symbols if symbol})
    if not unique_symbols:
        return {}
    placeholders = ",".join("?" for _ in unique_symbols)
    rows = conn.execute(
        f"""
        SELECT symbol, generated_at, row_json
        FROM market_rows
        WHERE symbol IN ({placeholders})
          AND generated_at <= ?
        ORDER BY symbol ASC, generated_at DESC
        """,
        [*unique_symbols, generated_at],
    ).fetchall()

    by_symbol: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in unique_symbols}
    for db_row in rows:
        symbol = db_row["symbol"]
        if len(by_symbol.get(symbol, [])) >= limit:
            continue
        item = _loads_json(db_row["row_json"], {})
        scores = item.get("scores", {})
        by_symbol.setdefault(symbol, []).append(
            {
                "generated_at": db_row["generated_at"],
                "price_usd": item.get("price_usd"),
                "price_change_24h_pct": item.get("price_change_24h_pct"),
                "oi_change_24h_pct": item.get("oi_change_24h_pct"),
                "funding_rate_pct": item.get("funding_rate_pct"),
                "long_short_ratio": item.get("long_short_ratio"),
                "quote_volume_usd": item.get("quote_volume_usd"),
                "factor_score": scores.get("factor_score"),
                "long_score": scores.get("long_score"),
                "short_score": scores.get("short_score"),
                "crowded_long_score": scores.get("crowded_long_score"),
                "squeeze_risk_score": scores.get("squeeze_risk_score"),
            }
        )
    return {symbol: list(reversed(points)) for symbol, points in by_symbol.items()}


def _setup_label(row: dict[str, Any], side: str) -> str:
    price_change = to_float(row.get("price_change_24h_pct")) or 0.0
    oi_change = to_float(row.get("oi_change_24h_pct")) or 0.0
    funding = to_float(row.get("funding_rate_pct")) or 0.0
    ls_ratio = to_float(row.get("long_short_ratio"))
    if side == "core":
        return "Core Regime Read"
    if side == "fade-long":
        return "Crowded Long Fade"
    if side == "squeeze-risk":
        return "Short Squeeze Risk"
    if side == "long":
        if price_change > 0 and oi_change > 0:
            return "OI Momentum Long"
        if price_change < 0 and oi_change <= 0:
            return "Reversal Long"
        if funding < 0:
            return "Funding Tailwind Long"
        return "Long Candidate"
    if side == "short":
        if price_change < 0 and oi_change > 0:
            return "OI Breakdown Short"
        if price_change > 0 and oi_change <= 0:
            return "Reversal Short"
        if funding > 0.01 or (ls_ratio is not None and ls_ratio > 1.2):
            return "Crowding Short"
        return "Short Candidate"
    return "Watchlist"


def _setup_tone(side: str) -> str:
    if side == "long":
        return "pos"
    if side == "short":
        return "neg"
    if side in {"fade-long", "squeeze-risk"}:
        return "warn"
    return "neutral"


def _chart_priority(row: dict[str, Any], score_field: str, score: Any) -> float:
    numeric_score = abs(to_float(score) or 0.0) * (100.0 if score_field == "factor_score" else 1.0)
    quality = to_float(row.get("data_quality_score"))
    quality_multiplier = max(0.0, min(1.0, (100.0 if quality is None else quality) / 100.0))
    if row.get("is_trusted", True) is False:
        quality_multiplier *= 0.35
    return round(numeric_score * quality_multiplier, 2)


def _factor_parts(factors: dict[str, Any]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    for name in DIRECTIONAL_FACTORS:
        value = to_float(factors.get(name))
        if value is None:
            continue
        parts.append(
            {
                "name": name,
                "label": FACTOR_LABELS.get(name, name.replace("_", " ").title()),
                "value": round(value, 4),
                "tone": _reason_tone(value),
            }
        )
    return sorted(parts, key=lambda item: abs(item["value"]), reverse=True)


def _primary_driver(factors: dict[str, Any]) -> dict[str, Any] | None:
    parts = _factor_parts(factors)
    return parts[0] if parts else None


def _reason_parts(row: dict[str, Any], side: str) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    scores = row.get("scores", {})
    factors = row.get("factors", {})

    _append_reason_metric(
        parts,
        "24h",
        row.get("price_change_24h_pct"),
        "{:+.2f}%",
        "Spot or mark price change over the last 24 hours.",
    )
    _append_reason_metric(
        parts,
        "OI 24h",
        row.get("oi_change_24h_pct"),
        "{:+.2f}%",
        "Open-interest change over the last 24 hours; rising OI means more futures positioning.",
    )
    _append_reason_metric(
        parts,
        "Funding",
        row.get("funding_rate_pct"),
        "{:+.4f}%",
        "Perpetual funding rate; positive usually means longs pay shorts, negative means shorts pay longs.",
    )
    if row.get("long_short_ratio") is not None:
        _append_reason_metric(
            parts,
            "L/S",
            row.get("long_short_ratio"),
            "{:.2f}",
            "Long/short volume ratio; above 1 leans long, below 1 leans short.",
            neutral_value=1.0,
        )
    if scores.get("factor_score") is not None:
        _append_reason_metric(
            parts,
            "Factor",
            scores.get("factor_score"),
            "{:+.2f}",
            "Weighted directional model score before watchlist-specific ranking.",
        )

    strongest = sorted(
        ((name, value) for name, value in factors.items() if name in DIRECTIONAL_FACTORS),
        key=lambda item: abs(item[1]),
        reverse=True,
    )[:2]
    for name, value in strongest:
        if abs(value) >= 0.5:
            parts.append(
                {
                    "kind": "driver",
                    "label": FACTOR_LABELS.get(name, name.replace("_", " ").title()),
                    "value": f"{float(value):+.2f}",
                    "tone": _reason_tone(float(value)),
                    "help": "Normalized factor driver. Larger absolute values contributed more to the setup read.",
                }
            )

    if side == "fade-long":
        parts.append(
            {
                "kind": "context",
                "label": "Crowding",
                "value": "long fade",
                "tone": "warn",
                "help": "Crowded-long watchlist: useful for fade ideas, not automatic shorts.",
            }
        )
    if side == "squeeze-risk":
        parts.append(
            {
                "kind": "context",
                "label": "Crowding",
                "value": "short squeeze",
                "tone": "warn",
                "help": "Crowded-short watchlist: useful for squeeze-risk review, not automatic longs.",
            }
        )

    quality_flags = row.get("data_quality_flags") or []
    if quality_flags:
        parts.append(
            {
                "kind": "quality",
                "label": "Excluded",
                "value": ", ".join(str(flag) for flag in quality_flags),
                "tone": "bad",
                "help": "This row failed sanity checks and is excluded from ranking.",
            }
        )

    return parts


def _append_reason_metric(
    parts: list[dict[str, Any]],
    label: str,
    value: Any,
    template: str,
    help_text: str,
    neutral_value: float = 0.0,
) -> None:
    numeric = to_float(value)
    if numeric is None:
        return
    parts.append(
        {
            "kind": "metric",
            "label": label,
            "value": template.format(numeric),
            "tone": _reason_tone(numeric - neutral_value),
            "help": help_text,
        }
    )


def _reason_tone(value: float) -> str:
    if value > 0:
        return "pos"
    if value < 0:
        return "neg"
    return "neutral"


def _quality_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    flagged = [row for row in rows if row.get("data_quality_flags")]
    trusted = sum(1 for row in rows if row.get("is_trusted", True))
    return {
        "trusted_count": trusted,
        "excluded_count": len(rows) - trusted,
        "flagged_count": len(flagged),
        "flagged_rows": [
            {
                "symbol": row.get("symbol"),
                "data_source": row.get("data_source"),
                "price_change_24h_pct": row.get("price_change_24h_pct"),
                "oi_change_24h_pct": row.get("oi_change_24h_pct"),
                "flags": row.get("data_quality_flags", []),
            }
            for row in flagged[:20]
        ],
    }


def _is_crowded_long(row: dict[str, Any]) -> bool:
    funding = row.get("funding_rate_pct") or 0.0
    ls_ratio = row.get("long_short_ratio")
    return funding > 0.015 or (ls_ratio is not None and ls_ratio >= 1.3)


def _is_crowded_short(row: dict[str, Any]) -> bool:
    funding = row.get("funding_rate_pct") or 0.0
    ls_ratio = row.get("long_short_ratio")
    return funding < -0.015 or (ls_ratio is not None and ls_ratio <= 0.8)


def _loads_json(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def latest_run_generated_at(db_path: Path) -> datetime | None:
    if not db_path.exists():
        return None
    with connect(db_path) as conn:
        row = conn.execute("SELECT generated_at FROM runs ORDER BY generated_at DESC LIMIT 1").fetchone()
    if row is None:
        return None
    try:
        generated_at = datetime.fromisoformat(row["generated_at"])
    except ValueError:
        return None
    if generated_at.tzinfo is None:
        generated_at = generated_at.replace(tzinfo=timezone.utc)
    return generated_at


def latest_run_age_seconds(db_path: Path) -> float | None:
    generated_at = latest_run_generated_at(db_path)
    if generated_at is None:
        return None
    return max(0.0, (datetime.now(generated_at.tzinfo) - generated_at).total_seconds())
