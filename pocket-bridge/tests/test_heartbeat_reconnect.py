"""Heartbeat/keepalive and reconnect-ladder regressions.

Covers the 60s Pocket Option stream timeout fix:

  * a 25s application keepalive is sent on the live SDK socket;
  * the 5s watchdog recycles a connected-but-silent stream at the 50s stale
    threshold, before the server's ~60s cutoff;
  * a half-open client is released so readers rebuild it;
  * the native SDK handshake budget can never fall back to 60s;
  * the reader backoff resets after real auth/tick progress instead of staying
    pinned at 60s.
"""

from __future__ import annotations

import asyncio
import time

from pocket_bridge.bridge import PocketOptionBridge
from pocket_bridge.config import BridgeSettings
from pocket_bridge.m20_engine import M20Engine


def _settings(**overrides) -> BridgeSettings:
    return BridgeSettings(
        ssid="",
        symbols=[],
        session_path="",
        refresh_at_startup=False,
        **overrides,
    )


def _bridge(**overrides) -> PocketOptionBridge:
    return PocketOptionBridge(_settings(**overrides), M20Engine([], max_history=10))


class _ConnectedClient:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.disconnected = False

    def is_connected(self) -> bool:
        return True

    async def send_raw_message(self, message: str) -> None:
        self.sent.append(message)

    async def disconnect(self) -> None:
        self.disconnected = True


class _FailingKeepaliveClient(_ConnectedClient):
    async def send_raw_message(self, message: str) -> None:
        raise RuntimeError("channel closed")


def test_heartbeat_defaults_are_25s_and_50s():
    settings = _settings()
    assert settings.heartbeat_interval == 25.0
    assert settings.stream_stale_after == 50.0
    assert settings.keepalive_message == '42["ping"]'


def test_native_handshake_budget_can_never_be_60s():
    assert _settings(po_init_timeout=60.0).po_init_timeout >= 90.0
    assert _settings(po_init_timeout=120.0).po_init_timeout == 120.0


def test_heartbeat_sends_keepalive_on_a_quiet_live_stream():
    bridge = _bridge()
    client = _ConnectedClient()
    bridge.client = client
    bridge.status = "connected"
    bridge._subs = {"EUR/USD": object()}
    bridge._tick_count = {"EUR/USD": 1}
    bridge._last_tick_ts = {"EUR/USD": time.time()}

    asyncio.run(bridge._heartbeat_tick())

    assert client.sent == ['42["ping"]']
    assert client.disconnected is False
    assert bridge.status == "connected"


def test_stale_stream_is_recycled_before_60s_and_preserves_otc_state():
    bridge = _bridge()
    client = _ConnectedClient()
    bridge.client = client
    bridge.status = "connected"
    bridge._subs = {"EUR/USD_otc": object()}
    bridge._dynamic_symbols = {"EUR/USD"}
    bridge._tick_count = {"EUR/USD": 3}
    bridge._last_tick_ts = {"EUR/USD": time.time() - 51.0}
    bridge.engine.ensure_feed("EUR/USD", "otc")
    bridge.engine.handle_tick_all("EUR/USD", 1.1010, 1_000)

    asyncio.run(bridge._heartbeat_tick(send_keepalive=False, emit=False))

    assert client.disconnected is True
    assert bridge.client is None
    assert bridge.status == "stalled"
    assert "reconnecting" in (bridge.last_error or "")
    # The engine tape + desired dynamic subscription survive the recycle.
    assert bridge._dynamic_symbols == {"EUR/USD"}
    assert bridge.engine.snapshot("EUR/USD") is not None


def test_failed_keepalive_releases_half_open_client():
    bridge = _bridge()
    client = _FailingKeepaliveClient()
    bridge.client = client
    bridge.status = "connected"
    bridge._subs = {"EUR/USD": object()}

    asyncio.run(bridge._heartbeat_tick())

    assert client.disconnected is True
    assert bridge.client is None
    assert bridge.status == "connection_error"
    assert "keepalive failed" in (bridge.last_error or "")


def test_reader_backoff_resets_after_auth_or_ticks():
    bridge = _bridge()
    bridge.connect_epoch = 4
    bridge._tick_seq = 10
    assert bridge._stream_progressed(4, 10) is False
    assert bridge._stream_progressed(3, 10) is True
    assert bridge._stream_progressed(4, 9) is True
