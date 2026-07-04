from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .factors import reason_for


REPORT_FIELDS = [
    "symbol",
    "contract_symbol",
    "data_source",
    "price_usd",
    "price_change_24h_pct",
    "quote_volume_usd",
    "open_interest_usd",
    "oi_change_24h_pct",
    "funding_rate_pct",
    "long_short_ratio",
    "long_liquidation_usd_24h",
    "short_liquidation_usd_24h",
    "spread_bps",
    "depth_0_5pct_usd",
    "factor_score",
    "liquidity_quality",
    "confidence_score",
    "technical_setup",
    "technical_interval",
    "rsi_14",
    "macd_histogram_pct",
    "atr_14_pct",
    "bb_position",
    "bb_width_pct",
    "distance_ema20_pct",
    "technical_trend_score",
    "technical_momentum_score",
    "derivatives_interval",
    "oi_change_4h_pct_history",
    "oi_change_24h_pct_history",
    "oi_acceleration_4h_pct",
    "oi_zscore_30",
    "funding_avg_24h_pct",
    "funding_persistence_24h",
    "liquidation_imbalance_24h_pct",
    "taker_buy_sell_ratio_24h",
    "taker_imbalance_24h_pct",
    "derivatives_confirmation_score",
    "long_score",
    "short_score",
    "crowded_long_score",
    "squeeze_risk_score",
    "signal_conflict_label",
    "signal_conflict_score",
    "regime_alignment_score",
    "breadth_alignment_score",
    "is_trusted",
    "data_quality_score",
    "data_quality_flags",
]


def now_jakarta() -> datetime:
    return datetime.now(ZoneInfo("Asia/Jakarta"))


def format_usd(value: Any) -> str:
    if value is None:
        return "-"
    value = float(value)
    abs_value = abs(value)
    if abs_value >= 1_000_000_000_000:
        return f"${value / 1_000_000_000_000:.2f}T"
    if abs_value >= 1_000_000_000:
        return f"${value / 1_000_000_000:.2f}B"
    if abs_value >= 1_000_000:
        return f"${value / 1_000_000:.2f}M"
    if abs_value >= 1_000:
        return f"${value / 1_000:.2f}K"
    return f"${value:.2f}"


def format_pct(value: Any, digits: int = 2, signed: bool = True) -> str:
    if value is None:
        return "-"
    sign = "+" if signed else ""
    return f"{float(value):{sign}.{digits}f}%"


def top_by(
    rows: list[dict[str, Any]],
    field: str,
    limit: int,
    minimum: float = 0.01,
    predicate=None,
    trusted_only: bool = True,
) -> list[dict[str, Any]]:
    if trusted_only:
        rows = [row for row in rows if row.get("is_trusted", True)]
    ranked = sorted(rows, key=lambda item: item.get(field) or 0, reverse=True)
    if predicate is not None:
        ranked = [row for row in ranked if predicate(row)]
    return [row for row in ranked if (row.get(field) or 0) >= minimum][:limit]


def render_markdown(payload: dict[str, Any], config: dict[str, Any]) -> str:
    rows = payload.get("rows", [])
    report_cfg = config.get("report", {})
    limit = int(report_cfg.get("limit", 12))
    regime = payload.get("regime", {})
    context = payload.get("market_context", {})
    provider_status = payload.get("provider_status", {})
    weights = payload.get("factor_weights", {})

    long_rows = top_by(rows, "long_score", limit, predicate=lambda row: (row.get("factor_score") or 0) > 0)
    short_rows = top_by(rows, "short_score", limit, predicate=lambda row: (row.get("factor_score") or 0) < 0)
    fade_rows = top_by(rows, "crowded_long_score", limit, predicate=_is_crowded_long)
    squeeze_rows = top_by(rows, "squeeze_risk_score", limit, predicate=_is_crowded_short)
    core_rows = [row for row in rows if row.get("symbol") in set(report_cfg.get("core_symbols", ["BTC", "ETH", "SOL"]))]

    return "\n".join(
        [
            "# Crypto Quant Daily Report",
            "",
            f"Generated: `{payload.get('generated_at')}`",
            "",
            "Signal-only report. It ranks symbols for manual chart review and never places trades.",
            "",
            "## Market Bias",
            _market_bias_block(regime, context),
            "",
            "## Provider Status",
            _provider_status_block(provider_status),
            "",
            "## Data Quality",
            _data_quality_block(rows),
            "",
            "## Factor Regime",
            _factor_weights_table(weights),
            "",
            "## Dominance And Sector Rotation",
            _rotation_block(context),
            "",
            "## BTC / ETH / SOL Core Read",
            _candidate_table(core_rows, "factor_score", "long"),
            "",
            "## Top Long Watchlist",
            _candidate_table(long_rows, "long_score", "long"),
            "",
            "## Top Short Watchlist",
            _candidate_table(short_rows, "short_score", "short"),
            "",
            "## Crowded Longs To Fade",
            _candidate_table(fade_rows, "crowded_long_score", "fade-long"),
            "",
            "## Crowded Shorts / Squeeze Risk",
            _candidate_table(squeeze_rows, "squeeze_risk_score", "squeeze-risk"),
            "",
            "## Manual Chart Checklist",
            "- Confirm higher-timeframe trend and current key level.",
            "- Reject late entries where price is extended far from invalidation.",
            "- Treat extreme funding and long/short crowding as risk, not an entry by itself.",
            "- Prefer setups where factor direction, liquidity, sector context, and BTC regime agree.",
            "- If BTC regime conflicts with the alt setup, size down or skip.",
            "",
        ]
    )


