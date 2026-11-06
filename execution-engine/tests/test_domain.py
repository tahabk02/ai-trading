from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from app.domain import SignalEnvelope, SignalRejected


def payload(**overrides):
    base = {
        "schema_version": "1.0.0",
        "confidence_unit": "percent",
        "symbol": "EUR/USD",
        "signal_type": "BUY",
        "confidence": 97.0,
        "price": 1.1,
        "target_price": 1.1005,
        "executable": True,
        "dispatchable": True,
        "market_waiting": False,
        "horizon_minutes": 1,
        "tier": "T1",
        "regime_gate": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    base.update(overrides)
    return {"payload": json.dumps(base)}


def test_parses_valid_signal_and_aliases() -> None:
    signal = SignalEnvelope.from_stream_entry(
        "1-0",
        payload(
            signal_type=None,
            price=None,
            signalType="SELL",
            current_price=1.1,
            target_price=1.0995,
        ),
    )
    assert signal.side == "SELL"
    assert signal.price == 1.1
    assert signal.target_price == 1.0995
    assert signal.executable is True


def test_parses_real_core_stream_payload() -> None:
    core_payload = {
        "schema_version": "1.0.0",
        "confidence_unit": "percent",
        "symbol": "EUR/USD",
        "signalType": "BUY",
        "signal": "BUY",
        "confidence": 97.2,
        "confidence_score": 97.2,
        "current_price": 1.0842,
        "target_price": 1.0861,
        "take_profit": 1.0861,
        "timeframe": "1m",
        "market_waiting": False,
        "tier": "T1",
        "dispatchable": True,
        "scored_only": False,
        "executable": True,
        "regime_gate": "ok",
        "horizon_minutes": 1,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    signal = SignalEnvelope.from_stream_entry(
        "1700000000000-0", {"payload": json.dumps(core_payload)}
    )
    assert signal.symbol == "EUR/USD"
    assert signal.side == "BUY"
    assert signal.price == pytest.approx(1.0842)
    assert signal.target_price == pytest.approx(1.0861)
    assert signal.confidence == pytest.approx(97.2)
    assert signal.horizon_minutes == 1


def test_rejects_non_executable_signal() -> None:
    with pytest.raises(SignalRejected) as exc:
        SignalEnvelope.from_stream_entry("1-0", payload(executable=False))
    assert exc.value.code == "NOT_EXECUTABLE"


def test_non_executable_placeholder_target_is_not_a_target_error() -> None:
    with pytest.raises(SignalRejected) as exc:
        SignalEnvelope.from_stream_entry(
            "1-0", payload(executable=False, target_price=1.1)
        )
    assert exc.value.code == "NOT_EXECUTABLE"


def test_rejects_market_waiting() -> None:
    with pytest.raises(SignalRejected) as exc:
        SignalEnvelope.from_stream_entry("1-0", payload(market_waiting=True))
    assert exc.value.code == "MARKET_WAITING"


def test_rejects_confidence_without_percent_units() -> None:
    with pytest.raises(SignalRejected) as exc:
        SignalEnvelope.from_stream_entry(
            "1-0", payload(confidence_unit="fraction", confidence=0.97)
        )
    assert exc.value.code == "CONFIDENCE_UNIT_MISSING"


def test_rejects_missing_schema_version() -> None:
    signal_payload = payload()
    decoded = json.loads(signal_payload["payload"])
    decoded.pop("schema_version")
    with pytest.raises(SignalRejected) as exc:
        SignalEnvelope.from_stream_entry(
            "1-0", {"payload": json.dumps(decoded)}
        )
    assert exc.value.code == "SCHEMA_VERSION_UNSUPPORTED"


def test_accepts_small_confidence_when_explicitly_percent() -> None:
    parsed = SignalEnvelope.from_stream_entry(
        "1-0", payload(confidence=0.97)
    )
    assert parsed.confidence == pytest.approx(0.97)


def test_rejects_target_contradicting_direction() -> None:
    with pytest.raises(SignalRejected) as exc:
        SignalEnvelope.from_stream_entry("1-0", payload(target_price=1.099))
    assert exc.value.code == "TARGET_CONTRADICTS_DIRECTION"


def test_rejects_missing_timestamp() -> None:
    with pytest.raises(SignalRejected) as exc:
        SignalEnvelope.from_stream_entry("1-0", payload(timestamp=None))
    assert exc.value.code == "TIMESTAMP_MISSING"


def test_dedupe_key_is_stable_within_window() -> None:
    ts = datetime(2026, 1, 1, 12, 0, 7, tzinfo=timezone.utc)
    first = SignalEnvelope.from_stream_entry("1-0", payload(timestamp=ts.isoformat()))
    second = SignalEnvelope.from_stream_entry(
        "2-0", payload(timestamp=(ts + timedelta(seconds=20)).isoformat())
    )
    assert first.dedupe_key(60) == second.dedupe_key(60)
    third = SignalEnvelope.from_stream_entry(
        "3-0", payload(timestamp=(ts + timedelta(seconds=61)).isoformat())
    )
    assert first.dedupe_key(60) != third.dedupe_key(60)
