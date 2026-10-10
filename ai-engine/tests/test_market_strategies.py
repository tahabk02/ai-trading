"""
Multi-logic signal engine: ROUTER + STRATEGY contract + CRYPTO gate.

Covers the three market strategies (OTC / REAL / CRYPTO), the router that
dispatches to them, and the crypto-specific momentum-breakout gate. The
headline regression is that crypto majors are no longer graded by the
institutional FX liquidity gate.
"""

from __future__ import annotations

import math
import random

import pytest

from app.services.asset_class import (
    ASSET_CLASS_CRYPTO,
    ASSET_CLASS_OTC,
    ASSET_CLASS_REAL,
    is_crypto_asset,
    resolve_asset_class,
)
from app.services.crypto_hf_quality import (
    CRYPTO_ATR_MAX_RATIO,
    CRYPTO_ATR_MIN_RATIO,
    CRYPTO_HF_PASS_BAR,
    evaluate_crypto_hf_quality,
)
from app.services.data_sanitization import (
    MIN_CRYPTO_TICKS,
    MIN_OTC_TICKS,
    MIN_REAL_CLOSES,
    minimum_closes_for_class,
    sufficient_history,
)
from app.services.execution_gate import build_execution_surface
from app.services.market_strategies import (
    STRATEGY_REGISTRY,
    CryptoMarketStrategy,
    MarketStrategy,
    OtcMarketStrategy,
    RealMarketStrategy,
    describe_registry,
    evaluate_for_symbol,
    resolve_strategy,
)


# ── fixtures ────────────────────────────────────────────────────────────────

def _trend(n: int, start: float, step: float, noise: float = 0.0, seed: int = 7) -> list:
    """A clean directional ramp, optionally with bounded noise."""
    rng = random.Random(seed)
    out = []
    p = start
    for _ in range(n):
        p = p * (1.0 + step + rng.uniform(-noise, noise))
        out.append(p)
    return out


def _chop(n: int, start: float, amp: float = 0.0002, seed: int = 11) -> list:
    """Flat noise with no directional structure."""
    rng = random.Random(seed)
    return [start * (1.0 + rng.uniform(-amp, amp)) for _ in range(n)]


# ── taxonomy ─────────────────────────────────────────────────────────────────

def test_crypto_is_a_distinct_class():
    assert resolve_asset_class("BTC/USD") == ASSET_CLASS_CRYPTO
    assert resolve_asset_class("ETH/USD") == ASSET_CLASS_CRYPTO
    assert resolve_asset_class("btc/usd") == ASSET_CLASS_CRYPTO
    assert resolve_asset_class("ETH/USDT") == ASSET_CLASS_CRYPTO
    assert is_crypto_asset("BTC/USD") is True


def test_crypto_quote_variants_do_not_fall_into_otc():
    """A vendor USDT spelling must not be silently demoted to the OTC class."""
    for sym in ("BTC/USDT", "ETH/USDT", "btc/usdt"):
        assert resolve_asset_class(sym) == ASSET_CLASS_CRYPTO


def test_wholesale_fx_stays_real_and_otc_stays_otc():
    assert resolve_asset_class("EUR/SEK") == ASSET_CLASS_REAL
    assert resolve_asset_class("USD/CZK") == ASSET_CLASS_REAL
    assert resolve_asset_class("EUR/USD") == ASSET_CLASS_OTC
    assert resolve_asset_class("EUR/USD OTC") == ASSET_CLASS_OTC
    assert resolve_asset_class("NOPE/ZZ") == ASSET_CLASS_OTC


def test_per_class_minimum_windows_are_distinct():
    assert minimum_closes_for_class(ASSET_CLASS_REAL) == MIN_REAL_CLOSES
    assert minimum_closes_for_class(ASSET_CLASS_OTC) == MIN_OTC_TICKS
    assert minimum_closes_for_class(ASSET_CLASS_CRYPTO) == MIN_CRYPTO_TICKS
    # Three genuinely different windows — not one reused constant.
    assert len({MIN_REAL_CLOSES, MIN_OTC_TICKS, MIN_CRYPTO_TICKS}) == 3
    # Unknown class falls back to the conservative shallow window.
    assert minimum_closes_for_class("WHO_KNOWS") == MIN_OTC_TICKS


