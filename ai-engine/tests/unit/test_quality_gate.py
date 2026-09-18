"""
test_quality_gate.py — MULTI-TIER ENSEMBLE WATERSHED (5-FACTOR LOCK)

The quality gate now resolves the ensemble score onto the SAME canonical
multi-tier ladder as the confluence gate (signal_gatekeeper):

  GATE_WEIGHTS  = mtf .25 | momentum .25 | volatility .15 | volume .15 | pressure .20
  ensemble_score = Σ weight × factor (every factor is an honest 0|1)
  EMIT ⇔ ensemble tier is dispatchable (>= T4-LOW 0.70), resolved honestly:
      5/5 = 1.00 → T1 PREMIUM · 4/5 = 0.75-0.85 → T4/T3 · 3/5 = 0.60 → T5 BLOCK.

A single failed factor no longer blankets-everything sub-thermal: it honestly
downgrades the emission to the tier the real evidence supports.
"""

import pytest

from app.services.signal_gatekeeper import TIER_THRESHOLDS, MIN_EXECUTABLE_TIER
from app.services.quality_gate import (
    GATE_WEIGHTS,
    FACTOR_ORDER,
    QUALITY_EMIT_BAR,
    evaluate_quality,
    compute_factor_scores,
    apply_quality_gate,
    current_hard_gate,
    quality_score,
)
from app.services.accuracy_tracker import AccuracyTracker


def _strong_uptrend(n: int = 900) -> dict:
    import random

    rng = random.Random(42)
    closes = [1.10]
    for _ in range(1, n):
        closes.append(closes[-1] * (1.0018 + rng.uniform(0.0, 0.0006)))
    highs = [c * 1.001 for c in closes]
    lows = [c * 0.999 for c in closes]
    volumes = [1000.0 + float(i) for i in range(n)]
    return {"close": closes, "high": highs, "low": lows, "volume": volumes}


def _aligned_inputs() -> dict:
    return {
        "timeframes": {"1m": _strong_uptrend(), "5m": _strong_uptrend()},
        "price": 1.10,
        "atr": 0.0015,           # ratio 0.00136 — inside [0.0008, 0.005]
        "volume": 2000.0,
        "volume_sma20": 1000.0,  # 2.0x surge >= 1.5x
        "buy_volume": 1400.0,
        "sell_volume": 600.0,    # buy share 0.70 (> 0.60 for BUY)
    }


# ── 1 ── the quality bar is the weakest EXECUTABLE tier (T4=0.70)
def test_quality_emit_bar_is_weakest_tier():
    assert QUALITY_EMIT_BAR == pytest.approx(TIER_THRESHOLDS[MIN_EXECUTABLE_TIER])
    assert QUALITY_EMIT_BAR == pytest.approx(0.70)
    assert current_hard_gate() == pytest.approx(0.70)
    assert round(sum(GATE_WEIGHTS.values()), 6) == pytest.approx(1.0)
    assert FACTOR_ORDER == ["mtf", "momentum", "volatility", "volume", "pressure"]


# ── 2 ── a one-timeframe window admits no MTF confluence → honest T4 emission
def test_mtf_single_tf_downgrades_to_t4():
    from unittest.mock import patch

    inputs = _aligned_inputs()
    inputs["timeframes"] = {"1m": _strong_uptrend()}
    with patch("app.services.quality_gate._tf_aligned", return_value=True):
        factors = compute_factor_scores(inputs, "BUY")
    assert factors["mtf"] == 0               # one TF can never claim confluence
    assert factors["momentum"] == 1
    verdict = evaluate_quality(factors)
    assert verdict["decision"] == "EMIT"
    assert verdict["tier"] == "T4"          # 0.75 — honest LOW, not a hard block
    assert verdict["tier_label"] == "LOW"


