from types import SimpleNamespace

import pandas as pd

from app.services import signal_generator as module
from app.services.signal_generator import SignalGenerator


def _candles():
    return [
        {"open": 1.1, "high": 1.11, "low": 1.09, "close": 1.1}
        for _ in range(30)
    ]


def _generator(monkeypatch, confidence: float) -> SignalGenerator:
    generator = SignalGenerator(confidence_threshold=0.965)
    monkeypatch.setattr(
        generator.ta_service,
        "calculate_indicators",
        lambda frame: frame.assign(adx=20.0, atr=0.01),
    )
    monkeypatch.setattr(
        generator.ta_service,
        "get_market_regime",
        lambda _adx: "TRENDING",
    )
    monkeypatch.setattr(
        generator.risk_filter,
        "check_and_update_freeze",
        lambda _frame: {"frozen": False},
    )
    monkeypatch.setattr(
        module,
        "evaluate_quant_matrix",
        lambda **_kwargs: SimpleNamespace(
            direction="BUY",
            confidence=confidence,
            high_confidence_alert=False,
            diagnostics={},
            factors={},
            direction_score=0.0,
        ),
    )
    return generator


def test_zero_confidence_no_signal(monkeypatch):
    generator = _generator(monkeypatch, 0.0)
    result = generator.generate_signal(
        {"symbol": "EUR/USD", "candles": _candles(), "live_price": 1.1}
    )
    assert result["signal_type"] is None
    assert result["waiting_reason"] == "LOW_CONFIDENCE"
    assert "NO SIGNAL" in result["waiting_detail"]


def test_gate_enforced_before_emit(monkeypatch):
    generator = _generator(monkeypatch, 95.0)
    result = generator.generate_signal(
        {"symbol": "EUR/USD", "candles": _candles(), "live_price": 1.1}
    )
    assert result["signal_type"] is None
    assert result["confidence"] == 95.0
    assert result["market_waiting"] is True
