"""Real pytest conversion of the endpoint contract in `test_endpoint_mixed.py`.

`test_endpoint_mixed.py` is a `main()`-based probe: pytest collects ZERO tests
from it, so the 98% thermal-gate contract it describes has never actually run
in CI. This module ports the assertions that are still true.

TWO of its original assertions were wrong and are deliberately NOT ported:

  * "Short series should be rejected 400/422" — wrong. The documented contract
    is <2 bars -> 400; 2..100 bars -> 200 with executable=False and
    suppressed_reason=insufficient_history. See test_short_series_contract.py.

  * "√horizon scaling broken: 1h=1d=10d=0.443" — not a bug, a measurement
    artifact. The probe reused ONE symbol (USD/JPY) across all three
    timeframes, so the expiry-scoped signal lock returned the 1h target for
    every horizon. Here each horizon gets its OWN symbol, which is what the
    √horizon law is actually about.

ORDER INDEPENDENCE: every request in this file reuses the same whitelisted
symbols, and both the signal lock and the ML model cache are process-global
singleton state. Without a reset between tests the suite would assert on a
verdict pinned by whichever test ran first -- which is exactly how the legacy
probe produced order-dependent, contradictory numbers.
"""
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.main import app
from app.services.book_instruments import DEFINITIVE_CONFIDENCE_MIN
from app.services.ml_predictor import _model_cache
from app.services.signal_lock import signal_lock

# Scenario builders live in the legacy probe; importing them keeps a single
# definition of each tape instead of drifting copies.
from test_endpoint_mixed import (  # noqa: E402
    bearish_candles,
    bullish_candles,
    jpy_bullish_candles,
    last_close,
    scenario_perfect_confluence,
)

PILLARS = ("volatility", "momentum", "microstructure")


@pytest.fixture(autouse=True)
def _isolated_process_state():
    """Drop the two process-global caches that make /predict order-dependent.

    - signal_lock pins the FIRST verdict per symbol+timeframe for the expiry
      window. That is correct product behaviour, but it means a second test
      reusing EUR/USD 1h would silently observe the first test's verdict.
    - _model_cache holds trained models keyed by symbol+timeframe+fingerprint.
    """
    signal_lock._local.clear()
    _model_cache.clear()
    yield
    signal_lock._local.clear()
    _model_cache.clear()


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _predict(client, symbol, timeframe, candles, **extra):
    payload = {
        "symbol": symbol,
        "timeframe": timeframe,
        "candles": candles,
        "live_price": last_close(candles),
        "dataSource": "forex_otc_test",
    }
    payload.update(extra)
    resp = client.post("/api/v1/predict", json=payload)
    assert resp.status_code == 200, "%s failed: %s" % (symbol, resp.text[:300])
    return resp.json()


def _confluence(body):
    return ((body.get("book_confluence") or {}).get("confluence") or {})


# ── the sub-thermal market-waiting contract (v11) ─────────────────────────

def test_subthermal_attempt_keeps_its_true_direction(client):
    """A directional attempt below the thermal bar KEEPS its real BUY/SELL and
    is honestly suppressed. It must never be flattened to HOLD and must never be
    inverted.

    NOTE on vocabulary: the legacy probe asserted
    ``waiting_reason == "CONFLUENCE_BELOW_THERMAL"`` + ``market_waiting=True``.
    That surface has been superseded -- suppression is now carried by
    ``suppressed_reason`` + ``executable=False`` + a ``tier`` label, and
    ``market_waiting`` stays False. The invariants that still matter (true
    direction retained, gate reported, alert silent, nothing executable) are
    asserted here against the CURRENT surface.
    """
    body = _predict(client, "GBP/USD", "4h", bearish_candles())

    assert body.get("signal") == "SELL", (
        "a downtrend must keep SELL, got %r" % body.get("signal")
    )
    assert body.get("high_confidence_alert") is not True
    assert body.get("executable") is False, (
        "a sub-thermal attempt must never be executable"
    )
    assert body.get("suppressed_reason"), (
        "suppression must carry an honest reason, got %r"
        % body.get("suppressed_reason")
    )
    assert body.get("diagnostics", {}).get("gated_direction") == "SELL"
    assert body.get("diagnostics", {}).get("confidence_gated") is True
    assert _confluence(body).get("gate") == "INSUFFICIENT"
    assert 0.0 <= float(body.get("confidence", -1)) < DEFINITIVE_CONFIDENCE_MIN


def test_subthermal_target_is_a_real_projection_never_flat(client):
    """The retained direction must own the target: SELL projects BELOW."""
    body = _predict(client, "GBP/USD", "4h", bearish_candles())

    target = float(body.get("target_price") or 0)
    current = float(body.get("current_price") or 0)
    distance = target - current
    assert distance < 0, (
        "SELL market-waiting target must project below current, got %+.6f"
        % distance
    )
    assert abs(distance) > 1e-9, "target must not pin flat to the live price"


