from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


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
    with connect(db_path) as conn:
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
        conn.commit()


def load_labeled_factor_records(config: dict[str, Any]) -> list[dict[str, Any]]:
    db_path = Path(config.get("storage_path", "data/crypto_screener.sqlite3"))
    if not db_path.exists():
        return []

    factor_cfg = config.get("factors", {})
    window_days = int(factor_cfg.get("ic_window_days", 30))
    horizon_hours = float(factor_cfg.get("forward_return_hours", 24))
    min_target_hours = horizon_hours * 0.75
    max_target_hours = horizon_hours * 1.5
    cutoff = datetime.now().astimezone() - timedelta(days=window_days + 3)

    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT generated_at, symbol, price_usd, factors_json
            FROM market_rows
            WHERE generated_at >= ?
            ORDER BY generated_at ASC
            """,
            (cutoff.isoformat(timespec="seconds"),),
        ).fetchall()

    by_symbol: dict[str, list[dict[str, Any]]] = {}
    for db_row in rows:
        price = db_row["price_usd"]
        if price is None or price <= 0:
            continue
        item = {
            "generated_at": datetime.fromisoformat(db_row["generated_at"]),
            "symbol": db_row["symbol"],
            "price_usd": float(price),
            "factors": json.loads(db_row["factors_json"]),
        }
        by_symbol.setdefault(item["symbol"], []).append(item)

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


def _find_forward_row(
    candidates: list[dict[str, Any]],
    generated_at: datetime,
    min_target_hours: float,
    max_target_hours: float,
) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    best_delta: float | None = None
    for candidate in candidates:
        delta_hours = (candidate["generated_at"] - generated_at).total_seconds() / 3600.0
        if delta_hours < min_target_hours:
            continue
        if delta_hours > max_target_hours:
            break
        distance = abs(delta_hours - ((min_target_hours + max_target_hours) / 2.0))
        if best is None or best_delta is None or distance < best_delta:
            best = candidate
            best_delta = distance
    return best
