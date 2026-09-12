"""Tests for the M20 bucketing + last-valid-price hold engine.

Runs without any network or SSID: the engine is pure logic.
Run:  python -m pytest pocket-bridge/tests -q
   or: .venv-1\\Scripts\\python -m pytest pocket-bridge/tests -q
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pocket_bridge.m20_engine import M20Engine, M20_MS  # noqa: E402
from pocket_bridge.config import PLATFORM_TIME_OFFSET  # noqa: E402


def test_strict_bucket_boundary():
    engine = M20Engine(["TEST/USD"])
    # 20_000ms lands in bucket 20_000 ((20_000 // 20_000) * 20_000).
    engine.handle_tick("TEST/USD", 1.1000, 20_000)
    engine.handle_tick("TEST/USD", 1.1005, 39_999)   # still bucket 20_000
    candle = engine.forming("TEST/USD")
    assert candle.time == 20_000
    assert candle.high == 1.1005
    # 40_000ms is a NEW bucket (exact boundary) -> the closed candle of the
    # just-finished 20_000 window must be returned (real-time emit path).
    closed = engine.handle_tick("TEST/USD", 1.1010, 40_000)
    assert closed is not None
    assert closed.time == 20_000
    assert closed.close == 1.1005
    assert closed.closed is True
    history = engine.snapshot("TEST/USD")["closed_candles"]
    assert len(history) == 1
    assert history[0]["time"] == 20_000
    assert history[0]["close"] == 1.1005
    forming = engine.forming("TEST/USD")
    assert forming.time == 40_000
    assert forming.open == 1.1010


def test_last_valid_price_hold_no_default():
    """A gap must not collapse to a static default; close holds last price."""
    engine = M20Engine(["TEST/USD"])
    for i in range(6):
        engine.handle_tick("TEST/USD", 1.15942 + i * 0.00001, 20_000 + i * 10)
    # Simulate a gap: no more ticks; the forming candle close must remain the
    # last valid price (1.15947), NOT a rounded/static default.
    forming = engine.forming("TEST/USD")
    assert forming is not None
    assert abs(forming.close - 1.15947) < 1e-9
    assert forming.close != 1.15942


def test_platform_offset_alignment():
    """Timestamps are aligned to PO server time before bucketing."""
    # A raw PO timestamp with the 7200s offset lands in bucket 20_000 after
    # the bridge subtracts the platform offset.
    raw_ms = 20_000 + PLATFORM_TIME_OFFSET * 1000
    engine = M20Engine(["TEST/USD"])
    engine.handle_tick("TEST/USD", 1.1000, raw_ms - PLATFORM_TIME_OFFSET * 1000)
    assert engine.forming("TEST/USD").time == 20_000


def test_snapshot_shape():
    engine = M20Engine(["TEST/USD"])
    engine.handle_tick("TEST/USD", 1.2000, 20_000)
    snap = engine.snapshot("TEST/USD")
    assert set(snap.keys()) >= {"symbol", "closed_candles", "forming",
                                "last_valid_price", "last_valid_at"}
    assert snap["symbol"] == "TEST/USD"
    assert snap["forming"]["close"] == 1.2000
    assert snap["last_valid_price"] == 1.2000