def test_confidence_is_never_padded_above_the_confluence_score(client):
    """The number the client shows IS the authoritative confluence score."""
    for symbol, tf, candles in (
        ("GBP/USD", "4h", bearish_candles()),
        ("EUR/USD", "1h", bullish_candles()),
    ):
        body = _predict(client, symbol, tf, candles)
        shown = float(body.get("confidence", -1))
        actual = float(_confluence(body).get("score", -2))
        assert abs(shown - actual) <= 0.01, (
            "%s: shown confidence %s != confluence score %s" % (symbol, shown, actual)
        )


def test_confluence_response_ships_all_three_pillars(client):
    body = _predict(client, "GBP/USD", "4h", bearish_candles())
    clusters = _confluence(body).get("clusters") or {}
    for pillar in PILLARS:
        assert pillar in clusters, "missing %s pillar in %r" % (pillar, clusters)


# ── mixed-direction arbitration ────────────────────────────────────────────

def test_uptrend_and_downtrend_never_both_gate_the_same_way(client):
    """Direction arbitration is the whole point: an uptrend and a downtrend
    must not collapse onto the same attempt."""
    up = _predict(client, "EUR/USD", "1h", bullish_candles())
    down = _predict(client, "GBP/USD", "4h", bearish_candles())

    g_up = up.get("diagnostics", {}).get("gated_direction")
    g_down = down.get("diagnostics", {}).get("gated_direction")
    assert not (g_up == "BUY" and g_down == "BUY"), (
        "ALL-CALL BIAS: uptrend and downtrend both gated BUY"
    )
    assert not (g_up == "SELL" and g_down == "SELL"), (
        "ALL-CALL BIAS: uptrend and downtrend both gated SELL"
    )


# ── √horizon target scaling ────────────────────────────────────────────────
# One symbol PER horizon. Reusing a single symbol is what made the legacy probe
# read 1h == 1d == 10d: the expiry-scoped lock pinned the 1h verdict.

def test_target_distance_scales_with_sqrt_horizon(client):
    distances = {}
    for tf, symbol in (("1h", "EUR/USD"), ("1d", "GBP/USD"), ("10d", "AUD/USD")):
        body = _predict(client, symbol, tf, jpy_bullish_candles())
        target = float(body.get("target_price") or 0)
        current = float(body.get("current_price") or 0)
        distances[tf] = abs(target - current)
        assert distances[tf] > 1e-9, "%s projected a flat target" % tf

    assert distances["1h"] < distances["1d"] < distances["10d"], (
        "√horizon scaling broken: %r" % distances
    )


def test_sqrt_horizon_ratios_match_the_atr_law(client):
    """√t scaling, checked against the actual law rather than mere monotonicity.

    project_target uses `atr * 1.5 * √(horizon_minutes / 60)`, so the 1h->1d
    ratio should be √24 and 1h->10d should be √240, give or take the
    perceptibility floor.
    """
    distances = {}
    for tf, symbol in (("1h", "EUR/USD"), ("1d", "GBP/USD"), ("10d", "AUD/USD")):
        body = _predict(client, symbol, tf, jpy_bullish_candles())
        distances[tf] = abs(
            float(body.get("target_price") or 0) - float(body.get("current_price") or 0)
        )

    base = distances["1h"]
    for tf, expected in (("1d", 24.0), ("10d", 240.0)):
        ratio = distances[tf] / base
        assert ratio == pytest.approx(np.sqrt(expected), rel=0.02), (
            "%s ratio %.4f != √%d = %.4f" % (tf, ratio, expected, np.sqrt(expected))
        )


# ── DEFINITIVE emission with a live order book ─────────────────────────────

def test_definitive_tape_fires_the_alert_and_carries_ml(client):
    """A fully-converged tape clears the 98% bar, trips the alert, reports no
    confluence blockers, and carries ML corroboration.

    NOTE on vocabulary: ``book_confluence.confluence.gate`` is a T1..T5 tier
    label, not the legacy "DEFINITIVE" token the probe asserted. T1 is the
    strongest and is what a >=98% confluence reports.

    NOTE: ``executable`` is False here because this tape is sent with
    ``dataSource=forex_otc_test`` and the OTC high-frequency quality filter
    rejects it (``suppressed_reason=otc_hf_fail``). That is correct: a synthetic
    probe tape must not become a dispatchable signal just because its confluence
    is high.
    """
    candles, spot, bid, ask = scenario_perfect_confluence()
    body = _predict(client, "EUR/USD", "1h", candles, live_price=spot,
                    bid=bid, ask=ask)

    assert body.get("signal") == "BUY"
    assert float(body.get("confidence", 0)) >= 98.0, (
        "definitive tape scored %s" % body.get("confidence")
    )
    assert body.get("high_confidence_alert") is True
    assert _confluence(body).get("gate") == "T1", (
        "a >=98%% confluence must report the strongest gate, got %r"
        % _confluence(body).get("gate")
    )
    assert not _confluence(body).get("blockers"), (
        "a definitive tape must carry no confluence blockers, got %r"
        % _confluence(body).get("blockers")
    )
    assert float(body.get("target_price", 0)) > float(body.get("current_price", 0))
    assert body.get("executable") is False, (
        "a synthetic OTC test tape must stay non-dispatchable"
    )
    assert body.get("suppressed_reason") == "otc_hf_fail"

    ml = body.get("diagnostics", {}).get("ml")
    assert isinstance(ml, dict), "ML corroboration diagnostics.ml missing"
    assert ml.get("confidence") is not None, (
        "ML corroborator ran but left diagnostics.ml.confidence null: %r" % ml
    )


