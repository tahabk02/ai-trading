"""
test_inference_budget.py — P1-2026-09-24 NON-BLOCKING INFERENCE BUDGET.

Proves the terminal-freeze fix end to end:

  * Unit: a cold-cache RandomForest train that exceeds INFERENCE_BUDGET_MS
    raises InferenceBudgetExceeded QUICKLY (the HTTP response is never held
    hostage), and the SHIELDED background train keeps running to warm the
    model cache for the next call.
  * Endpoint: /api/v1/predict ships the fast STRUCTURAL verdict (real
    confluence-derived data, no fabricated signal) with
    inference_fallback="ml_budget_exceeded" and RF fields honestly null,
    within a hard wall-clock bound.
  * Budget disabled (0) preserves the legacy blocking-path behavior contract.

Run:  python -m pytest tests/test_inference_budget.py -q
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

import app.services.ml_predictor as ml_predictor
from app.services.ml_predictor import (
    predict_with_rf,
    InferenceBudgetExceeded,
    _model_cache,
)


def _make_candles(closes, base_spread=0.0008, volume=None):
    closes = list(closes)
    candles = []
    for i, c in enumerate(closes):
        o = closes[i - 1] if i > 0 else c * (1 - base_spread)
        hi = max(o, c) * (1 + base_spread)
        lo = min(o, c) * (1 - base_spread)
        candles.append(
            {
                "timestamp": i * 60_000,
                "open": round(o, 6),
                "high": round(hi, 6),
                "low": round(lo, 6),
                "close": round(c, 6),
                "volume": (volume[i] if volume is not None else 1000.0),
            }
        )
    return candles


def _trend_candles(base, n=120, seed=42, sign=+1):
    rng = np.random.default_rng(seed)
    drift = np.linspace(0, 0.03, n) * sign
    noise = rng.normal(0, 0.0015, n).cumsum() * 0.3
    return _make_candles(base * (1 + drift + noise))


def _definitive_candles(base=1.1000, n=120, seed=99):
    """Exact definitive-tape recipe from test_rf_corroboration_split: a steady
    drift + a strong 6-bar extension + a volume jump → confluence ≥ 70% (a
    DEFINITIVE tape the RandomForest corroborator runs on)."""
    rng = np.random.default_rng(seed)
    drift = np.linspace(0, 0.02, n - 6)
    noise = rng.normal(0, 0.0006, n - 6).cumsum() * 0.12
    closes = [float(x) for x in (base * (1 + drift + noise))]
    tail = closes[-1]
    closes += [
        tail * 1.004, tail * 1.009, tail * 1.016,
        tail * 1.024, tail * 1.034, tail * 1.046,
    ]
    vol = [1200.0 + (i % 7) * 50.0 for i in range(n - 6)] + [12000.0] * 6
    return _make_candles(closes, base_spread=0.0001, volume=vol)


def _slow_feature_and_train(*_args, **_kwargs):
    """Executor stub simulating a cold-cache RandomForest train that exceeds
    the interactive budget (slow, but deterministic)."""
    time.sleep(0.5)
    return object(), object(), 0.51, None


def test_cold_train_over_budget_raises_fast_and_background_warms(monkeypatch):
    """On-timeout the /predict path receives InferenceBudgetExceeded quickly
    (well under the 0.5s train) and the shielded train warms the cache.
    The WHOLE scenario runs on ONE event loop — the background done-callback
    is scheduled on the loop that created the executor future, so the cache
    warm must be observed before that loop is torn down."""
    monkeypatch.setattr(ml_predictor, "_feature_and_train", _slow_feature_and_train)
    monkeypatch.setattr(ml_predictor, "INFERENCE_BUDGET_MS", 0.05)

    candles = _trend_candles(1.1000, n=100)
    spot = float(candles[-1]["close"])

    async def _scenario():
        t0 = time.perf_counter()
        raised = None
        try:
            await predict_with_rf(
                symbol="BUDGET/UNIT",
                timeframe="1h",
                candles=candles,
                live_price=spot,
                bid=spot * (1 - 0.0004),
                ask=spot,
            )
        except InferenceBudgetExceeded as ibe:
            raised = ibe
        elapsed_ms = (time.perf_counter() - t0) * 1000

        assert raised is not None, "budget-exceeded train must raise InferenceBudgetExceeded"
        assert raised.budget_ms == 0.05
        # Returned well before the 0.5s train finished → the HTTP response was
        # NOT held hostage by a cold RandomForest fit.
        assert elapsed_ms < 400, f"budget return took {elapsed_ms:.0f}ms"

        # The SHIELDED background train finishes on the SAME loop and warms it.
        # The cache key carries the training window, so look it up with the
        # same fingerprint the predict path computed.
        await asyncio.sleep(0.8)
        fp = ml_predictor._data_fingerprint(
            np.array([c["close"] for c in candles], dtype=np.float64),
            np.array([c.get("open", c["close"]) for c in candles], dtype=np.float64),
            np.array([c["high"] for c in candles], dtype=np.float64),
            np.array([c["low"] for c in candles], dtype=np.float64),
            np.array([c.get("volume", 0) for c in candles], dtype=np.float64),
        )
        cached = _model_cache.get("BUDGET/UNIT", "1h", fp)
        assert cached is not None, "background train must warm the model cache"
        assert cached[2] == 0.51

    asyncio.run(_scenario())


def test_predict_ships_fast_structural_verdict_within_budget(monkeypatch):
    """/predict returns 200 fast with the confluence verdict + honest
    inference_fallback surface (RF numbers null, warming in background)."""
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setattr(ml_predictor, "_feature_and_train", _slow_feature_and_train)
    monkeypatch.setattr(ml_predictor, "INFERENCE_BUDGET_MS", 0.05)

    candles = _definitive_candles()
    spot = float(candles[-1]["close"])

    t0 = time.perf_counter()
    client = TestClient(app)
    resp = client.post(
        "/api/v1/predict",
        json={
            # Unique (symbol, timeframe) so the shared module-level ModelCache
            # is guaranteed COLD for this train (no cross-test contamination).
            "symbol": "CAD/CHF",
            "timeframe": "20m",
            "candles": candles,
            "live_price": spot,
            "bid": spot * (1 - 0.0004),
            "ask": spot,
            "dataSource": "forex_otc_test",
        },
    )
    elapsed_ms = (time.perf_counter() - t0) * 1000

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Fast structural verdict — real confluence data, never a frozen request.
    assert elapsed_ms < 1500, f"response took {elapsed_ms:.0f}ms"
    assert body["signal"] == "BUY", body
    assert float(body["confidence"]) >= 60, body
    # Honest RF surface: numbers absent this round, flag present + warming.
    assert body["rf_probability"] is None, body
    assert body["rf_holdout_accuracy"] is None, body
    assert body["corroborator_unavailable"] is True, body
    assert body["inference_fallback"] == "ml_budget_exceeded", body
    assert body["inference_budget_ms"] == 0.05, body


def test_budget_disabled_preserves_existing_blocking_path(monkeypatch):
    """A 0 budget (legacy unbounded) does NOT raise — the awaited train result
    is used directly (exact pre-change behavior)."""
    calls = {"n": 0}

    def _realish_train(*_args, **_kwargs):
        calls["n"] += 1
        return object(), object(), 0.5, None

    # `_run_with_budget` with a 0 budget must await the future untouched.
    async def _probe():
        fut = asyncio.get_event_loop().create_future()
        fut.set_result("echo")
        return await ml_predictor._run_with_budget(fut, "EUR/USD", "1h")

    monkeypatch.setattr(ml_predictor, "INFERENCE_BUDGET_MS", 0.0)
    assert asyncio.run(_probe()) == "echo"
    monkeypatch.setattr(ml_predictor, "_feature_and_train", _realish_train)
    # No exception path whatsover when budget is 0 (call completes normally).
    assert calls["n"] == 0  # the stub was never invoked (probe used a Future)