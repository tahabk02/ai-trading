"""Tests for the Phase-1 upgraded streaming core:

* Zero-drop closed-candle emit (every finalized bucket, not just the last).
* Unified relay emit (monotonic ``seq`` + UTC-ms ``ts_utc`` on every frame).
* Outbox non-blocking broadcast preserves per-client ordering.
* Control frames (ping -> pong).

Runs fully offline — no network, no SSID.
Run:  .venv-1\\Scripts\\python -m pytest pocket-bridge/tests -q
"""

from __future__ import annotations

import asyncio
import json
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import websockets  # noqa: E402

from pocket_bridge.config import BridgeSettings  # noqa: E402
from pocket_bridge.m20_engine import M20Engine  # noqa: E402
from pocket_bridge.relay import RelayServer  # noqa: E402


# ── Zero-drop closed-candle emit ─────────────────────────────────────────────

def test_handle_tick_all_emits_every_closed_bucket():
    """A fast tape that crosses several buckets in one tick must emit each
    bucket's close in order — the old single-return API dropped intermediates."""
    engine = M20Engine(["TEST/USD"], interval_ms=1_000)
    engine.handle_tick_all("TEST/USD", 1.00, 1_000)
    engine.handle_tick_all("TEST/USD", 1.01, 1_500)
    engine.handle_tick_all("TEST/USD", 1.02, 3_100)
    engine.handle_tick_all("TEST/USD", 1.03, 4_100)
    engine.handle_tick_all("TEST/USD", 1.04, 5_200)
    # One tick at 8_100 -> watermark 5_100 drains pending through bucket 3_000,
    # finalizing BOTH bucket 1_000 and bucket 3_000 in a single flush.
    closed = engine.handle_tick_all("TEST/USD", 1.05, 8_100)
    assert [c.time for c in closed] == [1_000, 3_000]
    assert [float(c.close) for c in closed] == [1.01, 1.02]
    assert all(c.closed for c in closed)


def test_handle_tick_single_view_backward_compat():
    """``handle_tick`` keeps returning the last closed candle or None."""
    engine = M20Engine(["TEST/USD"], interval_ms=1_000)
    engine.handle_tick_all("TEST/USD", 1.00, 1_000)
    engine.handle_tick_all("TEST/USD", 1.01, 1_500)
    engine.handle_tick_all("TEST/USD", 1.02, 3_100)
    engine.handle_tick_all("TEST/USD", 1.03, 4_100)
    engine.handle_tick_all("TEST/USD", 1.04, 5_200)
    closed = engine.handle_tick("TEST/USD", 1.05, 8_100)
    assert closed is not None and closed.closed and closed.time == 3_000


def test_candle_dict_numbers_and_exact_fields():
    """Relay candles carry NUMBER OHLC (Node contract) + ``*_exact`` strings."""
    engine = M20Engine(["TEST/USD"], interval_ms=1_000)
    engine.handle_tick_all("TEST/USD", 1.23456789, 1_000)
    engine.handle_tick_all("TEST/USD", 1.235, 8_100)
    engine.handle_tick_all("TEST/USD", 1.236, 12_000)
    closed = engine.snapshot("TEST/USD")["closed_candles"]
    assert len(closed) == 1
    c = closed[0]
    assert c["open"] == 1.23456789 and isinstance(c["open"], float)
    assert c["close"] == 1.23456789
    assert c["open_exact"] == "1.23456789"
    assert c["time"] == 1_000


# ── Unified relay emit + outbox ordering ─────────────────────────────────────

def _free_ports(count=1):
    ports = []
    socks = []
    for _ in range(count):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        socks.append(s)
        ports.append(s.getsockname()[1])
    for s in socks:
        s.close()
    return ports


def test_relay_unified_emit_seq_ts_utc():
    port = _free_ports()[0]
    settings = BridgeSettings(relay_host="127.0.0.1", relay_port=port, symbols=["EUR/USD"])
    engine = M20Engine(["EUR/USD"])
    relay = RelayServer(settings, engine)

    async def run():
        await relay.start()
        frames = []
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            await relay.broadcast({
                "type": "tick",
                "payload": {"symbol": "EUR/USD", "price": 1.1010,
                            "ts_ms": 1_765_000_000_000,
                            "ts_utc": 1_765_000_000},
            })
            for _ in range(3):
                frames.append(json.loads(await ws.recv()))
        await relay.close()
        return frames

    frames = asyncio.run(run())
    assert [f["type"] for f in frames] == ["snapshot", "hello", "tick"]
    tick = frames[2]
    assert tick["payload"]["price"] == 1.1010
    assert isinstance(tick["seq"], int) and tick["seq"] > 0
    assert isinstance(tick["ts_utc"], int) and tick["ts_utc"] > 1_700_000_000_000
    seqs = [f["seq"] for f in frames]
    assert seqs == sorted(seqs)  # monotonic, never reordered


def test_relay_ping_pong():
    port = _free_ports()[0]
    settings = BridgeSettings(relay_host="127.0.0.1", relay_port=port, symbols=["EUR/USD"])
    relay = RelayServer(settings, M20Engine(["EUR/USD"]))

    async def run():
        await relay.start()
        frame = None
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            # drain the initial snapshot + hello
            await ws.recv()
            await ws.recv()
            await ws.send("ping")
            frame = json.loads(await ws.recv())
        await relay.close()
        return frame

    frame = asyncio.run(run())
    assert frame["type"] == "pong"
    assert frame["payload"] == {"ok": True}