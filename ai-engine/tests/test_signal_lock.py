"""
AUTHORITATIVE EXPIRY-SCOPED SIGNAL LOCK.

Covers the identity contract, the commit/serve/maturity cycle, the
"return locked verdict, skip recompute" behaviour, and the Redis path via a
stub client (so the shared-store guarantee is tested without a live Redis).
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app.services.horizon_engine import HORIZON_OPTIONS
from app.services.signal_lock import (
    HORIZON_TO_EXPIRATION_SECONDS,
    KEY_PREFIX,
    SignalLock,
    build_identity,
    locked_projection_fields,
    resolve_expiration_seconds,
)


def _run(coro):
    return asyncio.run(coro)


# ── identity ─────────────────────────────────────────────────────────────────

def test_identity_is_bound_to_symbol_class_horizon_and_expiry():
    ident = build_identity("eur/usd", 3, 180)
    assert ident["symbol"] == "EUR/USD"
    assert ident["asset_class"] == "OTC"
    assert ident["horizon_minutes"] == 3
    assert ident["expiration_seconds"] == 180


def test_identity_separates_crypto_from_fx():
    """A crypto verdict must never serve an FX symbol and vice versa."""
    btc = build_identity("BTC/USD", 3, 180)
    eur = build_identity("EUR/USD", 3, 180)
    assert btc["asset_class"] == "CRYPTO"
    assert eur["asset_class"] == "OTC"
    assert btc != eur


def test_identity_tolerates_garbage():
    ident = build_identity(None, "abc", None)
    assert ident["symbol"] == ""
    assert ident["horizon_minutes"] == 0
    assert ident["expiration_seconds"] == 0


def test_expiry_table_matches_the_supported_horizons():
    assert set(HORIZON_TO_EXPIRATION_SECONDS) == set(HORIZON_OPTIONS)


def test_expiry_table_is_the_inverse_of_the_client_mapping():
    """The server's lock duration must equal the button the operator pressed.

    client-app expirySecondsToHorizonMinutes: 60/120/180/300/600 -> 1/2/3/5/10.
    """
    for seconds, minutes in [(60, 1), (120, 2), (180, 3), (300, 5), (600, 10)]:
        assert resolve_expiration_seconds(minutes) == seconds


def test_unknown_horizon_snaps_to_the_shortest_expiry():
    """Prefer a too-short lock over holding a stale contract too long."""
    assert resolve_expiration_seconds(0) == 60
    assert resolve_expiration_seconds(None) == 60
    assert resolve_expiration_seconds(999) == 600  # nearest supported
    assert resolve_expiration_seconds(4) == 180  # tie -> shorter


# ── commit / serve / mature (process-local path) ────────────────────────────

def _lock() -> SignalLock:
    return SignalLock()


def _verdict(**over):
    base = {"signal": "BUY", "confidence": 98.4, "target_price": 1.12}
    base.update(over)
    return base


def test_a_committed_verdict_is_served_until_it_matures():
    lock = _lock()
    ident = build_identity("EUR/USD", 1, 60)
    t0 = time.time() * 1000.0

    got = _run(lock.acquire(ident, _verdict(), t0))
    assert got["signal"] == "BUY"
    assert got["target_price"] == 1.12
    assert got["expires_at_ms"] == pytest.approx(t0 + 60_000, abs=50)

    # Mid-expiry: still the SAME contract.
    served = _run(lock.get(ident))
    assert served["signal"] == "BUY"
    assert served["target_price"] == 1.12


def test_an_in_window_request_can_never_overwrite_the_contract():
    """The whole point: a contradictory mid-expiry verdict is refused."""
    lock = _lock()
    ident = build_identity("EUR/USD", 1, 60)
    t0 = time.time() * 1000.0

    _run(lock.acquire(ident, _verdict(signal="BUY", target_price=1.12), t0))
    # 20s later the market screams SELL.
    returned = _run(
        lock.acquire(ident, _verdict(signal="SELL", target_price=1.09), t0 + 20_000)
    )
    assert returned["signal"] == "BUY"
    assert returned["target_price"] == 1.12

    served = _run(lock.get(ident))
    assert served["signal"] == "BUY"
    assert served["target_price"] == 1.12


def test_the_lock_matures_and_allows_a_fresh_evaluation():
    lock = _lock()
    ident = build_identity("EUR/USD", 1, 60)
    t0 = time.time() * 1000.0

    _run(lock.acquire(ident, _verdict(signal="BUY"), t0))
    assert _run(lock.get(ident)) is not None

    # Past the contract deadline it is gone, so a new verdict may commit.
    after = _run(lock.acquire(ident, _verdict(signal="SELL"), t0 + 60_001))
    assert after["signal"] == "SELL"


def test_payload_expiry_beats_the_store_ttl():
    """A store TTL that outlives the contract must not extend it.

    Simulates clock skew / a paused VM by writing an entry whose TTL is far
    longer than its own ``expires_at_ms``.
    """
    lock = _lock()
    ident = build_identity("EUR/USD", 1, 60)
    t0 = time.time() * 1000.0
    _run(lock.acquire(ident, _verdict(), t0))

    # Rewrite the payload as expired, keeping the store entry alive.
    lock._local[KEY_PREFIX + ":EUR/USD:OTC:1:60"] = (
        {"signal": "BUY", "expires_at_ms": t0 - 1},
        t0 - 1,
    )
    assert _run(lock.get(ident)) is None


def test_different_identities_never_interfere():
    lock = _lock()
    t0 = time.time() * 1000.0
    eur3 = build_identity("EUR/USD", 3, 180)
    eur1 = build_identity("EUR/USD", 1, 60)
    btc1 = build_identity("BTC/USD", 1, 60)

    _run(lock.acquire(eur3, _verdict(signal="BUY", target_price=1.12), t0))
    # A different horizon for the SAME symbol is a different contract.
    assert _run(lock.get(eur1)) is None
    # ...and a different symbol too.
    assert _run(lock.get(btc1)) is None


def test_release_drops_the_contract():
    lock = _lock()
    ident = build_identity("EUR/USD", 1, 60)
    _run(lock.acquire(ident, _verdict(), time.time() * 1000.0))
    assert _run(lock.get(ident)) is not None
    _run(lock.release(ident))
    assert _run(lock.get(ident)) is None


# ── fail-safe: a broken lock backend must never suppress trading ─────────────

class _BrokenRedis:
    async def get(self, key):
        raise RuntimeError("redis down")

    async def set(self, *a, **k):
        raise RuntimeError("redis down")

    async def delete(self, key):
        raise RuntimeError("redis down")


def test_a_broken_backend_reports_no_lock_rather_than_raising():
    lock = _lock()
    lock._redis = _BrokenRedis()
    ident = build_identity("EUR/USD", 1, 60)
    # Must not raise — a lock outage degrades to "no lock", never to a 500.
    assert _run(lock.get(ident)) is None
    assert _run(lock.acquire(ident, _verdict())) is None


# ── the Redis path (stub client) ────────────────────────────────────────────

class _StubRedis:
    """Minimal SET NX / GET / DELETE with TTL, enough to prove the shared path."""

    def __init__(self):
        self.store: dict[str, str] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None, nx=False):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def delete(self, key):
        self.store.pop(key, None)


def test_the_redis_path_is_used_when_available():
    lock = _lock()
    lock._redis = _StubRedis()
    ident = build_identity("EUR/USD", 1, 60)
    t0 = time.time() * 1000.0

    _run(lock.acquire(ident, _verdict(), t0))
    assert any(k.startswith(KEY_PREFIX) for k in lock._redis.store)
    served = _run(lock.get(ident))
    assert served["signal"] == "BUY"
    # A contradictory write is still refused through the shared store.
    _run(lock.acquire(ident, _verdict(signal="SELL"), t0 + 1_000))
    assert _run(lock.get(ident))["signal"] == "BUY"


def test_two_locks_sharing_redis_see_the_same_contract():
    """This is the property an in-process dict CANNOT provide.

    Two independent SignalLock instances (standing in for two workers/replicas)
    must agree on the committed verdict, otherwise the contract is not
    authoritative under scale.
    """
    shared = _StubRedis()
    a, b = _lock(), _lock()
    a._redis = shared
    b._redis = shared
    ident = build_identity("BTC/USD", 5, 300)
    t0 = time.time() * 1000.0

    _run(a.acquire(ident, _verdict(signal="BUY", target_price=104_000.0), t0))
    # The other worker must serve the same contract, not recompute its own.
    served = _run(b.get(ident))
    assert served is not None
    assert served["signal"] == "BUY"
    assert served["target_price"] == 104_000.0


# ── projection field selection ──────────────────────────────────────────────

def test_locked_projection_is_the_verdict_and_nothing_else():
    payload = {
        "signal": "BUY",
        "confidence": 98.4,
        "target_price": 1.12,
        "target_distance": 0.0142,
        # Live values — the market keeps moving under the frozen verdict.
        "current_price": 1.1058,
        "atr": 0.0007,
        "barCount": 240,
        "proxyLatencyMs": 0.4,
        "timestamp": "2026-01-01T00:00:00",
        # Per-request POLICY — a raised confidence floor must take effect now.
        "threshold_pct": 99.0,
        "min_confidence": 99.0,
        "bar_source": "user",
        # Derived policy output — re-derived from the locked verdict under the
        # CURRENT threshold, so raising the floor correctly demotes the tier.
        "tier": "T1",
        "tier_label": "High conviction",
        "status": "EXECUTABLE",
    }
    locked = locked_projection_fields(payload)
    # The verdict is locked...
    assert locked == {
        "signal": "BUY",
        "confidence": 98.4,
        "target_price": 1.12,
        "target_distance": 0.0142,
    }
    # ...and nothing else is.
    for excluded in (
        "current_price",
        "atr",
        "barCount",
        "proxyLatencyMs",
        "timestamp",
        "threshold_pct",
        "min_confidence",
        "bar_source",
        "tier",
        "tier_label",
        "status",
    ):
        assert excluded not in locked


# ── non-actionable verdicts are never committed ──────────────────────────────

@pytest.mark.parametrize(
    "verdict",
    [
        {"signal": None, "confidence": 99.3, "target_price": 1.12},
        {"signal": "HOLD", "confidence": 99.3, "target_price": 1.12},
        {"signal": "", "confidence": 99.3, "target_price": 1.12},
        {"signal": "BUY", "confidence": 99.3, "target_price": None},
        {"signal": "BUY", "confidence": 99.3, "target_price": 0},
        {"signal": "BUY", "confidence": 99.3},
        {},
        # PHANTOM DIRECTION: a 3-bar flat tape returns signal="BUY" with
        # confidence 0.0 and suppressed_reason="insufficient_history". The
        # direction+target checks alone let this be committed, freezing a fake
        # CALL for the full window while reporting status="active".
        {"signal": "BUY", "confidence": 0.0, "target_price": 90.018},
        {"signal": "SELL", "confidence_pct": 0, "target_price": 90.0},
        {"signal": "BUY", "target_price": 90.018},
    ],
    ids=["none", "hold", "empty", "no_target", "zero_target", "missing_target",
         "empty_verdict", "zero_confidence", "zero_confidence_pct",
         "missing_confidence"],
)
def test_a_non_actionable_verdict_is_never_committed(verdict):
    """A HOLD must not be pinned for the whole expiry window.

    The lock serves its payload verbatim for up to 10 minutes. Committing a
    transient ``signal=None`` would freeze a guaranteed-miss for minutes and
    suppress the first real CALL/PUT after the market turns.
    """
    lock = _lock()
    ident = build_identity("EUR/USD", 5, 300)
    assert _run(lock.acquire(ident, verdict)) is None
    assert _run(lock.get(ident)) is None


def test_a_hold_does_not_suppress_the_next_real_signal():
    """The exact user-visible failure: a HOLD, then a BUY.

    Committing the first response would make the second call serve ``None`` and
    the operator would never see the tradeable signal.
    """
    lock = _lock()
    ident = build_identity("EUR/USD", 5, 300)
    assert _run(lock.acquire(ident, {"signal": None, "confidence": 55.0})) is None
    held = _run(lock.acquire(ident, _verdict(signal="BUY", confidence=97.0, target_price=1.13)))
    assert held is not None
    assert held["signal"] == "BUY"
    assert _run(lock.get(ident))["signal"] == "BUY"


def test_a_non_actionable_verdict_never_overwrites_a_live_contract():
    """A later HOLD must not clobber an in-force BUY either."""
    lock = _lock()
    ident = build_identity("EUR/USD", 5, 300)
    buy = _run(lock.acquire(ident, _verdict(signal="BUY", confidence=97.0, target_price=1.13)))
    returned = _run(lock.acquire(ident, {"signal": None, "confidence": 12.0}))
    # The active contract is returned, and it is still the BUY.
    assert returned["signal"] == "BUY"
    assert _run(lock.get(ident))["signal"] == buy["signal"]


def test_direction_alias_is_accepted_for_commit():
    """``direction`` is accepted as an alias and normalised onto ``signal``."""
    lock = _lock()
    ident = build_identity("EUR/USD", 5, 300)
    held = _run(lock.acquire(ident, {"direction": "SELL", "confidence": 96.0, "target_price": 1.11}))
    assert held is not None
    # Canonicalised, so the projection the endpoints serve actually carries a
    # direction instead of an empty verdict.
    assert held["signal"] == "SELL"
    assert locked_projection_fields(_run(lock.get(ident)))["signal"] == "SELL"


# ── /predict seam ───────────────────────────────────────────────────────────

def _ohlc(closes):
    out = []
    for i, c in enumerate(closes):
        o = closes[i - 1] if i > 0 else c * (1 - 0.0008)
        out.append(
            {
                "timestamp": i * 60_000,
                "open": round(o, 6),
                "high": round(max(o, c) * 1.0008, 6),
                "low": round(min(o, c) * 0.9992, 6),
                "close": round(c, 6),
                "volume": 1000.0 + (i % 7) * 50.0,
            }
        )
    return out


def _seed_lock(symbol, horizon_minutes=5, **over):
    """Commit a real directional contract so lock-SERVED paths are reachable.

    The /predict inference pipeline legitimately returns ``signal=None`` for a
    plain ramped tape, and a non-directional verdict is (correctly) no longer
    committable, so tests about what happens ON a lock hit must seed the
    contract explicitly rather than rely on the tape to produce a signal.
    """
    contract = _verdict(**over)
    identity = build_identity(
        symbol, horizon_minutes, resolve_expiration_seconds(horizon_minutes)
    )
    # Must be the PROCESS-GLOBAL singleton the endpoints read, not a fresh
    # instance - otherwise the contract is written to a store nobody serves.
    from app.services.signal_lock import signal_lock

    held = _run(signal_lock.acquire(identity, contract))
    assert held is not None, "seed contract was rejected"
    assert held.get("signal") == over.get("signal", "BUY")
    return held


def test_a_tick_lock_hit_returns_a_complete_contract():
    """Regression: the tick lock hit served a BARE lock payload.

    The lock only stores the verdict, so ``{**held, ...}`` left every policy
    field missing — ``tier``, ``status``, ``executable``, ``threshold_pct``,
    ``bar_source``, ``asset_class`` were all absent on any locked tick, and the
    client rendered a half-empty contract. The gate is now re-run against the
    locked numbers so the response is complete and self-consistent.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    closes = [120.0 + i * 0.05 for i in range(95)]
    seeded = _seed_lock("EUR/USD", 5, signal="BUY", confidence=98.4, target_price=120.5)

    r = client.post(
        "/api/v1/tick-signal",
        json={
            "symbol": "EUR/USD",
            "timeframe": "1m",
            "prices": closes,
            "tick": closes[-1],
            "dataSource": "forex_otc_test",
            "horizon_minutes": 5,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # The verdict is the locked one...
    assert body["signal_locked"] is True
    assert body["signal"] == seeded["signal"]
    assert body["confidence"] == pytest.approx(seeded["confidence"])
    # ...on the endpoint's 0..100 scale, not the gate's fractional one.
    assert 0.0 <= body["confidence"] <= 100.0
    # ...and the policy contract is present, not stripped.
    for field in (
        "tier",
        "tier_label",
        "status",
        "executable",
        "threshold_pct",
        "bar_source",
        "max_executable_tier",
        "asset_class",
    ):
        assert field in body, f"locked tick response is missing '{field}'"
    # Live fields still track the market rather than the frozen verdict.
    assert body["current_price"] == pytest.approx(closes[-1], rel=1e-4)
    assert body["signal_locked"] is True


def test_predict_holds_its_contract_across_calls_for_the_same_horizon():
    """/predict and /tick-signal must agree on the contract.

    A second /predict for the SAME (symbol, horizon) is served the committed
    projection, so the REST path cannot repaint what the tick path is holding.
    The rich analysis fields still come from the live request.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    closes = [120.0 + i * 0.05 for i in range(95)]
    payload = {
        "symbol": "EUR/USD",
        "timeframe": "1m",
        "candles": _ohlc(closes),
        "live_price": float(closes[-1]),
        "dataSource": "forex_otc_test",
        "horizon_minutes": 5,
    }
    seeded = _seed_lock("EUR/USD", 5, signal="BUY", confidence=98.4, target_price=120.5)

    first = client.post("/api/v1/predict", json=payload)
    assert first.status_code == 200, first.text
    a = first.json()
    assert a.get("signal_locked") is True
    assert a["signal"] == seeded["signal"]
    assert a["confidence"] == pytest.approx(seeded["confidence"])

    # Reversed tape, different live price, same horizon.
    reversed_payload = dict(payload)
    reversed_closes = [c * (1.0 - 0.002 * i / len(closes)) for i, c in enumerate(closes)]
    reversed_payload["candles"] = _ohlc(reversed_closes)
    reversed_payload["live_price"] = float(reversed_closes[-1])
    b = client.post("/api/v1/predict", json=reversed_payload)
    assert b.status_code == 200, b.text
    bj = b.json()

    assert bj.get("signal_locked") is True
    assert bj["signal"] == a["signal"]
    assert bj["confidence"] == a["confidence"]
    assert bj["target_price"] == a["target_price"]
    # The live price still tracks the NEW request, not the locked one (it is
    # rounded to the symbol's digit precision).
    assert bj["current_price"] == pytest.approx(
        float(reversed_closes[-1]), rel=1e-4
    )


def test_predict_with_a_different_horizon_gets_a_fresh_evaluation():
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    closes = [120.0 + i * 0.05 for i in range(95)]
    base = {
        "symbol": "EUR/USD",
        "timeframe": "1m",
        "candles": _ohlc(closes),
        "live_price": float(closes[-1]),
        "dataSource": "forex_otc_test",
    }
    client.post("/api/v1/predict", json={**base, "horizon_minutes": 1})
    other = client.post("/api/v1/predict", json={**base, "horizon_minutes": 10})
    assert other.status_code == 200, other.text
    assert other.json().get("signal_locked") is not True


def test_a_raised_confidence_floor_still_takes_effect_under_a_held_lock():
    """Regression: the lock must not swallow a policy change.

    ``threshold_pct``/``bar_source``/``tier`` are per-request policy and derived
    output, not part of the committed verdict. Locking them made a raised
    confidence floor silently no-op — the response kept reporting the previous
    request's threshold.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    closes = [120.0 + i * 0.05 for i in range(95)]
    base = {
        "symbol": "USD/JPY",
        "timeframe": "1m",
        "candles": _ohlc(closes),
        "live_price": float(closes[-1]),
        "dataSource": "forex_otc_test",
        "horizon_minutes": 5,
    }
    _seed_lock("USD/JPY", 5, signal="BUY", confidence=98.4, target_price=147.0)

    strict = client.post("/api/v1/predict", json={**base, "min_confidence": 99.0})
    assert strict.status_code == 200, strict.text
    s = strict.json()
    assert s["threshold_pct"] == pytest.approx(99.0)
    assert s["bar_source"] == "user"
    # The floor must NOT be satisfied by silently borrowing the discarded live
    # inference's numbers: the verdict is the locked one, and the policy fields
    # are re-derived from THAT under the raised floor.
    assert s["confidence"] == pytest.approx(98.4)
    assert s["signal"] == "BUY"

    # Same symbol + horizon, so the verdict IS locked — but the user has now
    # lowered their floor and that must be reflected immediately.
    floored = client.post("/api/v1/predict", json={**base, "min_confidence": 55.0})
    assert floored.status_code == 200, floored.text
    f = floored.json()
    assert f.get("signal_locked") is True  # the verdict is served from the lock
    # ...while the policy is honoured from THIS request.
    assert f["threshold_pct"] == pytest.approx(70.0)
    assert f["bar_source"] == "floored"
    # Lowering the floor must promote the SAME locked verdict again, and the
    # locked confidence must stay on the endpoint's 0..100 scale. The strict
    # gate's own `confidence` is FRACTIONAL 0..1, so merging the whole surface
    # back in used to rescale 98.4 to 0.984 and defeat the lock from inside.
    assert f["confidence"] == pytest.approx(98.4)
    assert 0.0 <= f["confidence"] <= 100.0
    assert f["signal"] == "BUY"
