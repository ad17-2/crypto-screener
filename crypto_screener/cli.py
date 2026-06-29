from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .pipeline import run_pipeline
from .report import top_by


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run crypto quant daily screener.")
    parser.add_argument("--config", default="config/default.json", help="Path to JSON config.")
    parser.add_argument("--out-dir", default="reports", help="Directory for report files.")
    parser.add_argument("--top-symbols", type=int, help="Override top symbols by 24h volume.")
    parser.add_argument("--depth-symbols", type=int, help="Override number of symbols with order-book depth fetch.")
    parser.add_argument("--report-limit", type=int, help="Override number of rows per markdown section.")
    parser.add_argument("--min-quote-volume-usd", type=float, help="Override minimum 24h quote volume.")
    parser.add_argument("--max-spread-bps", type=float, help="Override max bid/ask spread in bps.")
    parser.add_argument("--max-coinglass-symbols", type=int, help="Override number of symbols enriched via CoinGlass.")
    parser.add_argument("--disable-coinglass", action="store_true", help="Skip CoinGlass even if COINGLASS_API_KEY is set.")
    parser.add_argument("--no-save", action="store_true", help="Do not write this run into SQLite history.")
    return parser.parse_args()


def apply_overrides(config: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    universe = config.setdefault("universe", {})
    binance = config.setdefault("providers", {}).setdefault("binance", {})
    coinglass = config.setdefault("providers", {}).setdefault("coinglass", {})
    report = config.setdefault("report", {})

    if args.top_symbols is not None:
        universe["top_symbols_by_volume"] = args.top_symbols
    if args.depth_symbols is not None:
        binance["depth_symbols"] = args.depth_symbols
    if args.report_limit is not None:
        report["limit"] = args.report_limit
    if args.min_quote_volume_usd is not None:
        universe["min_quote_volume_usd"] = args.min_quote_volume_usd
    if args.max_spread_bps is not None:
        universe["max_spread_bps"] = args.max_spread_bps
    if args.max_coinglass_symbols is not None:
        coinglass["max_symbols"] = args.max_coinglass_symbols
    if args.disable_coinglass:
        coinglass["enabled"] = False
    return config


def main() -> int:
    args = parse_args()
    config = apply_overrides(load_config(Path(args.config)), args)

    payload, paths = run_pipeline(config, Path(args.out_dir), save=not args.no_save)
    rows = payload["rows"]
    limit = int(config.get("report", {}).get("limit", 12))

    long_count = len(top_by(rows, "long_score", limit, predicate=lambda row: (row.get("factor_score") or 0) > 0))
    short_count = len(top_by(rows, "short_score", limit, predicate=lambda row: (row.get("factor_score") or 0) < 0))
    fade_count = len(
        top_by(
            rows,
            "crowded_long_score",
            limit,
            predicate=lambda row: (row.get("funding_rate_pct") or 0) > 0.015
            or (row.get("long_short_ratio") is not None and row["long_short_ratio"] >= 1.3),
        )
    )
    squeeze_count = len(
        top_by(
            rows,
            "squeeze_risk_score",
            limit,
            predicate=lambda row: (row.get("funding_rate_pct") or 0) < -0.015
            or (row.get("long_short_ratio") is not None and row["long_short_ratio"] <= 0.8),
        )
    )

    print(f"run_id={payload['run_id']}")
    print(f"screened_symbols={len(rows)}")
    print(f"bias={payload.get('regime', {}).get('bias')}")
    print(f"factor_regime={payload.get('regime', {}).get('label')}")
    print(f"weight_mode={payload.get('factor_weights', {}).get('mode')}")
    print(f"long_candidates={long_count}")
    print(f"short_candidates={short_count}")
    print(f"crowded_longs={fade_count}")
    print(f"squeeze_risks={squeeze_count}")
    for label, path in paths.items():
        print(f"{label}={path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