def _market_bias_block(regime: dict[str, Any], context: dict[str, Any]) -> str:
    lines = [
        f"- Bias: `{regime.get('bias', 'unknown')}`",
        f"- Factor regime: `{regime.get('label', 'unknown')}`",
        f"- Bias score: `{regime.get('bias_score', '-')}`",
        f"- Total crypto market cap: `{format_usd(context.get('total_market_cap_usd'))}`",
        f"- Market cap 24h: `{format_pct(context.get('market_cap_change_24h_pct'))}`",
        f"- BTC dominance: `{format_pct(context.get('btc_dominance_pct'), signed=False)}`",
        f"- ETH dominance: `{format_pct(context.get('eth_dominance_pct'), signed=False)}`",
        f"- Avg futures funding: `{format_pct(regime.get('avg_funding_rate_pct'), digits=4)}`",
        f"- Breadth: `{regime.get('breadth_label', 'unknown')}` (`{regime.get('breadth_score', '-')}`)",
        f"- Sector rotation: `{regime.get('sector_rotation_label', 'unknown')}`",
    ]
    return "\n".join(lines)


def _provider_status_block(provider_status: dict[str, Any]) -> str:
    if not provider_status:
        return "_No provider status._"
    lines = ["| Provider | Status | Rows | Note |", "|---|---|---:|---|"]
    for provider, details in provider_status.items():
        lines.append(
            "| {provider} | {status} | {rows} | {note} |".format(
                provider=provider,
                status=details.get("status", "-"),
                rows=details.get("rows", "-"),
                note=(details.get("reason") or details.get("note") or "-").replace("|", "/"),
            )
        )
    return "\n".join(lines)


def _factor_weights_table(weights: dict[str, Any]) -> str:
    stats = weights.get("stats", {})
    if not stats:
        return "_No factor weights._"
    lines = [
        f"History records: `{weights.get('history_records', 0)}`. Weight mode: `{weights.get('mode', 'prior')}`.",
        _validation_summary(weights.get("validation", {})),
        "",
        "| Factor | Weight | IC | Obs | Mode |",
        "|---|---:|---:|---:|---|",
    ]
    for factor, details in sorted(stats.items(), key=lambda item: abs(item[1].get("weight", 0.0)), reverse=True):
        ic = details.get("ic")
        lines.append(
            "| {factor} | {weight:+.3f} | {ic} | {obs} | {mode} |".format(
                factor=factor,
                weight=details.get("weight", 0.0),
                ic="-" if ic is None else f"{ic:+.3f}",
                obs=details.get("observations", 0),
                mode=details.get("mode", "-"),
            )
        )
    return "\n".join(lines)


def _rotation_block(context: dict[str, Any]) -> str:
    categories = context.get("categories", {})
    breadth = context.get("breadth", {})
    sector_rotation = context.get("sector_rotation", {})
    leaders = categories.get("leaders", [])[:5]
    laggards = categories.get("laggards", [])[:5]
    if not leaders and not laggards and not breadth:
        return "_No category data available._"

    lines = [
        f"Market breadth: `{breadth.get('label', 'unknown')}` score `{breadth.get('score', '-')}`, advancers `{breadth.get('advancer_pct', '-')}%`.",
        f"Sector tape: `{sector_rotation.get('label', 'unknown')}`.",
        "",
        "Top category leaders:",
    ]
    lines.extend(_category_lines(leaders))
    lines.append("")
    lines.append("Top category laggards:")
    lines.extend(_category_lines(laggards))
    return "\n".join(lines)


