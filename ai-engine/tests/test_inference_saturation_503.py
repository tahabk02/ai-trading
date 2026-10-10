"""
test_inference_saturation_503.py — INFERENCE POOL SATURATION IS A 503, NOT A HANG.

`/predict` depends on two CPU steps that must run on the isolated INFERENCE
executor (`ml_predictor.run_inference`). If that executor is saturated by
background model training, `run_inference` cannot admit the request inside
`INFERENCE_QUEUE_TIMEOUT_S` and raises `InferenceAdmissionTimeout`.

The required contract is that the endpoint ANSWERS 503 in that situation:

  * It must NOT block the HTTP response behind the queue. A request that waits
    behind training holds a connection, an asyncio slot, and the operator's UI
    for the whole training run.
  * It must NOT fall through to a generic 500. 503 is what the client already
    classifies as RECOVERABLE (`quoteStreamWaiting` + exponential backoff
    retry), whereas a 500 surfaces as a hard "Prediction unavailable" error.
  * It must NOT fabricate a verdict. There is no structural fallback available
    here — the confluence gate IS the work that could not be admitted, so the
    honest answer is "come back shortly".

The ML-corroboration step deliberately behaves the OPPOSITE way (it degrades to
the structural verdict with `inference_fallback="ml_budget_exceeded"`), because
by then the authoritative confluence verdict already exists. These tests pin
both halves so they cannot be confused for one another again.

Run:  python -m pytest tests/test_inference_saturation_503.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.services.ml_predictor import InferenceAdmissionTimeout, InferenceBudgetExceeded


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


def _client():
    from fastapi.testclient import TestClient
    from app.main import app

    return TestClient(app)


def _unwrap_http_detail(resp):
    body = resp.json()
    detail = body.get("detail", body)
    if isinstance(detail, dict):
        return detail
    return {"error": "unknown", "message": str(detail)}


def _payload(symbol="USD/JPY", n=95):
    closes = [120.0 + i * 0.05 for i in range(n)]
    return {
        "symbol": symbol,
        "timeframe": "1m",
        "candles": make_candles(closes),
        "live_price": float(closes[-1]),
        "dataSource": "forex_otc_test",
    }


# MINIMUM_REQUIRED_BARS = 100 is the fast-path / full-pipeline boundary.
# `run_inference` is called by BOTH branches and both map admission timeouts to
# 503, so the saturation tests below run against each branch.
FAST_PATH_BARS = 95
FULL_PIPELINE_BARS = 120


# ─────────────────── the structural gate: saturation ⇒ 503 ───────────────────

@pytest.mark.parametrize(
    "bars", [FAST_PATH_BARS, FULL_PIPELINE_BARS],
    ids=["fast-path", "full-pipeline"],
)
def test_predict_503_when_the_inference_gate_cannot_be_admitted(monkeypatch, bars):
    """The authoritative confluence step could not be admitted ⇒ 503.

    Parametrised across BOTH branches: `run_inference` is called by the
    micro-quant fast path (2..99 bars) and by the full ML pipeline (>= 100
    bars), and each carries its own `except InferenceAdmissionTimeout`. A fix
    applied to only one branch would leave the other able to 500 — or hang —
    under the same load.
    """
    from app.api.v1 import signals as signals_mod

    async def _saturated(*_args, **_kwargs):
        raise InferenceAdmissionTimeout("USD/JPY", "1m", 5.0)

    monkeypatch.setattr(signals_mod, "run_inference", _saturated)

    resp = _client().post("/api/v1/predict", json=_payload(n=bars))
    assert resp.status_code == 503, resp.text
    detail = _unwrap_http_detail(resp)
    assert detail["error"] == "Inference capacity exhausted"
    assert detail["inference_fallback"] == "executor_saturated"
    assert detail["symbol"] == "USD/JPY"
    # The operator must be told WHY, and told it is worth retrying.
    assert "retry" in detail["message"].lower()
    # Above all: no fabricated signal may leak out of a starved engine.
    assert "signal" not in resp.json()


def test_predict_503_is_not_masked_as_a_generic_500(monkeypatch):
    """The saturation type must be handled BEFORE the bare `except Exception`.

    `InferenceAdmissionTimeout` subclasses `InferenceBudgetExceeded`, so a
    handler ordering slip silently degrades a recoverable 503 into a hard 500
    and the client stops retrying. Pin the status code exactly.
    """
    from app.api.v1 import signals as signals_mod

    async def _saturated(*_args, **_kwargs):
        raise InferenceAdmissionTimeout("USD/JPY", "1m", 5.0)

    monkeypatch.setattr(signals_mod, "run_inference", _saturated)

    resp = _client().post("/api/v1/predict", json=_payload())
    assert resp.status_code == 503
    assert resp.status_code != 500


def test_predict_admission_timeout_is_ordered_before_the_budget_handler(monkeypatch):
    """`InferenceAdmissionTimeout` MUST remain a strict subclass of the budget error.

    The two are semantically different — executor saturation vs. slow model —
    and the endpoint labels them differently. If the hierarchy were ever
    flattened, the `except InferenceAdmissionTimeout` arms would become
    unreachable and this test fails before production does.
    """
    assert issubclass(InferenceAdmissionTimeout, InferenceBudgetExceeded)


# ─────────────── ML corroboration: saturation ⇒ honest non-503 ───────────────

def test_ml_admission_timeout_degrades_to_the_structural_verdict(monkeypatch):
    """Once the verdict exists, ML saturation must NOT 503 — ship the verdict.

    `/predict` resolves the confluence gate FIRST. If the RF corroboration then
    cannot finish inside the interactive budget, refusing the whole request
    would throw away a real, fully-resolved verdict and freeze the terminal on
    a spinner. The correct behaviour is to ship the structural payload and say
    so in `inference_fallback`.

    Note the ML step is awaited directly (not through `run_inference`), so this
    stubs `predict_with_rf` rather than the executor helper.
    """
    from app.api.v1 import signals as signals_mod

    async def _slow_ml(**_kwargs):
        raise InferenceBudgetExceeded(
            symbol="USD/JPY", timeframe="1m", budget_ms=150.0, elapsed_ms=150.0
        )

    monkeypatch.setattr(signals_mod, "predict_with_rf", _slow_ml)

    resp = _client().post("/api/v1/predict", json=_payload(n=FULL_PIPELINE_BARS))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("signal") in ("BUY", "SELL")
    assert body.get("inference_fallback") == "ml_budget_exceeded"
    # The structural verdict must be COMPLETE, not hollowed out by the fallback.
    assert body.get("confidence") is not None


def test_ml_unexpected_failure_also_keeps_the_structural_verdict(monkeypatch):
    """A corroboration crash must never 500 a request that already has a verdict."""
    from app.api.v1 import signals as signals_mod

    async def _explode(**_kwargs):
        raise RuntimeError("RF exploded")

    monkeypatch.setattr(signals_mod, "predict_with_rf", _explode)

    resp = _client().post("/api/v1/predict", json=_payload(n=FULL_PIPELINE_BARS))
    assert resp.status_code == 200, resp.text
    assert resp.json().get("signal") in ("BUY", "SELL")


def test_predict_answers_promptly_under_saturation(monkeypatch):
    """A saturated executor must cost one timeout, not a queue-length wait.

    Guards against reintroducing an unbounded `await` on the executor future:
    the whole point of the admission bound is that the request is REFUSED at a
    known deadline instead of trailing the training queue.
    """
    import time

    from app.api.v1 import signals as signals_mod

    async def _saturated(*_args, **_kwargs):
        raise InferenceAdmissionTimeout("USD/JPY", "1m", 0.0)

    monkeypatch.setattr(signals_mod, "run_inference", _saturated)

    t0 = time.perf_counter()
    resp = _client().post("/api/v1/predict", json=_payload())
    elapsed = time.perf_counter() - t0
    assert resp.status_code == 503
    assert elapsed < 10.0, f"503 took {elapsed:.1f}s — it is queueing, not refusing"


def main():
    raise SystemExit(pytest.main([__file__, "-v"]))


if __name__ == "__main__":
    main()
