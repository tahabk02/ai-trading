"""Tests for the raw PO tick parser (timestamp units + timebase integrity).

The parser MUST pass epoch-millisecond timestamps through untouched: a bare
multiply on ms values pushes every real bucket into the far future. Epoch
seconds are defensively converted. No network / SSID required.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pocket_bridge.bridge import (  # noqa: E402
    coerce_tick_payload,
    parse_quote,
    parse_tick,
)


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


def test_binary_utf8_frame_is_decoded():
    now_ms = 1_765_000_000_000
    frame = (
        '42["tick",{"price":1.1010,"timestamp":' + str(now_ms) + "}]"
    ).encode("utf-8")
    result = parse_tick(frame)
    assert result == (now_ms, 1.1010)


def test_memoryview_binary_frame_is_decoded():
    now_ms = 1_765_000_000_000
    frame = memoryview(
        ('451-["tick",{"close":1.25,"time":' + str(now_ms) + "}]").encode()
    )
    result = parse_tick(frame)
    assert result == (now_ms, 1.25)


def test_json_text_frame_without_envelope():
    now_ms = 1_765_000_000_000
    result = parse_quote(
        '{"bid":1.1000,"ask":1.1004,"timestamp":%d}' % now_ms,
        now_ms=now_ms,
    )
    assert result is not None
    assert result["price"] == "1.1002"
    assert result["synthetic_quote"] is False


def test_update_assets_frame_is_not_a_tick():
    frame = '451-["updateAssets",{"EURUSD_otc":true}]'
    assert coerce_tick_payload(frame) == {"EURUSD_otc": True}
    assert parse_tick(frame) is None


def test_unparseable_binary_frame_returns_none():
    assert coerce_tick_payload(b"\xff\xfe\x00") is None
    assert parse_tick(b"not-json") is None