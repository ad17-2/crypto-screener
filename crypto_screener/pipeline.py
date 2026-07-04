from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

from .collector import collect_market
from .factors import score_snapshot
from .report import now_jakarta, write_reports
from .storage import load_labeled_factor_records, save_snapshot


def run_pipeline(
    config: dict[str, Any],
    out_dir: Path,
    save: bool = True,
    write_report_files: bool = True,
) -> tuple[dict[str, Any], dict[str, Path]]:
    generated_at = now_jakarta()
    run_id = generated_at.strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:8]

    collected = collect_market(config)
    history_records = load_labeled_factor_records(config)
    scored = score_snapshot(
        collected["rows"],
        collected.get("market_context", {}),
        history_records,
        config,
    )

    payload = {
        "run_id": run_id,
        "generated_at": generated_at.isoformat(timespec="seconds"),
        "rows": scored["rows"],
        "market_context": scored.get("market_context", collected.get("market_context", {})),
        "provider_status": collected.get("provider_status", {}),
        "factor_weights": scored["factor_weights"],
        "regime": scored["regime"],
    }
    if save:
        save_snapshot(payload, config)
    paths = write_reports(payload, config, out_dir) if write_report_files else {}
    return payload, paths
