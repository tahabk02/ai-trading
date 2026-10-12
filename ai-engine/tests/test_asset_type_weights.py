"""
test_asset_type_weights.py — PART 33 [239] PER-ASSET-TYPE BOOK-WEIGHT PROFILES

The contract these tests protect:

  * The three asset types are weighted INDEPENDENTLY (PART 12 [27]c — an OTC
    weight may never move on a CRYPTO outcome).
  * Nothing is learned until a type has >= MIN_RESOLVED_SIGNALS (30) resolved
    signals — the honest PART 19.2 [120] floor.
  * Learning never relaxes the STRICT 0.965 emission bar. Because every vector
    sums to 1.0, a single failed factor still cannot clear it.
  * The shipped shared GATE_WEIGHTS vector and its exact scores are unchanged
    when no per-type weights are supplied (backwards compatibility).
"""

from __future__ import annotations

import pytest

from app.services.accuracy_tracker import (
    MIN_RESOLVED_SIGNALS,
    AccuracyTracker,
)
from app.services.asset_class import (
    ASSET_CLASS_CRYPTO,
    ASSET_CLASS_OTC,
    ASSET_CLASS_REAL,
)
from app.services.asset_type_weights import (
    MAX_TILT,
    MIN_FACTOR_SIGNALS,
    base_weights_for,
    describe_registry,
    learned_weights_for,
    profile_by_symbol,
    profile_for,
    profiles,
    weights_by_symbol,
    weights_for,
)
from app.services.quality_gate import (
    FACTOR_ORDER,
    GATE_WEIGHTS,
    QUALITY_EMIT_BAR,
    apply_quality_gate,
    evaluate_quality,
    quality_score,
)

ALL_ON = {name: 1 for name in FACTOR_ORDER}
ALL_ON_FACTORS = set(FACTOR_ORDER)


def _record(tracker, symbol, outcome, factors, confidence=95.0, asset_class=None):
    tracker.record_outcome(
        symbol=symbol,
        direction="BUY",
        confidence=confidence,
        outcome=outcome,
        factors=factors,
        tier="T1",
        asset_class=asset_class,
    )


def _factors(miss=None):
    return {name: (0 if name == miss else 1) for name in FACTOR_ORDER}


def _feed(tracker, records, asset_class=None, symbol="EUR/SEK"):
    """Record an explicit list of ``(aligned_factor_names, is_win)`` outcomes.

    Explicit beats clever here: every weight-learning test below can be read
    directly as "this factor was aligned on these N signals and was right on W
    of them". Nothing is random.
    """
    for aligned, is_win in records:
        factors = {name: (1 if name in aligned else 0) for name in FACTOR_ORDER}
        _record(
            tracker,
            symbol,
            "WIN" if is_win else "LOSS",
            factors,
            asset_class=asset_class,
        )


def _repeat(aligned, wins, losses):
    """``wins`` WINs then ``losses`` LOSSes, all with the same aligned set."""
    return [(set(aligned), True)] * wins + [(set(aligned), False)] * losses


# ── structural priors ──
def test_three_profiles_exist_and_differ():
    p = profiles()
    assert set(p) == {ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO}
    vectors = [tuple(v["weights"][n] for n in FACTOR_ORDER) for v in p.values()]
    # Genuinely distinct per-type weighting, not one vector wearing three names.
    assert len(set(vectors)) == 3


def test_every_profile_sums_to_one():
    for name in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO):
        w = base_weights_for(name)
        assert round(sum(w.values()), 6) == 1.0
        assert set(w) == set(FACTOR_ORDER)


def test_registry_documents_rationale_and_floors():
    reg = describe_registry()
    assert reg["min_resolved_signals"] == MIN_RESOLVED_SIGNALS == 30
    assert reg["min_factor_signals"] == MIN_FACTOR_SIGNALS
    assert reg["max_tilt"] == MAX_TILT
    for name in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO):
        assert reg["profiles"][name]["rationale"].strip()
        assert round(sum(reg["profiles"][name]["base_weights"].values()), 6) == 1.0


def test_unknown_asset_class_falls_back_to_a_valid_profile():
    assert round(sum(base_weights_for("NOT_A_CLASS").values()), 6) == 1.0


# ── nothing is learned without evidence (PART 19.2 [120]) ──
def test_no_outcomes_means_structural_prior_and_insufficient_data():
    tracker = AccuracyTracker()
    for name in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO):
        prof = profile_for(name, tracker=tracker)
        assert prof["learned"] is False
        assert prof["source"] == "structural_prior"
        assert prof["weights"] == prof["base_weights"]
        assert prof["insufficient_data"] is True
        assert prof["sufficient_data"] is False
        assert prof["resolved"] == 0
        assert prof["weights_sum"] == 1.0
        assert learned_weights_for(name, tracker=tracker) is None


