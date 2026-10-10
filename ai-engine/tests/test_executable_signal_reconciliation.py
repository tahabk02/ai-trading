"""Executable ⇄ signal state reconciliation + inference-isolation regressions.

Three production defects, one file because they share a root cause: gates
evaluated from different inputs whose disagreement reached the terminal.

1. `executable: true` shipped alongside `signal: null` / `market_waiting: true`.
   `executable` comes from apply_strict_execution_gate; `signal`/`market_waiting`
   come from the confluence gate + horizon lock. Reconciliation in
   `_validate_response_finite` now enforces the invariant
   `executable == True => directional signal AND not market_waiting`.

2. `is_dispatchable_tier(confluence_gate)` was called with the default T1 floor
   while `resolve_confluence_tier`'s contract says T2 "can still dispatch at a
   lower tier". Every blockered-but-strong confluence therefore became
   market_waiting, and the class gate downstream of it was dead code.

3. `/predict`'s structural step shared the 2-worker RF *training* pool with no
   timeout, producing 371s/386s/388s request latencies.
"""
import asyncio
import time

import pytest

from app.api.v1.signals import _validate_response_finite
from app.services.signal_gatekeeper import (
    CONFLUENCE_DISPATCH_TIER,
    MIN_EXECUTABLE_TIER,
    SUPPRESSED_REASON_AWAITING_DIRECTION,
    SUPPRESSED_TIER,
    is_dispatchable_tier,
)
from app.services.book_instruments import resolve_confluence_tier
from app.services import ml_predictor


DIRECTIONAL = ("BUY", "SELL", "CALL", "PUT")


def _response(**overrides):
    """Minimal response skeleton accepted by the terminal sanitiser."""
    base = {
        "signal": None,
        "executable": False,
        "market_waiting": True,
        "tier": "T1",
        "tier_label": "PREMIUM",
        "confidence": 99.32,
        "current_price": 1.0850,
        "target_price": 1.0850,
        "diagnostics": {},
    }
    base.update(overrides)
    return base


# ═════════════════════════════════════════════════════════════════════════
# 1. EXECUTABLE ⇄ SIGNAL RECONCILIATION
# ═════════════════════════════════════════════════════════════════════════

def test_executable_true_with_null_signal_is_corrected():
    """The exact production bug: class gate passed, confluence withheld."""
    out = _validate_response_finite(_response(
        signal=None, executable=True, market_waiting=True,
    ))
    assert out["executable"] is False
    assert out["signal"] is None


def test_executable_true_with_market_waiting_is_corrected():
    """A waiting verdict is SCORED-ONLY even with a directional label."""
    out = _validate_response_finite(_response(
        signal="SELL", executable=True, market_waiting=True,
    ))
    assert out["executable"] is False
    assert out["signal"] == "SELL"  # label preserved for display


@pytest.mark.parametrize("label", [None, "", "HOLD", "WAIT", "NEUTRAL", "FLAT", 0, 1])
def test_non_directional_labels_are_never_executable(label):
    """Anything that is not an actionable direction cannot be executable."""
    out = _validate_response_finite(_response(
        signal=label, executable=True, market_waiting=False,
    ))
    assert out["executable"] is False


def test_legal_executable_state_survives_untouched():
    """The invariant must not break the ONE legal executable combination."""
    out = _validate_response_finite(_response(
        signal="SELL", executable=True, market_waiting=False,
    ))
    assert out["executable"] is True
    assert out["signal"] == "SELL"
    # No forced suppression of a legitimately released call.
    assert out.get("suppressed_reason") is None
    assert out["tier"] == "T1"


@pytest.mark.parametrize("label", DIRECTIONAL)
def test_every_directional_label_can_be_executable(label):
    for waiting in (False, True):
        out = _validate_response_finite(_response(
            signal=label, executable=True, market_waiting=waiting,
        ))
        assert out["executable"] is (not waiting)


def test_reconciliation_records_the_real_blocker_not_no_directional_signal():
    """Suppression must cite the true cause, not a fabricated one."""
    out = _validate_response_finite(_response(
        signal=None,
        executable=True,
        market_waiting=True,
        waiting_reason="CONFLUENCE_BELOW_THERMAL",
    ))
    assert out["suppressed_reason"] == "CONFLUENCE_BELOW_THERMAL"
    assert "no_directional_signal" not in json(out)


def test_reconciliation_falls_back_to_a_honest_default_reason():
    out = _validate_response_finite(_response(
        signal=None, executable=True, market_waiting=True,
    ))
    assert out["suppressed_reason"] == SUPPRESSED_REASON_AWAITING_DIRECTION


