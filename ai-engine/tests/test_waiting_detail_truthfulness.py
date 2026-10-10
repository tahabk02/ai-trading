"""
test_waiting_detail_truthfulness.py — REGRESSION: waiting_detail must not lie.

Production defect (2026-09-30): a verdict whose confluence score CLEARED the
thermal bar was still reported as

    "Direction SELL held below thermal: 10-book multiplicative confluence
     99.32% < 70.0% thermal gate"

— a mathematically FALSE inequality, and it named "10-book" while only 5 books
were active. `confidence_gated` has TWO distinct causes (sub-thermal score, or
a tier demotion from incomplete evidence pillars) and the message hardcoded the
first one, so operators were sent to debug the wrong subsystem.

`waiting_reason` is a client contract (client-app verdict-state.test.ts maps
CONFLUENCE_BELOW_THERMAL -> INSUFFICIENT_CONFLUENCE) and must NOT change; only
the human-readable `waiting_detail` is corrected.

Run:  python -m pytest tests/test_waiting_detail_truthfulness.py -q
"""

import io
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pytest

from app.services.quant_matrix import evaluate_quant_matrix
from app.services.live_quant import evaluate_live_tick_signal


def _candles(closes, volume=300.0):
    out = []
    for i, c in enumerate(closes):
        o = closes[i - 1] if i else c
        out.append({
            "timestamp": i * 60_000, "open": o, "high": max(o, c) * 1.0004,
            "low": min(o, c) * 0.9996, "close": c, "volume": volume,
        })
    return out


def _tapes():
    """A spread of tapes: trending, noisy-trending, flat, and choppy."""
    rng = np.random.default_rng(42)
    drift_up = 1.1 * (1 + np.linspace(0, 0.03, 120) + rng.normal(0, 0.0015, 120).cumsum() * 0.3)
    rng2 = np.random.default_rng(7)
    drift_dn = 1.1 * (1 + np.linspace(0, -0.03, 120) + rng2.normal(0, 0.0015, 120).cumsum() * 0.3)
    rng3 = np.random.default_rng(11)
    chop = 1.1 * (1 + rng3.normal(0, 0.004, 120).cumsum() * 0.2)
    return {
        "drift_up": list(drift_up),
        "drift_down": list(drift_dn),
        "flat": [1.1] * 120,
        "choppy": list(chop),
    }


def _strong_trend_no_volume():
    """Reproduces the PRODUCTION shape that shipped the bug.

    A strongly aligned tape scores above the thermal bar on its active books,
    but with no volume and no order book the microstructure pillar is
    incomplete, so `resolve_confluence_tier` demotes the gate T1 -> T2. The
    verdict is then market_waiting DESPITE clearing the thermal bar — the
    exact case the old message misreported as "99.32% < 70.0% thermal gate".
    """
    rng = np.random.default_rng(3)
    closes = 1.1 * (1 + np.linspace(0, 0.05, 140) + rng.normal(0, 0.0008, 140).cumsum() * 0.2)
    return _candles(list(closes), volume=0.0)


def _assert_truthful(verdict, label):
    """The core invariant, asserted on a verdict object."""
    if not getattr(verdict, "market_waiting", False):
        return False
    if verdict.waiting_reason != "CONFLUENCE_BELOW_THERMAL":
        return False

    detail = verdict.waiting_detail or ""
    assert detail, f"{label}: market_waiting with an empty waiting_detail"
    assert "10-book" not in detail, (
        f"{label}: waiting_detail hardcodes '10-book' but only "
        f"{(verdict.diagnostics.get('book') or {}).get('confluence', {}).get('active_count')} "
        f"books were active — {detail}"
    )

    score = float(verdict.confidence)
    threshold = verdict.diagnostics.get("dispatch_threshold")
    if threshold is None:
        threshold = verdict.diagnostics.get("thermal_floor")
    if threshold is None:
        return False
    threshold = float(threshold)

    if score >= threshold:
        # The score CLEARED the bar: the hold came from a tier demotion, so the
        # message must not claim a below-thermal inequality.
        assert "% <" not in detail, (
            f"{label}: confluence {score}% >= {threshold}% thermal bar, so "
            f"waiting_detail must NOT assert a below-thermal inequality — {detail}"
        )
        assert "pillars cap the dispatch tier" in detail, (
            f"{label}: expected the tier-demotion cause to be named — {detail}"
        )
    else:
        assert "% <" in detail, (
            f"{label}: confluence {score}% < {threshold}% thermal bar, so "
            f"waiting_detail must state the below-thermal inequality — {detail}"
        )
    return True


@pytest.mark.parametrize("name", ["drift_up", "drift_down", "flat", "choppy"])
def test_quant_matrix_waiting_detail_never_asserts_false_inequality(name):
    """quant_matrix is the /predict full-path site that shipped the bug."""
    closes = _tapes()[name]
    v = evaluate_quant_matrix(_candles(closes), live_price=closes[-1], timeframe="1h")
    _assert_truthful(v, f"quant_matrix[{name}]")