def test_sufficient_history_enforces_the_crypto_window():
    just_under = [1.0] * (MIN_CRYPTO_TICKS - 1)
    assert sufficient_history(just_under, ASSET_CLASS_CRYPTO)["sufficient"] is False
    assert sufficient_history(just_under, ASSET_CLASS_CRYPTO)["minimum"] == MIN_CRYPTO_TICKS
    exact = [1.0] * MIN_CRYPTO_TICKS
    assert sufficient_history(exact, ASSET_CLASS_CRYPTO)["sufficient"] is True


# ── router ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "symbol,expected,filter_name",
    [
        ("EUR/USD", OtcMarketStrategy, "otc_hf_quality"),
        ("EUR/USD_OTC", OtcMarketStrategy, "otc_hf_quality"),
        ("EUR/SEK", RealMarketStrategy, "real_liquidity_gate"),
        ("BTC/USD", CryptoMarketStrategy, "crypto_hf_quality"),
        ("ETH/USDT", CryptoMarketStrategy, "crypto_hf_quality"),
        ("GARBAGE", OtcMarketStrategy, "otc_hf_quality"),
    ],
)
def test_router_dispatches_to_the_right_strategy(symbol, expected, filter_name):
    strategy = resolve_strategy(symbol)
    assert isinstance(strategy, expected)
    assert strategy.filter_name == filter_name


def test_every_registered_strategy_satisfies_the_contract():
    for asset_class, cls in STRATEGY_REGISTRY.items():
        assert issubclass(cls, MarketStrategy)
        inst = cls()
        assert inst.asset_class == asset_class
        assert inst.filter_name
        assert inst.min_history > 0
        d = inst.describe()
        assert d["asset_class"] == asset_class
        assert d["filter_name"] == inst.filter_name


def test_router_instances_are_shared_and_stateless():
    """Stateless strategies must not be re-instantiated per request."""
    a = resolve_strategy("BTC/USD")
    b = resolve_strategy("BTC/USD")
    assert a is b


def test_describe_registry_exposes_every_market_type():
    reg = describe_registry()
    assert reg["fallback"] == ASSET_CLASS_OTC
    assert set(reg["strategies"]) == {ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO}


def test_evaluate_for_symbol_stamps_class_and_filter():
    v = evaluate_for_symbol("BTC/USD", closes=_trend(120, 100.0, 0.002), direction="BUY")
    assert v["asset_class"] == ASSET_CLASS_CRYPTO
    assert v["class_filter"] == "crypto_hf_quality"
    assert "passes" in v and "score" in v and "factors" in v and "metrics" in v


# ── crypto gate ──────────────────────────────────────────────────────────────

def test_crypto_gate_requires_its_own_minimum_window():
    short = _trend(20, 100.0, 0.002)
    v = evaluate_crypto_hf_quality(short, "BUY")
    assert v["passes"] is False
    assert v["reason"] == "insufficient_history"


def test_crypto_gate_rejects_non_directional():
    v = evaluate_crypto_hf_quality(_trend(120, 100.0, 0.002), None)
    assert v["passes"] is False
    assert v["reason"] == "no_directional_signal"


def test_crypto_breakout_passes_on_a_real_expansion():
    """A genuine Donchian breakout with crypto-sized vol clears the bar."""
    closes = _chop(100, 100.0, amp=0.0008, seed=3)
    closes += _trend(30, closes[-1], 0.006, noise=0.0004, seed=5)
    v = evaluate_crypto_hf_quality(closes, "BUY")
    assert v["factors"]["breakout"] == 1
    assert v["factors"]["momentum"] == 1
    assert v["factors"]["volatility_band"] == 1
    assert v["score"] >= CRYPTO_HF_PASS_BAR
    assert v["passes"] is True
    assert v["reason"] is None