def test_reconciliation_never_rewrites_tier_and_surfaces_anomaly():
    """A non-executable verdict keeps its HONEST tier (no T5 overwrite).

    The old "tier coherence clamp" forced tier=T5 whenever executable was
    false and stashed `tier_suppressed`. That destroyed the true band and made
    it unusable as a client filter key. Now the tier is never rewritten; the
    illegal `executable: true` beside a null signal is still prevented, and the
    honest tier-without-a-direction anomaly is recorded for audit.
    """
    out = _validate_response_finite(_response(
        signal=None,
        executable=True,
        market_waiting=True,
        waiting_reason="CONFLUENCE_BELOW_THERMAL",
    ))
    # executable is reconciled DOWN (null direction + waiting) ...
    assert out["executable"] is False
    # ... but the honest tier is preserved (T1 from the 99.3% confidence).
    assert out["tier"] == "T1"
    # The anomaly is surfaced without mutating the maths.
    assert out["diagnostics"]["tier_without_direction"]["reported_tier"] == "T1"
    # No direction => nothing is dispatchable and nothing is scored-only.
    assert out["dispatchable"] is False
    assert out["scored_only"] is False
    # The legacy T5-suppression artifacts must be gone entirely.
    assert "tier_suppressed" not in out["diagnostics"]


def test_low_tier_direction_is_scored_only_not_nulled():
    """A genuine but sub-floor direction stays VISIBLE as scored-only.

    This is the core flexible-tier contract: T2/T3/T4 verdicts the maths
    actually produced must reach the client with their real tier and direction,
    marked scored_only instead of being erased into signal=None.
    """
    out = _validate_response_finite(_response(
        signal="BUY",
        executable=False,
        market_waiting=False,
        tier="T3",
        tier_label="MEDIUM",
    ))
    assert out["signal"] == "BUY"        # direction preserved
    assert out["tier"] == "T3"           # honest band preserved
    assert out["dispatchable"] is True   # a real direction exists
    assert out["scored_only"] is True    # but not executable at this floor
    assert out["executable"] is False


def test_directional_executable_verdict_is_not_scored_only():
    out = _validate_response_finite(_response(
        signal="SELL", executable=True, market_waiting=False,
    ))
    assert out["dispatchable"] is True
    assert out["scored_only"] is False
    assert out["tier"] == "T1"


def test_no_direction_means_not_dispatchable_and_not_scored_only():
    out = _validate_response_finite(_response(
        signal=None, executable=False, market_waiting=True,
    ))
    assert out["dispatchable"] is False
    assert out["scored_only"] is False


def test_reconciliation_handles_numpy_bool():
    """`executable` arrives as numpy.bool_ from pandas math; identity checks
    (`is True`) silently skip the clamp, which is how this bug survived."""
    np = pytest.importorskip("numpy")
    out = _validate_response_finite(_response(
        signal=None, executable=np.bool_(True), market_waiting=True,
    ))
    assert out["executable"] is False


def test_reconciliation_is_idempotent():
    """Sanitisation runs again on retries/lock merges; twice must equal once."""
    once = _validate_response_finite(_response(
        signal=None, executable=True, market_waiting=True,
    ))
    twice = _validate_response_finite(dict(once))
    assert twice["executable"] == once["executable"]
    assert twice["tier"] == once["tier"]
    assert twice["suppressed_reason"] == once["suppressed_reason"]


# ═════════════════════════════════════════════════════════════════════════
# 2. T1/T2 DISPATCH CONTRACT (no dead code, no short-circuit)
# ═════════════════════════════════════════════════════════════════════════

def test_confluence_dispatch_floor_is_t2_not_the_execution_floor():
    assert CONFLUENCE_DISPATCH_TIER == "T2"
    assert MIN_EXECUTABLE_TIER == "T1"


def test_resolver_contract_and_consumer_agree():
    """A blockered-but-strong confluence is T2 and IS dispatchable."""
    blockers = ["BOOK_CONFLUENCE_INCOMPLETE"]
    tier = resolve_confluence_tier(99.32, blockers)
    assert tier == "T2"
    assert is_dispatchable_tier(tier, CONFLUENCE_DISPATCH_TIER) is True


