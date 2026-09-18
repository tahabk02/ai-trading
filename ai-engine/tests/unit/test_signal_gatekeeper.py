"""Unit tests for the multi-tier signal gate (signal_gatekeeper parity).

Tier contract:
  T1 >= 0.965, T2 >= 0.90, T3 >= 0.80, T4 >= 0.70, below T4 is T5 (never
  dispatched). The default dispatch bar is T4 (70%), so a verdict is
  executable when its genuine confidence clears the caller's minimum tier.
  HARD_GATE = 0.98 / DEFINITIVE_CONFIDENCE_MIN = 98.0 remain as LEGACY
  aliases for old imports — the tier ladder is the dispatch source of truth.
"""

import pytest

from app.services.signal_gatekeeper import (
    HARD_GATE,
    DEFINITIVE_CONFIDENCE_MIN,
    GATE_REASON,
    TIER_THRESHOLDS,
    TIER_ORDER,
    TIER_RANK,
    TIER_LABELS,
    MIN_EXECUTABLE_TIER,
    scale_for,
    normalize_confidence,
    is_executable,
    is_dispatchable_tier,
    resolve_tier,
    tier_min_confidence,
    tier_rank,
    apply_gate,
)


def test_tier_ladder_canonical_constants():
    assert TIER_ORDER == ["T1", "T2", "T3", "T4"]
    assert TIER_THRESHOLDS["T1"] == pytest.approx(0.965)
    assert TIER_THRESHOLDS["T2"] == pytest.approx(0.90)
    assert TIER_THRESHOLDS["T3"] == pytest.approx(0.80)
    assert TIER_THRESHOLDS["T4"] == pytest.approx(0.70)
    assert MIN_EXECUTABLE_TIER == "T4"
    # Strictly monotonic (strongest first), as enforced at import time.
    for i in range(1, len(TIER_ORDER)):
        assert TIER_THRESHOLDS[TIER_ORDER[i - 1]] > TIER_THRESHOLDS[TIER_ORDER[i]]
    # T5 sits strictly below the weakest tier.
    assert tier_min_confidence("T5") == pytest.approx(0.0)


def test_legacy_hard_gate_aliases_retained():
    assert HARD_GATE == pytest.approx(0.98)
    assert DEFINITIVE_CONFIDENCE_MIN == pytest.approx(98.0)
    assert DEFINITIVE_CONFIDENCE_MIN == pytest.approx(HARD_GATE * 100.0)
    assert GATE_REASON == "TIER_GATE"


def test_tier_ranks_and_labels():
    assert tier_rank("T1") == 4
    assert tier_rank("T2") == 3
    assert tier_rank("T3") == 2
    assert tier_rank("T4") == 1
    assert tier_rank("T5") == 0
    assert tier_rank("bogus") == 0
    assert TIER_LABELS["T1"] == "PREMIUM"
    assert TIER_LABELS["T4"] == "LOW"
    assert TIER_LABELS["T5"] == "WEAK"


def test_is_dispatchable_tier():
    assert is_dispatchable_tier("T1") is True
    assert is_dispatchable_tier("T2") is True
    assert is_dispatchable_tier("T3") is True
    assert is_dispatchable_tier("T4") is True
    assert is_dispatchable_tier("T5") is False
    assert is_dispatchable_tier("T5", min_tier="T4") is False
    assert is_dispatchable_tier("T2", min_tier="T2") is True
    assert is_dispatchable_tier("T3", min_tier="T2") is False


def test_resolve_tier_maps_confidence_to_honest_tier():
    assert resolve_tier(0.965) == "T1"
    assert resolve_tier(0.99) == "T1"
    assert resolve_tier(96.5) == "T1"
    assert resolve_tier(0.90) == "T2"
    assert resolve_tier(0.89) == "T3"
    assert resolve_tier(0.80) == "T3"
    assert resolve_tier(0.79) == "T4"
    assert resolve_tier(0.70) == "T4"
    assert resolve_tier(0.69) == "T5"
    assert resolve_tier(0.0) == "T5"
    assert resolve_tier(None) == "T5"
    assert resolve_tier("junk") == "T5"


def test_scale_for_detects_fraction_and_percent():
    assert scale_for(0.0) == "frac"
    assert scale_for(0.6) == "frac"
    assert scale_for(0.98) == "frac"
    assert scale_for(1.0) == "frac"
    assert scale_for(60.0) == "pct"
    assert scale_for(98.0) == "pct"
    assert scale_for(100.0) == "pct"
    assert scale_for(-1) == "invalid"
    assert scale_for(float("nan")) == "invalid"
    assert scale_for(float("inf")) == "invalid"
    assert scale_for(None) == "invalid"
    assert scale_for("nope") == "invalid"


