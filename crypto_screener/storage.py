from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .scoring import to_float

_STORAGE_TZ = ZoneInfo("Asia/Jakarta")


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            generated_at TEXT NOT NULL,
            config_json TEXT NOT NULL,
            context_json TEXT NOT NULL,
            provider_status_json TEXT NOT NULL,
            regime_json TEXT NOT NULL DEFAULT '{}',
            factor_weights_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS market_rows (
            run_id TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            symbol TEXT NOT NULL,
            price_usd REAL,
            factors_json TEXT NOT NULL,
            scores_json TEXT NOT NULL,
            row_json TEXT NOT NULL,
            PRIMARY KEY (run_id, symbol),
            FOREIGN KEY (run_id) REFERENCES runs(run_id)
        );

        CREATE INDEX IF NOT EXISTS idx_market_rows_symbol_time
            ON market_rows(symbol, generated_at);
        CREATE INDEX IF NOT EXISTS idx_market_rows_time
            ON market_rows(generated_at);

        CREATE TABLE IF NOT EXISTS factor_history (
            run_id TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            symbol TEXT NOT NULL,
            price_usd REAL,
            factors_json TEXT NOT NULL,
            scores_json TEXT NOT NULL DEFAULT '{}',
            metrics_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (run_id, symbol)
        );

        CREATE INDEX IF NOT EXISTS idx_factor_history_symbol_time
            ON factor_history(symbol, generated_at);
        CREATE INDEX IF NOT EXISTS idx_factor_history_time
            ON factor_history(generated_at);

        CREATE TABLE IF NOT EXISTS market_regime_history (
            run_id TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            btc_dominance_pct REAL,
            eth_btc_performance_pct REAL,
            regime_state TEXT,
            regime_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_market_regime_history_time
            ON market_regime_history(generated_at);
        """
    )
    _ensure_column(conn, "runs", "regime_json", "TEXT NOT NULL DEFAULT '{}'")
    _ensure_column(conn, "runs", "factor_weights_json", "TEXT NOT NULL DEFAULT '{}'")
    conn.commit()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def save_snapshot(payload: dict[str, Any], config: dict[str, Any]) -> None:
    db_path = Path(config.get("storage_path", "data/crypto_screener.sqlite3"))
    conn = connect(db_path)
    try:
        run_id = payload["run_id"]
        generated_at = payload["generated_at"]
        conn.execute(
            """
            INSERT OR REPLACE INTO runs
                (
                    run_id,
                    generated_at,
                    config_json,
                    context_json,
                    provider_status_json,
                    regime_json,
                    factor_weights_json
                )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                generated_at,
                json.dumps(config, sort_keys=True),
                json.dumps(payload.get("market_context", {}), sort_keys=True),
                json.dumps(payload.get("provider_status", {}), sort_keys=True),
                json.dumps(payload.get("regime", {}), sort_keys=True),
                json.dumps(payload.get("factor_weights", {}), sort_keys=True),
            ),
        )
        for row in payload.get("rows", []):
            conn.execute(
                """
                INSERT OR REPLACE INTO market_rows
                    (run_id, generated_at, symbol, price_usd, factors_json, scores_json, row_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    generated_at,
                    row.get("symbol"),
                    row.get("price_usd"),
                    json.dumps(row.get("factors", {}), sort_keys=True),
                    json.dumps(row.get("scores", {}), sort_keys=True),
                    json.dumps(row, sort_keys=True),
                ),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO factor_history
                    (run_id, generated_at, symbol, price_usd, factors_json, scores_json, metrics_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    generated_at,
                    row.get("symbol"),
                    row.get("price_usd"),
                    json.dumps(row.get("factors", {}), sort_keys=True),
                    json.dumps(row.get("scores", {}), sort_keys=True),
                    json.dumps(_history_metrics(row), sort_keys=True),
                ),
            )
        _persist_market_regime_history(conn, payload)
        conn.commit()
    finally:
        conn.close()


def save_factor_history_records(records: list[dict[str, Any]], config: dict[str, Any]) -> int:
    db_path = Path(config.get("storage_path", "data/crypto_screener.sqlite3"))
    if not records:
        return 0

    conn = connect(db_path)
    try:
        for row in records:
            conn.execute(
                """
                INSERT OR REPLACE INTO factor_history
                    (run_id, generated_at, symbol, price_usd, factors_json, scores_json, metrics_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["run_id"],
                    row["generated_at"],
                    row.get("symbol"),
                    row.get("price_usd"),
                    json.dumps(row.get("factors", {}), sort_keys=True),
                    json.dumps(row.get("scores", {}), sort_keys=True),
                    json.dumps(_history_metrics(row), sort_keys=True),
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return len(records)


def prune_old_runs(db_path: Path, keep: int) -> dict[str, int]:
    if keep <= 0 or not db_path.exists():
        return {"kept_runs": 0, "deleted_runs": 0, "deleted_rows": 0}

    conn = connect(db_path)
    try:
        keep_rows = conn.execute(
            """
            SELECT run_id
            FROM runs
            ORDER BY generated_at DESC
            LIMIT ?
            """,
            (keep,),
        ).fetchall()
        keep_run_ids = [row["run_id"] for row in keep_rows]
        total_runs = conn.execute("SELECT COUNT(*) AS count FROM runs").fetchone()["count"]
        if total_runs <= len(keep_run_ids):
            return {"kept_runs": len(keep_run_ids), "deleted_runs": 0, "deleted_rows": 0}

        placeholders = ",".join("?" for _ in keep_run_ids)
        row_delete = conn.execute(
            f"DELETE FROM market_rows WHERE run_id NOT IN ({placeholders})",
            keep_run_ids,
        )
        run_delete = conn.execute(
            f"DELETE FROM runs WHERE run_id NOT IN ({placeholders})",
            keep_run_ids,
        )
        conn.commit()
        return {
            "kept_runs": len(keep_run_ids),
            "deleted_runs": run_delete.rowcount,
            "deleted_rows": row_delete.rowcount,
        }
    finally:
        conn.close()


def load_regime_states(config: dict[str, Any]) -> dict[str, str]:
    db_path = Path(config.get("storage_path", "data/crypto_screener.sqlite3"))
    if not db_path.exists():
        return {}

    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT generated_at, regime_state
            FROM market_regime_history
            WHERE regime_state IS NOT NULL
            """
        ).fetchall()
    finally:
        conn.close()
    return {row["generated_at"]: row["regime_state"] for row in rows}


def load_labeled_factor_records(config: dict[str, Any]) -> list[dict[str, Any]]:
    factor_cfg = config.get("factors", {})
    horizon_hours = float(factor_cfg.get("forward_return_hours", 24))
    by_symbol = _labeling_rows_by_symbol(config)
    records = _labeled_records_for_horizon(by_symbol, horizon_hours)
    regime_map = load_regime_states(config)
    for record in records:
        record["regime"] = regime_map.get(record["generated_at"])
    return records


def load_labeled_records_by_horizon(
    config: dict[str, Any],
    horizons: list[float],
) -> dict[float, list[dict[str, Any]]]:
    by_symbol = _labeling_rows_by_symbol(config)
    return {horizon: _labeled_records_for_horizon(by_symbol, horizon) for horizon in horizons}


def _labeling_rows_by_symbol(config: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    db_path = Path(config.get("storage_path", "data/crypto_screener.sqlite3"))
    if not db_path.exists():
        return {}

    factor_cfg = config.get("factors", {})
    window_days = int(factor_cfg.get("ic_window_days", 30))
    cutoff = datetime.now().astimezone() - timedelta(days=window_days + 3)

    conn = connect(db_path)
    try:
        rows = _load_factor_history_rows(conn, cutoff.isoformat(timespec="seconds"))
        if not rows:
            rows = conn.execute(
                """
                SELECT generated_at, symbol, price_usd, factors_json, scores_json
                FROM market_rows
                WHERE generated_at >= ?
                ORDER BY generated_at ASC
                """,
                (cutoff.isoformat(timespec="seconds"),),
            ).fetchall()
    finally:
        conn.close()

    by_symbol: dict[str, list[dict[str, Any]]] = {}
    for db_row in rows:
        price = db_row["price_usd"]
        if price is None or price <= 0:
            continue
        row_keys = set(db_row.keys())
        item = {
            "generated_at": datetime.fromisoformat(db_row["generated_at"]),
            "symbol": db_row["symbol"],
            "price_usd": float(price),
            "factors": json.loads(db_row["factors_json"]),
            "scores": json.loads(db_row["scores_json"] or "{}") if "scores_json" in row_keys else {},
        }
        by_symbol.setdefault(item["symbol"], []).append(item)
    return by_symbol


def _labeled_records_for_horizon(
    by_symbol: dict[str, list[dict[str, Any]]],
    horizon_hours: float,
) -> list[dict[str, Any]]:
    min_target_hours, max_target_hours = _horizon_tolerance(horizon_hours)
    records: list[dict[str, Any]] = []
    for symbol_rows in by_symbol.values():
        for index, current in enumerate(symbol_rows):
            target = _find_forward_row(
                symbol_rows[index + 1 :],
                current["generated_at"],
                min_target_hours,
                max_target_hours,
            )
            if not target:
                continue
            forward_return = ((target["price_usd"] - current["price_usd"]) / current["price_usd"]) * 100.0
            records.append(
                {
                    "symbol": current["symbol"],
                    "generated_at": current["generated_at"].isoformat(timespec="seconds"),
                    "forward_return_pct": forward_return,
                    "factors": current["factors"],
                }
            )
    return records


def load_latest_regime_state(db_path_or_conn: Path | str | sqlite3.Connection) -> dict[str, Any] | None:
    should_close = False
    if isinstance(db_path_or_conn, sqlite3.Connection):
        conn = db_path_or_conn
    else:
        db_path = Path(db_path_or_conn)
        if not db_path.exists():
            return None
        conn = connect(db_path)
        should_close = True
    try:
        row = conn.execute(
            """
            SELECT btc_dominance_pct, eth_btc_performance_pct, regime_state, regime_json
            FROM market_regime_history
            ORDER BY generated_at DESC
            LIMIT 1
            """
        ).fetchone()
        if row is None:
            return None
        return {
            "btc_dominance_pct": row["btc_dominance_pct"],
            "eth_btc_performance_pct": row["eth_btc_performance_pct"],
            "regime_state": row["regime_state"],
        }
    finally:
        if should_close:
            conn.close()


def _persist_market_regime_history(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    regime = payload.get("regime", {})
    market_context = payload.get("market_context", {})
    conn.execute(
        """
        INSERT INTO market_regime_history
            (run_id, generated_at, btc_dominance_pct, eth_btc_performance_pct, regime_state, regime_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            payload["run_id"],
            payload["generated_at"],
            to_float(market_context.get("btc_dominance_pct")),
            to_float(market_context.get("eth_btc_performance_pct") or regime.get("eth_btc_performance_pct")),
            regime.get("regime_state") or regime.get("label"),
            json.dumps(regime, sort_keys=True),
        ),
    )


def _history_metrics(row: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "price_change_24h_pct",
        "oi_change_24h_pct",
        "funding_rate_pct",
        "long_short_ratio",
        "long_short_account_ratio",
        "top_trader_long_short_ratio",
        "quote_volume_usd",
        "open_interest_usd",
        "confidence_score",
        "technical_setup",
        "technical_interval",
        "derivatives_interval",
        "rsi_14",
        "macd_histogram_pct",
        "atr_14_pct",
        "bb_position",
        "bb_width_pct",
        "distance_ema20_pct",
        "technical_trend_score",
        "technical_momentum_score",
        "oi_change_4h_pct_history",
        "oi_change_24h_pct_history",
        "oi_acceleration_4h_pct",
        "oi_zscore_30",
        "funding_avg_24h_pct",
        "funding_abs_avg_24h_pct",
        "funding_persistence_24h",
        "long_liquidation_usd_24h_history",
        "short_liquidation_usd_24h_history",
        "liquidation_total_24h_usd",
        "liquidation_imbalance_24h_pct",
        "taker_buy_volume_usd_24h",
        "taker_sell_volume_usd_24h",
        "taker_buy_sell_ratio_24h",
        "taker_imbalance_24h_pct",
        "derivatives_confirmation_score",
        "signal_conflict_label",
        "signal_conflict_score",
        "regime_alignment_score",
        "breadth_alignment_score",
    ]
    return {key: row.get(key) for key in keys if row.get(key) is not None}


def _load_factor_history_rows(conn: sqlite3.Connection, cutoff: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT generated_at, symbol, price_usd, factors_json, scores_json
        FROM factor_history
        WHERE generated_at >= ?
        ORDER BY generated_at ASC
        """,
        (cutoff,),
    ).fetchall()


def _find_forward_row(
    candidates: list[dict[str, Any]],
    generated_at: datetime,
    min_target_hours: float,
    max_target_hours: float,
) -> dict[str, Any] | None:
    items: list[tuple[dict[str, Any], float]] = []
    for candidate in candidates:
        delta_hours = (candidate["generated_at"] - generated_at).total_seconds() / 3600.0
        if delta_hours < min_target_hours:
            continue
        if delta_hours > max_target_hours:
            break
        items.append((candidate, delta_hours))
    # Midpoint target preserved for forward-return continuity (pre-existing behavior).
    forward_target_hours = (min_target_hours + max_target_hours) / 2.0
    return _select_horizon_match(items, min_target_hours, max_target_hours, forward_target_hours)


def _horizon_tolerance(hours: float) -> tuple[float, float]:
    return hours * 0.75, hours * 1.5


def _select_horizon_match(
    items: list[tuple[dict[str, Any], float]],
    min_target_hours: float,
    max_target_hours: float,
    target_hours: float,
) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    best_distance: float | None = None
    for row, delta_hours in items:
        if delta_hours < min_target_hours:
            continue
        if delta_hours > max_target_hours:
            continue
        distance = abs(delta_hours - target_hours)
        if best is None or best_distance is None or distance < best_distance:
            best = row
            best_distance = distance
    return best


def load_price_lookback(config: dict[str, Any], hours: float) -> dict[str, float]:
    db_path = Path(config.get("storage_path", "data/crypto_screener.sqlite3"))
    if not db_path.exists():
        return {}

    reference_at = datetime.now().astimezone()
    min_target_hours, max_target_hours = _horizon_tolerance(hours)
    # generated_at is stored in Asia/Jakarta; ISO string SQL bounds must use the same offset.
    cutoff = (
        (reference_at - timedelta(hours=max_target_hours * 1.25)).astimezone(_STORAGE_TZ).isoformat(timespec="seconds")
    )
    reference_iso = reference_at.astimezone(_STORAGE_TZ).isoformat(timespec="seconds")

    conn = connect(db_path)
    try:
        db_rows = conn.execute(
            """
            SELECT generated_at, symbol, price_usd
            FROM factor_history
            WHERE generated_at >= ?
              AND generated_at <= ?
              AND price_usd IS NOT NULL
              AND price_usd > 0
            ORDER BY generated_at ASC
            """,
            (cutoff, reference_iso),
        ).fetchall()
    finally:
        conn.close()

    by_symbol: dict[str, list[dict[str, Any]]] = {}
    for db_row in db_rows:
        parsed_at = datetime.fromisoformat(db_row["generated_at"])
        if parsed_at.tzinfo is None:
            # Legacy rows without an offset are assumed to be storage-local.
            parsed_at = parsed_at.replace(tzinfo=_STORAGE_TZ)
        by_symbol.setdefault(db_row["symbol"], []).append(
            {
                "generated_at": parsed_at,
                "price_usd": float(db_row["price_usd"]),
            }
        )

    result: dict[str, float] = {}
    for symbol, history in by_symbol.items():
        items = [
            (
                row,
                (reference_at - row["generated_at"]).total_seconds() / 3600.0,
            )
            for row in history
        ]
        matched = _select_horizon_match(items, min_target_hours, max_target_hours, hours)
        if matched is not None:
            result[symbol] = matched["price_usd"]
    return result
