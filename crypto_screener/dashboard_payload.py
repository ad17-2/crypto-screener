from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .dashboard_freshness import freshness_summary, latest_run_age_seconds, latest_run_generated_at
from .dashboard_rows import dashboard_row
from .dashboard_taxonomy import factor_label
from .scoring import to_float
from .storage import connect
from .watchlists import (
    WATCHLIST_LABELS,
    is_crowded_long,
    is_crowded_short,
    is_long_candidate,
    is_short_candidate,
    top_by,
)

__all__ = ["build_dashboard_payload", "latest_run_age_seconds", "latest_run_generated_at"]


def build_dashboard_payload(db_path: Path, run_id: str | None = None, limit: int = 12) -> dict[str, Any]:
    if not db_path.exists():
        return {
            "status": "empty",
            "database": str(db_path),
            "runs": [],
            "refresh_status": None,
        }

    conn = connect(db_path)
    try:
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
    finally:
        conn.close()

    context = _loads_json(selected["context_json"], {})
    provider_status = _loads_json(selected["provider_status_json"], {})
    regime = _loads_json(selected["regime_json"], {})
    factor_weights = _loads_json(selected["factor_weights_json"], {})
    sections = _sections(rows, limit, history, regime)
    freshness = freshness_summary(selected["generated_at"])

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
        "model_weights": _model_weights_summary(factor_weights),
        "validation": _validation_summary(factor_weights.get("validation", {}), rows, sections),
        "freshness": freshness,
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
    regime: dict[str, Any] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    history = history or {}
    regime = regime or {}
    core_symbols = ["BTC", "ETH", "SOL"]
    core_by_symbol = {row.get("symbol"): row for row in rows if row.get("symbol") in core_symbols}
    return {
        "core": [
            dashboard_row(core_by_symbol[symbol], "factor_score", "core", history.get(symbol, []))
            for symbol in core_symbols
            if symbol in core_by_symbol
        ],
        "long": [
            dashboard_row(row, "long_score", "long", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "long_score", limit, predicate=is_long_candidate)
        ],
        "regime_fit": _regime_fit_rows(rows, limit, history, regime),
        "short": [
            dashboard_row(row, "short_score", "short", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "short_score", limit, predicate=is_short_candidate)
        ],
        "crowded_longs": [
            dashboard_row(row, "crowded_long_score", "fade-long", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "crowded_long_score", limit, predicate=is_crowded_long)
        ],
        "squeeze_risks": [
            dashboard_row(row, "squeeze_risk_score", "squeeze-risk", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "squeeze_risk_score", limit, predicate=is_crowded_short)
        ],
    }


