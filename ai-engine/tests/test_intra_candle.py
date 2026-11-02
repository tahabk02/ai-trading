from __future__ import annotations

import pytest

from app.services.intra_candle import (
    apply_pullback_confidence,
    apply_pullback_projection,
    build_intra_candle_features,
    compute_bollinger,
    compute_velocity,
    compute_wick_metrics,
    detect_intra_candle_pullback,
)


def _flat_closed(count: int = 20, high: float = 1.105, low: float = 1.1):
    return [
        {
            "open": 1.102,
            "high": high,
            "low": low,
            "close": 1.1025,
            "volume": 10.0,
        }
        for _ in range(count)
    ]


def _micro_bars():
    closed = [
        {
            "open": 1.103,
            "high": 1.1032,
            "low": 1.103,
            "close": 1.1031,
            "volume": 2.0,
        }
        for _ in range(20)
    ]
    forming = {
        "open": 1.104,
        "high": 1.106,
        "low": 1.103,
        "close": 1.103,
        "volume": 6.0,
    }
    return forming, closed


def _tape():
    return [
        {"tsMs": 0.0, "price": 1.1},
        {"tsMs": 5_000.0, "price": 1.101},
        {"tsMs": 10_000.0, "price": 1.1015},
        {"tsMs": 15_000.0, "price": 1.104},
        {"tsMs": 16_000.0, "price": 1.1048},
        {"tsMs": 17_000.0, "price": 1.1056},
        {"tsMs": 18_000.0, "price": 1.106},
        {"tsMs": 19_000.0, "price": 1.1057},
        {"tsMs": 20_000.0, "price": 1.1054},
    ]


def _upper_rejection_features():
    micro_forming, micro_closed = _micro_bars()
    return detect_intra_candle_pullback(
        {
            "open": 1.102,
            "high": 1.106,
            "low": 1.1015,
            "close": 1.1025,
            "volume": 9.0,
        },
        _flat_closed(),
        symbol="EUR/USD",
        timeframe="M1",
        now_ms=20_000.0,
        micro_forming=micro_forming,
        micro_closed=micro_closed,
        tape=_tape(),
    )


def test_wick_metrics_split_the_range():
    metrics = compute_wick_metrics(
        {"open": 1.1, "high": 1.12, "low": 1.09, "close": 1.11}
    )
    assert metrics["range"] == pytest.approx(0.03)
    assert metrics["upperWickRatio"] == pytest.approx(0.01 / 0.03)
    assert metrics["lowerWickRatio"] == pytest.approx(0.01 / 0.03)
    assert metrics["bodyRatio"] == pytest.approx(0.01 / 0.03)
    assert metrics["direction"] == "up"


def test_bollinger_band_requires_real_samples():
    assert compute_bollinger([1.1, 1.2]) is None
    band = compute_bollinger([1.1 + index * 0.0001 for index in range(20)])
    assert band is not None
    assert band["upper"] > band["middle"] > band["lower"]
    assert band["sampleCount"] == 20


def test_velocity_spike_decelerates_into_reversal():
    velocity = compute_velocity(_tape(), 0.0002, 20_000.0)
    assert velocity["available"] is True
    assert velocity["direction"] == "up"
    assert velocity["spike"] is True
    assert velocity["decelerating"] is True
    assert velocity["delta5"] == pytest.approx(0.0014)


def test_upper_wick_rejection_is_a_put_pullback():
    features = _upper_rejection_features()
    assert features["wick"]["upperWickRatio"] > 0.55
    assert features["wickRejection"]["alert"] is True
    assert features["wickRejection"]["side"] == "upper"
    assert features["boundaries"]["boundaryKind"] == "resistance"
    assert features["exhaustion"]["detected"] is True
    assert features["confluence"]["microValidated"] is True
    assert features["pullback"]["signal"] == "PUT"
    assert features["pullback"]["entryTiming"] == "now"
    assert features["pullback"]["tierEligible"] is True
    assert features["pullback"]["confidence"] >= 70.0


def test_core_features_are_authoritative():
    features = _upper_rejection_features()
    resolved = build_intra_candle_features(
        [{"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0}],
        symbol="EUR/USD",
        timeframe="M1",
        core_features=features,
    )
    assert resolved is features


def test_pullback_confidence_only_lifts_matching_direction():
    features = _upper_rejection_features()
    score, lift = apply_pullback_confidence(50.0, features, "BUY")
    assert score == 50.0
    assert lift == 0.0
    score, lift = apply_pullback_confidence(50.0, features, "SELL")
    assert score == pytest.approx(features["pullback"]["confidence"])
    assert score > 50.0
    assert lift == pytest.approx(score - 50.0)


def test_pullback_projection_anchors_to_the_rejection_entry():
    features = _upper_rejection_features()
    target, distance, entry, timing = apply_pullback_projection(
        features,
        "SELL",
        1.1025,
        0.0003,
        5,
        1.103,
        0.001,
    )
    assert target < 1.1025
    assert distance > 0
    assert entry == pytest.approx(1.106)
    assert timing == "now"


def test_live_tick_diagnostics_carry_the_pullback_layer():
    from app.services.live_quant import evaluate_live_tick_signal

    prices = [1.1 + index * 0.00005 for index in range(30)]
    verdict = evaluate_live_tick_signal(
        prices,
        tick=prices[-1],
        highs=prices,
        lows=prices,
        timeframe="1m",
        symbol="EUR/USD",
        tick_timestamps=[index for index in range(30)],
        intra_candle=_upper_rejection_features(),
    )
    assert verdict.diagnostics["intra_candle"]["pullback"]["signal"] == "PUT"
    assert verdict.diagnostics["pullback"]["tierEligible"] is True


def test_quant_matrix_diagnostics_carry_the_pullback_layer():
    from app.services.quant_matrix import evaluate_quant_matrix

    candles = []
    for index in range(30):
        close = 1.1 + index * 0.00005
        candles.append(
            {
                "open": close - 0.00002,
                "high": close + 0.0001,
                "low": close - 0.0001,
                "close": close,
                "volume": 10.0,
            }
        )
    verdict = evaluate_quant_matrix(
        candles,
        live_price=candles[-1]["close"],
        timeframe="1m",
        symbol="EUR/USD",
        intra_candle=_upper_rejection_features(),
    )
    assert verdict.diagnostics["intra_candle"]["pullback"]["signal"] == "PUT"
    assert verdict.diagnostics["intra_candle"]["confluence"]["microValidated"] is True
