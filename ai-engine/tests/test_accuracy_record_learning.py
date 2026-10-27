"""Accuracy ingestion must actually reach the Bayesian learning loop."""

from app.api.v1.health import (
    AccuracyRecordIn,
    _component_scores,
    _realized_direction,
)


def test_binary_quality_factors_are_signed_by_the_signal_direction():
    record = AccuracyRecordIn(
        symbol="EUR/USD",
        direction="SELL",
        outcome="LOSS",
        quality=0.85,
        factors={"mtf": 1, "momentum": 1, "volatility": 1, "volume": 1, "pressure": 0},
    )

    scores = _component_scores(record)

    assert scores["momentum"] == -1.0
    assert "order_flow" not in scores
    assert _realized_direction("SELL", "LOSS") == "BUY"


def test_signed_quant_factors_are_not_flipped():
    record = AccuracyRecordIn(
        symbol="EUR/USD",
        direction="SELL",
        outcome="WIN",
        factors={"micro_momentum": -0.7, "bid_ask_pressure": -0.5},
    )

    scores = _component_scores(record)

    assert scores["momentum"] == -0.7
    assert scores["order_flow"] == -0.5


def test_explicit_component_scores_take_precedence():
    record = AccuracyRecordIn(
        symbol="EUR/USD",
        direction="BUY",
        outcome="WIN",
        component_scores={"regime": 0.4},
    )

    assert _component_scores(record) == {"regime": 0.4}
