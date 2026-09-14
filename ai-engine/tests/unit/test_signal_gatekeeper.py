"""Unit tests for the STRICT 96.5% hard gate (signal_gatekeeper parity)."""

import pytest

from app.services.signal_gatekeeper import (
    HARD_GATE,
    DEFINITIVE_CONFIDENCE_MIN,
    GATE_REASON,
    scale_for,
    normalize_confidence,
    is_executable,
    apply_gate,
)


def test_hard_gate_canonical_constants():
    assert HARD_GATE == 0.965
    assert DEFINITIVE_CONFIDENCE_MIN == 96.5
    assert GATE_REASON == "HARD_GATE"


def test_scale_for_detects_fraction_and_percent():
    assert scale_for(0.0) == "frac"
    assert scale_for(0.965) == "frac"
    assert scale_for(1.0) == "frac"
    assert scale_for(96.5) == "pct"
    assert scale_for(100.0) == "pct"
    assert scale_for(-1) == "invalid"
    assert scale_for(float("nan")) == "invalid"
    assert scale_for(float("inf")) == "invalid"
    assert scale_for(None) == "invalid"
    assert scale_for("nope") == "invalid"


def test_normalize_confidence_cross_scale():
    assert normalize_confidence(0.965) == pytest.approx(0.965)
    assert normalize_confidence(96.5) == pytest.approx(0.965)
    assert normalize_confidence(97) == pytest.approx(0.97)
    assert normalize_confidence(100) == pytest.approx(1.0)
    assert normalize_confidence(0) == pytest.approx(0.0)
    assert normalize_confidence(-5) == pytest.approx(0.0)
    assert normalize_confidence(None) == pytest.approx(0.0)
    assert normalize_confidence("junk") == pytest.approx(0.0)
    assert normalize_confidence(float("inf")) == pytest.approx(0.0)


def test_is_executable_hard_gate():
    assert is_executable("BUY", 0.965) is True
    assert is_executable("BUY", 96.5) is True
    assert is_executable("SELL", 0.98) is True
    assert is_executable("SELL", 0.96) is False
    assert is_executable("BUY", 0.8) is False
    assert is_executable(None, 0.99) is False
    assert is_executable("HOLD", 0.99) is False
    assert is_executable("bogus", 0.99) is False
    assert is_executable("", 0.99) is False


def test_is_executable_custom_threshold():
    assert is_executable("BUY", 0.7, threshold=0.75) is False
    assert is_executable("BUY", 0.7, threshold=0.6) is True
    assert is_executable("BUY", 0.7, threshold=1.0) is False


def test_apply_gate_executable_verdict():
    result = apply_gate("BUY", 0.97)
    assert result["signal"] == "BUY"
    assert result["confidence"] == pytest.approx(0.97)
    assert result["confidence_pct"] == pytest.approx(97.0)
    assert result["executable"] is True
    assert result["market_waiting"] is False
    assert result["gate"] is None
    assert result["threshold_pct"] == pytest.approx(96.5)


def test_apply_gate_sub_thermal_keeps_direction():
    result = apply_gate("BUY", 37)
    assert result["signal"] == "BUY"  # direction NEVER hidden
    assert result["confidence"] == pytest.approx(0.37)
    assert result["executable"] is False
    assert result["market_waiting"] is True
    assert result["gate"] == "HARD_GATE"


def test_apply_gate_non_directional_never_executable():
    for sig in (None, "HOLD", ""):
        result = apply_gate(sig, 0.99)
        assert result["signal"] is None
        assert result["executable"] is False
        assert result["market_waiting"] is False
        assert result["gate"] is None


def test_apply_gate_fractional_confidence_payload():
    result = apply_gate("SELL", 0.965)
    assert result["executable"] is True
    assert result["confidence_pct"] == pytest.approx(96.5)

    result_low = apply_gate("SELL", 0.9649)
    assert result_low["executable"] is False
    assert result_low["market_waiting"] is True


def test_apply_gate_invalid_inputs_safe_never_executable():
    result = apply_gate("BUY", None)
    assert result["executable"] is False
    assert result["market_waiting"] is True  # direction kept, not dispatched

    result_bad = apply_gate("SELL", "abc")
    assert result_bad["executable"] is False
    assert result_bad["market_waiting"] is True