def test_definitive_confidence_equals_confluence_score(client):
    candles, spot, bid, ask = scenario_perfect_confluence()
    body = _predict(client, "EUR/USD", "1h", candles, live_price=spot,
                    bid=bid, ask=ask)
    assert float(body.get("confidence", -1)) == pytest.approx(
        float(_confluence(body).get("score", -2)), abs=0.01
    )


# ── the real order-dependence regression ───────────────────────────────────

def test_same_symbol_different_tapes_get_independent_ml_models(client):
    """THE cross-contamination regression, exercised through the real path.

    Two DIFFERENT candle payloads for one symbol+timeframe used to collide in
    the model cache, because the key was only ``symbol:timeframe``. Whichever
    payload trained first won the key, so a later request was scored with a
    model trained on someone else's candles.

    Over HTTP this is masked by the expiry-scoped signal lock, which pins the
    first verdict on purpose. So the invariant is asserted at the layer that
    actually owns it: each distinct window trains and stores its own model, and
    the cache never hands one window another window's model.
    """
    from app.services.ml_predictor import _data_fingerprint, _model_cache as mc

    def fingerprint_of(tape):
        return _data_fingerprint(
            np.array([c["close"] for c in tape], dtype=np.float64),
            np.array([c["open"] for c in tape], dtype=np.float64),
            np.array([c["high"] for c in tape], dtype=np.float64),
            np.array([c["low"] for c in tape], dtype=np.float64),
            np.array([c.get("volume", 0) for c in tape], dtype=np.float64),
        )

    tape_a = bullish_candles()
    tape_b = jpy_bullish_candles()
    fp_a, fp_b = fingerprint_of(tape_a), fingerprint_of(tape_b)
    assert fp_a != fp_b, "the two fixtures must be genuinely different windows"

    _predict(client, "EUR/USD", "1h", tape_a)
    _predict(client, "GBP/USD", "4h", bearish_candles())
    _predict(client, "EUR/USD", "1h", tape_b)

    # Both windows are independently addressable under their own fingerprint.
    for fp in (fp_a, fp_b):
        assert mc.get("EUR/USD", "1h", fp) is not None, (
            "window %s has no model of its own" % fp
        )
    # And neither window is served the other's model.
    keys = {mc._key("EUR/USD", "1h", fp) for fp in (fp_a, fp_b)}
    assert len(keys) == 2, "distinct windows collapsed onto one cache key"


def test_verdict_does_not_depend_on_a_prior_request(client):
    """A cold request and the SAME request after an unrelated one must agree.

    The legacy probe reported 98.7 cold and 96.6 after another symbol had run,
    which made it self-contradictory. (The deeper cause was the model-cache key
    collision asserted in test_model_cache_window.py; the expiry-scoped signal
    lock then masked it at the HTTP layer by pinning the verdict, which is
    intended product behaviour.)
    """
    candles, spot, bid, ask = scenario_perfect_confluence()

    cold = _predict(client, "EUR/USD", "1h", candles, live_price=spot,
                    bid=bid, ask=ask)

    # An unrelated request on a different symbol/timeframe.
    _predict(client, "GBP/USD", "4h", bearish_candles())

    warmed = _predict(client, "EUR/USD", "1h", candles, live_price=spot,
                      bid=bid, ask=ask)

    assert warmed.get("signal") == cold.get("signal")
    assert float(warmed.get("confidence", -1)) == pytest.approx(
        float(cold.get("confidence", -2)), abs=0.01
    ), (
        "verdict changed after an unrelated request: %s -> %s"
        % (cold.get("confidence"), warmed.get("confidence"))
    )


def test_repeated_requests_on_one_symbol_are_stable(client):
    """The lock legitimately pins a verdict for the expiry window; the pinned
    verdict must equal the cold one rather than contradicting it."""
    candles, spot, bid, ask = scenario_perfect_confluence()
    first = _predict(client, "EUR/USD", "1h", candles, live_price=spot,
                     bid=bid, ask=ask)
    second = _predict(client, "EUR/USD", "1h", candles, live_price=spot,
                      bid=bid, ask=ask)
    assert first.get("signal") == second.get("signal")
    assert float(first.get("confidence", -1)) == pytest.approx(
        float(second.get("confidence", -2)), abs=0.01
    )
