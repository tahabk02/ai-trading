"""No-data stream stall handling.

The SDK raises ``Subscription stream timed out after 60s waiting for data``
when the socket authenticates but the session is not authorised for market
data (expired / incomplete SSID). That must not reconnect forever: after
repeated consecutive strikes with zero ticks the bridge stops and asks for a
fresh capture, exactly like a terminal SSID parse failure.
"""

from __future__ import annotations

import asyncio

from pocket_bridge.bridge import (
    STREAM_TIMEOUT_STREAK_LIMIT,
    PocketOptionBridge,
)
from pocket_bridge.config import BridgeSettings
from pocket_bridge.m20_engine import M20Engine

_TIMEOUT_MSG = (
    "General(\"Subscription stream timed out after 60s waiting for data "
    "from EURUSD\")"
)


def _bridge() -> PocketOptionBridge:
    settings = BridgeSettings(
        ssid="",
        symbols=[],
        session_path="",
        refresh_at_startup=False,
    )
    bridge = PocketOptionBridge(settings, M20Engine([], max_history=10))
    bridge.session.raw_ssid = "token"
    return bridge


def test_stream_timeout_matcher_is_specific():
    bridge = _bridge()
    assert bridge._is_stream_timeout(TimeoutError(_TIMEOUT_MSG)) is True
    assert bridge._is_stream_timeout(RuntimeError("network unreachable")) is False


def test_repeated_no_tick_timeouts_trip_terminal_expiry(monkeypatch):
    bridge = _bridge()
    refreshes = {"count": 0}

    async def fake_reader(symbol: str, asset: str) -> None:
        raise TimeoutError(_TIMEOUT_MSG)

    async def fake_refresh() -> bool:
        refreshes["count"] += 1
        return False

    async def no_sleep(_seconds: float) -> None:
        return None

    async def no_release() -> None:
        return None

    monkeypatch.setattr(bridge, "run_reader", fake_reader)
    monkeypatch.setattr(bridge, "_run_refresh_once", fake_refresh)
    monkeypatch.setattr(bridge, "_release_client", no_release)
    monkeypatch.setattr(asyncio, "sleep", no_sleep)

    asyncio.run(bridge._reader_loop("EUR/USD", "EURUSD"))

    assert bridge._stream_timeout_streak == STREAM_TIMEOUT_STREAK_LIMIT
    assert bridge.session_expired is True
    assert bridge._retry_stopped is True
    assert refreshes["count"] == 1


def test_any_tick_resets_the_strike_counter(monkeypatch):
    bridge = _bridge()
    calls = {"n": 0}

    async def fake_reader(symbol: str, asset: str) -> None:
        calls["n"] += 1
        if calls["n"] <= 2:
            bridge._tick_seq += 1
        elif calls["n"] >= 4:
            raise asyncio.CancelledError
        raise TimeoutError(_TIMEOUT_MSG)

    async def no_sleep(_seconds: float) -> None:
        return None

    async def no_release() -> None:
        return None

    async def no_refresh() -> bool:
        return False

    monkeypatch.setattr(bridge, "run_reader", fake_reader)
    monkeypatch.setattr(bridge, "_release_client", no_release)
    monkeypatch.setattr(bridge, "_run_refresh_once", no_refresh)
    monkeypatch.setattr(asyncio, "sleep", no_sleep)

    try:
        asyncio.run(bridge._reader_loop("EUR/USD", "EURUSD"))
    except asyncio.CancelledError:
        pass

    assert bridge._stream_timeout_streak == 1
    assert bridge.session_expired is False
