"""
test_min_confidence_filter.py — USER-SET MINIMUM CONFIDENCE FILTER.

The dashboard's Confidence Filter (default 96.5%, range 50..99) sends a
``min_confidence`` field on /predict. This suite proves the engine honors it:

  1. ``_resolve_execution_bar`` — the effective executable bar:
       * absent        -> engine default STRICT_EXECUTION_CONFIDENCE (96.5),
       * user value    -> the user's pct (50..99),
       * never floored below T4 (70%) so sub-tradable-tier verdicts can never
         become executable by lowering the filter.
  2. ``apply_strict_execution_gate`` — a verdict below the USER bar is demoted
     to SCORED-ONLY even if it would pass the 96.5% default; one at/above the
     user bar is tradable even if below the 96.5% default.
  3. ``build_execution_surface`` (full OTC path) — threshold_pct / bar_source
     ride the surface and the executable verdict follows the effective bar.
  4. POST /api/v1/predict — accepts ``min_confidence``, echoes the effective
     bar, and rejects out-of-range values with a 400 (pydantic ge=50, le=99).

Run:  python -m pytest tests/test_min_confidence_filter.py -q
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.services.execution_gate import build_execution_surface
from app.services.signal_gatekeeper import (
    REGIME_GATE_PENDING_HIGH_PRECISION,
    REGIME_GATE_TRADABLE,
    STRICT_EXECUTION_CONFIDENCE,
    SUPPRESSED_REASON_HIGH_PRECISION,
    _resolve_execution_bar,
    apply_strict_execution_gate,
)


# ── fixtures ────────────────────────────────────────────────────────────────

def _otc_clean_trend(n: int = 60, step: float = 0.001, start: float = 1.10) -> list:
    """Monotonic accelerating micro-ramp that clears the OTC HF filter (BUY)."""
    return [start + step * i for i in range(n)]


def make_candles(closes, base_spread=0.0008, volume=None):
    closes = list(closes)
    candles = []
    for i, c in enumerate(closes):
        o = closes[i - 1] if i > 0 else c * (1 - base_spread)
        hi = max(o, c) * (1 + base_spread)
        lo = min(o, c) * (1 - base_spread)
        candles.append(
            {
                "timestamp": i * 60_000,
                "open": round(o, 6),
                "high": round(hi, 6),
                "low": round(lo, 6),
                "close": round(c, 6),
                "volume": (volume[i] if volume is not None else 1000.0),
            }
        )
    return candles


# ── 1 ── _resolve_execution_bar ─────────────────────────────────────────────

def test_bar_default_when_filter_absent():
    frac, pct, source = _resolve_execution_bar(None)
    assert frac == pytest.approx(STRICT_EXECUTION_CONFIDENCE)
    assert pct == pytest.approx(96.5)
    assert source == "default"


def test_bar_user_override():
    frac, pct, source = _resolve_execution_bar(90.0)
    assert frac == pytest.approx(0.90)
    assert pct == pytest.approx(90.0)
    assert source == "user"


def test_bar_floored_at_t4_when_user_dips_below_70():
    for low in (50.0, 55.0, 69.9, 0.0):
        frac, pct, source = _resolve_execution_bar(low)
        assert frac == pytest.approx(0.70), low
        assert pct == pytest.approx(70.0), low
        assert source == "floored", low


def test_bar_exactly_t4_is_user_not_floored():
    frac, pct, source = _resolve_execution_bar(70.0)
    assert frac == pytest.approx(0.70)
    assert source == "user"


# ── 2 ── apply_strict_execution_gate ────────────────────────────────────────

def test_gate_user_bar_above_default_demotes_otherwise_tradable():
    out = apply_strict_execution_gate("BUY", 97.0, min_confidence=99.0)
    assert out["executable"] is False
    assert out["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION
    assert out["suppressed_reason"] == SUPPRESSED_REASON_HIGH_PRECISION
    assert out["signal"] == "BUY"
    assert out["threshold_pct"] == pytest.approx(99.0)
    assert out["bar_source"] == "user"


def test_gate_user_bar_below_default_marks_previously_scored_only_executable():
    out = apply_strict_execution_gate("BUY", 90.0, min_confidence=90.0)
    assert out["executable"] is True
    assert out["regime_gate"] == REGIME_GATE_TRADABLE
    assert out["suppressed_reason"] is None
    assert out["tier"] == "T2"          # honest resolved tier
    assert out["threshold_pct"] == pytest.approx(90.0)
    assert out["bar_source"] == "user"

    below = apply_strict_execution_gate("BUY", 89.9, min_confidence=90.0)
    assert below["executable"] is False
    assert below["suppressed_reason"] == SUPPRESSED_REASON_HIGH_PRECISION


def test_gate_at_the_user_bar_is_executable():
    out = apply_strict_execution_gate("SELL", 80.0, min_confidence=80.0)
    assert out["executable"] is True
    assert out["threshold_pct"] == pytest.approx(80.0)


def test_gate_user_bar_floored_never_unlocks_sub_t4():
    # User asks 55% but the effective bar is floored at T4 (70%): a 65%
    # verdict must stay SCORED-ONLY; a 70% one becomes tradable.
    low = apply_strict_execution_gate("BUY", 65.0, min_confidence=55.0)
    assert low["executable"] is False
    assert low["threshold_pct"] == pytest.approx(70.0)
    assert low["bar_source"] == "floored"

    at_floor = apply_strict_execution_gate("BUY", 70.0, min_confidence=55.0)
    assert at_floor["executable"] is True
    assert at_floor["bar_source"] == "floored"


def test_gate_default_bar_unchanged_when_filter_absent():
    out = apply_strict_execution_gate("BUY", 96.5)
    assert out["executable"] is True
    assert out["threshold_pct"] == pytest.approx(96.5)
    assert out["bar_source"] == "default"


def test_gate_class_gate_still_vetoes_even_below_user_bar():
    out = apply_strict_execution_gate(
        "BUY", 80.0,
        asset_class="REAL",
        class_gate={"passes": False, "reason": "spread_too_wide", "score": 0.4},
        min_confidence=80.0,
    )
    assert out["executable"] is False
    assert out["suppressed_reason"] == "spread_too_wide"


# ── 3 ── build_execution_surface (full OTC path) ────────────────────────────

def test_surface_otc_user_bar_enables_below_default_confidence():
    series = _otc_clean_trend()
    surface = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=90.0, bid=series[-1] * 0.9999, ask=series[-1],
        live_price=series[-1], timeframe="1m", min_confidence=90.0,
    )
    assert surface["executable"] is True
    assert surface["threshold_pct"] == pytest.approx(90.0)
    assert surface["bar_source"] == "user"


def test_surface_otc_user_bar_above_engine_bar_demotes_definitive():
    series = _otc_clean_trend()
    surface = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=97.0, bid=series[-1] * 0.9999, ask=series[-1],
        live_price=series[-1], timeframe="1m", min_confidence=99.0,
    )
    assert surface["executable"] is False
    assert surface["suppressed_reason"] == SUPPRESSED_REASON_HIGH_PRECISION
    assert surface["threshold_pct"] == pytest.approx(99.0)
    assert surface["bar_source"] == "user"


def test_surface_otc_user_bar_floored():
    series = _otc_clean_trend()
    low = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=65.0, bid=series[-1] * 0.9999, ask=series[-1],
        live_price=series[-1], timeframe="1m", min_confidence=55.0,
    )
    assert low["executable"] is False
    assert low["threshold_pct"] == pytest.approx(70.0)
    assert low["bar_source"] == "floored"

    at_floor = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=70.0, bid=series[-1] * 0.9999, ask=series[-1],
        live_price=series[-1], timeframe="1m", min_confidence=55.0,
    )
    assert at_floor["executable"] is True
    assert at_floor["bar_source"] == "floored"


def test_surface_default_bar_when_no_filter():
    series = _otc_clean_trend()
    surface = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=96.5, bid=series[-1] * 0.9999, ask=series[-1],
        live_price=series[-1], timeframe="1m",
    )
    assert surface["executable"] is True
    assert surface["threshold_pct"] == pytest.approx(96.5)
    assert surface["bar_source"] == "default"


# ── 4 ── POST /api/v1/predict ───────────────────────────────────────────────

def _predict_client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def test_predict_400_when_min_confidence_out_of_range():
    client = _predict_client()
    closes = [120.0 + i * 0.05 for i in range(95)]
    candles = make_candles(closes)
    for bad in (10.0, 49.9, 99.1, 120.0, -1.0):
        payload = {
            "symbol": "USD/JPY",
            "timeframe": "1m",
            "candles": candles,
            "live_price": float(closes[-1]),
            "dataSource": "forex_otc_test",
            "min_confidence": bad,
        }
        resp = client.post("/api/v1/predict", json=payload)
        assert resp.status_code == 400, bad


def test_predict_accepts_min_confidence_and_stamps_bar_source():
    client = _predict_client()
    closes = [120.0 + i * 0.05 for i in range(95)]
    candles = make_candles(closes)
    base = {
        "symbol": "USD/JPY",
        "timeframe": "1m",
        "candles": candles,
        "live_price": float(closes[-1]),
        "dataSource": "forex_otc_test",
    }
    strict = client.post("/api/v1/predict", json={**base, "min_confidence": 99.0})
    assert strict.status_code == 200
    body = strict.json()
    assert body["threshold_pct"] == pytest.approx(99.0)
    assert body["bar_source"] == "user"

    floored = client.post("/api/v1/predict", json={**base, "min_confidence": 55.0})
    assert floored.status_code == 200
    body = floored.json()
    assert body["threshold_pct"] == pytest.approx(70.0)
    assert body["bar_source"] == "floored"

    default = client.post("/api/v1/predict", json=base)
    assert default.status_code == 200
    body = default.json()
    assert body["threshold_pct"] == pytest.approx(96.5)
    assert body["bar_source"] == "default"


def main():
    raise SystemExit(pytest.main([__file__, "-q"]))


if __name__ == "__main__":
    main()