@pytest.mark.parametrize("name", ["drift_up", "drift_down", "flat", "choppy"])
def test_live_quant_waiting_detail_never_asserts_false_inequality(name):
    """The /tick-signal site carries the same two-cause contract."""
    closes = _tapes()[name]
    arr = np.asarray(closes, dtype=np.float64)
    v = evaluate_live_tick_signal(
        prices=[float(x) for x in closes],
        tick=float(closes[-1]),
        highs=[float(x) for x in arr * 1.0004],
        lows=[float(x) for x in arr * 0.9996],
        timeframe="1m",
    )
    _assert_truthful(v, f"live_quant[{name}]")


def _sub_tier_but_above_threshold_detail():
    """Return the first verdict that clears dispatch_threshold yet is still held.

    The tier-demotion message branch is only reachable when the confluence gate
    is T3/T4/INSUFFICIENT (T2 and above now dispatch), i.e. a score inside
    [70%, 96.5%). That band is NOT covered by the other fixtures — the pillar-
    capped T2 tape dispatches — so this sweep is what keeps the branch honest
    instead of silently dead.

    Seeded and deterministic: it replays the exact tape family that produced a
    score of 84.02% under a T3 gate (4/5 books aligned, MOMENTUM_CLUSTER_MISSING).
    """
    rng = np.random.default_rng(11)
    for _trial in range(400):
        n = int(rng.integers(20, 140))
        drift = float(rng.normal(0, float(rng.choice([0.0, 0.0002, 0.0008, 0.002, 0.006]))))
        noise = float(rng.choice([0.0, 1e-5, 5e-5, 2e-4, 1e-3, 4e-3]))
        closes = 1.1 + drift * np.arange(n) + rng.normal(0, noise, n)
        closes = np.maximum(closes, 0.05)
        bars = [{
            "open": float(c),
            "high": float(c) * (1 + abs(drift) * 0.5 + 1e-5),
            "low": float(c) * (1 - abs(drift) * 0.5 - 1e-5),
            "close": float(c),
            "volume": float(rng.integers(500, 5000)),
        } for i, c in enumerate(closes)]
        v = evaluate_quant_matrix(bars, live_price=float(closes[-1]), timeframe="1h")
        score = float(v.confidence)
        threshold = float(v.diagnostics.get("dispatch_threshold", 0.0))
        if v.market_waiting and score >= threshold and "% <" not in v.waiting_detail:
            return str(score), str(v.diagnostics.get("confluence_gate")), v.waiting_detail
    return None, None, None


def test_pillar_capped_t2_verdict_now_dispatches():
    """A pillar-capped T2 confluence is DISPATCHABLE — it must NOT be held.

    This fixture is the direct regression guard for the producer/consumer tier
    contract. `resolve_confluence_tier` demotes a strong-but-blockered
    confluence from T1 to T2 and documents that such a confluence "can still
    dispatch at a lower tier". The consumer used to test the gate against the
    T1 EXECUTION floor, turning that designed demotion into a total veto — so
    this exact tape was held as market_waiting and the class gate downstream of
    it never received a direction (dead code).

    With the dispatch floor at CONFLUENCE_DISPATCH_TIER ("T2") the verdict
    dispatches. The separate T1 96.5% EXECUTION bar still applies later in
    apply_strict_execution_gate; this is not a policy loosening.
    """
    candles = _strong_trend_no_volume()
    v = evaluate_quant_matrix(candles, live_price=candles[-1]["close"], timeframe="1h")

    gate = str(v.diagnostics.get("confluence_gate"))
    assert gate == "T2", f"fixture must be pillar-capped to T2, got {gate}"

    assert v.market_waiting is False, (
        "a T2 pillar-capped confluence must dispatch, not be held: "
        f"{v.waiting_detail}"
    )
    assert v.direction in ("BUY", "SELL"), v.direction
    assert float(v.confidence) >= 96.5, (
        f"the fixture must clear the T1 execution bar, got {v.confidence}"
    )


def test_gated_verdict_names_the_tier_demotion_not_the_thermal_bar():
    """Below the dispatch floor: the message must name the tier, not a false
    below-thermal inequality.

    Reachable only when the confluence gate falls to T3/T4/INSUFFICIENT — a
    genuinely sub-tier verdict — because T2 and above now dispatch. The score
    clearing `dispatch_threshold` while the gate stays sub-T3 is what separates
    a tier demotion from a plain below-thermal verdict.
    """
    score, gate, detail = _sub_tier_but_above_threshold_detail()
    assert score is not None, (
        "no reachable fixture produced a sub-dispatch-tier verdict whose score "
        "cleared dispatch_threshold — the tier-demotion branch is unreachable"
    )
    assert "% <" not in detail, f"false below-thermal inequality: {detail}"
    assert "pillars cap the dispatch tier" in detail, detail
    assert gate in detail, f"detail should name the capped dispatch tier — {detail}"
    assert score in detail, f"detail should quote the real score {score} — {detail}"
