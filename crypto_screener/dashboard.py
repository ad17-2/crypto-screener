from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .cli import load_config
from .factors import reason_for
from .pipeline import run_pipeline
from .report import top_by
from .storage import connect


DEFAULT_CONFIG_PATH = Path("config/default.json")


@dataclass(frozen=True)
class DashboardSettings:
    config_path: Path
    db_path: Path
    report_dir: Path
    host: str
    port: int
    limit: int
    auto_refresh_seconds: int
    refresh_token: str | None


class RefreshRuntime:
    def __init__(self, settings: DashboardSettings) -> None:
        self.settings = settings
        self.lock = threading.Lock()
        self.status: dict[str, Any] = {"state": "idle"}

    def refresh(self, reason: str) -> dict[str, Any]:
        if not self.lock.acquire(blocking=False):
            return self.status | {"state": "running"}
        try:
            started_at = datetime.now(timezone.utc)
            self.status = {
                "state": "running",
                "reason": reason,
                "started_at": started_at.isoformat(timespec="seconds"),
            }
            config = _load_runtime_config(self.settings)
            payload, paths = run_pipeline(config, self.settings.report_dir, save=True)
            finished_at = datetime.now(timezone.utc)
            self.status = {
                "state": "ok",
                "reason": reason,
                "run_id": payload.get("run_id"),
                "generated_at": payload.get("generated_at"),
                "finished_at": finished_at.isoformat(timespec="seconds"),
                "duration_seconds": round((finished_at - started_at).total_seconds(), 2),
                "paths": {key: str(path) for key, path in paths.items()},
            }
            return self.status
        except Exception as exc:  # pragma: no cover - exercised in deployed runtime
            self.status = {
                "state": "error",
                "reason": reason,
                "error": str(exc),
                "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            return self.status
        finally:
            self.lock.release()

    def refresh_async(self, reason: str) -> dict[str, Any]:
        if self.lock.locked():
            return self.status | {"state": "running"}
        thread = threading.Thread(target=self.refresh, args=(reason,), daemon=True)
        thread.start()
        return {"state": "queued", "reason": reason}


def settings_from_env() -> DashboardSettings:
    config_path = Path(os.environ.get("CRYPTO_SCREENER_CONFIG", DEFAULT_CONFIG_PATH))
    config = load_config(config_path)
    db_path = Path(os.environ.get("CRYPTO_SCREENER_DB_PATH", config.get("storage_path", "data/crypto_screener.sqlite3")))
    report_dir = Path(os.environ.get("CRYPTO_SCREENER_REPORT_DIR", "reports"))
    return DashboardSettings(
        config_path=config_path,
        db_path=db_path,
        report_dir=report_dir,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
        limit=int(os.environ.get("CRYPTO_DASHBOARD_LIMIT", config.get("report", {}).get("limit", 12))),
        auto_refresh_seconds=int(os.environ.get("CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS", "0")),
        refresh_token=os.environ.get("CRYPTO_DASHBOARD_REFRESH_TOKEN") or None,
    )


def _load_runtime_config(settings: DashboardSettings) -> dict[str, Any]:
    config = load_config(settings.config_path)
    config["storage_path"] = str(settings.db_path)
    return config


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

    context = _loads_json(selected["context_json"], {})
    provider_status = _loads_json(selected["provider_status_json"], {})
    regime = _loads_json(selected["regime_json"], {})
    factor_weights = _loads_json(selected["factor_weights_json"], {})
    sections = _sections(rows, limit)

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


def _sections(rows: list[dict[str, Any]], limit: int) -> dict[str, list[dict[str, Any]]]:
    core_symbols = ["BTC", "ETH", "SOL"]
    core_by_symbol = {row.get("symbol"): row for row in rows if row.get("symbol") in core_symbols}
    return {
        "core": [_dashboard_row(core_by_symbol[symbol], "factor_score", "long") for symbol in core_symbols if symbol in core_by_symbol],
        "long": [
            _dashboard_row(row, "long_score", "long")
            for row in top_by(rows, "long_score", limit, predicate=lambda item: (item.get("factor_score") or 0) > 0)
        ],
        "short": [
            _dashboard_row(row, "short_score", "short")
            for row in top_by(rows, "short_score", limit, predicate=lambda item: (item.get("factor_score") or 0) < 0)
        ],
        "crowded_longs": [
            _dashboard_row(row, "crowded_long_score", "fade-long")
            for row in top_by(rows, "crowded_long_score", limit, predicate=_is_crowded_long)
        ],
        "squeeze_risks": [
            _dashboard_row(row, "squeeze_risk_score", "squeeze-risk")
            for row in top_by(rows, "squeeze_risk_score", limit, predicate=_is_crowded_short)
        ],
    }


def _dashboard_row(row: dict[str, Any], score_field: str, side: str) -> dict[str, Any]:
    return {
        "symbol": row.get("symbol"),
        "score": row.get(score_field),
        "quality": row.get("data_quality_score", 100),
        "price_usd": row.get("price_usd"),
        "price_change_24h_pct": row.get("price_change_24h_pct"),
        "oi_change_24h_pct": row.get("oi_change_24h_pct"),
        "funding_rate_pct": row.get("funding_rate_pct"),
        "long_short_ratio": row.get("long_short_ratio"),
        "quote_volume_usd": row.get("quote_volume_usd"),
        "data_source": row.get("data_source"),
        "is_trusted": row.get("is_trusted", True),
        "reason": reason_for(row, side),
    }


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


def latest_run_age_seconds(db_path: Path) -> float | None:
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
    return max(0.0, (datetime.now(generated_at.tzinfo) - generated_at).total_seconds())


def start_auto_refresh(runtime: RefreshRuntime) -> None:
    seconds = runtime.settings.auto_refresh_seconds
    if seconds <= 0:
        return

    def loop() -> None:
        while True:
            age = latest_run_age_seconds(runtime.settings.db_path)
            if age is None or age >= seconds:
                runtime.refresh("auto")
            time.sleep(max(60, min(seconds, 1800)))

    threading.Thread(target=loop, daemon=True).start()


class DashboardHandler(BaseHTTPRequestHandler):
    settings: DashboardSettings
    runtime: RefreshRuntime

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_html(DASHBOARD_HTML)
            return
        if parsed.path == "/health":
            self._send_json(
                {
                    "status": "ok",
                    "database_exists": self.settings.db_path.exists(),
                    "refresh": self.runtime.status,
                }
            )
            return
        if parsed.path == "/api/dashboard":
            params = parse_qs(parsed.query)
            run_id = params.get("run_id", [None])[0]
            payload = build_dashboard_payload(self.settings.db_path, run_id=run_id, limit=self.settings.limit)
            payload["refresh_status"] = self.runtime.status
            self._send_json(payload)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/refresh":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not self._refresh_allowed():
            self._send_json({"status": "forbidden", "reason": "refresh token required"}, HTTPStatus.FORBIDDEN)
            return
        self._send_json(self.runtime.refresh_async("manual"), HTTPStatus.ACCEPTED)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        print("%s - %s" % (self.address_string(), format % args))

    def _refresh_allowed(self) -> bool:
        token = self.settings.refresh_token
        if not token:
            return False
        supplied = self.headers.get("X-Refresh-Token", "")
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            supplied = auth.removeprefix("Bearer ").strip()
        return supplied == token

    def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, body: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class DashboardServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def server_bind(self) -> None:
        self.socket.bind(self.server_address)
        self.server_address = self.socket.getsockname()
        self.server_name = str(self.server_address[0])
        self.server_port = int(self.server_address[1])


def serve() -> None:
    settings = settings_from_env()
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    settings.report_dir.mkdir(parents=True, exist_ok=True)
    runtime = RefreshRuntime(settings)
    start_auto_refresh(runtime)

    handler = type(
        "ConfiguredDashboardHandler",
        (DashboardHandler,),
        {"settings": settings, "runtime": runtime},
    )
    server = DashboardServer((settings.host, settings.port), handler)
    print(f"crypto dashboard listening on {settings.host}:{settings.port}", flush=True)
    server.serve_forever()


DASHBOARD_HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crypto Dashboard</title>
  <style>
    :root {
      --bg: #f5f7fa;
      --panel: #ffffff;
      --ink: #171a1f;
      --muted: #657084;
      --line: #dbe1ea;
      --teal: #0f766e;
      --green: #15803d;
      --red: #b42318;
      --amber: #b7791f;
      --blue: #2563eb;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    .shell {
      width: min(1480px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 22px 0 34px;
    }
    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 { margin: 0; font-size: 24px; line-height: 1.1; }
    .subline { color: var(--muted); font-size: 13px; margin-top: 6px; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    select, button {
      height: 36px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      border-radius: 8px;
      padding: 0 10px;
      font: inherit;
      font-size: 13px;
    }
    button { cursor: pointer; font-weight: 650; }
    button:hover { border-color: #aeb8c7; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(130px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { min-height: 86px; padding: 12px; }
    .label { color: var(--muted); font-size: 12px; line-height: 1.2; }
    .value { font-size: 23px; font-weight: 760; margin-top: 8px; line-height: 1.15; word-break: break-word; }
    .value.small { font-size: 18px; }
    .good { color: var(--green); }
    .bad { color: var(--red); }
    .warn { color: var(--amber); }
    .accent { color: var(--teal); }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(360px, .75fr);
      gap: 12px;
      align-items: start;
    }
    .panel { overflow: hidden; margin-bottom: 12px; }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      min-height: 42px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
    }
    h2 { margin: 0; font-size: 14px; }
    .count { color: var(--muted); font-size: 12px; }
    .table-wrap { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 820px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #edf1f6; text-align: right; font-size: 12px; vertical-align: top; }
    th { color: var(--muted); font-weight: 650; background: #fbfcfe; white-space: nowrap; }
    td:first-child, th:first-child, td.reason, th.reason { text-align: left; }
    td.reason { color: #3b4351; min-width: 240px; max-width: 380px; }
    .symbol { font-weight: 760; font-size: 13px; }
    .tag {
      display: inline-flex;
      align-items: center;
      height: 22px;
      border-radius: 999px;
      padding: 0 8px;
      font-size: 12px;
      font-weight: 700;
      background: #edf7f5;
      color: var(--teal);
    }
    .list { padding: 10px 12px 12px; display: grid; gap: 8px; }
    .list-row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
    .list-row span:last-child { color: var(--muted); text-align: right; }
    .quality-flags { padding: 10px 12px; display: grid; gap: 8px; }
    .flag-row { font-size: 12px; color: #3b4351; line-height: 1.4; }
    .empty { padding: 28px 12px; color: var(--muted); text-align: center; }
    @media (max-width: 1100px) {
      .metrics { grid-template-columns: repeat(3, minmax(130px, 1fr)); }
      .grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 680px) {
      .shell { width: min(100vw - 20px, 1480px); padding-top: 14px; }
      .topbar { flex-direction: column; align-items: stretch; }
      .actions { justify-content: stretch; }
      select, button { width: 100%; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .value { font-size: 19px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div>
        <h1>Crypto Dashboard</h1>
        <div class="subline" id="generated">Loading latest run</div>
      </div>
      <div class="actions">
        <select id="runSelect" aria-label="Run"></select>
        <button id="reload" type="button">Reload</button>
      </div>
    </div>
    <section class="metrics" id="metrics"></section>
    <section class="grid">
      <div>
        <div class="panel" id="corePanel"></div>
        <div class="panel" id="longPanel"></div>
        <div class="panel" id="shortPanel"></div>
        <div class="panel" id="squeezePanel"></div>
        <div class="panel" id="fadePanel"></div>
      </div>
      <aside>
        <div class="panel" id="providerPanel"></div>
        <div class="panel" id="qualityPanel"></div>
        <div class="panel" id="sectorPanel"></div>
        <div class="panel" id="runsPanel"></div>
      </aside>
    </section>
  </main>
  <script>
    const state = { selectedRun: null };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "-").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const clsFor = (value) => Number(value || 0) > 0 ? "good" : Number(value || 0) < 0 ? "bad" : "";

    function fmtNum(value, digits = 2) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      return Number(value).toFixed(digits);
    }
    function fmtPct(value, digits = 2) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      const n = Number(value);
      return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
    }
    function fmtUsd(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      const n = Number(value);
      const a = Math.abs(n);
      if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
      if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
      if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
      if (a >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
      return `$${n.toFixed(2)}`;
    }
    function metric(label, value, klass = "") {
      return `<article class="metric"><div class="label">${esc(label)}</div><div class="value ${klass}">${esc(value)}</div></article>`;
    }
    function panel(title, count, body) {
      return `<div class="panel-head"><h2>${esc(title)}</h2><span class="count">${esc(count)}</span></div>${body}`;
    }
    function rowsTable(rows) {
      if (!rows || rows.length === 0) return `<div class="empty">No matches</div>`;
      const body = rows.map((row) => `
        <tr>
          <td><span class="symbol">${esc(row.symbol)}</span></td>
          <td>${fmtNum(row.score)}</td>
          <td>${esc(row.quality ?? 100)}</td>
          <td class="${clsFor(row.price_change_24h_pct)}">${fmtPct(row.price_change_24h_pct)}</td>
          <td class="${clsFor(row.oi_change_24h_pct)}">${fmtPct(row.oi_change_24h_pct)}</td>
          <td class="${clsFor(row.funding_rate_pct)}">${fmtPct(row.funding_rate_pct, 4)}</td>
          <td>${row.long_short_ratio == null ? "-" : fmtNum(row.long_short_ratio)}</td>
          <td>${fmtUsd(row.quote_volume_usd)}</td>
          <td><span class="tag">${esc(row.data_source)}</span></td>
          <td class="reason">${esc(row.reason)}</td>
        </tr>`).join("");
      return `<div class="table-wrap"><table>
        <thead><tr><th>Symbol</th><th>Score</th><th>Q</th><th>24h</th><th>OI 24h</th><th>Funding</th><th>L/S</th><th>Volume</th><th>Source</th><th class="reason">Reason</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>`;
    }
    function providerList(providers) {
      const entries = Object.entries(providers || {});
      if (entries.length === 0) return `<div class="empty">No providers</div>`;
      return `<div class="list">${entries.map(([name, details]) => `
        <div class="list-row"><strong>${esc(name)}</strong><span>${esc(details.status || "-")} ${details.rows === undefined ? "" : `/${details.rows}`}</span></div>
      `).join("")}</div>`;
    }
    function sectorList(context) {
      const leaders = context?.categories?.leaders || [];
      const laggards = context?.categories?.laggards || [];
      const line = (item) => `<div class="list-row"><strong>${esc(item.name || item.id)}</strong><span class="${clsFor(item.market_cap_change_24h_pct)}">${fmtPct(item.market_cap_change_24h_pct)}</span></div>`;
      return `<div class="list">
        <div class="label">Leaders</div>${leaders.slice(0, 5).map(line).join("") || `<div class="empty">No leaders</div>`}
        <div class="label">Laggards</div>${laggards.slice(0, 5).map(line).join("") || `<div class="empty">No laggards</div>`}
      </div>`;
    }
    function qualityBlock(quality) {
      const flags = quality?.flagged_rows || [];
      if (flags.length === 0) return `<div class="quality-flags"><div class="flag-row">All displayed rows passed sanity checks.</div></div>`;
      return `<div class="quality-flags">${flags.map((row) => `
        <div class="flag-row"><strong>${esc(row.symbol)}</strong> ${fmtPct(row.price_change_24h_pct)} / OI ${fmtPct(row.oi_change_24h_pct)}<br>${esc((row.flags || []).join(", "))}</div>
      `).join("")}</div>`;
    }
    function runsBlock(runs) {
      if (!runs || runs.length === 0) return `<div class="empty">No runs</div>`;
      return `<div class="list">${runs.slice(0, 12).map((run) => `
        <div class="list-row"><strong>${esc(run.generated_at)}</strong><span>${esc(run.bias)} / ${esc(run.coinglass_status)} / ${esc(run.row_count)} rows</span></div>
      `).join("")}</div>`;
    }
    function runOptions(runs, selected) {
      $("runSelect").innerHTML = (runs || []).map((run) => `<option value="${esc(run.run_id)}" ${run.run_id === selected ? "selected" : ""}>${esc(run.generated_at)}</option>`).join("");
    }
    async function load(runId = null) {
      const url = runId ? `/api/dashboard?run_id=${encodeURIComponent(runId)}` : "/api/dashboard";
      const data = await fetch(url, { cache: "no-store" }).then((res) => res.json());
      if (data.status !== "ok") {
        $("generated").textContent = "No saved screener runs";
        $("metrics").innerHTML = metric("Database", data.database || "-");
        ["corePanel","longPanel","shortPanel","squeezePanel","fadePanel","providerPanel","qualityPanel","sectorPanel","runsPanel"].forEach((id) => $(id).innerHTML = panel(id, "", `<div class="empty">No data</div>`));
        return;
      }
      state.selectedRun = data.run.run_id;
      runOptions(data.runs, data.run.run_id);
      const c = data.market_context || {};
      const r = data.regime || {};
      $("generated").textContent = `${data.run.generated_at} / ${data.run.row_count} symbols`;
      $("metrics").innerHTML = [
        metric("Bias", r.bias || "unknown", "accent"),
        metric("Factor Regime", r.label || "unknown", "small"),
        metric("Market Cap 24h", fmtPct(c.market_cap_change_24h_pct), clsFor(c.market_cap_change_24h_pct)),
        metric("BTC Dominance", fmtPct(c.btc_dominance_pct, 2).replace("+", "")),
        metric("Trusted", data.quality.trusted_count),
        metric("Excluded", data.quality.excluded_count, data.quality.excluded_count ? "warn" : "good"),
      ].join("");
      $("corePanel").innerHTML = panel("BTC / ETH / SOL", `${data.sections.core.length} rows`, rowsTable(data.sections.core));
      $("longPanel").innerHTML = panel("Top Long Watchlist", `${data.sections.long.length} rows`, rowsTable(data.sections.long));
      $("shortPanel").innerHTML = panel("Top Short Watchlist", `${data.sections.short.length} rows`, rowsTable(data.sections.short));
      $("squeezePanel").innerHTML = panel("Crowded Shorts / Squeeze Risk", `${data.sections.squeeze_risks.length} rows`, rowsTable(data.sections.squeeze_risks));
      $("fadePanel").innerHTML = panel("Crowded Longs To Fade", `${data.sections.crowded_longs.length} rows`, rowsTable(data.sections.crowded_longs));
      $("providerPanel").innerHTML = panel("Providers", "", providerList(data.provider_status));
      $("qualityPanel").innerHTML = panel("Data Quality", `${data.quality.excluded_count} excluded`, qualityBlock(data.quality));
      $("sectorPanel").innerHTML = panel("Sector Rotation", "", sectorList(c));
      $("runsPanel").innerHTML = panel("Recent Runs", `${data.runs.length} loaded`, runsBlock(data.runs));
    }
    $("reload").addEventListener("click", () => load(state.selectedRun));
    $("runSelect").addEventListener("change", (event) => load(event.target.value));
    load().catch((error) => {
      $("generated").textContent = "Dashboard error";
      $("metrics").innerHTML = metric("Error", error.message || String(error), "bad");
    });
  </script>
</body>
</html>
"""


def main() -> int:
    serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