def test_below_threshold_still_prior():
    tracker = AccuracyTracker()
    _feed(tracker, _repeat(["pressure", "momentum"], wins=20, losses=9))
    prof = profile_for(ASSET_CLASS_REAL, tracker=tracker)
    assert prof["resolved"] == MIN_RESOLVED_SIGNALS - 1
    assert prof["learned"] is False
    assert prof["insufficient_data"] is True


def test_exactly_threshold_may_learn():
    tracker = AccuracyTracker()
    # Two factors with clearly different win rates, so there is something real to
    # redistribute between (see test_one_informative_factor_cannot_reshape_alone).
    _feed(tracker, _repeat(["pressure"], wins=14, losses=1) + _repeat(["mtf"], wins=9, losses=6))
    prof = profile_for(ASSET_CLASS_REAL, tracker=tracker)
    assert prof["resolved"] == MIN_RESOLVED_SIGNALS
    assert prof["sufficient_data"] is True
    assert prof["learned"] is True
    assert prof["source"] == "learned_from_resolved_signals"


def test_one_informative_factor_cannot_reshape_alone():
    """A factor with evidence is not automatically a reason to reshuffle the
    whole vector. With every other factor unevidenced there is nothing to trade
    against, so the prior stands — 'we have no view on mtf' is not 'mtf is bad'.
    """
    tracker = AccuracyTracker()
    _feed(tracker, _repeat(["pressure"], wins=40, losses=0))
    prof = profile_for(ASSET_CLASS_REAL, tracker=tracker)
    assert prof["factor_evidence"]["pressure"]["win_rate"] == 1.0
    assert prof["learned"] is False
    assert prof["source"] == "structural_prior"


# ── per-type isolation (PART 12 [27]c) ──
def test_outcomes_are_isolated_per_asset_class():
    tracker = AccuracyTracker()
    for i in range(MIN_RESOLVED_SIGNALS):
        _record(tracker, "EUR/SEK", "WIN", ALL_ON, asset_class=ASSET_CLASS_REAL)
        _record(tracker, "BTC/USD", "LOSS", ALL_ON, asset_class=ASSET_CLASS_CRYPTO)
    stats = tracker.asset_class_stats()
    assert stats[ASSET_CLASS_REAL]["resolved"] == MIN_RESOLVED_SIGNALS
    assert stats[ASSET_CLASS_CRYPTO]["resolved"] == MIN_RESOLVED_SIGNALS
    assert stats[ASSET_CLASS_REAL]["win_rate"] == 1.0
    assert stats[ASSET_CLASS_CRYPTO]["win_rate"] == 0.0
    assert stats[ASSET_CLASS_OTC]["resolved"] == 0


def test_one_type_cannot_reach_the_floor_for_another():
    """100 shared-window outcomes on crypto must NOT make OTC 'sufficient'."""
    tracker = AccuracyTracker()
    for i in range(100):
        _record(tracker, "BTC/USD", "WIN", ALL_ON, asset_class=ASSET_CLASS_CRYPTO)
    otc = profile_for(ASSET_CLASS_OTC, tracker=tracker)
    assert otc["resolved"] == 0
    assert otc["learned"] is False


def test_learning_is_confined_to_the_types_own_resolved_signals():
    """A decisive CRYPTO record must not move the OTC or REAL weights."""
    tracker = AccuracyTracker()
    # Crypto: momentum 90% aligned, mtf 55% aligned — momentum is far more
    # informative, so only the CRYPTO vector may tilt.
    _feed(
        tracker,
        _repeat(["momentum"], wins=60, losses=7) + _repeat(["mtf"], wins=11, losses=9),
        asset_class=ASSET_CLASS_CRYPTO,
        symbol="BTC/USD",
    )
    crypto = weights_for(ASSET_CLASS_CRYPTO, tracker=tracker)
    for other in (ASSET_CLASS_OTC, ASSET_CLASS_REAL):
        assert weights_for(other, tracker=tracker) == base_weights_for(other)
    assert crypto != base_weights_for(ASSET_CLASS_CRYPTO)
    # The informative factor gains; the weak one loses.
    assert crypto["momentum"] > base_weights_for(ASSET_CLASS_CRYPTO)["momentum"]
    assert crypto["mtf"] < base_weights_for(ASSET_CLASS_CRYPTO)["mtf"]


def test_uniformly_informative_factors_leave_the_prior_intact():
    """When EVERY factor is right at the same rate, no factor deserves more
    weight than any other — the reweighting is a no-op and must be reported as
    the prior, not dressed up as learned."""
    tracker = AccuracyTracker()
    _feed(tracker, _repeat(ALL_ON_FACTORS, wins=20, losses=20),
          asset_class=ASSET_CLASS_CRYPTO, symbol="BTC/USD")
    prof = profile_for(ASSET_CLASS_CRYPTO, tracker=tracker)
    assert prof["resolved"] == 40
    assert prof["sufficient_data"] is True
    assert prof["learned"] is False
    assert prof["source"] == "structural_prior"
    assert prof["weights"] == base_weights_for(ASSET_CLASS_CRYPTO)