def _watchlists(sections: dict[str, list[dict[str, Any]]], limit: int) -> list[dict[str, Any]]:
    chart_next = _chart_next_rows(sections, limit)
    ordered = [
        ("chart_next", chart_next),
        ("regime_fit", sections.get("regime_fit", [])),
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
    for key in ("regime_fit", "long", "short", "squeeze_risks", "crowded_longs", "core"):
        for row in sections.get(key, []):
            symbol = str(row.get("symbol") or "")
            current = candidates.get(symbol)
            if current is None or (row.get("priority") or 0) > (current.get("priority") or 0):
                candidates[symbol] = row
    return sorted(candidates.values(), key=lambda item: item.get("priority") or 0, reverse=True)[: max(limit, 12)]


def _regime_fit_rows(
    rows: list[dict[str, Any]],
    limit: int,
    history: dict[str, list[dict[str, Any]]],
    regime: dict[str, Any],
) -> list[dict[str, Any]]:
    ranked: list[tuple[float, dict[str, Any], str]] = []
    for row in rows:
        if row.get("is_trusted", True) is False:
            continue
        score_field, side = _regime_fit_score_field(row, regime)
        factor_score = to_float(row.get("factor_score"), 0.0) or 0.0
        if side == "long" and factor_score <= 0:
            continue
        if side == "short" and factor_score >= 0:
            continue
        base_score = to_float(row.get(score_field), 0.0) or 0.0
        if base_score <= 0:
            continue
        conflict_score = to_float(row.get("signal_conflict_score"), 0.0) or 0.0
        if str(row.get("signal_conflict_label") or "") == "high-conflict" and conflict_score >= 70:
            continue
        confidence = to_float(row.get("confidence_score"), 0.0) or 0.0
        quality = to_float(row.get("data_quality_score"), 100.0) or 100.0
        regime_alignment = to_float(row.get("regime_alignment_score"), 0.0) or 0.0
        breadth_alignment = to_float(row.get("breadth_alignment_score"), 0.0) or 0.0
        fit_score = (
            base_score
            + max(0.0, regime_alignment) * 8.0
            + max(0.0, breadth_alignment) * 6.0
            + confidence * 0.18
            + quality * 0.05
            - conflict_score * 0.22
        )
        ranked.append((fit_score, row, side))

    selected: list[dict[str, Any]] = []
    for fit_score, row, side in sorted(ranked, key=lambda item: item[0], reverse=True)[:limit]:
        item = dict(row)
        item["regime_fit_score"] = round(max(0.0, fit_score), 2)
        selected.append(
            dashboard_row(
                item,
                "regime_fit_score",
                side,
                history.get(str(row.get("symbol")), []),
            )
        )
    return selected


def _regime_fit_score_field(row: dict[str, Any], regime: dict[str, Any]) -> tuple[str, str]:
    bias = str(regime.get("bias") or "mixed")
    label = str(regime.get("label") or "mixed")
    factor_score = to_float(row.get("factor_score"), 0.0) or 0.0
    if label == "crowding-contrarian":
        crowded_score = to_float(row.get("crowded_long_score"), 0.0) or 0.0
        squeeze_score = to_float(row.get("squeeze_risk_score"), 0.0) or 0.0
        if crowded_score >= squeeze_score:
            return "crowded_long_score", "fade-long"
        return "squeeze_risk_score", "squeeze-risk"
    if bias == "risk-off":
        return "short_score", "short"
    if bias == "risk-on":
        return "long_score", "long"
    if factor_score < 0:
        return "short_score", "short"
    return "long_score", "long"


def _validation_summary(
    validation: dict[str, Any],
    rows: list[dict[str, Any]],
    sections: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    summary = dict(validation or {})
    model = dict(summary.get("model") or {})
    factors = dict(summary.get("factors") or {})
    hit_rate = to_float(model.get("hit_rate"))
    observations = int(to_float(summary.get("observations"), 0.0) or 0)
    summary["model"] = model
    summary["factors"] = factors
    summary["model_hit_rate"] = hit_rate
    summary["model_avg_forward_return_pct"] = to_float(model.get("avg_forward_return_pct"))
    summary["calibration_label"] = _calibration_label(hit_rate, observations)
    summary["best_factors"] = _rank_validation_factors(factors, reverse=True)
    summary["weakest_factors"] = _rank_validation_factors(factors, reverse=False)
    summary["conflict_buckets"] = _conflict_buckets(rows)
    summary["watchlist_counts"] = {
        key: len(value)
        for key, value in sections.items()
        if key in {"regime_fit", "long", "short", "squeeze_risks", "crowded_longs", "core"}
    }
    return summary


def _calibration_label(hit_rate: float | None, observations: int) -> str:
    if observations < 20 or hit_rate is None:
        return "learning"
    if hit_rate >= 58.0:
        return "useful"
    if hit_rate >= 50.0:
        return "neutral"
    return "weak"


def _model_weights_summary(factor_weights: dict[str, Any]) -> dict[str, Any]:
    stats = factor_weights.get("stats", {}) or {}
    factors: list[dict[str, Any]] = []
    for name, details in stats.items():
        if not isinstance(details, dict):
            continue
        factors.append(
            {
                "name": name,
                "label": factor_label(name),
                "weight": to_float(details.get("weight")),
                "base_weight": to_float(details.get("base_weight")),
                "mode": details.get("mode"),
                "ic": to_float(details.get("ic")),
                "t_stat": to_float(details.get("t_stat")),
                "n_periods": int(to_float(details.get("n_periods"), 0) or 0),
                "credibility_k": to_float(details.get("credibility_k")),
                "regime_multiplier": to_float(details.get("regime_multiplier")),
            }
        )
    factors.sort(key=lambda item: abs(item.get("weight") or 0), reverse=True)
    return {
        "mode": factor_weights.get("mode"),
        "regime": factor_weights.get("regime_adjustment", {}) or {},
        "factors": factors,
    }


def _rank_validation_factors(factors: dict[str, Any], reverse: bool) -> list[dict[str, Any]]:
    ranked: list[dict[str, Any]] = []
    for name, details in factors.items():
        if not isinstance(details, dict):
            continue
        hit_rate = to_float(details.get("hit_rate"))
        observations = int(to_float(details.get("observations"), 0.0) or 0)
        if hit_rate is None or observations <= 0:
            continue
        ranked.append(
            {
                "name": name,
                "label": factor_label(name),
                "hit_rate": round(hit_rate, 2),
                "observations": observations,
                "avg_forward_return_pct": to_float(details.get("avg_forward_return_pct")),
            }
        )
    return sorted(ranked, key=lambda item: (item["hit_rate"], item["observations"]), reverse=reverse)[:3]


def _conflict_buckets(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for row in rows:
        label = str(row.get("signal_conflict_label") or "unknown")
        bucket = buckets.setdefault(label, {"label": label, "count": 0, "avg_confidence": 0.0})
        bucket["count"] += 1
        bucket["avg_confidence"] += to_float(row.get("confidence_score"), 0.0) or 0.0
    result: list[dict[str, Any]] = []
    for bucket in buckets.values():
        count = bucket["count"]
        result.append(
            {
                "label": bucket["label"],
                "count": count,
                "avg_confidence": round(bucket["avg_confidence"] / count, 1) if count else None,
            }
        )
    return sorted(result, key=lambda item: item["count"], reverse=True)


def _history_by_symbol(conn, symbols: list[str], generated_at: str, limit: int = 16) -> dict[str, list[dict[str, Any]]]:
    unique_symbols = sorted({symbol for symbol in symbols if symbol})
    if not unique_symbols:
        return {}
    placeholders = ",".join("?" for _ in unique_symbols)
    rows = conn.execute(
        f"""
        SELECT symbol, generated_at, price_usd, factors_json, scores_json, metrics_json
        FROM factor_history
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
        item = _loads_json(db_row["metrics_json"], {})
        factors = _loads_json(db_row["factors_json"], {})
        scores = _loads_json(db_row["scores_json"], {})
        by_symbol.setdefault(symbol, []).append(
            {
                "generated_at": db_row["generated_at"],
                "price_usd": db_row["price_usd"],
                "price_change_24h_pct": item.get("price_change_24h_pct"),
                "oi_change_24h_pct": item.get("oi_change_24h_pct"),
                "funding_rate_pct": item.get("funding_rate_pct"),
                "long_short_ratio": item.get("long_short_ratio"),
                "long_short_account_ratio": item.get("long_short_account_ratio"),
                "top_trader_long_short_ratio": item.get("top_trader_long_short_ratio"),
                "quote_volume_usd": item.get("quote_volume_usd"),
                "confidence_score": scores.get("confidence_score") or item.get("confidence_score"),
                "technical_trend_4h": factors.get("technical_trend_4h"),
                "technical_momentum_4h": factors.get("technical_momentum_4h"),
                "rsi_14": item.get("rsi_14"),
                "factor_score": scores.get("factor_score"),
                "long_score": scores.get("long_score"),
                "short_score": scores.get("short_score"),
                "crowded_long_score": scores.get("crowded_long_score"),
                "squeeze_risk_score": scores.get("squeeze_risk_score"),
                "signal_conflict_score": scores.get("signal_conflict_score") or item.get("signal_conflict_score"),
            }
        )
    if not any(by_symbol.values()):
        return _legacy_history_by_symbol(conn, unique_symbols, generated_at, limit)
    return {symbol: list(reversed(points)) for symbol, points in by_symbol.items()}


def _legacy_history_by_symbol(
    conn,
    symbols: list[str],
    generated_at: str,
    limit: int,
) -> dict[str, list[dict[str, Any]]]:
    placeholders = ",".join("?" for _ in symbols)
    rows = conn.execute(
        f"""
        SELECT symbol, generated_at, row_json
        FROM market_rows
        WHERE symbol IN ({placeholders})
          AND generated_at <= ?
        ORDER BY symbol ASC, generated_at DESC
        """,
        [*symbols, generated_at],
    ).fetchall()

    by_symbol: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in symbols}
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
                "long_short_account_ratio": item.get("long_short_account_ratio"),
                "top_trader_long_short_ratio": item.get("top_trader_long_short_ratio"),
                "quote_volume_usd": item.get("quote_volume_usd"),
                "confidence_score": scores.get("confidence_score"),
                "factor_score": scores.get("factor_score"),
                "long_score": scores.get("long_score"),
                "short_score": scores.get("short_score"),
                "crowded_long_score": scores.get("crowded_long_score"),
                "squeeze_risk_score": scores.get("squeeze_risk_score"),
            }
        )
    return {symbol: list(reversed(points)) for symbol, points in by_symbol.items()}


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


def _loads_json(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default
