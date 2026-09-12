"""Tests for the raw PO tick parser (timestamp units + timebase integrity).

The parser MUST pass epoch-millisecond timestamps through untouched: a bare
multiply on ms values pushes every real bucket into the far future. Epoch
seconds are defensively converted. No network / SSID required.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pocket_bridge.bridge import parse_tick  # noqa: E402


def test_epoch_ms_passthrough():
    """~1.7e12 epoch-ms ticks (2026) must NOT be multiplied."""
    now_ms = 1_765_000_000_000
    result = parse_tick({"price": 1.1010, "timestamp": now_ms})
    assert result is not None
    ts, price = result
    assert ts == now_ms
    assert price == 1.1010


def test_epoch_ms_above_1e10_untouched():
    """Any ms value beyond 1e10 is real-world epoch ms — never rescaled."""
    for probe in [11_000_000_000, 1_234_567_890_123, 1_800_000_000_000]:
        ts, _ = parse_tick({"price": 1.0, "timestamp": probe})
        assert ts == probe


def test_epoch_seconds_converted_to_ms():
    """Defensive seconds-value (<1e10) is converted to ms."""
    now_s = 1_765_000_000
    ts, _ = parse_tick({"price": 1.1010, "timestamp": now_s})
    assert ts == now_s * 1000


def test_missing_price_or_ts_returns_none():
    assert parse_tick({"timestamp": 1_765_000_000_000}) is None
    assert parse_tick({"price": 1.10}) is None


def test_non_numeric_ts_returns_none():
    assert parse_tick({"price": 1.10, "timestamp": "not-a-number"}) is None