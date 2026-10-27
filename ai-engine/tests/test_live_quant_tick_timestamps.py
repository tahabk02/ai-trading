"""Tick timestamps must reach the regime layer without becoming news events."""

import numpy as np

from app.services.live_quant import evaluate_live_tick_signal


def test_live_tick_signal_forwards_timestamps_to_velocity_dynamics():
    prices = list(1.1000 + np.arange(8, dtype=float) * 0.0001)
    timestamps = list(np.arange(8, dtype=float))

    verdict = evaluate_live_tick_signal(
        prices,
        tick=prices[-1],
        timeframe="1m",
        symbol="EUR/USD",
        tick_timestamps=timestamps,
    )

    regime = verdict.diagnostics["predictive"]["regime"]
    velocity = regime["adapter"]["velocity_dynamics"]
    assert velocity["available"] is True
    assert velocity["window_seconds"] == 3.0
    assert regime["news"]["active"] is False
    assert regime["news"]["reason"] == "no_event_calendar_supplied"
