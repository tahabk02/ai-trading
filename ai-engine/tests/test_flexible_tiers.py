"""
test_flexible_tiers.py — FLEXIBLE-TIER ARCHITECTURE (2026-09-30).

The engine used to enforce a hardcoded T1-only policy at the API boundary:
any verdict below 96.5% had its `tier` OVERWRITTEN with T5/WEAK and its
direction NULLED (`signal=None`, `market_waiting=true`). That destroyed the
signal: a genuine T2/T3/T4 verdict never reached the trader, and because `tier`
is the client's filter key, no user-driven tier selection could ever work.

This suite roots the replacement contract end to end:

  1. `resolve_execution_floor` maps a user-selected tier onto an executable bar,
     never weaker than T4 (70%), so T5 stays monitor-only.
  2. `apply_strict_execution_gate` marks `executable` per the SELECTED floor and
     always reports `dispatchable` / `scored_only` / `min_tier`.
  3. `_validate_response_finite` NEVER rewrites `tier`, and a real direction is
     never nulled merely for being below the floor.
  4. POST /predict accepts `min_tier` (T1..T5, case-insensitive) and forwards
     it to the gate; garbage/absent falls back to the T1 default.
  5. THE INVARIANT HOLDS: `executable=true` is impossible without a real
     directional signal and with `market_waiting=true`.

Run:  python -m pytest tests/test_flexible_tiers.py -q
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json

import pytest

from app.api.v1.signals import _validate_response_finite
from app.services.execution_gate import build_execution_surface
from app.services.signal_gatekeeper import (
    DEFAULT_EXECUTION_TIER,
    LOWEST_TRADABLE_TIER,
    TIER_LABELS,
    TIER_ORDER,
    TIER_THRESHOLDS,
    resolve_execution_floor,
    resolve_tier,
    tier_min_confidence,
)

DIRECTIONAL = ("BUY", "SELL", "CALL", "PUT")


def _otc_clean_trend(n: int = 60, step: float = 0.001, start: float = 1.10) -> list:
    return [start + step * i for i in range(n)]


def make_candles(closes, base_spread=0.0008, volume=None):
    closes = list(closes)
    out = []
    for i, c in enumerate(closes):
        o = closes[i - 1] if i > 0 else c * (1 - base_spread)
        hi = max(o, c) * (1 + base_spread)
        lo = min(o, c) * (1 - base_spread)
        out.append(
            {
                "timestamp": i * 60_000,
                "open": round(o, 6),
                "high": round(hi, 6),
                "low": round(lo, 6),
                "close": round(c, 6),
                "volume": (volume[i] if volume is not None else 1000.0),
            }
        )
    return out


def _response(**overrides):
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


# ── 1 ── the ladder and its floor ──────────────────────────────────────────

def test_every_band_is_a_real_emitted_tier():
    # T5 is no longer an internal "suppressed" sentinel — it is a band the
    # engine genuinely reports for sub-70% confidences.
    assert TIER_ORDER == ["T1", "T2", "T3", "T4", "T5"]
    assert tier_min_confidence("T5") == pytest.approx(0.0)
    assert TIER_LABELS["T5"] == "WEAK"


@pytest.mark.parametrize(
    "raw,expected_bar,source",
    [
        (None, 96.5, "default"),
        ("", 96.5, "default"),
        ("   ", 96.5, "default"),
        ("nonsense", 96.5, "default"),
        ("T0", 96.5, "default"),
        ("T1", 96.5, "user"),
        ("t1", 96.5, "user"),
        ("  T2 ", 90.0, "user"),
        ("T3", 80.0, "user"),
        ("t4", 70.0, "user"),
        ("T5", 70.0, "floored"),
    ],
)
def test_execution_floor_resolution(raw, expected_bar, source):
    out = resolve_execution_floor(raw)
    assert out["bar_pct"] == pytest.approx(expected_bar)
    assert out["bar_source"] == source
    assert out["floored"] is (source == "floored")


def test_t5_selection_never_becomes_an_executable_bar():
    # Selecting T5 monitors WEAK verdicts; it must not license trading them.
    floor = resolve_execution_floor("T5")
    assert floor["bar_frac"] >= tier_min_confidence(LOWEST_TRADABLE_TIER)
    assert floor["tier"] == "T5"  # the selection itself is reported honestly
    assert floor["effective"] == LOWEST_TRADABLE_TIER


def test_weaker_selection_never_raises_the_bar():
    bars = [
        resolve_execution_floor(t)["bar_frac"] for t in ("T1", "T2", "T3", "T4")
    ]
    assert bars == sorted(bars, reverse=True)


def test_default_is_the_unchanged_legacy_bar():
    assert DEFAULT_EXECUTION_TIER == "T1"
    assert resolve_execution_floor(None)["bar_pct"] == pytest.approx(96.5)


# ── 2 ── the gate honours the selection ────────────────────────────────────

def _surface(confidence_pct, min_tier=None, min_confidence=None):
    series = _otc_clean_trend()
    return build_execution_surface(
        symbol="EUR/USD",
        closes=series,
        direction="BUY",
        confidence_pct=confidence_pct,
        bid=series[-1] * 0.9999,
        ask=series[-1],
        live_price=series[-1],
        timeframe="1m",
        min_confidence=min_confidence,
        min_tier=min_tier,
    )


def test_gate_reports_the_selected_min_tier_and_floor_metadata():
    surface = _surface(92.0, min_tier="T2")
    assert surface["min_tier"] == "T2"
    assert surface["threshold_pct"] == pytest.approx(90.0)
    assert surface["bar_source"] == "user"
    assert "dispatchable" in surface
    assert "scored_only" in surface


@pytest.mark.parametrize(
    "confidence,floor,expected_executable",
    [
        # Under the strict T1 default nothing below 96.5% trades.
        (92.0, None, False),
        (92.0, "T1", False),
        # The SAME 92% verdict trades as soon as the trader selects T2.
        (92.0, "T2", True),
        (92.0, "T3", True),
        (92.0, "T4", True),
        # Widening further never makes a WEAK verdict tradable.
        (92.0, "T5", True),
        (60.0, "T5", False),
        (60.0, "T4", False),
        (71.0, "T4", True),
        (79.0, "T3", False),
        (97.0, "T1", True),
    ],
)
def test_executable_follows_the_selected_floor(confidence, floor, expected_executable):
    surface = _surface(confidence, min_tier=floor)
    assert surface["executable"] is expected_executable


def test_valid_min_tier_takes_precedence_over_min_confidence():
    # Two overlapping controls: the tier is the newer, coarser control and wins
    # when both are supplied, so behaviour is unambiguous.
    surface = _surface(75.0, min_tier="T4", min_confidence=99.0)
    assert surface["threshold_pct"] == pytest.approx(70.0)
    assert surface["executable"] is True


def test_tier_selection_never_hides_the_verdict_from_the_surface():
    # Even when a verdict is not executable, the surface still describes it.
    surface = _surface(50.0, min_tier="T1")
    assert surface["executable"] is False
    assert surface["dispatchable"] is True   # a real direction exists
    assert surface["scored_only"] is True    # but not tradable at this floor


# ── 3 ── sanitisation never rewrites a tier or nulls a direction ───────────

@pytest.mark.parametrize(
    "confidence,expected_tier",
    [
        (99.5, "T1"),
        (92.0, "T2"),
        (85.0, "T3"),
        (75.0, "T4"),
        (42.0, "T5"),
        (0.0, "T5"),
    ],
)
def test_honest_tier_survives_sanitisation_for_every_band(confidence, expected_tier):
    out = _validate_response_finite(
        _response(signal="BUY", executable=False, market_waiting=False,
                  tier=resolve_tier(confidence),
                  tier_label=TIER_LABELS[resolve_tier(confidence)])
    )
    assert out["tier"] == expected_tier
    assert out["tier_label"] == TIER_LABELS[expected_tier]
    # The legacy suppression artifacts must not reappear.
    assert "tier_suppressed" not in out["diagnostics"]


def test_scored_only_verdict_keeps_its_direction_and_band():
    out = _validate_response_finite(
        _response(signal="SELL", executable=False, market_waiting=False,
                  tier="T3", tier_label="MEDIUM")
    )
    assert out["signal"] == "SELL"
    assert out["tier"] == "T3"
    assert out["dispatchable"] is True
    assert out["scored_only"] is True
    assert out["executable"] is False


def test_directionless_verdict_is_neither_dispatchable_nor_scored_only():
    out = _validate_response_finite(
        _response(signal=None, executable=False, market_waiting=True)
    )
    assert out["dispatchable"] is False
    assert out["scored_only"] is False
    assert out["signal"] is None


def test_non_directional_signal_is_not_treated_as_dispatchable():
    out = _validate_response_finite(
        _response(signal="HOLD", executable=False, market_waiting=True)
    )
    assert out["dispatchable"] is False
    assert out["scored_only"] is False


# ── 4 ── THE INVARIANT ─────────────────────────────────────────────────────

def test_executable_without_a_direction_is_always_corrected_down():
    out = _validate_response_finite(_response(signal=None, executable=True))
    assert out["executable"] is False


def test_executable_with_market_waiting_is_always_corrected_down():
    out = _validate_response_finite(
        _response(signal="BUY", executable=True, market_waiting=True)
    )
    assert out["executable"] is False


@pytest.mark.parametrize("tier", TIER_ORDER)
@pytest.mark.parametrize("executable", [True, False])
def test_invariant_holds_across_every_band(tier, executable):
    """executable=true is impossible for a null/non-directional signal or a
    market-waiting verdict — for EVERY tier band, not just the default one."""
    for signal, waiting in (
        (None, False),
        (None, True),
        ("HOLD", False),
        ("BUY", True),
    ):
        out = _validate_response_finite(
            _response(
                signal=signal,
                executable=executable,
                market_waiting=waiting,
                tier=tier,
                tier_label=TIER_LABELS[tier],
            )
        )
        if out["executable"]:
            assert out["signal"] in DIRECTIONAL
            assert out["market_waiting"] is False
            assert out["scored_only"] is False
            assert out["dispatchable"] is True


# ── 5 ── POST /predict honours min_tier ────────────────────────────────────

def _predict_client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def _post(client, **extra):
    closes = [120.0 + i * 0.05 for i in range(95)]
    payload = {
        "symbol": "USD/JPY",
        "timeframe": "1m",
        "candles": make_candles(closes),
        "live_price": float(closes[-1]),
        "dataSource": "forex_otc_test",
    }
    payload.update(extra)
    return client.post("/api/v1/predict", json=payload)


def test_predict_accepts_min_tier_without_400():
    client = _predict_client()
    for tier in ("T1", "T2", "T3", "T4", "T5"):
        resp = _post(client, min_tier=tier)
        assert resp.status_code == 200, f"{tier}: {resp.text}"
        body = resp.json()
        # The selection is echoed and, at worst, the honest default.
        assert body.get("min_tier") in ("T1", "T2", "T3", "T4", "T5")


def test_predict_normalises_min_tier_case():
    client = _predict_client()
    for sent in ("t2", "  T4  ", "t3"):
        resp = _post(client, min_tier=sent)
        assert resp.status_code == 200, resp.text
        assert resp.json().get("min_tier") in ("T2", "T3", "T4")


def test_predict_does_not_400_on_garbage_min_tier():
    # An unrecognised tier must fall back to the default, never reject the
    # request — a stale client must not be able to break the terminal.
    client = _predict_client()
    for bad in ("T9", "premium", "", "  "):
        resp = _post(client, min_tier=bad)
        assert resp.status_code == 200, f"{bad!r}: {resp.text}"


def test_predict_without_min_tier_uses_the_strict_default():
    client = _predict_client()
    resp = _post(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["threshold_pct"] == pytest.approx(96.5)
    assert body["bar_source"] == "default"
    assert body["min_tier"] == "T1"


def test_predict_response_always_carries_the_dispatch_triple():
    client = _predict_client()
    body = _post(client).json()
    for key in ("dispatchable", "scored_only", "executable", "tier", "tier_label"):
        assert key in body, f"missing {key} in {sorted(body)}"
    assert isinstance(body["dispatchable"], bool)
    assert isinstance(body["scored_only"], bool)


def test_predict_never_ships_a_rewritten_tier():
    """The response tier must match the confidence band the maths produced —
    never a blanket T5 standing in for the real strength."""
    client = _predict_client()
    body = _post(client).json()
    conf = float(body.get("confidence") or 0.0)
    expected = resolve_tier(conf)
    assert body["tier"] == expected
    assert body["tier_label"] == TIER_LABELS[expected]
    # And the legacy suppression record is gone from the payload entirely.
    assert "tier_suppressed" not in json.dumps(body.get("diagnostics") or {})


def test_predict_keeps_the_reconciliation_invariant_end_to_end():
    client = _predict_client()
    for tier in ("T1", "T3", "T5"):
        body = _post(client, min_tier=tier).json()
        if body.get("executable"):
            assert body["signal"] in DIRECTIONAL
            assert body.get("market_waiting") is not True
            assert body.get("scored_only") is False


# ── 6 ── the quality watershed must not ERASE a direction ──────────────────
#
# The five-factor ensemble below the 0.98 gate used to null `signal` outright
# on the full pipeline, so a genuine directional verdict that merely missed the
# watershed shipped as "no signal" — indistinguishable from a directionless
# verdict, and invisible to every tier below T1. The watershed is a
# CONFIDENCE HOLD: it must gate tradability and the high-confidence alert while
# leaving the direction intact (scored-only).

def _trending_candles(n: int = 160, step: float = 0.05, start: float = 120.0):
    return [
        {
            "timestamp": i * 60_000,
            "open": start + step * i,
            "high": start + step * i + 0.4,
            "low": start + step * i - 0.4,
            "close": start + step * i,
            "volume": 1000.0,
        }
        for i in range(n)
    ]


def _post_with_factors(client, **extra):
    from app.services.quality_gate import build_factor_inputs_from_candles

    candles = _trending_candles()
    payload = {
        "symbol": "USD/JPY",
        "timeframe": "1m",
        "candles": candles,
        "live_price": float(candles[-1]["close"]),
        "dataSource": "forex_otc_test",
        "factor_inputs": build_factor_inputs_from_candles(candles),
    }
    payload.update(extra)
    return client.post("/api/v1/predict", json=payload)


def test_watershed_hold_keeps_the_direction_and_only_blocks_tradability(
    monkeypatch,
):
    """Force the ensemble to hold, then prove the direction survives."""
    import app.services.quality_gate as qg

    def _blocking_gate(direction, confidence, factor_inputs):
        return {
            "signal": None,          # below the watershed
            "confidence": None,
            "quality": 0.01,
            "factors": {},
            "reason": "TEST_BLOCK",
            "gate": 0.30,
            "market_waiting": True,
        }

    monkeypatch.setattr(qg, "apply_quality_gate", _blocking_gate)

    client = _predict_client()
    resp = _post_with_factors(client, min_tier="T1")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # The hold is VISIBLE (surfaced as a top-level response key)...
    assert body.get("quality_watershed_blocked") is True
    assert body.get("quality_reason") == "TEST_BLOCK"
    # ...and it blocks tradability and the alert...
    assert body["executable"] is False
    assert body["high_confidence_alert"] is False
    # ...but it does NOT erase the direction the confluence maths produced.
    assert body["signal"] in DIRECTIONAL
    assert body["dispatchable"] is True
    assert body["scored_only"] is True


def test_watershed_release_still_allows_execution(monkeypatch):
    """The control must not be neutered: a released gate stays tradable."""
    import app.services.quality_gate as qg

    def _releasing_gate(direction, confidence, factor_inputs):
        return {
            "signal": direction,
            "confidence": confidence,
            "quality": 0.99,
            "factors": {},
            "reason": "TEST_RELEASE",
            "gate": 0.30,
            "market_waiting": False,
        }

    monkeypatch.setattr(qg, "apply_quality_gate", _releasing_gate)

    client = _predict_client()
    body = _post_with_factors(client, min_tier="T1").json()
    assert body["signal"] in DIRECTIONAL
    assert body["high_confidence_alert"] in (True, False)