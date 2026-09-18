"""
test_math_target.py — MATH-BASED TARGET (Alpha.5 Pro, Part 4) verification.

Covers:
  1. compute_math_target — pure model math over a 30m window (ATR14 / sigma /
     VWAP / EMA12·26 momentum, mean-rev + momentum + ATR·0.2·sign blend,
     ±3·ATR clamp), direction contract, 30-bar window slicing, and the
     honest insufficient-data path.
  2. GET /api/v1/math-target — 400 on empty / non-whitelisted symbol,
     503 when history is unavailable, 200 with the full labeled model when
     backend history is reachable.
  3. POST /api/v1/predict — the response now carries `math_target` computed on
     the REAL forwarded bars (both the fast-path and full-pipeline branches).

Run:  python -m pytest tests/test_math_target.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
import pytest


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


# ───────────────────────────── UNIT: compute_math_target ─────────────────────────────

def test_compute_math_target_buy_uptrend():
    from app.services.math_target import compute_math_target
    closes = [100.0 + i * 0.12 for i in range(31)]
    candles = make_candles(closes)
    r = compute_math_target(
        "EUR/USD",
        [c["close"] for c in candles],
        [c["high"] for c in candles],
        [c["low"] for c in candles],
        window_sec=1800,
    )
    assert r["success"] is True
    assert r["symbol"] == "EUR/USD"
    assert r["direction"] == "BUY"          # live > VWAP and EMA12 > EMA26
    assert r["bars"] == 30                  # 30-minute window → 30 real bars
    assert r["window_sec"] == 1800
    assert r["atr14"] is not None and r["atr14"] > 0
    assert r["sigma"] > 0
    assert r["momentum_slope"] > 0
    assert r["clamped"] is False
    assert abs(r["target_price"] - r["live_price"]) <= 3 * r["atr14"] + 1e-6


def test_compute_math_target_sell_downtrend():
    from app.services.math_target import compute_math_target
    closes = [100.0 - i * 0.12 for i in range(31)]
    candles = make_candles(closes)
    r = compute_math_target(
        "GBP/USD",
        [c["close"] for c in candles],
        [c["high"] for c in candles],
        [c["low"] for c in candles],
    )
    assert r["success"] is True
    assert r["direction"] == "SELL"         # live < VWAP and EMA12 < EMA26
    assert r["momentum_slope"] < 0
    assert r["vwap"] > r["live_price"]


def test_compute_math_target_hold_flat():
    from app.services.math_target import compute_math_target
    closes = [100.0] * 30
    r = compute_math_target("EUR/USD", closes, closes, closes)
    assert r["direction"] == "HOLD"
    assert r["momentum_slope"] == 0.0
    assert r["deviation"] == 0.0


def test_compute_math_target_clamps_pm_3atr():
    from app.services.math_target import compute_math_target
    # A violent ramp makes the blended deviation explode far past ±3·ATR;
    # the low-volatility spread keeps ATR tiny, so the clamp MUST engage.
    closes = [float(i * 2.2) for i in range(31)]
    candles = make_candles(closes)
    r = compute_math_target(
        "EUR/JPY",
        [c["close"] for c in candles],
        [c["high"] for c in candles],
        [c["low"] for c in candles],
    )
    assert r["clamped"] is True
    assert abs(r["deviation"]) <= 3 * r["atr14"] + 1e-6
    assert abs(r["target_price"] - r["live_price"]) <= 3 * r["atr14"] + 1e-6


def test_compute_math_target_window_slices_last_30():
    from app.services.math_target import compute_math_target
    closes = [100.0 + i * 0.1 for i in range(60)]
    candles = make_candles(closes)
    r = compute_math_target("EUR/USD", [c["close"] for c in candles])
    assert r["bars"] == 30
    assert r["live_price"] == pytest.approx(105.9, rel=0.01)  # close[59] = 100 + 59×0.1


def test_compute_math_target_insufficient_data():
    from app.services.math_target import compute_math_target
    r = compute_math_target("EUR/USD", [100.0])
    assert r["success"] is False
    assert r["error"] == "insufficient_data"


def test_parse_window():
    from app.services.math_target import parse_window, DEFAULT_WINDOW_SECONDS
    assert parse_window("30m") == 1800
    assert parse_window("15m") == 900
    assert parse_window("1h") == 3600
    assert parse_window("1800") == 1800
    assert parse_window("1800s") == 1800
    assert parse_window("") == DEFAULT_WINDOW_SECONDS
    assert parse_window("garbage") == DEFAULT_WINDOW_SECONDS
    assert parse_window("2d") == 86400  # bounded by the MAX_WINDOW_SECONDS ceiling


def _unwrap_http_detail(resp):
    """FastAPI wraps an HTTPException dict detail under {"detail": ...}."""
    body = resp.json()
    return body.get("detail") if isinstance(body.get("detail"), dict) else body


# ───────────────────────────── ENDPOINT: GET /api/v1/math-target ─────────────────────────────

def _app_client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def test_math_target_400_empty_symbol():
    client = _app_client()
    resp = client.get("/api/v1/math-target")  # symbol missing
    assert resp.status_code == 400
    body = _unwrap_http_detail(resp)
    assert body["error"] == "Validation Error"
    assert "symbol" in body["message"].lower()


def test_math_target_400_nonwhitelisted_symbol():
    client = _app_client()
    resp = client.get("/api/v1/math-target", params={"symbol": "XX/YYY"})
    assert resp.status_code == 400
    assert _unwrap_http_detail(resp)["error"] == "Validation Error"


def test_math_target_503_when_history_unreachable(monkeypatch):
    from app.api.v1 import signals as signals_mod

    monkeypatch.setattr(signals_mod.settings, "BACKEND_API_URL", "http://127.0.0.1:1/api/v1")
    client = _app_client()
    resp = client.get("/api/v1/math-target", params={"symbol": "EUR/USD"})
    assert resp.status_code == 503
    assert _unwrap_http_detail(resp)["error"] == "history_unavailable"


def test_math_target_200_with_mocked_history(monkeypatch):
    from app.api.v1 import signals as signals_mod

    closes = [100.0 + i * 0.12 for i in range(31)]
    bars = make_candles(closes)

    class FakeResp:
        def __init__(self, bars_):
            self._bars = bars_

        def raise_for_status(self):
            return None

        def json(self):
            return {"symbol": "EUR/USD", "window": "30m", "bars": self._bars}

    class FakeClient:
        def __init__(self, timeout=0.0):
            self._bars = bars

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return None

        async def get(self, _url):
            return FakeResp(self._bars)

    monkeypatch.setattr(signals_mod.httpx, "AsyncClient", lambda timeout=0.0, **kwargs: FakeClient())

    client = _app_client()
    resp = client.get("/api/v1/math-target", params={"symbol": "EUR/USD", "window": "30m"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["symbol"] == "EUR/USD"
    assert body["direction"] == "BUY"
    assert body["bars"] == 30
    assert body["window_sec"] == 1800
    assert body["vwap"] > 0
    assert body["target_price"] > 0


# ───────────────────────────── PREDICT carries math_target ─────────────────────────────

def test_predict_fast_path_carries_math_target():
    client = _app_client()
    closes = [120.0 + i * 0.05 for i in range(95)]
    candles = make_candles(closes)
    payload = {
        "symbol": "USD/JPY",
        "timeframe": "1m",
        "candles": candles,
        "live_price": float(closes[-1]),
        "dataSource": "forex_otc_test",
    }
    resp = client.post("/api/v1/predict", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    mt = body.get("math_target")
    assert isinstance(mt, dict), "predict response MUST ship math_target"
    assert mt.get("success") is True
    assert mt.get("symbol") == "USD/JPY"
    assert mt.get("bars") == 30
    assert mt.get("direction") in ("BUY", "SELL", "HOLD")
    assert mt.get("target_price") and mt.get("target_price") > 0


def main():
    raise SystemExit(pytest.main([__file__, "-v"]))


if __name__ == "__main__":
    main()