# ── 3 ── momentum disagreement (weight .25 loss → 0.75) = honest T4
def test_momentum_failure_downgrades_to_t4():
    verdict = evaluate_quality(
        {"mtf": 1, "momentum": 0, "volatility": 1, "volume": 1, "pressure": 1}
    )
    assert verdict["decision"] == "EMIT"
    assert verdict["tier"] == "T4"
    assert verdict["quality"] == pytest.approx(0.75)


# ── 4 ── wild/crushed volatility (ATR outside band) = honest T3
def test_volatility_failure_downgrades_to_t3():
    verdict = evaluate_quality(
        {"mtf": 1, "momentum": 1, "volatility": 0, "volume": 1, "pressure": 1}
    )
    assert verdict["decision"] == "EMIT"
    assert verdict["tier"] == "T3"      # 0.85 → MEDIUM
    assert verdict["quality"] == pytest.approx(0.85)


# ── 5 ── no real volume surge → honest T3
def test_volume_failure_downgrades_to_t3():
    verdict = evaluate_quality(
        {"mtf": 1, "momentum": 1, "volatility": 1, "volume": 0, "pressure": 1}
    )
    assert verdict["decision"] == "EMIT"
    assert verdict["tier"] == "T3"
    assert verdict["reason"] == "ALL_FACTORS_ALIGNED"


# ── 6 ── balanced order-flow (not one-sided) → honest T3
def test_pressure_failure_downgrades_to_t3():
    inputs = _aligned_inputs()
    inputs["buy_volume"] = 1000.0
    inputs["sell_volume"] = 1000.0  # buy share 0.50 — not one-sided
    factors = compute_factor_scores(inputs, "BUY")
    assert factors["pressure"] == 0
    verdict_d = evaluate_quality(
        {"mtf": 1, "momentum": 1, "volatility": 1, "volume": 1, "pressure": 0}
    )
    assert verdict_d["decision"] == "EMIT"
    assert verdict_d["tier"] == "T3"
    assert verdict_d["quality"] == pytest.approx(0.80)


# ── 7 ── full alignment = T1 PREMIUM; 3/5 = T5 BLOCK (below the weakest tier)
def test_score_tiers_five_factors():
    verdict = evaluate_quality(
        {"mtf": 1, "momentum": 1, "volatility": 1, "volume": 1, "pressure": 1}
    )
    assert verdict["decision"] == "EMIT"
    assert verdict["tier"] == "T1"
    assert verdict["tier_label"] == "PREMIUM"
    assert verdict["quality"] == pytest.approx(1.0)

    # 3/5 aligned → 0.60 < 0.70 → T5 WEAK → BLOCK (the only true hard block)
    verdict_w = evaluate_quality(
        {"mtf": 1, "momentum": 1, "volatility": 0, "volume": 0, "pressure": 0}
    )
    assert verdict_w["decision"] == "BLOCK"
    assert verdict_w["tier"] == "T5"
    assert verdict_w["quality"] == pytest.approx(0.50)


# ── 8 ── full payload contract: T5 block -> signal null + confidence 0
def test_apply_quality_gate_payload_and_waiting():
    from unittest.mock import patch

    with patch("app.services.quality_gate._tf_aligned", return_value=True):
        qq = apply_quality_gate("BUY", 99.0, _aligned_inputs())
    assert qq["signal"] == "BUY"
    assert qq["confidence"] > 0.0
    assert qq["tier"] == "T1"
    assert qq["quality"] >= 0.70
    assert set(qq["factors"].keys()) == set(FACTOR_ORDER)
    assert qq["market_waiting"] is False
    assert qq["reason"] == "ALL_FACTORS_ALIGNED"

    # only ~50% ensemble (3 of the 5 factors) is a true T5 hard block
    weak_inputs = _aligned_inputs()
    weak_inputs["atr"] = 0.1              # outside the volatility band → vol 0
    weak_inputs["buy_volume"] = 1000.0
    weak_inputs["sell_volume"] = 1000.0   # balanced → pressure 0
    with patch("app.services.quality_gate._tf_aligned", return_value=True):
        qb = apply_quality_gate("BUY", 99.0, weak_inputs)
    assert qb["signal"] is None
    assert qb["confidence"] == 0.0
    assert qb["tier"] == "T5"
    assert qb["market_waiting"] is True
    assert qb["quality"] < 0.70

    ql = apply_quality_gate("BUY", 99.0, None)
    assert ql["quality"] is None
    assert ql["reason"] == "FACTOR_WINDOW_UNAVAILABLE"
    assert ql["signal"] == "BUY"  # latency window: caller gate stays in control