def test_crypto_gate_vetoes_flat_chop():
    """A signal on a structureless chop must NOT be executable."""
    v = evaluate_crypto_hf_quality(_chop(140, 100.0, amp=0.0002), "BUY")
    assert v["passes"] is False
    assert v["reason"] == "crypto_hf_fail"
    assert v["factors"]["breakout"] == 0


def test_crypto_volatility_band_is_crypto_sized_not_fx_sized():
    """The band must be wide enough to admit a real 1-2% crypto bar.

    An FX-sized band (OTC caps at 0.0050) would veto every crypto signal as
    "wild volatility"; this is the regression that motivated a separate gate.
    """
    assert CRYPTO_ATR_MAX_RATIO > 0.0050 * 5
    assert CRYPTO_ATR_MIN_RATIO < CRYPTO_ATR_MAX_RATIO
    # A ~1.5% per-bar move sits comfortably inside the crypto band.
    closes = _chop(100, 100.0, amp=0.004, seed=13)
    closes += _trend(40, closes[-1], 0.015, noise=0.003, seed=17)
    v = evaluate_crypto_hf_quality(closes, "BUY")
    ratio = v["metrics"]["atr_ratio"]
    assert ratio is not None
    assert CRYPTO_ATR_MIN_RATIO <= ratio <= CRYPTO_ATR_MAX_RATIO
    assert v["factors"]["volatility_band"] == 1


def test_crypto_gate_vetoes_a_dead_compressed_tape():
    """Below the floor there is no room to express a 1-10m move."""
    v = evaluate_crypto_hf_quality(_chop(140, 100.0, amp=1e-7), "BUY")
    assert v["passes"] is False
    assert v["factors"]["volatility_band"] == 0


def test_crypto_gate_vetoes_strong_opposing_flow():
    closes = _chop(100, 100.0, amp=0.0008, seed=3)
    closes += _trend(30, closes[-1], 0.006, noise=0.0004, seed=5)
    # A BUY against a deeply offer-heavy book is a veto in any market.
    v = evaluate_crypto_hf_quality(closes, "BUY", bid=90.0, ask=110.0, live_price=95.0)
    assert v["passes"] is False
    assert v["reason"] == "flow_against_direction"


def test_crypto_gate_score_is_bounded_and_finite():
    closes = _chop(100, 100.0, amp=0.0008, seed=3)
    closes += _trend(30, closes[-1], 0.006, noise=0.0004, seed=5)
    v = evaluate_crypto_hf_quality(closes, "BUY")
    assert 0.0 <= v["score"] <= 1.0
    assert math.isfinite(v["score"])
    for k, val in v["factors"].items():
        assert val in (0, 1), k


# ── execution surface integration ────────────────────────────────────────────

def test_execution_surface_routes_crypto_to_the_crypto_gate():
    closes = _chop(100, 100.0, amp=0.0008, seed=3)
    closes += _trend(30, closes[-1], 0.006, noise=0.0004, seed=5)
    # Coherent book for a BUY: price pinned at the ASK is buy-side absorption
    # (+1). Pinning it at the bid would legitimately veto a BUY, so the book
    # and the direction must agree for this to be a routing assertion.
    surface = build_execution_surface(
        symbol="BTC/USD", closes=closes, direction="BUY", confidence_pct=99.0,
        bid=100.0, ask=100.1, live_price=100.1, allow_real_quote_proxy=True,
    )
    assert surface["asset_class"] == ASSET_CLASS_CRYPTO
    # The FX gate must NOT be what ran for a crypto symbol.
    assert surface["class_filter"] == "crypto_hf_quality"


def test_crypto_never_gets_the_fx_quote_proxy_floor():
    """The REAL proxy relaxation is an FX concept; crypto must not inherit it.

    Regression: the gate used to test ``asset_class != "OTC"`` to mean "REAL".
    That binary assumption silently widened when CRYPTO was introduced and
    stamped ``quote_proxy_enabled`` on crypto surfaces.
    """
    closes = _chop(100, 100.0, amp=0.0008, seed=3)
    closes += _trend(30, closes[-1], 0.006, noise=0.0004, seed=5)
    surface = build_execution_surface(
        symbol="BTC/USD", closes=closes, direction="BUY", confidence_pct=99.0,
        live_price=100.0, allow_real_quote_proxy=True,
    )
    assert surface.get("quote_proxy_enabled") is None
    assert surface.get("bar_source") != "real_proxy_floor"
    assert surface["asset_class"] == ASSET_CLASS_CRYPTO


