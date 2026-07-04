from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from datetime import time as local_time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from .config import load_config_dict
from .dashboard_payload import build_dashboard_payload, latest_run_age_seconds, latest_run_generated_at
from .pipeline import run_pipeline
from .storage import prune_old_runs

DEFAULT_CONFIG_PATH = Path("config/default.json")

DASHBOARD_STATIC_DIR = Path(__file__).with_name("dashboard_static")
DASHBOARD_ASSETS = {
    "/assets/dashboard.css": ("dashboard.css", "text/css; charset=utf-8"),
    "/assets/dashboard.js": ("dashboard.js", "text/javascript; charset=utf-8"),
}


@dataclass(frozen=True)
class DashboardSettings:
    config_path: Path
    db_path: Path
    report_dir: Path
    host: str
    port: int
    limit: int
    auto_refresh_seconds: int
    daily_refresh_times: tuple[local_time, ...]
    refresh_timezone: str
    retain_runs: int
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
            payload, paths = run_pipeline(config, self.settings.report_dir, save=True, write_report_files=False)
            retention = None
            if self.settings.retain_runs > 0:
                retention = prune_old_runs(self.settings.db_path, self.settings.retain_runs)
            finished_at = datetime.now(timezone.utc)
            self.status = {
                "state": "ok",
                "reason": reason,
                "run_id": payload.get("run_id"),
                "generated_at": payload.get("generated_at"),
                "finished_at": finished_at.isoformat(timespec="seconds"),
                "duration_seconds": round((finished_at - started_at).total_seconds(), 2),
                "paths": {key: str(path) for key, path in paths.items()},
                "retention": retention,
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
    config = load_config_dict(config_path)
    db_path = Path(
        os.environ.get("CRYPTO_SCREENER_DB_PATH", config.get("storage_path", "data/crypto_screener.sqlite3"))
    )
    report_dir = Path(os.environ.get("CRYPTO_SCREENER_REPORT_DIR", "reports"))
    return DashboardSettings(
        config_path=config_path,
        db_path=db_path,
        report_dir=report_dir,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
        limit=int(os.environ.get("CRYPTO_DASHBOARD_LIMIT", config.get("report", {}).get("limit", 12))),
        auto_refresh_seconds=int(os.environ.get("CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS", "0")),
        daily_refresh_times=_parse_daily_refresh_times(
            os.environ.get("CRYPTO_DASHBOARD_DAILY_REFRESH_TIME")
            or os.environ.get("CRYPTO_DASHBOARD_REFRESH_TIME")
            or ""
        ),
        refresh_timezone=os.environ.get("CRYPTO_DASHBOARD_REFRESH_TZ", "Asia/Jakarta"),
        retain_runs=int(os.environ.get("CRYPTO_DASHBOARD_RETAIN_RUNS", "0")),
        refresh_token=os.environ.get("CRYPTO_DASHBOARD_REFRESH_TOKEN") or None,
    )


def _load_runtime_config(settings: DashboardSettings) -> dict[str, Any]:
    config = load_config_dict(settings.config_path)
    config["storage_path"] = str(settings.db_path)
    return config


def start_auto_refresh(runtime: RefreshRuntime) -> None:
    if runtime.settings.daily_refresh_times:
        _start_daily_refresh(runtime)
        return

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


def _start_daily_refresh(runtime: RefreshRuntime) -> None:
    zone = ZoneInfo(runtime.settings.refresh_timezone)
    refresh_times = runtime.settings.daily_refresh_times
    if not refresh_times:
        return

    def loop() -> None:
        while True:
            now = datetime.now(zone)
            if _scheduled_refresh_due(runtime.settings.db_path, now, refresh_times):
                status = runtime.refresh("daily")
                if status.get("state") != "ok":
                    time.sleep(300)
                    continue
            time.sleep(_seconds_until_next_daily_check(datetime.now(zone), refresh_times))

    threading.Thread(target=loop, daemon=True).start()


def _parse_daily_refresh_time(raw: str) -> local_time | None:
    value = raw.strip()
    if not value:
        return None
    hour_text, minute_text = value.split(":", 1)
    return local_time(hour=int(hour_text), minute=int(minute_text))


def _parse_daily_refresh_times(raw: str) -> tuple[local_time, ...]:
    times = []
    for part in raw.split(","):
        refresh_time = _parse_daily_refresh_time(part)
        if refresh_time is not None and refresh_time not in times:
            times.append(refresh_time)
    return tuple(sorted(times))


def _scheduled_refresh_due(db_path: Path, now: datetime, refresh_times: tuple[local_time, ...]) -> bool:
    return any(_daily_refresh_due(db_path, now, refresh_time) for refresh_time in refresh_times)


def _daily_refresh_due(db_path: Path, now: datetime, refresh_time: local_time) -> bool:
    target = _scheduled_datetime(now, refresh_time)
    if now < target:
        return False
    latest = latest_run_generated_at(db_path)
    if latest is None:
        return True
    return latest.astimezone(now.tzinfo) < target


def _seconds_until_next_daily_check(now: datetime, refresh_times: tuple[local_time, ...]) -> float:
    targets = [_scheduled_datetime(now, refresh_time) for refresh_time in refresh_times]
    future_targets = [target for target in targets if target > now]
    target = min(future_targets) if future_targets else min(targets) + timedelta(days=1)
    return max(60.0, min((target - now).total_seconds(), 1800.0))


def _scheduled_datetime(now: datetime, refresh_time: local_time) -> datetime:
    return datetime.combine(now.date(), refresh_time, tzinfo=now.tzinfo)


class DashboardHandler(BaseHTTPRequestHandler):
    settings: DashboardSettings
    runtime: RefreshRuntime

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_static_file("index.html", "text/html; charset=utf-8")
            return
        if parsed.path in DASHBOARD_ASSETS:
            filename, content_type = DASHBOARD_ASSETS[parsed.path]
            self._send_static_file(filename, content_type)
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
        print(f"{self.address_string()} - {format % args}")

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

    def _send_static_file(self, filename: str, content_type: str) -> None:
        path = DASHBOARD_STATIC_DIR / filename
        try:
            body = path.read_bytes()
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


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


def main() -> int:
    serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
