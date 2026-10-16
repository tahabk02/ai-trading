"""
test_expiry_engine.py — deterministic expiry + price-target regression vectors.

Covers the PART 52 contract in app/services/expiry_engine.py:

  1. Horizon set + snapping (sub-minute capable {5,15,30,60,300}).
  2. Boundary-aligned expiry timestamps (expiry lands ON a Δt edge).
  3. Price-target regression returns REAL numeric endpoints (never null/mock)
     for a sufficient tape, with a residual-Gaussian confidence band and a
     MODELED directional-hold probability whose basis is disclosed.
  4. The honest withheld path: too-short / degenerate tapes report
     available=False with all-None vectors (no fabricated numbers), and a
     zero-variance tape reports NO probability rather than a fake 100%.

Run:  python -m pytest tests/test_expiry_engine.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.expiry_engine import (  # noqa: E402
    HORIZON_SECONDS,
    MIN_REGRESSION_SAMPLES,
    PROBABILITY_BASIS,
    align_expiry_ms,
    build_expiry_boundaries,
    compute_price_target_regression,
    resolve_horizon_seconds,
    symbol_price_digits,
)


# ── helpers ────────────────────────────────────────────────────────────────


def noisy_uptrend(n: int = 20, base: float = 1.1, step: float = 0.0001):
    """Deterministic (no RNG) drifting tape with small residuals so σ > 0."""
    return [base + step * i + (0.00005 if i % 2 else -0.00005) for i in range(n)]


def noisy_downtrend(n: int = 20, base: float = 1.3, step: float = 0.0001):
    return [base - step * i + (0.00005 if i % 2 else -0.00005) for i in range(n)]


# ── horizon set ────────────────────────────────────────────────────────────


def test_horizon_set_is_sub_minute_capable():
    assert HORIZON_SECONDS == (5, 15, 30, 60, 300)


def test_resolve_horizon_seconds_accepts_supported():
    for s in HORIZON_SECONDS:
        assert resolve_horizon_seconds(s) == s
        assert resolve_horizon_seconds(str(s)) == s


def test_resolve_horizon_seconds_snaps_with_floor_bias():
    assert resolve_horizon_seconds(45) == 30
    assert resolve_horizon_seconds(4) == 5
    assert resolve_horizon_seconds(0) == 5
    assert resolve_horizon_seconds(None) == 5
    assert resolve_horizon_seconds(400) == 300


# ── expiry alignment ───────────────────────────────────────────────────────


def test_align_expiry_exact_boundary_is_preserved():
    # entry + Δt already on a boundary → unchanged.
    assert align_expiry_ms(0, 5) == 5_000
    assert align_expiry_ms(5_000, 5) == 10_000


def test_align_expiry_snaps_forward_to_next_boundary():
    # entry=1000ms, Δt=5s → target 6000ms → next 5s edge = 10000ms.
    assert align_expiry_ms(1_000, 5) == 10_000
    # entry=59000ms, Δt=60s → target 119000ms → next 60s edge = 120000ms.
    assert align_expiry_ms(59_000, 60) == 120_000


def test_align_expiry_is_on_a_horizon_edge():
    for d in HORIZON_SECONDS:
        for entry in (0, 1, 999, 1_234_567, 12_345_678):
            exp = align_expiry_ms(entry, d)
            assert exp % (d * 1000) == 0
            assert exp >= entry + d * 1000


def test_align_expiry_rejects_bad_delta():
    import pytest

    with pytest.raises(ValueError):
        align_expiry_ms(0, 0)


def test_build_expiry_boundaries_shape():
    b = build_expiry_boundaries(1_000, 5)
    assert b == {"entry_ms": 1_000, "expiry_ms": 10_000, "horizon_seconds": 5}


# ── regression: real numeric endpoints ─────────────────────────────────────


def test_regression_returns_real_numeric_endpoints():
    closes = noisy_uptrend()
    out = compute_price_target_regression(
        closes, entry_price=closes[-1], horizon_seconds=60, symbol_digits=5
    )
    assert out["available"] is True
    assert isinstance(out["predicted_end_price"], float)
    assert out["predicted_end_price"] != out["entry_price"]  # a real projection
    assert out["confidence_lower"] < out["confidence_upper"]
    assert out["confidence_margin"] > 0
    assert 0.0 <= out["hold_probability"] <= 1.0
    assert out["probability_basis"] == PROBABILITY_BASIS
    assert out["samples"] == len(closes)
    assert out["regression"]["r2"] > 0.9
    assert out["horizon_seconds"] == 60


def test_regression_direction_honored():
    up = noisy_uptrend()
    out_buy = compute_price_target_regression(
        up, entry_price=up[-1], horizon_seconds=30, direction="BUY"
    )
    assert out_buy["predicted_end_price"] > out_buy["entry_price"]

    down = noisy_downtrend()
    out_sell = compute_price_target_regression(
        down, entry_price=down[-1], horizon_seconds=30, direction="SELL"
    )
    assert out_sell["predicted_end_price"] < out_sell["entry_price"]


def test_regression_is_deterministic():
    closes = noisy_uptrend()
    a = compute_price_target_regression(closes, entry_price=closes[-1], horizon_seconds=15)
    b = compute_price_target_regression(closes, entry_price=closes[-1], horizon_seconds=15)
    assert a == b


# ── regression: honest withheld / degenerate paths ─────────────────────────


def test_regression_withholds_on_short_tape():
    closes = [1.10, 1.1001, 1.1002]
    assert len(closes) < MIN_REGRESSION_SAMPLES
    out = compute_price_target_regression(
        closes, entry_price=closes[-1], horizon_seconds=30
    )
    assert out["available"] is False
    assert out["reason"] == "insufficient_history"
    for key in (
        "predicted_end_price",
        "confidence_lower",
        "confidence_upper",
        "hold_probability",
        "entry_price",
        "probability_basis",
        "regression",
    ):
        assert out[key] is None


def test_regression_flat_tape_has_no_fabricated_probability():
    closes = [1.1] * 20
    out = compute_price_target_regression(
        closes, entry_price=1.1, horizon_seconds=60
    )
    assert out["available"] is True
    assert out["predicted_end_price"] == 1.1
    # Zero residual σ → the model has NO basis for a probability; withhold it.
    assert out["hold_probability"] is None
    assert out["probability_basis"] is None


def test_regression_empty_tape_withholds():
    out = compute_price_target_regression([], entry_price=1.1, horizon_seconds=5)
    assert out["available"] is False
    assert out["samples"] == 0
    assert out["predicted_end_price"] is None


def test_symbol_price_digits():
    assert symbol_price_digits("BTC/USD") == 2
    assert symbol_price_digits("EUR/JPY") == 3
    assert symbol_price_digits("EUR/USD") == 5
