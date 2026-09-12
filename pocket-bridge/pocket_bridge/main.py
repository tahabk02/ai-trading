"""Entrypoint for the Pocket Option live data bridge.

Run:
    python -m pocket_bridge.main

Env (in `pocket-bridge/.env` or environment):
    POCKET_OPTION_SSID     full `42["auth",{...}]` session cookie (required for live)
    POCKET_BRIDGE_HOST      relay bind host (default 127.0.0.1)
    POCKET_BRIDGE_PORT      relay bind port (default 8788)

The bridge intentionally does NOT fabricate prices. Without a valid SSID it
sits in a clean "awaiting_ssid" state while still exposing the relay so the
backend can observe status/history.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from typing import Dict

from .bridge import PocketOptionBridge
from .config import BridgeSettings, load_settings
from .m20_engine import M20Engine
from .relay import RelayServer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("pocket_bridge.main")


async def amain(settings: BridgeSettings) -> None:
    engine = M20Engine(
        settings.symbols,
        max_history=settings.max_m20_history,
        interval_ms=settings.candle_interval_ms,
        asset_types=settings.asset_types(),
    )
    relay = RelayServer(settings, engine)
    bridge = PocketOptionBridge(settings, engine)

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

    bridge.on_tick = on_tick
    bridge.on_candle = on_candle
    bridge.on_status = on_status
    bridge.on_ready = on_ready
    # Let the relay tell newly connected clients immediately whether the bridge
    # is already ready (see RelayServer.handler).
    relay.is_ready = lambda: bridge.assets_ready

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

    logger.info("pocket-bridge running (SSID present: %s)", settings.has_ssid)
    try:
        await stop.wait()
    except KeyboardInterrupt:
        pass

    poller.cancel()
    periodic.cancel()
    await bridge.stop()
    await relay.close()


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
