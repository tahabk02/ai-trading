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
    # ── PART 9: execution-latency-aware time-gated emission ──
    DEFAULT_MIN_ACTIONABLE_WINDOW_MS,
    LATENCY_P95_MULTIPLIER,
    MIN_MEASURED_SAMPLES,
    SUPPRESSED_TIER,
    SUPPRESSED_REASON_TOO_LATE,
    percentile,
    parse_execution_log_latencies,
    compute_min_actionable_window_ms,
    ExecutionLatencyTracker,
    min_actionable_window_ms,
    suppress_if_too_late,
    align_expiration_to_bucket,
    apply_time_gate,
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


# ═══ PART 9 — execution-latency-aware time-gated emission ═══


def test_percentile_nearest_rank():
    assert percentile([], 95.0) is None
    assert percentile([None, float("nan"), float("inf"), -1.0], 95.0) is None
    samples = [120.0, 110.0, 95.0, 130.0, 105.0]  # sorted: 95 … 130
    assert percentile(samples, 95.0) == pytest.approx(130.0)
    assert percentile(samples, 50.0) == pytest.approx(110.0)
    assert percentile([1.0, 2.0, 3.0], 100.0) == pytest.approx(3.0)


def test_parse_execution_log_latencies_real_formats():
    text = (
        '{"event":"Order executed successfully","latency_ms": 128.4, "symbol": "EUR/USD"}\n'
        '{"event":"Order executed successfully","latency_ms": 255.9}\n'
        "latency_ms=97.5 event=TradeExecuted symbol=EUR/USD\n"
        "latency_ms= -12 (rejected)\n"
        '{"event":"Order executed successfully","latency_ms": "nope"}\n'
        '{"event":"market update","latency_ms": 999.0}\n'
    )
    samples = parse_execution_log_latencies(text)
    assert samples == pytest.approx([128.4, 255.9, 97.5, 999.0])
    assert parse_execution_log_latencies("") == []
    assert parse_execution_log_latencies(None) == []


def test_compute_min_actionable_window_ms_is_p95_times_1_5():
    # 100 genuine latencies: 50 × 80ms … 20 × 120ms … 25 × 250ms … 5 × 800ms
    latencies = [80.0] * 50 + [120.0] * 20 + [250.0] * 25 + [800.0] * 5
    p95 = percentile(latencies, 95.0)
    assert p95 == pytest.approx(250.0)
    window = compute_min_actionable_window_ms(latencies)
    # p95=250 ⇒ window = 250 × 1.5 = 375
    assert window == pytest.approx(250.0 * LATENCY_P95_MULTIPLIER)
    assert window == pytest.approx(375.0)
    # No genuine measurement ⇒ honest bootstrap fallback, never 0.
    assert compute_min_actionable_window_ms([]) == pytest.approx(
        DEFAULT_MIN_ACTIONABLE_WINDOW_MS
    )


def test_execution_latency_tracker_rolling_window():
    tracker = ExecutionLatencyTracker(window_size=100, min_samples=10)
    assert tracker.is_measured() is False
    for i in range(150):
        tracker.add_sample(100.0 + i)
    # Rolling window keeps only the LAST 100 executed trades.
    samples = tracker.samples()
    assert len(samples) == 100
    assert samples[0] == 150.0
    assert samples[-1] == pytest.approx(249.0)
    tracker.add_sample(-5)  # garbage rejected
    tracker.add_sample(float("nan"))
    assert len(tracker.samples()) == 100
    assert tracker.is_measured() is True
    assert tracker.window_ms() > 0.0


def test_refresh_reads_real_log_and_measures_window(tmp_path):
    log = tmp_path / "execution.log"
    lines = [
        '{{"event":"Order executed successfully","latency_ms": {}}}'.format(100 + i)
        for i in range(12)
    ]
    log.write_text("\n".join(lines), encoding="utf-8")
    tracker = ExecutionLatencyTracker(
        window_size=100, min_samples=10, log_path=str(log)
    )
    assert tracker.read_log() == 12
    assert tracker.is_measured() is True
    p95 = percentile(list(range(100, 112)), 95.0)  # 11th sample = 110
    assert tracker.window_ms() == pytest.approx(p95 * LATENCY_P95_MULTIPLIER)
    assert parse_execution_log_latencies(log.read_text(encoding="utf-8")) == [
        float(100 + i) for i in range(12)
    ]