def test_type_determination_follows_the_asset_class_source_of_truth():
    tracker = AccuracyTracker()
    _record(tracker, "EUR/SEK", "WIN", ALL_ON)   # -> REAL
    _record(tracker, "BTC/USD", "WIN", ALL_ON)    # -> CRYPTO
    _record(tracker, "EUR/USD OTC 20", "WIN", ALL_ON)  # -> OTC
    stats = tracker.asset_class_stats()
    assert stats[ASSET_CLASS_REAL]["resolved"] == 1
    assert stats[ASSET_CLASS_CRYPTO]["resolved"] == 1
    assert stats[ASSET_CLASS_OTC]["resolved"] == 1


# ── learned weights stay well-behaved ──
def test_learned_weights_sum_to_one_and_stay_bounded():
    tracker = AccuracyTracker()
    # pressure 85% right, mtf 55% right; the other three are never aligned so
    # they carry no evidence and must hold their prior share untouched.
    _feed(tracker, _repeat(["pressure"], wins=34, losses=6) + _repeat(["mtf"], wins=11, losses=9))
    learned = learned_weights_for(ASSET_CLASS_REAL, tracker=tracker)
    assert learned is not None
    assert round(sum(learned.values()), 6) == 1.0
    base = base_weights_for(ASSET_CLASS_REAL)
    # A demonstrably informative factor gains weight; it cannot take over.
    assert learned["pressure"] > base["pressure"]
    for name in FACTOR_ORDER:
        assert learned[name] <= base[name] * (1.0 + MAX_TILT) + 1e-9
        assert learned[name] >= 0.0


def test_factor_below_its_own_floor_keeps_its_prior_share():
    """A factor with 2 aligned samples must not be tilted; its prior SHARE of the
    total is preserved exactly, because "no view" must not be reported as
    "became less important"."""
    tracker = AccuracyTracker()
    # 30 outcomes establish the type, pressure provides decisive evidence, mtf is
    # coin-flip, and volume is aligned on only 2 signals (below MIN_FACTOR_SIGNALS).
    _feed(
        tracker,
        _repeat(["pressure"], wins=14, losses=1)
        + _repeat(["mtf"], wins=7, losses=6)
        + _repeat(["volume"], wins=2, losses=0),
    )
    learned = learned_weights_for(ASSET_CLASS_REAL, tracker=tracker)
    base = base_weights_for(ASSET_CLASS_REAL)
    prof = profile_for(ASSET_CLASS_REAL, tracker=tracker)
    assert prof["resolved"] == 30
    assert prof["learned"] is True
    assert prof["factor_evidence"]["volume"]["aligned_count"] == 2
    assert prof["factor_evidence"]["volume"]["sufficient_data"] is False
    prior_share = base["volume"] / sum(base.values())
    learned_share = learned["volume"] / sum(learned.values())
    assert learned_share == pytest.approx(prior_share, abs=1e-6)


def test_neutral_factor_does_not_move():
    """A factor right on exactly half its aligned signals earns no tilt."""
    tracker = AccuracyTracker()
    _feed(tracker, _repeat(["mtf", "volume"], wins=10, losses=10))
    learned = learned_weights_for(ASSET_CLASS_REAL, tracker=tracker)
    base = base_weights_for(ASSET_CLASS_REAL)
    # Nothing moved, so nothing is reported as learned.
    assert learned is None
    assert weights_for(ASSET_CLASS_REAL, tracker=tracker) == base


def test_uninformative_type_reports_prior_not_noise():
    """Exactly-50% across the board: evidence exists, but it is worthless, so
    the profile must stay on the prior and say so."""
    tracker = AccuracyTracker()
    _feed(tracker, _repeat(["mtf", "volume"], wins=30, losses=30))
    prof = profile_for(ASSET_CLASS_REAL, tracker=tracker)
    assert prof["resolved"] == 60
    assert prof["sufficient_data"] is True
    assert prof["learned"] is False
    assert prof["source"] == "structural_prior"
    assert prof["factor_evidence"]["mtf"]["win_rate"] == 0.5


# ── the STRICT emission bar cannot be relaxed ──
def test_no_single_failed_factor_can_clear_the_emit_bar_on_any_profile():
    tracker = AccuracyTracker()
    for name in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO):
        for weights in (base_weights_for(name), weights_for(name, tracker=tracker)):
            for miss in FACTOR_ORDER:
                score = quality_score(_factors(miss), weights=weights)
                assert score < QUALITY_EMIT_BAR, (name, miss, score)


