from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .storage import connect


def freshness_summary(generated_at: str | None) -> dict[str, Any]:
    if not generated_at:
        return {"status": "unknown", "label": "unknown", "age_seconds": None, "age_minutes": None}
    try:
        parsed = datetime.fromisoformat(generated_at)
    except ValueError:
        return {
            "status": "unknown",
            "label": "unknown",
            "generated_at": generated_at,
            "age_seconds": None,
            "age_minutes": None,
        }
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    age_seconds = max(0.0, (datetime.now(parsed.tzinfo) - parsed).total_seconds())
    if age_seconds <= 4 * 60 * 60:
        label = "fresh"
    elif age_seconds <= 12 * 60 * 60:
        label = "aging"
    elif age_seconds <= 24 * 60 * 60:
        label = "stale"
    else:
        label = "old"
    return {
        "status": "ok",
        "label": label,
        "generated_at": generated_at,
        "age_seconds": round(age_seconds, 0),
        "age_minutes": round(age_seconds / 60.0, 1),
        "help": "Freshness is based on the selected saved run, not live tick data.",
    }


def latest_run_generated_at(db_path: Path) -> datetime | None:
    if not db_path.exists():
        return None
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT generated_at FROM runs ORDER BY generated_at DESC LIMIT 1").fetchone()
    finally:
        conn.close()
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