def test_min_actionable_window_ms_module_floor():
    # While the singleton has no real measurements, the ACTIVE window stays the
    # documented bootstrap default — an honest floor, never zero.
    assert min_actionable_window_ms() == pytest.approx(DEFAULT_MIN_ACTIONABLE_WINDOW_MS)


def test_suppress_if_too_late_remaining_below_window():
    assert suppress_if_too_late(50.0, window_ms=200.0) is True
    assert suppress_if_too_late(199.9, window_ms=200.0) is True
    assert suppress_if_too_late(200.0, window_ms=200.0) is False  # == window OK
    assert suppress_if_too_late(300.0, window_ms=200.0) is False
    # Unknown remaining is conservatively suppressed (cannot confirm actionable).
    assert suppress_if_too_late(None, window_ms=200.0) is True
    assert suppress_if_too_late(None, window_ms=200.0, suppress_unknown=False) is False


def test_apply_time_gate_too_late_demotes_never_silently():
    result = apply_time_gate(
        "BUY", 0.99, remaining_to_bucket_close_ms=80.0, window_ms=300.0
    )
    # Direction KEPT, tier demoted to T5, marked suppressed + market-waiting.
    assert result["signal"] == "BUY"
    assert result["tier"] == SUPPRESSED_TIER
    assert result["suppressed"] is True
    assert result["suppressed_reason"] == SUPPRESSED_REASON_TOO_LATE
    assert result["executable"] is False
    assert result["market_waiting"] is True
    assert result["gate"] == SUPPRESSED_TIER
    assert result["remaining_to_bucket_close_ms"] == pytest.approx(80.0)
    assert result["min_actionable_window_ms"] == pytest.approx(300.0)


def test_apply_time_gate_enough_time_passes_through():
    result = apply_time_gate(
        "BUY", 0.99, remaining_to_bucket_close_ms=400.0, window_ms=300.0
    )
    assert result["suppressed"] is False
    assert result["suppressed_reason"] is None
    assert result["tier"] == "T1"
    assert result["executable"] is True
    assert result["market_waiting"] is False


def test_apply_time_gate_aligned_expiration_seconds():
    # 60s timeframe, mid-bucket at elapsed 30s, window 300ms ⇒ next full bucket
    # boundary at least 30.3s after the signal instant.
    result = apply_time_gate(
        "SELL",
        0.90,
        remaining_to_bucket_close_ms=30_000.0,
        window_ms=300.0,
        expiration_seconds=120,
        timeframe_seconds=60,
    )
    assert result["suppressed"] is False
    aligned = result["aligned_expiration_seconds"]
    assert aligned is not None
    assert aligned % 60 == 0
    assert aligned >= 60
    assert aligned * 1000.0 >= 30_000.0 + 300.0


def test_align_expiration_to_bucket_property_based():
    import random

    rng = random.Random(1337)
    for _ in range(500):
        tf = rng.choice([5, 10, 15, 30, 60, 90, 120, 180, 300])
        elapsed = rng.uniform(0.0, tf * 1000.0)
        window = rng.uniform(0.0, 5000.0)
        base_exp = tf * rng.randint(1, 8)
        aligned = align_expiration_to_bucket(base_exp, tf, elapsed, window)
        # 1. bucket-aligned (whole number of timeframes)
        assert aligned % tf == 0
        # 2. never inside the currently-forming bucket
        assert aligned >= tf
        # 3. at least `window` ms after the signal instant
        assert aligned * 1000.0 >= elapsed + window
        # 4. rounding always goes UP (never an earlier boundary than requested)
        assert aligned >= base_exp


def test_align_expiration_to_bucket_invalid_timeframe_safe():
    assert align_expiration_to_bucket(60, None, 0, 300) == 60
    assert align_expiration_to_bucket(None, 0, 0, 300) == 60
    assert align_expiration_to_bucket(60, 60, 0, 300) == 60