def _category_lines(categories: list[dict[str, Any]]) -> list[str]:
    if not categories:
        return ["- none"]
    return [
        f"- {item.get('name', item.get('id', '-'))}: {format_pct(item.get('market_cap_change_24h_pct'))}, volume {format_usd(item.get('volume_24h_usd'))}"
        for item in categories
    ]


def _validation_summary(validation: dict[str, Any]) -> str:
    if not validation:
        return "Validation: `unavailable`."
    model = validation.get("model", {})
    hit_rate = model.get("hit_rate")
    hit_text = "-" if hit_rate is None else f"{hit_rate:.2f}%"
    return (
        "Validation: `{status}`, observations `{observations}`, horizon `{horizon}h`, model hit rate `{hit}`."
    ).format(
        status=validation.get("status", "unknown"),
        observations=validation.get("observations", 0),
        horizon=validation.get("horizon_hours", "-"),
        hit=hit_text,
    )


def _candidate_table(rows: list[dict[str, Any]], score_field: str, side: str) -> str:
    if not rows:
        return "_No matches._"

    lines = [
        "| Symbol | Score | Conf | Quality | Tech | 24h | OI 24h | Funding | L/S | Volume | Source | Reason |",
        "|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|---|",
    ]
    for row in rows:
        score = row.get(score_field)
        lines.append(
            "| {symbol} | {score:.2f} | {confidence} | {quality} | {tech} | {price} | {oi} | {funding} | {ls} | {volume} | {source} | {reason} |".format(
                symbol=row.get("symbol", "-"),
                score=score or 0.0,
                confidence="-" if row.get("confidence_score") is None else f"{float(row['confidence_score']):.0f}",
                quality=row.get("data_quality_score", 100),
                tech=str(row.get("technical_setup") or "-").replace("|", "/"),
                price=format_pct(row.get("price_change_24h_pct")),
                oi=format_pct(row.get("oi_change_24h_pct")),
                funding=format_pct(row.get("funding_rate_pct"), digits=4),
                ls="-" if row.get("long_short_ratio") is None else f"{float(row['long_short_ratio']):.2f}",
                volume=format_usd(row.get("quote_volume_usd")),
                source=row.get("data_source", "-"),
                reason=reason_for(row, side).replace("|", "/"),
            )
        )
    return "\n".join(lines)


def _is_crowded_long(row: dict[str, Any]) -> bool:
    funding = row.get("funding_rate_pct") or 0.0
    ls_ratio = row.get("long_short_ratio")
    return funding > 0.015 or (ls_ratio is not None and ls_ratio >= 1.3)


def _is_crowded_short(row: dict[str, Any]) -> bool:
    funding = row.get("funding_rate_pct") or 0.0
    ls_ratio = row.get("long_short_ratio")
    return funding < -0.015 or (ls_ratio is not None and ls_ratio <= 0.8)


def _data_quality_block(rows: list[dict[str, Any]]) -> str:
    flagged = [row for row in rows if row.get("data_quality_flags")]
    trusted = sum(1 for row in rows if row.get("is_trusted", True))
    excluded = len(rows) - trusted
    lines = [
        f"- Trusted rows used for ranking: `{trusted}`",
        f"- Excluded rows: `{excluded}`",
    ]
    if not flagged:
        return "\n".join(lines)

    lines.extend(
        [
            "",
            "| Symbol | Source | 24h | OI 24h | Flags |",
            "|---|---|---:|---:|---|",
        ]
    )
    for row in flagged[:12]:
        lines.append(
            "| {symbol} | {source} | {price} | {oi} | {flags} |".format(
                symbol=row.get("symbol", "-"),
                source=row.get("data_source", "-"),
                price=format_pct(row.get("price_change_24h_pct")),
                oi=format_pct(row.get("oi_change_24h_pct")),
                flags=", ".join(str(flag) for flag in row.get("data_quality_flags", [])).replace("|", "/"),
            )
        )
    if len(flagged) > 12:
        lines.append(f"| ... | ... | ... | ... | {len(flagged) - 12} more excluded rows |")
    return "\n".join(lines)


def write_reports(payload: dict[str, Any], config: dict[str, Any], out_dir: Path) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.fromisoformat(payload["generated_at"])
    stem = "crypto-quant-daily-" + generated_at.strftime("%Y%m%d-%H%M%S")

    json_path = out_dir / f"{stem}.json"
    csv_path = out_dir / f"{stem}.csv"
    md_path = out_dir / f"{stem}.md"

    json_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=REPORT_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(payload.get("rows", []))

    md_path.write_text(render_markdown(payload, config), encoding="utf-8")
    return {"json": json_path, "csv": csv_path, "markdown": md_path}
