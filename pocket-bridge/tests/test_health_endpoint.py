"""MASTER MISSION 2.x — GET /health on the bridge.

Both endpoints are exercised fully offline (no network, no SSID):

* ``test_health_returns_200_on_bridge`` — an HTTP ``GET /health`` against the
  relay server (port 8788 in production) answers 200 with JSON, merging the
  bridge's real ``health_payload()`` with the relay's ``candles_emitted``.
* ``test_health_reports_tick_count`` — a bridge with real tick/candle counters
  surfaces ``ticks_received``/``candles_emitted`` through the HTTP body; a
  live-relay candle broadcast also bumps the relay's own counter (byte-truth:
  the endpoint never fabricates numbers).

Run:  .venv-1\\Scripts\\python -m pytest pocket-bridge/tests/test_health_endpoint.py -q
"""

from __future__ import annotations

import asyncio
import json
import socket
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import websockets  # noqa: E402

from pocket_bridge.bridge import PocketOptionBridge  # noqa: E402
from pocket_bridge.config import BridgeSettings  # noqa: E402
from pocket_bridge.m20_engine import M20Engine  # noqa: E402
from pocket_bridge.relay import RelayServer  # noqa: E402


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _http_get(host: str, port: int, path: str = "/health") -> tuple[int, dict]:
    """Synchronous GET against the relay (websockets' process_request hook)."""
    with urllib.request.urlopen(
        f"http://{host}:{port}{path}", timeout=5
    ) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def test_health_returns_200_on_bridge():
    port = _free_port()
    settings = BridgeSettings(
        relay_host="127.0.0.1", relay_port=port, symbols=["EUR/USD"]
    )
    bridge = PocketOptionBridge(settings, M20Engine(["EUR/USD"]))
    relay = RelayServer(settings, M20Engine(["EUR/USD"]))
    relay.health_provider = bridge.health_payload

    async def run():
        await relay.start()
        try:
            code, body = await asyncio.to_thread(_http_get, "127.0.0.1", port)
        finally:
            await relay.close()
        return code, body

    code, body = asyncio.run(run())
    assert code == 200
    assert isinstance(body, dict)
    for key in (
        "status",
        "ssid_present",
        "ssid_format",
        "last_tick_ts",
        "ticks_received",
        "candles_emitted",
        "symbols",
    ):
        assert key in body, f"payload missing {key}"
    assert body["ticks_received"] == 0
    assert body["candles_emitted"] == 0


def test_health_reports_tick_count():
    port = _free_port()
    settings = BridgeSettings(
        relay_host="127.0.0.1", relay_port=port, symbols=["EUR/USD"]
    )
    bridge = PocketOptionBridge(settings, M20Engine(["EUR/USD"]))
    relay = RelayServer(settings, M20Engine(["EUR/USD"]))
    relay.health_provider = bridge.health_payload

    async def run():
        await relay.start()
        try:
            # A connected client so the relay's candle broadcast is delivered.
            async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                await ws.recv()  # snapshot
                await ws.recv()  # hello
                await relay.broadcast(
                    {"type": "candle", "payload": {"symbol": "EUR/USD"}}
                )
                await ws.recv()  # the candle frame
            # Real bridge counters (no fabrication — these are the exact
            # variables the /health handler sums).
            bridge._tick_count["EUR/USD"] = 7
            bridge._candle_count = 2
            bridge._subs["EUR/USD"] = object()
            code, body = await asyncio.to_thread(_http_get, "127.0.0.1", port)
        finally:
            await relay.close()
        return code, body

    code, body = asyncio.run(run())
    assert code == 200
    assert body["ticks_received"] == 7
    assert body["candles_emitted"] == 1  # relay counter (the one live delivery)
    assert body["status"] in (
        "awaiting_ssid",
        "auth_failed",
        "connected",
        "live",
        "degraded",
    )
    assert "EUR/USD" in body["symbols"]


def test_bridge_health_reports_ssid():
    settings = BridgeSettings(
        ssid='42["auth",{"session":"session-value","uid":123}]',
        symbols=["EUR/USD"],
    )
    bridge = PocketOptionBridge(settings, M20Engine(["EUR/USD"]))

    body = bridge.health_payload()

    assert body["ssid_present"] is True
    assert body["ssid_format"] == "full"
    assert body["last_tick_ts"] is None
    assert body["ticks_received"] == 0
    assert body["candles_emitted"] == 0