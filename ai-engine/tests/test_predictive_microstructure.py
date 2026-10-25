"""Contracts for the additive predictive microstructure layer.

These tests pin the behaviours the terminal depends on:

  * vectorised BRR/WRR/SRI and liquidity-sweep detection from real OHLC;
  * per-market regime adapters (OTC Markov, REAL session, CRYPTO squeeze);
  * real news-blackout windows only when event timestamps are supplied;
  * adaptive Bayesian weights that only improve from real settled outcomes;
  * the async multi-symbol ring-buffer pipeline;
  * additive integration into ``evaluate_quant_matrix`` diagnostics without
    touching the authoritative direction/confidence/gate.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from app.services.bayesian_ensemble import (
    AdaptiveBayesianEnsemble,
    get_ensemble,
    reset_ensemble,
)
from app.services.microstructure import (
    analyze_candle_microstructure,
    analyze_tick_stream,
    compute_body_metrics,
    compute_brr_wrr,
    compute_strength_reversal_index,
    compute_tick_velocity_series,
    compute_velocity_metrics,
    detect_liquidity_sweeps,
    detect_momentum_divergence,
)
from app.services.quant_matrix import evaluate_quant_matrix
from app.services.regime_adaptation import (
    evaluate_event_blackout,
    profile_market_regime,
)
from app.services.tick_pipeline import RingBuffer, TickEvent, TickStreamProcessor


def _candles(closes, *, wick=0.0002):
    out = []
    for i, close in enumerate(closes):
        open_ = closes[i - 1] if i else close
        out.append(
            {
                "open": float(open_),
                "high": float(max(open_, close) + wick),
                "low": float(min(open_, close) - wick),
                "close": float(close),
                "volume": float(100 + i),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Candle geometry
# ---------------------------------------------------------------------------
def test_body_metrics_and_wrr_are_bounded():
    candles = [
        {"open": 1.0, "high": 1.01, "low": 0.99, "close": 1.005, "volume": 1},
        {"open": 1.005, "high": 1.02, "low": 1.0, "close": 1.001, "volume": 2},
    ]
    metrics = compute_body_metrics(
        [c["open"] for c in candles],
        [c["close"] for c in candles],
        [c["high"] for c in candles],
        [c["low"] for c in candles],
    )
    assert len(metrics["brr"]) == 2
    assert np.all(metrics["brr"] >= 0) and np.all(metrics["brr"] <= 1)
    summary = compute_brr_wrr(
        [c["open"] for c in candles],
        [c["close"] for c in candles],
        [c["high"] for c in candles],
        [c["low"] for c in candles],
    )
    assert 0.0 <= summary["brr"] <= 1.0
    assert 0.0 <= summary["wrr_upper"] <= 1.0
    assert 0.0 <= summary["wrr_lower"] <= 1.0


def test_sri_positive_on_lower_wick_rejection():
    candles = [
        {"open": 1.0, "high": 1.001, "low": 0.98, "close": 0.999, "volume": 1},
        {"open": 0.999, "high": 1.0005, "low": 0.975, "close": 0.998, "volume": 1},
        {"open": 0.998, "high": 1.002, "low": 0.97, "close": 0.999, "volume": 1},
    ]
    sri = compute_strength_reversal_index(
        [c["open"] for c in candles],
        [c["close"] for c in candles],
        [c["high"] for c in candles],
        [c["low"] for c in candles],
    )
    assert sri > 0


def test_liquidity_sweep_high_requires_close_back_inside_pool():
    highs = [1.10 + (i % 3) * 0.001 for i in range(30)]
    lows = [h - 0.01 for h in highs]
    closes = [h - 0.004 for h in highs]
    highs[-1] = max(highs[:-1]) + 0.01
    closes[-1] = max(highs[:-1]) - 0.002
    result = detect_liquidity_sweeps(highs, lows, closes, lookback=20)
    assert result["available"] is True
    assert result["sweep_high"] is True
    assert result["last_sweep"] == "high"
    assert result["sweep_strength"] > 0
    assert result["pool_high"] is not None


# ---------------------------------------------------------------------------
# Velocity
# ---------------------------------------------------------------------------
def test_velocity_per_second_when_timestamps_are_monotonic():
    prices = [1.0, 1.0001, 1.0002, 1.0003]
    timestamps = [100.0, 101.0, 102.0, 103.0]
    velocity, units = compute_tick_velocity_series(prices, timestamps)
    assert units == "per_second"
    assert np.allclose(velocity, 0.0001, atol=1e-12)
    metrics = compute_velocity_metrics(prices, timestamps)
    assert metrics["available"] is True
    assert metrics["units"] == "per_second"


def test_velocity_uses_index_clock_without_timestamps():
    velocity, units = compute_tick_velocity_series([1.0, 1.1, 1.2])
    assert units == "per_tick"
    assert np.allclose(velocity, [0.1, 0.1])


def test_momentum_divergence_detects_fading_high():
    prices = np.linspace(1.0, 1.02, 16)
    prices[-1] = 1.03
    result = detect_momentum_divergence(prices, window=6)
    assert result["available"] is True
    assert result["kind"] in ("bearish_divergence", "none")


# ---------------------------------------------------------------------------
# Regime adapters
# ---------------------------------------------------------------------------
def test_otc_markov_probabilities_are_normalised():
    rng = np.random.default_rng(7)
    closes = 1.1 + np.cumsum(rng.normal(0, 0.0002, 200))
    profile = profile_market_regime(symbol="EUR/USD", candles=_candles(closes))
    assert profile["asset_class"] == "OTC"
    markov = profile["adapter"]["markov"]
    assert markov["available"] is True
    probs = markov["next_state_probabilities"]
    assert abs(sum(probs.values()) - 1.0) < 1e-3
    assert markov["persistence"] >= 0.0


def test_real_session_uses_london_newyork_overlap():
    closes = np.linspace(10.0, 10.2, 60)
    profile = profile_market_regime(
        symbol="EUR/SEK",
        candles=_candles(closes),
        bid=10.19,
        ask=10.21,
        now=datetime(2026, 10, 25, 13, 0, tzinfo=UTC),
    )
    assert profile["asset_class"] == "REAL"
    assert profile["adapter"]["session"]["session"] == "london_newyork_overlap"
    assert profile["adapter"]["spread"]["available"] is True
    assert profile["adapter"]["spread"]["spread_pips"] > 0


def test_crypto_squeeze_and_depth_state():
    closes = np.linspace(60000.0, 60010.0, 60) + np.sin(np.arange(60)) * 0.4
    profile = profile_market_regime(
        symbol="BTC/USD",
        candles=_candles(closes),
        bid_depth=120.0,
        ask_depth=30.0,
    )
    assert profile["asset_class"] == "CRYPTO"
    boll = profile["adapter"]["bollinger"]
    assert boll["available"] is True
    assert 0.0 <= boll["bandwidth_percentile"] <= 1.0
    depth = profile["adapter"]["depth"]
    assert depth["available"] is True
    assert depth["side"] == "bid"


def test_event_blackout_only_when_real_event_times_supplied():
    now = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
    absent = evaluate_event_blackout(now, None)
    assert absent["available"] is False and absent["active"] is False
    active = evaluate_event_blackout(
        now, [(now + timedelta(minutes=5)).isoformat()], before_minutes=15
    )
    assert active["active"] is True
    assert active["reason"] == "high_impact_event_window"
    outside = evaluate_event_blackout(
        now, [(now + timedelta(hours=3)).isoformat()], before_minutes=15
    )
    assert outside["active"] is False


def test_low_volatility_flat_zone_is_suppressed():
    closes = np.full(80, 1.1000)
    for i in range(1, 80):
        closes[i] = closes[i - 1] + (0.0000005 if i % 2 else -0.0000005)
    micro = analyze_candle_microstructure(_candles(closes, wick=0.000001))
    assert micro["available"] is True
    assert micro["low_volatility"] is True
    assert micro["flat_zone"] is True
    assert micro["suppressed"] is True
    assert "low_volatility_flat_zone" in micro["suppression_reasons"]


def test_zero_atr_regime_is_suppressed_not_treated_as_expansion():
    closes = np.full(40, 1.1000)
    profile = profile_market_regime(
        symbol="EUR/USD",
        candles=_candles(closes, wick=0.0),
    )
    assert profile["features"]["atr"] == 0.0
    assert profile["suppression"]["active"] is True
    assert "low_volatility_flat_zone" in profile["suppression"]["reasons"]


# ---------------------------------------------------------------------------
# Bayesian ensemble
# ---------------------------------------------------------------------------
def test_bayesian_ensemble_releases_only_above_threshold():
    ensemble = AdaptiveBayesianEnsemble(threshold=85.0)
    strong = ensemble.combine(
        {
            "momentum": 0.9,
            "microstructure": 0.8,
            "order_flow": 0.85,
            "volatility": 0.7,
            "regime": 0.8,
        },
        regime="trend",
        asset_class="OTC",
    )
    assert strong["available"] is True
    assert strong["confidence"] >= 85.0
    assert strong["release"] is True
    weak = ensemble.combine(
        {"momentum": 0.3, "microstructure": -0.4, "order_flow": 0.1},
        regime="range",
        asset_class="OTC",
    )
    assert weak["confidence"] < 85.0
    assert weak["release"] is False


def test_bayesian_ensemble_suppression_blocks_release():
    ensemble = AdaptiveBayesianEnsemble()
    result = ensemble.combine(
        {c: 1.0 for c in ("momentum", "microstructure", "order_flow", "volatility", "regime")},
        regime="trend",
        asset_class="REAL",
        suppressed=True,
        suppression_reasons=["event_blackout"],
    )
    assert result["release"] is False
    assert result["suppressed"] is True
    assert "event_blackout" in result["suppression_reasons"]


def test_bayesian_outcomes_update_precision_and_weights():
    ensemble = AdaptiveBayesianEnsemble()
    before = ensemble.weights("trend", "OTC")["momentum"]
    ensemble.record_outcome(
        regime="trend",
        component_scores={"momentum": 1.0, "microstructure": 1.0},
        realized_direction="BUY",
    )
    after = ensemble.weights("trend", "OTC")["momentum"]
    assert after >= before
    snap = ensemble.snapshot("trend", "OTC")["markets"]["OTC"]["trend"]["momentum"]
    assert snap["observations"] > 0
    with pytest.raises(ValueError):
        ensemble.record_outcome(
            regime="trend",
            component_scores={"momentum": 1.0},
            realized_direction="HOLD",
        )


def test_bayesian_learning_is_scoped_per_market_type():
    ensemble = AdaptiveBayesianEnsemble()
    otc_before = ensemble.weights("trend", "OTC")["momentum"]
    crypto_before = ensemble.weights("trend", "CRYPTO")["momentum"]
    crypto_obs_before = ensemble.snapshot("trend", "CRYPTO")["markets"]["CRYPTO"][
        "trend"
    ]["momentum"]["observations"]

    ensemble.record_outcome(
        regime="trend",
        asset_class="OTC",
        component_scores={"momentum": 1.0, "microstructure": 1.0},
        realized_direction="BUY",
    )

    assert ensemble.weights("trend", "OTC")["momentum"] > otc_before
    assert ensemble.weights("trend", "CRYPTO")["momentum"] == pytest.approx(
        crypto_before
    )
    snap = ensemble.snapshot(asset_class="CRYPTO")
    assert (
        snap["markets"]["CRYPTO"]["trend"]["momentum"]["observations"]
        == crypto_obs_before
    )


# ---------------------------------------------------------------------------
# Async tick pipeline
# ---------------------------------------------------------------------------
def test_ring_buffer_is_bounded():
    ring = RingBuffer(3)
    ring.extend([1.0, 2.0, 3.0, 4.0])
    assert len(ring) == 3
    assert ring.to_list() == [2.0, 3.0, 4.0]
    assert ring.latest() == 4.0


def test_tick_pipeline_processes_multiple_instruments():
    async def scenario():
        processor = TickStreamProcessor(capacity=64, workers=2, queue_size=64)
        await processor.start()
        try:
            now = 1000.0
            for i in range(20):
                processor.submit(
                    TickEvent(symbol="EUR/USD", price=1.1 + i * 0.0001, timestamp=now + i)
                )
                processor.submit(
                    TickEvent(symbol="BTC/USD", price=60000.0 + i, timestamp=now + i, bid_depth=10, ask_depth=8)
                )
            for _ in range(100):
                await asyncio.sleep(0.01)
                if processor.latest("EUR/USD") and processor.latest("BTC/USD"):
                    break
            eurusd = processor.latest("EUR/USD")
            btc = processor.latest("BTC/USD")
            stats = processor.stats()
        finally:
            await processor.stop()
        return eurusd, btc, stats

    eurusd, btc, stats = asyncio.run(scenario())
    assert eurusd is not None and eurusd["symbol"] == "EUR/USD"
    assert btc is not None and btc["available"] is True
    assert stats["instruments"] == 2
    assert stats["evaluated"] >= 2
    assert stats["errors"] == 0


def test_tick_stream_marks_low_volatility():
    prices = [1.1] * 30
    result = analyze_tick_stream(prices)
    assert result["available"] is True
    assert result["low_volatility"] is True
    assert result["suppressed"] is True


def test_tick_pipeline_stop_with_idle_workers_does_not_deadlock():
    async def scenario():
        processor = TickStreamProcessor(workers=4, queue_size=8)
        await processor.start()
        await asyncio.wait_for(processor.stop(), timeout=2.0)
        return processor.stats()

    stats = asyncio.run(scenario())
    assert stats["running"] is False
    assert stats["queue_depth"] == 0


# ---------------------------------------------------------------------------
# Integration
# ---------------------------------------------------------------------------
def test_quant_matrix_attaches_predictive_diagnostics_without_changing_verdict():
    reset_ensemble()
    closes = np.linspace(1.1000, 1.1120, 140) + np.sin(np.arange(140)) * 0.0002
    candles = _candles(closes)
    verdict = evaluate_quant_matrix(
        candles,
        live_price=float(closes[-1]),
        timeframe="1h",
        bid=float(closes[-1]) - 0.0001,
        ask=float(closes[-1]) + 0.0001,
        symbol="EUR/USD",
    )
    predictive = verdict.diagnostics.get("predictive")
    assert predictive is not None
    assert predictive["available"] is True
    assert predictive["authority"]["thermal_gate_unchanged"] is True
    assert predictive["ensemble"]["threshold"] == 85.0
    assert predictive["regime"]["available"] is True
    assert verdict.direction in ("BUY", "SELL")
    # The additive layer must never rewrite the authoritative gate output.
    assert verdict.confidence >= 0.0
    assert verdict.diagnostics["confluence_score"] >= 0.0


def test_quant_matrix_news_blackout_suppresses_ensemble_release():
    reset_ensemble()
    closes = np.linspace(1.1000, 1.1120, 140) + np.sin(np.arange(140)) * 0.0002
    event = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
    verdict = evaluate_quant_matrix(
        _candles(closes),
        live_price=float(closes[-1]),
        timeframe="1h",
        symbol="EUR/USD",
        event_times=[event],
    )
    predictive = verdict.diagnostics["predictive"]
    assert predictive["regime"]["news"]["active"] is True
    assert predictive["ensemble"]["suppressed"] is True
    assert "event_blackout" in predictive["ensemble"]["suppression_reasons"]
    assert predictive["ensemble"]["release"] is False


def test_global_ensemble_singleton_is_available():
    reset_ensemble()
    assert get_ensemble() is get_ensemble()