def test_regression_old_default_would_have_vetoed_dispatch():
    """Proves the bug: the OLD default floor (T1) rejected the same tier.

    This assertion is the non-vacuity guard — if the producer ever stops
    emitting T2, this fails loudly rather than the test passing for free.
    """
    tier = resolve_confluence_tier(99.32, ["BOOK_CONFLUENCE_INCOMPLETE"])
    assert is_dispatchable_tier(tier) is False


def test_weak_confluence_is_still_refused_dispatch():
    """The fix relaxes the DISPATCH floor only; weak verdicts stay refused."""
    assert is_dispatchable_tier("T3", CONFLUENCE_DISPATCH_TIER) is False
    assert is_dispatchable_tier("T4", CONFLUENCE_DISPATCH_TIER) is False


def test_all_verdict_producers_test_against_the_same_floor():
    """A producer left on the default floor is a silent regression."""
    import inspect
    from app.services import live_quant, ml_predictor as mlp, quant_matrix

    for mod in (live_quant, quant_matrix, mlp):
        src = inspect.getsource(mod)
        assert "is_dispatchable_tier(confluence_gate)" not in src, (
            f"{mod.__name__} still calls is_dispatchable_tier without the "
            "explicit CONFLUENCE_DISPATCH_TIER floor"
        )


# ═════════════════════════════════════════════════════════════════════════
# 3. INFERENCE POOL ISOLATION (no multi-minute /predict stall)
# ═════════════════════════════════════════════════════════════════════════

def test_inference_pool_is_distinct_from_training_pool():
    assert ml_predictor._INFERENCE_EXECUTOR is not ml_predictor._CPU_EXECUTOR
    assert ml_predictor._INFERENCE_EXECUTOR._max_workers > (
        ml_predictor._CPU_EXECUTOR._max_workers
    )


def test_admission_bound_is_enforced():
    assert ml_predictor.INFERENCE_QUEUE_TIMEOUT_S > 0


def test_run_inference_returns_result_on_the_happy_path():
    async def _run():
        return await ml_predictor.run_inference(lambda a, b: a + b, 2, 3)
    assert asyncio.run(_run()) == 5


def test_run_inference_raises_admission_timeout_instead_of_hanging():
    """A saturated pool must fail FAST, never block the HTTP response."""
    async def _run():
        # Longer than the bound so the wait_for is guaranteed to fire.
        return await ml_predictor.run_inference(
            time.sleep, 3.0, timeout_s=0.2,
        )
    started = time.time()
    with pytest.raises(ml_predictor.InferenceAdmissionTimeout):
        asyncio.run(_run())
    assert time.time() - started < 2.0


def test_admission_timeout_is_a_non_fatal_budget_type():
    """Callers already degrade on InferenceBudgetExceeded; keep that path."""
    assert issubclass(
        ml_predictor.InferenceAdmissionTimeout,
        ml_predictor.InferenceBudgetExceeded,
    )


def test_training_burst_does_not_starve_structural_inference(monkeypatch):
    """The regression test for the 371s/386s/388s production stalls.

    Saturates the TRAINING pool, then proves a structural step still returns
    promptly on the INFERENCE pool. On the old shared-pool code this would
    block for the full duration of the burst.

    A private training pool is installed for the duration of the test:
    `Future.cancel()` cannot stop an already-running thread, so saturating the
    real module-level `_CPU_EXECUTOR` would leave its workers burning after the
    test returns and starve every later test that relies on a free training
    worker (e.g. the shielded cache-warm in test_inference_budget).
    """
    import concurrent.futures

    private_train = concurrent.futures.ThreadPoolExecutor(max_workers=2)
    monkeypatch.setattr(ml_predictor, "_CPU_EXECUTOR", private_train)

    def _burn(_):
        time.sleep(2.0)
        return "trained"

    async def _run():
        loop = asyncio.get_event_loop()
        burst = [
            loop.run_in_executor(private_train, _burn, i) for i in range(2)
        ]
        await asyncio.sleep(0.2)  # let the burst occupy the pool

        started = time.time()
        result = await ml_predictor.run_inference(
            lambda: "structural", timeout_s=1.0,
        )
        elapsed = time.time() - started

        # Drain the burst instead of cancelling: cancellation cannot interrupt
        # running threads, so awaiting keeps the teardown deterministic.
        await asyncio.gather(*burst, return_exceptions=True)
        return result, elapsed

    try:
        result, elapsed = asyncio.run(_run())
    finally:
        private_train.shutdown(wait=True)

    assert result == "structural"
    assert elapsed < 1.0, f"structural step waited {elapsed:.2f}s behind training"


def json(obj):
    import json as _json
    return _json.dumps(obj, default=str)