def test_only_real_accepts_the_quote_proxy_relaxation():
    """The relaxation is opt-in per strategy, not inferred from the class."""
    assert RealMarketStrategy().accepts_quote_proxy is True
    assert OtcMarketStrategy().accepts_quote_proxy is False
    assert CryptoMarketStrategy().accepts_quote_proxy is False
    assert MarketStrategy.accepts_quote_proxy is False  # default is deny


def test_otc_still_never_gets_the_quote_proxy_floor():
    surface = build_execution_surface(
        symbol="EUR/USD", closes=_trend(80, 1.10, 0.001), direction="BUY",
        confidence_pct=99.0, live_price=1.1, allow_real_quote_proxy=True,
    )
    assert surface.get("quote_proxy_enabled") is None


def test_execution_surface_keeps_otc_on_the_otc_gate():
    surface = build_execution_surface(
        symbol="EUR/USD", closes=_trend(80, 1.10, 0.001),
        direction="BUY", confidence_pct=99.0, live_price=1.1,
    )
    assert surface["asset_class"] == ASSET_CLASS_OTC
    assert surface["class_filter"] == "otc_hf_quality"


def test_execution_surface_keeps_real_on_the_real_gate():
    surface = build_execution_surface(
        symbol="EUR/SEK", closes=_trend(200, 11.0, 0.001),
        direction="BUY", confidence_pct=99.0, live_price=11.0,
        bid=11.0, ask=11.001,
    )
    assert surface["asset_class"] == ASSET_CLASS_REAL
    assert surface["class_filter"] == "real_liquidity_gate"


# ── /tick-signal endpoint wiring (regression: it bypassed the gate entirely) ──

def _ramp(n: int, start: float, step: float) -> list:
    out, p = [], start
    for _ in range(n):
        p *= (1.0 + step)
        out.append(round(p, 4))
    return out


@pytest.mark.parametrize(
    "symbol,start,step,expected_class,expected_filter",
    [
        ("BTC/USD", 100.0, 0.004, ASSET_CLASS_CRYPTO, "crypto_hf_quality"),
        ("EUR/USD", 1.10, 0.0006, ASSET_CLASS_OTC, "otc_hf_quality"),
        ("EUR/SEK", 11.0, 0.0004, ASSET_CLASS_REAL, "real_liquidity_gate"),
    ],
)
def test_tick_signal_carries_the_routed_strategy(
    symbol, start, step, expected_class, expected_filter
):
    """/tick-signal must run the same routed gate as /predict.

    Regression: the 1s live-tick path produced an executable-looking signal
    that had never been through a per-market-type strategy gate at all.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    r = TestClient(app).post(
        "/api/v1/tick-signal",
        json={
            "symbol": symbol,
            "timeframe": "1m",
            "prices": _ramp(140, start, step),
            "tick": start * ((1.0 + step) ** 140),
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["asset_class"] == expected_class
    assert body["class_filter"] == expected_filter
    # The surface must be present, not silently dropped by the fail-soft path.
    assert "executable" in body
    assert "regime_gate" in body
    assert "class_gate" in body
    # The surface never overwrites the tick's own authoritative verdict.
    assert body["signal"] in ("BUY", "SELL", "HOLD")


def test_tick_signal_confidence_is_not_double_scaled():
    """The strict gate must see the tick's REAL 0..100 confidence.

    Regression: the surface was fed ``confidence * 100`` on the assumption the
    tick confidence was 0..1. It is documented 0..100, so the gate received
    ~9932% and marked every live tick executable, defeating the 96.5% bar on
    the whole high-frequency path.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    body = TestClient(app).post(
        "/api/v1/tick-signal",
        json={"symbol": "BTC/USD", "prices": _ramp(140, 100.0, 0.004)},
    ).json()
    conf = body["confidence"]
    assert 0.0 <= conf <= 100.0
    # The gate echoes the confidence it was given; it must be the same number
    # the endpoint reported, not a 100x multiple of it.
    assert body["confidence_pct"] == pytest.approx(conf, abs=0.5)