def test_all_factors_aligned_emits_on_every_profile():
    tracker = AccuracyTracker()
    for name in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO):
        verdict = evaluate_quality(ALL_ON, weights=weights_for(name, tracker=tracker))
        assert verdict["decision"] == "EMIT"
        assert verdict["quality"] == 1.0
        assert verdict["reason"] == "ALL_FACTORS_ALIGNED"


def test_weighted_block_reason_names_the_heaviest_failed_factor():
    """PART 33: the reason follows the ASSET TYPE's weighting, not the fixed
    FACTOR_ORDER. With both mtf and pressure missing, the shared vector names
    mtf (0.25 > 0.20) while the OTC profile names pressure (0.30 > 0.25)."""
    f = _factors("pressure")
    f["mtf"] = 0
    assert evaluate_quality(f)["reason"] == "QUALITY_BELOW_GATE:mtf"
    otc = base_weights_for(ASSET_CLASS_OTC)
    verdict = evaluate_quality(f, weights=otc)
    assert verdict["decision"] == "BLOCK"
    assert verdict["reason"] == "QUALITY_BELOW_GATE:pressure"


def test_gate_payload_carries_provenance():
    inputs = {
        "timeframes": {
            "1h": {"close": [1.0] * 250, "high": [1.0] * 250, "low": [1.0] * 250},
            "4h": {"close": [1.0] * 250, "high": [1.0] * 250, "low": [1.0] * 250},
        },
        "price": 1.0,
        "atr": 0.002,
        "volume": 100.0,
        "volume_sma20": 50.0,
        "buy_volume": 70.0,
        "sell_volume": 30.0,
    }
    payload = apply_quality_gate(
        "BUY",
        96.5,
        inputs,
        weights=base_weights_for(ASSET_CLASS_CRYPTO),
        asset_class=ASSET_CLASS_CRYPTO,
        weights_source="structural_prior",
    )
    assert payload["asset_class"] == ASSET_CLASS_CRYPTO
    assert payload["weights_source"] == "structural_prior"


# ── backwards compatibility: the shared vector is untouched ──
def test_default_weights_are_still_the_shared_gate_weights():
    assert quality_score(ALL_ON) == 1.0
    assert quality_score({}) == 0.0
    assert evaluate_quality(ALL_ON)["decision"] == "EMIT"


def test_omitting_weights_keeps_the_previous_default_behaviour():
    inputs = {"timeframes": {}, "price": 1.0}
    payload = apply_quality_gate("BUY", 90.0, inputs)
    assert payload["asset_class"] is None
    assert payload["weights_source"] is None


def test_symbol_helpers_resolve_the_right_type():
    assert weights_by_symbol("EUR/SEK") == base_weights_for(ASSET_CLASS_REAL)
    assert weights_by_symbol("BTC/USD") == base_weights_for(ASSET_CLASS_CRYPTO)
    assert weights_by_symbol("EUR/USD OTC 20") == base_weights_for(ASSET_CLASS_OTC)
    assert profile_by_symbol("BTC/USD")["asset_class"] == ASSET_CLASS_CRYPTO
    assert profile_by_symbol("BTC/USD")["shared_baseline"] == GATE_WEIGHTS


# ── calibration curves (PART 33 [240]) ──
def test_calibration_curve_is_honest_when_empty():
    tracker = AccuracyTracker()
    curve = tracker.calibration_curve(ASSET_CLASS_OTC)
    assert curve["resolved"] == 0
    assert curve["win_rate"] is None
    assert curve["insufficient_data"] is True
    assert all(b["count"] == 0 and b["observed_win_rate"] is None for b in curve["bins"])


def test_calibration_curve_bins_by_confidence_and_flags_evidence():
    tracker = AccuracyTracker()
    for i in range(35):
        _record(tracker, "EUR/SEK", "WIN", ALL_ON, confidence=96.0)
    for i in range(5):
        _record(tracker, "EUR/SEK", "LOSS", ALL_ON, confidence=75.0)
    curve = tracker.calibration_curve(ASSET_CLASS_REAL)
    assert curve["resolved"] == 40
    assert curve["sufficient_data"] is True
    top = curve["bins"][-1]
    assert top["lo"] == 95.0
    assert top["count"] == 35
    assert top["observed_win_rate"] == 1.0
    assert top["sufficient_data"] is True
    low = curve["bins"][1]
    assert low["count"] == 5
    assert low["observed_win_rate"] == 0.0
    # 5 samples in a bin is NOT evidence — even though the type total is.
    assert low["sufficient_data"] is False


def test_calibration_by_asset_class_covers_all_three():
    tracker = AccuracyTracker()
    curves = tracker.calibration_by_asset_class()
    assert set(curves) == {ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO}
    assert all(c["insufficient_data"] for c in curves.values())