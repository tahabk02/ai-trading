"""
test_departure_line.py — exact strike + entry-window departure contract.

Covers ``compute_departure_line`` in app/services/expiry_engine.py (the
"Ligne du Départ" / exact-entry overlay):

  1. WAITING_FOR_VALID_ENTRY_LEVEL (all-None levels) when the regression is
     unavailable or a level is missing/degenerate — never a synthetic price.
  2. ACTIVE inside the entry window and within slippage tolerance.
  3. PENDING before the window opens; EXPIRED_ZONE after it closes.
  4. MISSED_ENTRY when the live price has drifted beyond the ATR-derived
     ``max_allowed_slippage``.
  5. Side normalisation (BUY→CALL, SELL→PUT) and honest None when ATR is absent
     (no fabricated tolerance).

Run:  python -m pytest tests/test_departure_line.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.expiry_engine import (  # noqa: E402
    DEPARTURE_ACTIVE,
    DEPARTURE_EXPIRED_ZONE,
    DEPARTURE_MISSED_ENTRY,
    DEPARTURE_PENDING,
    DEPARTURE_WAITING,
    SLIPPAGE_ATR_FRACTION,
    compute_departure_line,
    compute_price_target_regression,
)


# ── helpers ────────────────────────────────────────────────────────────────


def noisy_uptrend(n: int = 20, base: float = 1.1, step: float = 0.0001):
    return [base + step * i + (0.00005 if i % 2 else -0.00005) for i in range(n)]


def real_regression(direction: str = "BUY"):
    closes = noisy_uptrend()
    return compute_price_target_regression(
        closes,
        entry_price=closes[-1],
        horizon_seconds=60,
        direction=direction,
        symbol_digits=5,
    )


def test_keys_present_in_every_state():
    out = compute_departure_line(None)
    assert set(out) == {
        "available",
        "status",
        "reason",
        "side",
        "strike_price",
        "target_price",
        "entry_window_start_ms",
        "entry_window_end_ms",
        "max_allowed_slippage",
        "slippage",
    }


# ── honest waiting state ─────────────────────────────────────────────────────


def test_waiting_when_regression_missing():
    out = compute_departure_line(None)
    assert out["available"] is False
    assert out["status"] == DEPARTURE_WAITING
    assert out["strike_price"] is None
    assert out["target_price"] is None


def test_waiting_when_regression_unavailable():
    withheld = compute_price_target_regression(
        [1.1, 1.11, 1.12], entry_price=1.12, horizon_seconds=30
    )
    assert withheld["available"] is False
    out = compute_departure_line(withheld, side="BUY")
    assert out["status"] == DEPARTURE_WAITING
    assert out["reason"] == "regression_unavailable"
    assert out["strike_price"] is None


def test_waiting_when_level_missing():
    # available=True but no entry/target level → withhold, never guess.
    out = compute_departure_line(
        {"available": True, "entry_price": None, "predicted_end_price": 1.2}
    )
    assert out["status"] == DEPARTURE_WAITING
    assert out["reason"] == "levels_unavailable"


# ── level mapping ────────────────────────────────────────────────────────────


def test_strike_is_real_entry_and_target_is_projection():
    reg = real_regression("BUY")
    out = compute_departure_line(
        reg, side="BUY", entry_ms=1_000_000, expiry_ms=1_060_000, now_ms=1_000_000
    )
    assert out["available"] is True
    assert out["status"] == DEPARTURE_ACTIVE
    assert out["strike_price"] == reg["entry_price"]
    assert out["target_price"] == reg["predicted_end_price"]
    assert out["entry_window_start_ms"] == 1_000_000
    assert out["entry_window_end_ms"] == 1_060_000


def test_side_normalisation():
    reg = real_regression("BUY")
    assert (
        compute_departure_line(reg, side="BUY", now_ms=0)["side"] == "CALL"
    )
    assert (
        compute_departure_line(reg, side="SELL", now_ms=0)["side"] == "PUT"
    )
    # Falls back to the regression direction when no side is supplied.
    assert compute_departure_line(reg, now_ms=0)["side"] == "CALL"


# ── status precedence ────────────────────────────────────────────────────────


def test_pending_before_window_opens():
    reg = real_regression("BUY")
    out = compute_departure_line(
        reg, side="BUY", entry_ms=2_000_000, expiry_ms=2_060_000, now_ms=1_000_000
    )
    assert out["status"] == DEPARTURE_PENDING
    assert out["reason"] == "awaiting_entry_window"


def test_expired_zone_after_window_closes():
    reg = real_regression("BUY")
    out = compute_departure_line(
        reg, side="BUY", entry_ms=1_000_000, expiry_ms=1_060_000, now_ms=1_100_000
    )
    assert out["status"] == DEPARTURE_EXPIRED_ZONE
    assert out["reason"] == "entry_window_elapsed"


def test_missed_entry_when_slippage_exceeds_tolerance():
    reg = real_regression("BUY")
    strike = reg["entry_price"]
    atr = 0.01
    # price drifts 10× the tolerance away from the strike, inside the window.
    out = compute_departure_line(
        reg,
        side="BUY",
        atr=atr,
        entry_ms=1_000_000,
        expiry_ms=1_060_000,
        current_price=strike + atr * 10,
        now_ms=1_010_000,
    )
    assert out["max_allowed_slippage"] == round(
        atr * SLIPPAGE_ATR_FRACTION, 5
    )
    assert out["slippage"] is not None
    assert out["status"] == DEPARTURE_MISSED_ENTRY
    assert out["reason"] == "slippage_exceeded"


def test_active_when_within_tolerance():
    reg = real_regression("BUY")
    strike = reg["entry_price"]
    out = compute_departure_line(
        reg,
        side="BUY",
        atr=0.01,
        entry_ms=1_000_000,
        expiry_ms=1_060_000,
        current_price=strike + 0.001,
        now_ms=1_010_000,
    )
    assert out["status"] == DEPARTURE_ACTIVE
    assert out["max_allowed_slippage"] is not None


def test_no_atr_means_no_fabricated_slippage_tolerance():
    reg = real_regression("BUY")
    out = compute_departure_line(
        reg, side="BUY", entry_ms=1_000_000, expiry_ms=1_060_000, now_ms=1_010_000
    )
    assert out["max_allowed_slippage"] is None
    assert out["slippage"] is None
    # Without a tolerance there is nothing to breach → ACTIVE.
    assert out["status"] == DEPARTURE_ACTIVE


def test_is_deterministic():
    reg = real_regression("SELL")
    a = compute_departure_line(reg, side="SELL", atr=0.002, now_ms=5)
    b = compute_departure_line(reg, side="SELL", atr=0.002, now_ms=5)
    assert a == b