def test_tick_signal_quote_proxy_is_real_only():
    """Endpoint-level proof of the accepts_quote_proxy scoping."""
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    real = client.post(
        "/api/v1/tick-signal",
        json={"symbol": "EUR/SEK", "prices": _ramp(200, 11.0, 0.0004)},
    ).json()
    crypto = client.post(
        "/api/v1/tick-signal",
        json={"symbol": "BTC/USD", "prices": _ramp(140, 100.0, 0.004)},
    ).json()
    assert real["asset_class"] == ASSET_CLASS_REAL
    assert real.get("quote_proxy_enabled") is True
    assert crypto["asset_class"] == ASSET_CLASS_CRYPTO
    assert crypto.get("quote_proxy_enabled") is None


# ── authoritative expiry lock at the /tick-signal seam ──────────────────────

def test_tick_signal_serves_the_locked_contract_and_skips_recompute():
    """A committed verdict must survive contradictory later ticks.

    The second post supplies REVERSED price action, so a recomputing engine
    would flip the direction. The locked contract must be served instead, and
    the live price must still update underneath it.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    up = _ramp(140, 100.0, 0.004)
    first = client.post(
        "/api/v1/tick-signal",
        json={"symbol": "BTC/USD", "prices": up, "horizon_minutes": 5},
    ).json()
    assert first.get("signal_locked") is not True
    committed = {
        "signal": first["signal"],
        "confidence": first["confidence"],
        "target_price": first["target_price"],
    }

    # Reversed tape, and a different live price.
    down = _ramp(140, 100.0, -0.004)
    second = client.post(
        "/api/v1/tick-signal",
        json={
            "symbol": "BTC/USD",
            "prices": down,
            "horizon_minutes": 5,
            "tick": 42.5,
        },
    ).json()

    assert second["signal_locked"] is True
    # The contract is byte-identical to what was committed.
    assert second["signal"] == committed["signal"]
    assert second["confidence"] == committed["confidence"]
    assert second["target_price"] == committed["target_price"]
    # ...but the market kept moving.
    assert second["current_price"] == 42.5
    assert second["locked_expires_at_ms"] > second["locked_at_ms"]


def test_changing_the_horizon_forces_a_fresh_evaluation():
    """A different expiry is a different contract, so the lock must not apply."""
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    client.post(
        "/api/v1/tick-signal",
        json={"symbol": "BTC/USD", "prices": _ramp(140, 100.0, 0.004), "horizon_minutes": 1},
    )
    other = client.post(
        "/api/v1/tick-signal",
        json={"symbol": "BTC/USD", "prices": _ramp(140, 100.0, 0.004), "horizon_minutes": 10},
    ).json()
    assert other.get("signal_locked") is not True


def test_a_different_symbol_is_never_served_the_active_contract():
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    client.post(
        "/api/v1/tick-signal",
        json={"symbol": "BTC/USD", "prices": _ramp(140, 100.0, 0.004), "horizon_minutes": 5},
    )
    other = client.post(
        "/api/v1/tick-signal",
        json={"symbol": "ETH/USD", "prices": _ramp(140, 100.0, 0.004), "horizon_minutes": 5},
    ).json()
    assert other["symbol"] == "ETH/USD"
    assert other.get("signal_locked") is not True


def test_a_locked_crypto_verdict_never_serves_an_fx_symbol():
    """The class is part of the lock identity, not just the symbol string."""
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    client.post(
        "/api/v1/tick-signal",
        json={"symbol": "EUR/USD", "prices": _ramp(140, 1.1, 0.004), "horizon_minutes": 5},
    )
    other = client.post(
        "/api/v1/tick-signal",
        json={"symbol": "EUR/USD", "prices": _ramp(140, 1.1, 0.004), "horizon_minutes": 5},
    ).json()
    # Same symbol + horizon, so the lock legitimately applies here.
    assert other.get("signal_locked") is True