# ── 9 ── win-rate watchdog auto-raises the gate when accuracy < 0.98
def test_accuracy_tracker_raises_gate():
    t = AccuracyTracker()
    assert t.current_hard_gate() == pytest.approx(0.98)
    assert t.is_gate_raised() is False

    for _ in range(60):
        t.record_outcome("EUR/USD", "BUY", 99.0, "WIN", factors={"mtf": 1})
    for _ in range(40):
        t.record_outcome("EUR/USD", "SELL", 98.5, "LOSS", factors={"mtf": 0})

    assert t.is_gate_raised() is True
    assert t.current_hard_gate() == pytest.approx(0.985)
    report = t.report()
    assert report["window_size"] == 100
    assert report["wins"] == 60
    assert report["gate_raised"] is True
    assert report["gate_auto_raised_to"] == pytest.approx(98.5)
    assert report["within_target"] is False

    t2 = AccuracyTracker()
    for _ in range(99):
        t2.record_outcome("GBP/USD", "BUY", 99.0, "WIN", factors={"pressure": 1})
    for _ in range(1):
        t2.record_outcome("GBP/USD", "SELL", 98.0, "LOSS", factors={"pressure": 0})
    assert t2.is_gate_raised() is False
    assert t2.current_hard_gate() == pytest.approx(0.98)
    assert t2.report()["within_target"] is True


# ── 10 ── PART 5: raise trigger lives at < 0.96, NOT below the 0.98 contract
def test_accuracy_tracker_trigger_is_096_not_098():
    t = AccuracyTracker()
    for _ in range(97):
        t.record_outcome("EUR/USD", "BUY", 99.0, "WIN", factors={"mtf": 1})
    for _ in range(3):
        t.record_outcome("EUR/USD", "SELL", 98.5, "LOSS", factors={"mtf": 0})

    assert t.report()["win_rate"] == pytest.approx(0.97)
    # 0.97 < 0.98 would trip the old watchdog; PART 5 trigger is 0.96 → NO raise.
    assert t.is_gate_raised() is False
    assert t.current_hard_gate() == pytest.approx(0.98)
    assert t.report()["within_target"] is False  # still a healthy-but-below-contract tape


# ── 11 ── PART 5: auto-raise steps +0.005 per cooldown and CEILS at 0.995
def test_accuracy_tracker_cap_at_0995():
    t = AccuracyTracker()
    assert t.current_hard_gate() == pytest.approx(0.98)
    for _ in range(100):
        t.record_outcome("EUR/USD", "SELL", 98.0, "LOSS", factors={"mtf": 0})
    # window full + cooldown: one bounded 50bp step
    assert t.is_gate_raised() is True
    assert t.current_hard_gate() == pytest.approx(0.985)

    # every full cooldown window of losses ratchets +0.005 until the ceiling
    for _ in range(200):
        t.record_outcome("EUR/USD", "SELL", 98.0, "LOSS", factors={"mtf": 0})
    assert t.current_hard_gate() == pytest.approx(0.995)

    # sustained losses can never push the gate past the 0.995 cap
    for _ in range(400):
        t.record_outcome("EUR/USD", "SELL", 98.0, "LOSS", factors={"mtf": 0})
    assert t.current_hard_gate() == pytest.approx(0.995)
    assert t.report()["gate_auto_raised_to"] == pytest.approx(99.5)