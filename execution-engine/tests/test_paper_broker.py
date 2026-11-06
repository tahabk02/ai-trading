from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import pytest

from app.broker.base import PermanentBrokerError
from app.broker.paper import PaperBroker
from app.config import Settings
from app.domain import OrderIntent, SignalEnvelope


def settings(**overrides) -> Settings:
    base = {
        "TRADING_MODE": "paper",
        "ALLOWED_SYMBOLS": "EUR/USD",
        "DEFAULT_BALANCE": 1_000.0,
        "ALLOW_SHORT": True,
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)


def intent(side: str = "BUY") -> OrderIntent:
    data = {
        "schema_version": "1.0.0",
        "confidence_unit": "percent",
        "symbol": "EUR/USD",
        "signal_type": side,
        "confidence": 97.0,
        "price": 1.1,
        "target_price": 1.1005 if side == "BUY" else 1.0995,
        "executable": True,
        "dispatchable": True,
        "market_waiting": False,
        "horizon_minutes": 1,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    signal = SignalEnvelope.from_stream_entry("1-0", {"payload": json.dumps(data)})
    return OrderIntent.build(signal, quantity=10.0, notional=11.0, dedupe_key="d1")


def test_paper_broker_is_idempotent_on_client_order_id() -> None:
    async def scenario() -> None:
        broker = PaperBroker(settings())
        await broker.start()
        first = await broker.place_order(intent())
        second = await broker.place_order(intent())
        assert first.broker_order_id == second.broker_order_id
        snapshot = await broker.account_snapshot()
        assert snapshot.open_positions == 1
        assert snapshot.open_notional == pytest.approx(11.0)
        assert snapshot.equity == pytest.approx(1_000.0)

    asyncio.run(scenario())


def test_paper_broker_refuses_short_when_disabled() -> None:
    async def scenario() -> None:
        broker = PaperBroker(settings(ALLOW_SHORT=False))
        with pytest.raises(PermanentBrokerError):
            await broker.place_order(intent("SELL"))

    asyncio.run(scenario())


def test_paper_broker_reversal_resets_average_price() -> None:
    async def scenario() -> None:
        broker = PaperBroker(settings())
        entry = intent()
        await broker.place_order(entry)
        reversal = entry.model_copy(
            update={
                "event_id": "2-0",
                "client_order_id": "ex-reversal",
                "side": "SELL",
                "quantity": 20.0,
                "notional": 24.0,
                "reference_price": 1.2,
            }
        )
        await broker.place_order(reversal)
        snapshot = await broker.account_snapshot()
        assert snapshot.open_positions == 1
        assert snapshot.open_notional == pytest.approx(12.0)
        assert snapshot.equity == pytest.approx(1_001.0)

    asyncio.run(scenario())