def test_normalize_confidence_cross_scale():
    assert normalize_confidence(0.6) == pytest.approx(0.6)
    assert normalize_confidence(60.0) == pytest.approx(0.6)
    assert normalize_confidence(0.98) == pytest.approx(0.98)
    assert normalize_confidence(98.0) == pytest.approx(0.98)
    assert normalize_confidence(97) == pytest.approx(0.97)
    assert normalize_confidence(100) == pytest.approx(1.0)
    assert normalize_confidence(0) == pytest.approx(0.0)
    assert normalize_confidence(-5) == pytest.approx(0.0)
    assert normalize_confidence(None) == pytest.approx(0.0)
    assert normalize_confidence("junk") == pytest.approx(0.0)
    assert normalize_confidence(float("inf")) == pytest.approx(0.0)


def test_is_executable_default_t4_bar():
    assert is_executable("BUY", 0.98) is True
    assert is_executable("BUY", 98.0) is True
    assert is_executable("SELL", 0.95) is True
    assert is_executable("SELL", 0.70) is True
    assert is_executable("SELL", 0.69) is False
    assert is_executable("SELL", 0.65) is False
    assert is_executable("BUY", 0.3) is False
    assert is_executable("BUY", 60) is False
    assert is_executable(None, 0.99) is False
    assert is_executable("HOLD", 0.99) is False
    assert is_executable("bogus", 0.99) is False
    assert is_executable("", 0.99) is False


def test_is_executable_custom_min_tier():
    assert is_executable("BUY", 0.70, min_tier="T1") is False
    assert is_executable("BUY", 0.97, min_tier="T1") is True
    assert is_executable("BUY", 0.90, min_tier="T2") is True
    assert is_executable("BUY", 0.89, min_tier="T2") is False
    assert is_executable("BUY", 0.89, min_tier="T3") is True
    assert is_executable("BUY", 0.79, min_tier="T3") is False
    assert is_executable("BUY", 0.79, min_tier="T4") is True


def test_apply_gate_executable_verdict():
    result = apply_gate("BUY", 0.99)
    assert result["signal"] == "BUY"
    assert result["confidence"] == pytest.approx(0.99)
    assert result["confidence_pct"] == pytest.approx(99.0)
    assert result["tier"] == "T1"
    assert result["executable"] is True
    assert result["market_waiting"] is False
    assert result["gate"] is None
    assert result["threshold_pct"] == pytest.approx(70.0)  # default T4 bar


def test_apply_gate_reports_honest_tier_at_each_bar():
    assert apply_gate("BUY", 0.98)["tier"] == "T1"
    assert apply_gate("BUY", 0.94)["tier"] == "T2"
    assert apply_gate("BUY", 0.85)["tier"] == "T3"
    assert apply_gate("BUY", 0.75)["tier"] == "T4"
    assert apply_gate("BUY", 0.69)["tier"] == "T5"


def test_apply_gate_sub_thermal_keeps_direction():
    result = apply_gate("BUY", 37)
    assert result["signal"] == "BUY"  # direction NEVER hidden
    assert result["confidence"] == pytest.approx(0.37)
    assert result["tier"] == "T5"
    assert result["executable"] is False
    assert result["market_waiting"] is True
    assert result["gate"] == "T5"  # names the tier actually reached


def test_apply_gate_t2_to_t5_all_report_waiting_below_bar():
    result = apply_gate("SELL", 0.85, min_tier="T2")
    assert result["tier"] == "T3"
    assert result["executable"] is False
    assert result["market_waiting"] is True
    assert result["gate"] == "T3"
    assert result["threshold_pct"] == pytest.approx(90.0)


def test_apply_gate_non_directional_never_executable():
    for sig in (None, "HOLD", ""):
        result = apply_gate(sig, 0.99)
        assert result["signal"] is None
        assert result["tier"] == "T1"
        assert result["executable"] is False
        assert result["market_waiting"] is False
        assert result["gate"] is None


def test_apply_gate_fractional_confidence_payload():
    result = apply_gate("SELL", 0.98)
    assert result["executable"] is True
    assert result["confidence_pct"] == pytest.approx(98.0)

    result_low = apply_gate("SELL", 0.69)
    assert result_low["executable"] is False
    assert result_low["market_waiting"] is True
    assert result_low["tier"] == "T5"


def test_apply_gate_invalid_inputs_safe_never_executable():
    result = apply_gate("BUY", None)
    assert result["executable"] is False
    assert result["market_waiting"] is True  # direction kept, not dispatched

    result_bad = apply_gate("SELL", "abc")
    assert result_bad["executable"] is False
    assert result_bad["market_waiting"] is True