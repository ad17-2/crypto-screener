import copy
import json
import tempfile
import threading
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from urllib.request import urlopen
from zoneinfo import ZoneInfo

from crypto_screener.dashboard import (
    DASHBOARD_STATIC_DIR,
    DashboardHandler,
    DashboardServer,
    DashboardSettings,
    RefreshRuntime,
    _daily_refresh_due,
    _parse_daily_refresh_time,
    _parse_daily_refresh_times,
    _scheduled_refresh_due,
    _seconds_until_next_daily_check,
    build_dashboard_payload,
)
from crypto_screener.storage import connect, prune_old_runs, save_snapshot


class DashboardTests(unittest.TestCase):
    def test_dashboard_reads_latest_run_from_sqlite(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "screener.sqlite3"
            config = {"storage_path": str(db_path)}
            payload = {
                "run_id": "run-1",
                "generated_at": "2026-07-02T09:00:00+07:00",
                "market_context": {
                    "market_cap_change_24h_pct": 1.2,
                    "btc_dominance_pct": 55.5,
                    "categories": {"leaders": [], "laggards": []},
                    "breadth": {"status": "ok", "label": "selective-risk-on", "score": 0.31},
                    "sector_rotation": {"status": "ok", "label": "selective-sector-bid"},
                },
                "provider_status": {"coinglass": {"status": "ok", "rows": 2}},
                "regime": {"bias": "risk-on", "label": "momentum", "breadth_label": "selective-risk-on"},
                "factor_weights": {
                    "mode": "prior",
                    "validation": {
                        "status": "limited",
                        "horizon_hours": 12,
                        "observations": 8,
                        "model": {"hit_rate": 62.5},
                        "factors": {
                            "momentum_24h": {"hit_rate": 75.0, "observations": 4},
                            "reversal_1d": {"hit_rate": 40.0, "observations": 4},
                        },
                    },
                },
                "rows": [
                    {
                        "symbol": "BTC",
                        "price_usd": 100,
                        "price_change_24h_pct": 1,
                        "oi_change_24h_pct": 2,
                        "funding_rate_pct": 0.01,
                        "quote_volume_usd": 100_000_000,
                        "data_source": "coinglass",
                        "primary_exchange": "OKX",
                        "is_trusted": True,
                        "data_quality_score": 100,
                        "factor_score": 0.2,
                        "long_score": 30,
                        "short_score": 0,
                        "crowded_long_score": 0,
                        "squeeze_risk_score": 0,
                        "confidence_score": 72,
                        "technical_setup": "Trend Continuation",
                        "technical_interval": "4h",
                        "technical_candle_count": 220,
                        "rsi_14": 61,
                        "atr_14_pct": 2.1,
                        "technical_trend_score": 0.8,
                        "technical_momentum_score": 0.5,
                        "signal_conflict_label": "minor-conflict",
                        "signal_conflict_score": 24,
                        "signal_conflicts": [{"code": "market_breadth", "label": "market breadth", "severity": 0.3}],
                        "regime_alignment_score": 0.5,
                        "breadth_alignment_score": -0.3,
                        "scores": {"factor_score": 0.2, "long_score": 30, "confidence_score": 72},
                        "factors": {"momentum_24h": 1.0, "technical_trend_4h": 0.8},
                    },
                    {
                        "symbol": "ODD",
                        "price_usd": 1,
                        "price_change_24h_pct": 400,
                        "oi_change_24h_pct": 10,
                        "funding_rate_pct": 0.01,
                        "quote_volume_usd": 100_000_000,
                        "data_source": "coinglass",
                        "is_trusted": False,
                        "data_quality_score": 75,
                        "data_quality_flags": ["extreme_24h_price_change:+400.00%"],
                        "factor_score": 0,
                        "long_score": 0,
                        "short_score": 0,
                        "crowded_long_score": 0,
                        "squeeze_risk_score": 0,
                        "scores": {},
                        "factors": {},
                    },
                ],
            }

            save_snapshot(payload, config)
            next_payload = copy.deepcopy(payload)
            next_payload["run_id"] = "run-2"
            next_payload["generated_at"] = "2026-07-02T12:00:00+07:00"
            next_payload["rows"][0]["price_usd"] = 105
            next_payload["rows"][0]["long_score"] = 35
            next_payload["rows"][0]["scores"]["long_score"] = 35
            save_snapshot(next_payload, config)
            dashboard = build_dashboard_payload(db_path, limit=5)

        self.assertEqual(dashboard["status"], "ok")
        self.assertEqual(dashboard["regime"]["bias"], "risk-on")
        self.assertEqual(dashboard["market_context"]["breadth"]["label"], "selective-risk-on")
        self.assertEqual(dashboard["validation"]["status"], "limited")
        self.assertEqual(dashboard["validation"]["model_hit_rate"], 62.5)
        self.assertEqual(dashboard["validation"]["calibration_label"], "learning")
        self.assertEqual(dashboard["validation"]["best_factors"][0]["label"], "Momentum")
        self.assertEqual(dashboard["freshness"]["status"], "ok")
        self.assertEqual(dashboard["sector_breadth"]["groups"][0]["sector"], "BTC / Store of Value")
        self.assertEqual(dashboard["quality"]["trusted_count"], 1)
        self.assertEqual(dashboard["quality"]["excluded_count"], 1)
        self.assertEqual(dashboard["sections"]["long"][0]["symbol"], "BTC")
        self.assertTrue(dashboard["sections"]["long"][0]["reason_parts"])
        self.assertEqual(dashboard["sections"]["long"][0]["reason_parts"][0]["label"], "24h")
        self.assertEqual(dashboard["watchlists"][0]["id"], "chart_next")
        self.assertEqual(dashboard["watchlists"][1]["id"], "regime_fit")
        self.assertEqual(dashboard["watchlists"][2]["id"], "long")
        long_row = dashboard["watchlists"][2]["rows"][0]
        self.assertEqual(long_row["setup"], "Trend Continuation Long")
        self.assertGreater(long_row["priority"], 0)
        self.assertEqual(long_row["confidence_score"], 72)
        self.assertEqual(long_row["signal_conflict_label"], "minor-conflict")
        self.assertEqual(long_row["signal_conflict_score"], 24)
        self.assertEqual(long_row["sector"], "BTC / Store of Value")
        self.assertIn("read", long_row["explanation"])
        self.assertIn("Signals", [part["label"] for part in long_row["reason_parts"]])
        self.assertEqual(long_row["technical_state"]["rsi_14"], 61)
        self.assertTrue(long_row["factor_parts"])
        self.assertEqual(len(long_row["history"]), 2)
        self.assertEqual(long_row["history"][0]["confidence_score"], 72)
        self.assertEqual(dashboard["runs"][0]["coinglass_status"], "ok")

    def test_prune_old_runs_keeps_only_latest_snapshot(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "screener.sqlite3"
            config = {"storage_path": str(db_path)}
            for run_id, generated_at, symbol in (
                ("run-1", "2026-07-01T06:00:00+07:00", "BTC"),
                ("run-2", "2026-07-02T06:00:00+07:00", "ETH"),
            ):
                save_snapshot(
                    {
                        "run_id": run_id,
                        "generated_at": generated_at,
                        "rows": [{"symbol": symbol, "price_usd": 100}],
                    },
                    config,
                )

            result = prune_old_runs(db_path, keep=1)
            dashboard = build_dashboard_payload(db_path, limit=5)
            conn = connect(db_path)
            try:
                factor_history_count = conn.execute("SELECT COUNT(*) AS count FROM factor_history").fetchone()["count"]
            finally:
                conn.close()

        self.assertEqual(result["kept_runs"], 1)
        self.assertEqual(result["deleted_runs"], 1)
        self.assertEqual(dashboard["run"]["run_id"], "run-2")
        self.assertEqual([run["run_id"] for run in dashboard["runs"]], ["run-2"])
        self.assertEqual(factor_history_count, 2)

    def test_daily_refresh_due_after_scheduled_time_only_once_per_day(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "screener.sqlite3"
            refresh_time = _parse_daily_refresh_time("06:00")
            zone = ZoneInfo("Asia/Jakarta")

            self.assertIsNotNone(refresh_time)
            self.assertFalse(_daily_refresh_due(db_path, datetime(2026, 7, 3, 5, 59, tzinfo=zone), refresh_time))
            self.assertTrue(_daily_refresh_due(db_path, datetime(2026, 7, 3, 6, 0, tzinfo=zone), refresh_time))

            save_snapshot(
                {
                    "run_id": "today",
                    "generated_at": "2026-07-03T06:05:00+07:00",
                    "rows": [{"symbol": "BTC", "price_usd": 100}],
                },
                {"storage_path": str(db_path)},
            )

            self.assertFalse(_daily_refresh_due(db_path, datetime(2026, 7, 3, 12, 0, tzinfo=zone), refresh_time))
            self.assertTrue(_daily_refresh_due(db_path, datetime(2026, 7, 4, 6, 0, tzinfo=zone), refresh_time))

    def test_daily_refresh_supports_multiple_times_per_day(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "screener.sqlite3"
            refresh_times = _parse_daily_refresh_times("15:10,07:10,11:10,07:10")
            zone = ZoneInfo("Asia/Jakarta")

            self.assertEqual([item.strftime("%H:%M") for item in refresh_times], ["07:10", "11:10", "15:10"])
            self.assertFalse(_scheduled_refresh_due(db_path, datetime(2026, 7, 3, 7, 9, tzinfo=zone), refresh_times))
            self.assertTrue(_scheduled_refresh_due(db_path, datetime(2026, 7, 3, 7, 10, tzinfo=zone), refresh_times))

            save_snapshot(
                {
                    "run_id": "morning",
                    "generated_at": "2026-07-03T07:15:00+07:00",
                    "rows": [{"symbol": "BTC", "price_usd": 100}],
                },
                {"storage_path": str(db_path)},
            )

            self.assertFalse(_scheduled_refresh_due(db_path, datetime(2026, 7, 3, 10, 59, tzinfo=zone), refresh_times))
            self.assertTrue(_scheduled_refresh_due(db_path, datetime(2026, 7, 3, 11, 10, tzinfo=zone), refresh_times))

            save_snapshot(
                {
                    "run_id": "midday",
                    "generated_at": "2026-07-03T11:20:00+07:00",
                    "rows": [{"symbol": "BTC", "price_usd": 101}],
                },
                {"storage_path": str(db_path)},
            )

            self.assertFalse(_scheduled_refresh_due(db_path, datetime(2026, 7, 3, 15, 9, tzinfo=zone), refresh_times))
            self.assertTrue(_scheduled_refresh_due(db_path, datetime(2026, 7, 3, 15, 10, tzinfo=zone), refresh_times))
            self.assertEqual(
                _seconds_until_next_daily_check(datetime(2026, 7, 3, 15, 11, tzinfo=zone), refresh_times),
                1800.0,
            )

    def test_dashboard_static_assets_keep_watchlist_ui_contract(self):
        index = (DASHBOARD_STATIC_DIR / "index.html").read_text()
        css = (DASHBOARD_STATIC_DIR / "dashboard.css").read_text()
        js = (DASHBOARD_STATIC_DIR / "dashboard.js").read_text()
        combined = "\n".join([index, css, js])

        self.assertIn('/assets/dashboard.css', index)
        self.assertIn('/assets/dashboard.js', index)
        self.assertNotIn("<style>", index)
        self.assertIn("reasonTooltip", js)
        self.assertIn("help-tip", css)
        self.assertIn("tooltip-popover", css)
        self.assertIn("reason_parts", js)
        self.assertIn("confidence_score", js)
        self.assertIn("technicalBlock", js)
        self.assertIn("watchTabs", index)
        self.assertIn("watchTable", index)
        self.assertIn("detailPanel", index)
        self.assertIn("validationPanel", index)
        self.assertIn("module-grid", index)
        self.assertIn("sparkline", js)
        self.assertNotIn("<div>Trend</div>", js)
        self.assertNotIn('data-label="Trend"', js)
        self.assertIn("filterValues", js)
        self.assertIn("factorBars", js)
        self.assertIn("validationBlock", js)
        self.assertIn("freshnessBlock", js)
        self.assertIn("conflictBlock", js)
        self.assertIn("explanationBlock", js)
        self.assertIn("sector_breadth", js)
        self.assertIn("Regime Fit", js)
        self.assertIn("module-panel", css)
        self.assertIn("detail-section", css)
        self.assertIn("module-grid", css)
        self.assertIn("sector-list", css)
        self.assertIn("summary::after", css)
        self.assertIn("conflict-badge", css)
        self.assertIn("explanation-box", css)
        self.assertIn("Use Top Setups first -> filter -> inspect detail -> open TradingView.", js)
        self.assertIn("sector_rotation", js)
        self.assertIn('class="watch-row', js)
        self.assertIn('class="watch-cell', js)
        self.assertIn('class="detail-rail"', index)
        self.assertIn("sourceTags(row.data_source)", js)
        self.assertIn("tradingViewSymbol", js)
        self.assertIn("${tradingViewExchange(row?.primary_exchange)}:${base}USDT.P", js)
        self.assertIn("GATEIO", js)
        self.assertIn("https://www.tradingview.com/chart/?symbol=", js)
        self.assertIn("rel=\"noopener noreferrer\"", js)
        self.assertIn("qualityFlagChip", js)
        self.assertNotIn("table-wrap", combined)
        self.assertNotIn("<table>", combined)
        self.assertNotIn('class="row-cell"', combined)
        self.assertNotIn('colspan="9"', combined)
        self.assertNotIn("function rowsTable", combined)
        self.assertNotIn("<th class=\"reason\">", combined)
        self.assertNotIn('class="reason-row"', combined)

    def test_dashboard_serves_index_assets_and_empty_api(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "missing.sqlite3"
            settings = DashboardSettings(
                config_path=Path("config/default.json"),
                db_path=db_path,
                report_dir=Path(tmpdir) / "reports",
                host="127.0.0.1",
                port=0,
                limit=5,
                auto_refresh_seconds=0,
                daily_refresh_times=(),
                refresh_timezone="Asia/Jakarta",
                retain_runs=0,
                refresh_token=None,
            )
            handler = type(
                "TestDashboardHandler",
                (DashboardHandler,),
                {"settings": settings, "runtime": RefreshRuntime(settings)},
            )
            server = DashboardServer((settings.host, settings.port), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                status, content_type, body = self._get(server, "/")
                self.assertEqual(status, 200)
                self.assertEqual(content_type, "text/html; charset=utf-8")
                self.assertIn('/assets/dashboard.css', body)
                self.assertIn('/assets/dashboard.js', body)

                status, content_type, body = self._get(server, "/assets/dashboard.css")
                self.assertEqual(status, 200)
                self.assertEqual(content_type, "text/css; charset=utf-8")
                self.assertIn(".watch-row", body)

                status, content_type, body = self._get(server, "/assets/dashboard.js")
                self.assertEqual(status, 200)
                self.assertEqual(content_type, "text/javascript; charset=utf-8")
                self.assertIn("reasonTooltip", body)

                status, content_type, body = self._get(server, "/api/dashboard")
                self.assertEqual(status, 200)
                self.assertEqual(content_type, "application/json; charset=utf-8")
                payload = json.loads(body)
                self.assertEqual(payload["status"], "empty")
                self.assertEqual(payload["runs"], [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_dashboard_refresh_saves_sqlite_without_report_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            settings = DashboardSettings(
                config_path=Path("config/default.json"),
                db_path=Path(tmpdir) / "screener.sqlite3",
                report_dir=Path(tmpdir) / "reports",
                host="127.0.0.1",
                port=0,
                limit=5,
                auto_refresh_seconds=0,
                daily_refresh_times=(),
                refresh_timezone="Asia/Jakarta",
                retain_runs=1,
                refresh_token=None,
            )
            runtime = RefreshRuntime(settings)
            payload = {
                "run_id": "run-refresh",
                "generated_at": "2026-07-03T06:00:00+07:00",
            }

            with patch("crypto_screener.dashboard.run_pipeline", return_value=(payload, {})) as run_pipeline:
                status = runtime.refresh("test")

        self.assertEqual(status["state"], "ok")
        self.assertEqual(status["run_id"], "run-refresh")
        self.assertEqual(status["paths"], {})
        self.assertEqual(status["retention"], {"kept_runs": 0, "deleted_runs": 0, "deleted_rows": 0})
        run_pipeline.assert_called_once()
        self.assertIs(run_pipeline.call_args.kwargs["save"], True)
        self.assertIs(run_pipeline.call_args.kwargs["write_report_files"], False)

    def test_existing_runs_table_gets_dashboard_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "legacy.sqlite3"
            raw = connect(db_path)
            raw.execute("DROP TABLE runs")
            raw.execute(
                """
                CREATE TABLE runs (
                    run_id TEXT PRIMARY KEY,
                    generated_at TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    context_json TEXT NOT NULL,
                    provider_status_json TEXT NOT NULL
                )
                """
            )
            raw.commit()
            raw.close()

            conn = connect(db_path)
            try:
                columns = {row["name"] for row in conn.execute("PRAGMA table_info(runs)")}
            finally:
                conn.close()

        self.assertIn("regime_json", columns)
        self.assertIn("factor_weights_json", columns)

    def _get(self, server: DashboardServer, path: str) -> tuple[int, str, str]:
        host, port = server.server_address
        with urlopen(f"http://{host}:{port}{path}", timeout=5) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read().decode("utf-8")


if __name__ == "__main__":
    unittest.main()
