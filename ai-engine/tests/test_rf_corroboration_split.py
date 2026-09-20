"""
test_rf_corroboration_split.py — PART 22.1 [153] regression: RF corroboration
split schema (rf_probability / rf_holdout_accuracy / corroborator_unavailable).

Roots the silent-swap PART 22 found: /predict reused `model_accuracy` and
`ml_probability` to mean RF numbers when the RandomForest corroborator ran and
confluence-derived numbers (factor agreement, confidence/100) when it did not —
same keys, two meanings.

The split contract under test:
  * DEFINITIVE tape (RF corroborator really runs on >= 85 real candles) →
      rf_probability / rf_holdout_accuracy PRESENT (not None, within [0,1]),
      corroborator_unavailable is False,
      legacy ml_probability == rf_probability and model_accuracy ==
      rf_holdout_accuracy (exact aliases of the RF numbers — never
      confidence-derived fallbacks).
  * SUB-THERMAL fallback (tape never clears the gate; RF never spawns) →
      corroborator_unavailable is True,
      rf_probability / rf_holdout_accuracy are null,
      legacy ml_probability / model_accuracy are null TOO — i.e. the old
      code's `ml_probability = confidence/100` / `model_accuracy = agreement`
      silent swap is caught and dead.
  * FAST path (2 <= bars < 100; RF never trains) →
      corroborator_unavailable is True, rf_* null, legacy null.

Run:  python -m pytest tests/test_rf_corroboration_split.py -q
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from app.services.book_instruments import DEFINITIVE_CONFIDENCE_MIN


def make_candles(closes, base_spread=0.0008, volume=None):
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
    return make_candles(base * (1 + drift + noise))


def _app_client():
    from fastapi.testclient import TestClient
    from app.main import app

    return TestClient(app)


def test_definitive_tape_ships_rf_numbers_and_flag_false():
    """The RandomForest corroborator RAN: split rf_* fields present, legacy
    ml_probability/model_accuracy are EXACT aliases of the RF numbers."""
    client = _app_client()
    n = 120
    rng = np.random.default_rng(99)
    drift = np.linspace(0, 0.02, n - 6)
    noise = rng.normal(0, 0.0006, n - 6).cumsum() * 0.12
    closes = [float(x) for x in (1.1000 * (1 + drift + noise))]
    base = closes[-1]
    closes += [
        base * 1.004, base * 1.009, base * 1.016,
        base * 1.024, base * 1.034, base * 1.046,
    ]
    vol = [1200.0 + (i % 7) * 50.0 for i in range(n - 6)] + [12000.0] * 6
    candles = make_candles(closes, base_spread=0.0001, volume=vol)
    spot = float(candles[-1]["close"])

    resp = client.post("/api/v1/predict", json={
        "symbol": "EUR/USD",
        "timeframe": "1h",
        "candles": candles,
        "live_price": spot,
        "bid": spot * (1 - 0.0004),
        "ask": spot,
        "dataSource": "forex_otc_test",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["signal"] == "BUY", body
    assert float(body["confidence"]) >= DEFINITIVE_CONFIDENCE_MIN, body

    assert body["corroborator_unavailable"] is False, body
    rf_p = body.get("rf_probability")
    rf_a = body.get("rf_holdout_accuracy")
    assert rf_p is not None, "rf_probability must be present on the RF path"
    assert rf_a is not None, "rf_holdout_accuracy must be present on the RF path"
    assert 0.0 <= rf_p <= 1.0
    assert 0.0 <= rf_a <= 1.0
    # Legacy keys are exact aliases of the RF numbers — never confidence/100 or
    # factor-agreement fallbacks.
    assert body["ml_probability"] == rf_p, body["ml_probability"]
    assert body["model_accuracy"] == rf_a, body["model_accuracy"]


def test_subthermal_fallback_never_populates_rf_or_legacy_keys(monkeypatch):
    """Sub-thermal fallback (RF never yields extras): the response must carry
    corroborator_unavailable=True, rf_* null AND the legacy keys null — the
    silent-swap values (confidence/100, agreement) must NEVER appear.

    The verdict is faked to the engine's REAL sub-thermal shape
    (direction kept + market_waiting=True + CONFLUENCE_BELOW_THERMAL); the RF
    is faked as unavailable, so the merge block (ml_extras is None) is
    exercised exactly like a gated tape whose corroborator did not run.
    """
    import asyncio

    from app.api.v1 import signals as signals_mod

    class FakeSubThermalVerdict:
        direction = "SELL"
        confidence = 40.0
        high_confidence_alert = False
        market_waiting = True
        waiting_reason = "CONFLUENCE_BELOW_THERMAL"
        waiting_detail = "sub-thermal tape (test fixture)"
        factors = {"tick_velocity": 0.0, "micro_momentum": 0.0}
        direction_score = -0.4
        diagnostics = {
            "tier": "T5",
            "tier_label": "WEAK",
            "agreement": 0.4,
            "book": {"confluence": {"score": 40.0, "gate": "INSUFFICIENT"}},
        }

    async def _rf_unavailable(*_a, **_k):
        raise asyncio.TimeoutError("simulated RF corroboration timeout")

    monkeypatch.setattr(
        signals_mod, "evaluate_quant_matrix",
        lambda *_a, **_k: FakeSubThermalVerdict(),
    )
    monkeypatch.setattr(signals_mod, "predict_with_rf", _rf_unavailable)

    client = _app_client()
    candles = _trend_candles(1.1000, n=120, seed=7, sign=-1)

    resp = client.post("/api/v1/predict", json={
        "symbol": "GBP/USD",
        "timeframe": "4h",
        "candles": candles,
        "live_price": float(candles[-1]["close"]),
        "dataSource": "forex_otc_test",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # The sub-thermal path: direction kept, signal withheld as market-waiting.
    assert body["market_waiting"] is True, body
    assert body["signal"] is None, body

    # RF never ran: honest nulls + flag — the response must NOT show the old
    # `ml_probability = confidence/100` / `model_accuracy = agreement` swap.
    assert body["corroborator_unavailable"] is True, body
    assert body["rf_probability"] is None, body["rf_probability"]
    assert body["rf_holdout_accuracy"] is None, body["rf_holdout_accuracy"]
    assert body["ml_probability"] is None, body["ml_probability"]
    assert body["model_accuracy"] is None, body["model_accuracy"]


def test_definitive_tape_with_rf_unavailable_stays_null(monkeypatch):
    """A DEFINITIVE tape whose RF corroborator fails (timeout) must NOT fall
    back to confluence-derived numbers under the RF keys. The merge block only
    runs when ml_extras is not None — this roots that boundary."""
    import asyncio

    from app.api.v1 import signals as signals_mod

    async def _rf_unavailable(*_a, **_k):
        raise asyncio.TimeoutError("simulated RF corroboration timeout")

    monkeypatch.setattr(signals_mod, "predict_with_rf", _rf_unavailable)

    client = _app_client()
    n = 120
    rng = np.random.default_rng(99)
    drift = np.linspace(0, 0.02, n - 6)
    noise = rng.normal(0, 0.0006, n - 6).cumsum() * 0.12
    closes = [float(x) for x in (1.1000 * (1 + drift + noise))]
    base = closes[-1]
    closes += [
        base * 1.004, base * 1.009, base * 1.016,
        base * 1.024, base * 1.034, base * 1.046,
    ]
    vol = [1200.0 + (i % 7) * 50.0 for i in range(n - 6)] + [12000.0] * 6
    candles = make_candles(closes, base_spread=0.0001, volume=vol)
    spot = float(candles[-1]["close"])

    resp = client.post("/api/v1/predict", json={
        "symbol": "EUR/USD",
        "timeframe": "1h",
        "candles": candles,
        "live_price": spot,
        "bid": spot * (1 - 0.0004),
        "ask": spot,
        "dataSource": "forex_otc_test",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["signal"] == "BUY", body
    # Still emitted (the confluence verdict is the dispatch authority) but the
    # RF numbers must be honestly null with the flag raised.
    assert body["corroborator_unavailable"] is True, body
    assert body["rf_probability"] is None, body["rf_probability"]
    assert body["rf_holdout_accuracy"] is None, body["rf_holdout_accuracy"]
    assert body["ml_probability"] is None, body["ml_probability"]
    assert body["model_accuracy"] is None, body["model_accuracy"]


def test_fast_path_never_populates_rf_or_legacy_keys():
    """95 bars < MINIMUM_REQUIRED_BARS => micro-quant fast path; the RF never
    trains, so all RF/legacy NULL keys render — not stale 0.0 stubs."""
    client = _app_client()
    closes = [100.0 + i * 0.05 for i in range(95)]
    candles = make_candles(closes)

    resp = client.post("/api/v1/predict", json={
        "symbol": "USD/JPY",
        "timeframe": "1m",
        "candles": candles,
        "live_price": float(closes[-1]),
        "dataSource": "forex_otc_test",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["corroborator_unavailable"] is True, body
    assert body["rf_probability"] is None, body["rf_probability"]
    assert body["rf_holdout_accuracy"] is None, body["rf_holdout_accuracy"]
    assert body["ml_probability"] is None, body["ml_probability"]
    assert body["model_accuracy"] is None, body["model_accuracy"]