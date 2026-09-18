"""Entrypoint for the Pocket Option live data bridge.

Run:
    python -m pocket_bridge.main

Env (in `pocket-bridge/.env` or environment):
    POCKET_OPTION_SSID     full `42["auth",{...}]` session cookie (required for live)
    POCKET_BRIDGE_HOST      relay bind host (default 0.0.0.0)
    POCKET_BRIDGE_PORT      relay bind port (default 8788)

The bridge intentionally does NOT fabricate prices. Without a valid SSID it
sits in a clean "awaiting_ssid" state while still exposing the relay so the
backend can observe status/history.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread
from typing import Dict

from .bridge import PocketOptionBridge
from .config import (
    BridgeSettings,
    load_settings,
    load_stored_session,
    mask_secret,
)
from .m20_engine import M20Engine
from .relay import RelayServer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("pocket_bridge.main")


async def amain(settings: BridgeSettings) -> None:
    logger.info(
        "SSID loaded: format=%s length=%d uid=%s isDemo=%s isOptimized=%s",
        settings.ssid_format,
        len(settings.ssid),
        settings.uid,
        settings.is_demo,
        settings.auth.get("isOptimized", False),
    )
    engine = M20Engine(
        settings.symbols,
        max_history=settings.max_m20_history,
        interval_ms=settings.candle_interval_ms,
        asset_types=settings.asset_types(),
    )
    relay = RelayServer(settings, engine)

    # ── SESSION LOADING ──
    stored_session = load_stored_session(settings.session_path_resolved)
    if stored_session.exists:
        age = stored_session.age_days
        logger.info(
            "session loaded captured_at=%s age=%.1f days cookies=%d ua=%s",
            stored_session.captured_at or "?",
            age,
            len(stored_session.cookies),
            mask_secret(stored_session.user_agent),
        )
        if age > settings.session_max_age_days:
            logger.warning(
                "SESSION_OLD — age %.1f days > %d days; consider re-capturing",
                age, settings.session_max_age_days,
            )
    elif settings.has_ssid:
        logger.warning(
            "session file missing; using POCKET_OPTION_SSID from .env (run "
            "capture_session.py to persist a browser session)"
        )
    else:
        logger.critical(
            "NO_SESSION — run capture_session.py first (no po_session.json "
            "and no POCKET_OPTION_SSID in .env)"
        )

    bridge = PocketOptionBridge(settings, engine, session=stored_session)
    relay.health_provider = bridge.health_payload

    # Wire bridge -> relay.
    async def on_tick(payload: Dict) -> None:
        await relay.broadcast({"type": "tick", "payload": payload})

    async def on_candle(candle) -> None:
        await relay.broadcast({"type": "candle", "payload": candle.to_dict()})

    async def on_status(payload: Dict) -> None:
        await relay.broadcast({"type": "status", "payload": payload})
        await relay.broadcast({"type": "snapshot", "payload": engine.snapshots()})

    async def on_ready() -> None:
        # Explicit readiness handshake: the Node backend holds its subscribe
        # pushes (staged in poArmedByClient) until this frame so it never races
        # Python's asset initialisation.
        await relay.broadcast(
            {"type": "ready", "payload": {"assets_initialized": True}}
        )

    async def on_heartbeat(payload: Dict) -> None:
        await relay.broadcast({"type": "heartbeat", "payload": payload})

    bridge.on_tick = on_tick
    bridge.on_candle = on_candle
    bridge.on_status = on_status
    bridge.on_heartbeat = on_heartbeat
    bridge.on_ready = on_ready
    # Let the relay tell newly connected clients immediately whether the bridge
    # is already ready (see RelayServer.handler).
    relay.is_ready = lambda: bridge.assets_ready
    relay.asset_provider = bridge.available_assets_payload

    async def on_unsubscribe(_websocket, payload: Dict) -> None:
        await bridge.request_unsubscription(str(payload.get("symbol", "")))

    relay.on_unsubscribe = on_unsubscribe

    # ── INITIAL TICK HANDSHAKE ──
    # A relay client (the Node backend, acting on a browser subscribe) pushes
    # the ACTIVE symbol so the bridge arms its live tick reader immediately and
    # replies with a `subscribed` confirmation carrying the held price + candles
    # — the WAITING lock clears the instant the handshake completes, not when
    # the first fresh tick happens to crawl through.
    async def on_subscribe(websocket, payload: dict) -> None:
        symbol = payload.get("symbol") if isinstance(payload, dict) else None
        result = await bridge.request_subscription(symbol or "")
        await relay.send(websocket, {"type": "subscribed", "payload": result})
        result_symbol = result.get("symbol") if isinstance(result, dict) else None
        if result_symbol:
            snap = engine.snapshot(result_symbol)
            if snap is not None:
                await relay.broadcast({"type": "snapshot", "payload": [snap]})

    relay.on_subscribe = on_subscribe

    await relay.start()

    async def periodic_holder() -> None:
        """Periodically push the held forming candle so the backend's
        last-valid-price hold stays warm even when no ticks arrive."""
        while True:
            await asyncio.sleep(1)
            for symbol in engine.symbols:
                forming = engine.forming(symbol)
                if forming is not None:
                    await on_candle(forming)

    await bridge.start()
    periodic = asyncio.create_task(periodic_holder())

    stop = asyncio.Event()

    def _sig(*_):
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _sig)
        except (NotImplementedError, RuntimeError):
            # Windows does not support loop.add_signal_handler; fall back to a
            # polling approach driven by the periodic task below.
            break

    async def _poll_stop() -> None:
        while not stop.is_set():
            await asyncio.sleep(0.5)

    poller = asyncio.create_task(_poll_stop())

    logger.info(
        "pocket-bridge running (session=%s ssid_present=%s status=%s)",
        mask_secret(stored_session.raw_ssid, 4),
        stored_session.has_ssid or settings.has_ssid,
        bridge.status,
    )

    # ── /health HTTP ENDPOINT (3.3) ──
    health_port = (settings.relay_port + 1) % 65_536

    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - HTTP method name
            uptime_s = None
            if bridge.connected_at is not None:
                uptime_s = round(max(0.0, time.time() - bridge.connected_at), 1)
            body = json.dumps(
                {
                    "ok": True,
                    "status": bridge.status,
                    "ssid_present": bridge.has_credential,
                    "ssid_format": bridge.settings.ssid_format,
                    "last_tick_ts": (
                        max(bridge._last_tick_source_ts.values(), default=None)
                    ),
                    "ticks_received": sum(bridge._tick_count.values()),
                    "candles_emitted": bridge._candle_count,
                    "session_file_present": bool(stored_session.exists),
                    "is_optimized": bool(
                        bridge.settings.auth.get("isOptimized")
                    ),
                    "symbols": sorted(bridge._subs),
                    "session_expired": bridge.session_expired,
                    "session_file": bool(stored_session.exists),
                    "session_age_days": round(stored_session.age_days, 1),
                    "cookies": len(stored_session.cookies),
                    "connect_epoch": bridge.connect_epoch,
                    "tick_seq": bridge._tick_seq,
                    "subscribed_symbols": len(bridge._subs),
                    "connected_at": bridge.connected_at,
                    "uptime_s": uptime_s,
                }
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

        def log_message(self, fmt, *args):  # pragma: no cover
            logger.debug("health>%s", fmt % args)

    health_server: HTTPServer | None = None
    health_thread: Thread | None = None
    try:
        health_server = HTTPServer(("0.0.0.0", health_port), HealthHandler)
        health_thread = Thread(target=health_server.serve_forever, daemon=True)
        health_thread.start()
        logger.info("health endpoint listening on http://0.0.0.0:%d/health", health_port)
    except OSError as exc:
        logger.warning("could not start health endpoint on port %d: %s", health_port, exc)
    try:
        await stop.wait()
    except KeyboardInterrupt:
        pass

    poller.cancel()
    periodic.cancel()
    await bridge.stop()
    await relay.close()
    if health_server is not None:
        try:
            health_server.shutdown()
        except Exception:  # noqa: BLE001 - best-effort
            pass


def main() -> None:
    settings = load_settings()
    try:
        asyncio.run(amain(settings))
    except KeyboardInterrupt:
        pass
    except RuntimeError as exc:
        if "relay port" in str(exc):
            logger.error("%s", exc)
            raise SystemExit(1) from exc
        raise


if __name__ == "__main__":
    main()
