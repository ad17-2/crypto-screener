from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .config import load_config_dict
from .pipeline import run_pipeline
from .watchlists import is_crowded_long, is_crowded_short, is_long_candidate, is_short_candidate, top_by


def load_config(path: Path) -> dict[str, Any]:
    return load_config_dict(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run crypto quant daily screener.")
    parser.add_argument("--config", default="config/default.json", help="Path to JSON config.")
    parser.add_argument("--out-dir", default="reports", help="Directory for report files.")
    parser.add_argument("--top-symbols", type=int, help="Override top symbols by 24h volume.")
    parser.add_argument("--report-limit", type=int, help="Override number of rows per markdown section.")
    parser.add_argument("--min-quote-volume-usd", type=float, help="Override minimum 24h quote volume.")
    parser.add_argument(
        "--coinglass-candidate-symbols",
        "--max-coinglass-symbols",
        dest="coinglass_candidate_symbols",
        type=int,
        help="Override number of CoinGlass candidate symbols to query.",
    )
    parser.add_argument("--no-save", action="store_true", help="Do not write this run into SQLite history.")
    parser.add_argument("--no-reports", action="store_true", help="Do not write Markdown, JSON, or CSV report files.")
    return parser.parse_args()


def apply_overrides(config: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    universe = config.setdefault("universe", {})
    coinglass = config.setdefault("providers", {}).setdefault("coinglass", {})
    report = config.setdefault("report", {})

    if args.top_symbols is not None:
        universe["top_symbols_by_volume"] = args.top_symbols
    if args.report_limit is not None:
        report["limit"] = args.report_limit
    if args.min_quote_volume_usd is not None:
        universe["min_quote_volume_usd"] = args.min_quote_volume_usd
    if args.coinglass_candidate_symbols is not None:
        coinglass["candidate_symbols"] = args.coinglass_candidate_symbols
    return config


def main() -> int:
    args = parse_args()
    config = apply_overrides(load_config(Path(args.config)), args)

    payload, paths = run_pipeline(
        config, Path(args.out_dir), save=not args.no_save, write_report_files=not args.no_reports
    )
    rows = payload["rows"]
    limit = int(config.get("report", {}).get("limit", 12))

    long_count = len(top_by(rows, "long_score", limit, predicate=is_long_candidate))
    short_count = len(top_by(rows, "short_score", limit, predicate=is_short_candidate))
    fade_count = len(top_by(rows, "crowded_long_score", limit, predicate=is_crowded_long))
    squeeze_count = len(top_by(rows, "squeeze_risk_score", limit, predicate=is_crowded_short))

    print(f"run_id={payload['run_id']}")
    print(f"screened_symbols={len(rows)}")
    print(f"bias={payload.get('regime', {}).get('bias')}")
    print(f"factor_regime={payload.get('regime', {}).get('label')}")
    print(f"weight_mode={payload.get('factor_weights', {}).get('mode')}")
    print(f"long_candidates={long_count}")
    print(f"short_candidates={short_count}")
    print(f"crowded_longs={fade_count}")
    print(f"squeeze_risks={squeeze_count}")
    if not paths:
        print("reports=skipped")
    for label, path in paths.items():
        print(f"{label}={path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
