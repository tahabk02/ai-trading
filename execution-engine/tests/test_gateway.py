from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.broker.base import TransientBrokerError
from app.broker.paper import PaperBroker
from app.config import Settings
from app.domain import BrokerOrder, OrderIntent, OrderStatus
from app.execution.gateway import ExecutionGateway
from app.observability import Metrics
from app.risk.gate import KillSwitch, RiskGate
from app.state.store import OrderStore


def settings(**overrides) -> Settings:
    base = {
        "TRADING_MODE": "paper",
        "ALLOWED_SYMBOLS": "EUR/USD",
        "MIN_CONFIDENCE": 90.0,
        "MAX_SIGNAL_AGE_MS": 60_000,
        "MAX_TRADES_PER_DAY": 100,
        "MAX_NOTIONAL_PER_TRADE": 100.0,
        "RISK_PER_TRADE": 0.01,
        "DEFAULT_BALANCE": 1_000.0,
        "ALLOW_SHORT": True,
        "DEDUPE_WINDOW_SECONDS": 60,
        "MAX_SUBMIT_ATTEMPTS": 3,
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)


def fields(**overrides) -> dict:
    data = {
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
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    data.update(overrides)
    return {"payload": json.dumps(data)}


class FlakyBroker(PaperBroker):
    def __init__(self, cfg: Settings) -> None:
        super().__init__(cfg)
        self.fail_next = True

    async def place_order(self, intent: OrderIntent) -> BrokerOrder:
        if self.fail_next:
            self.fail_next = False
            raise TransientBrokerError("simulated transient failure")
        return await super().place_order(intent)


def build(tmp_path: Path, cfg: Settings, broker=None):
    store = OrderStore(tmp_path / "orders.db")
    broker = broker or PaperBroker(cfg)
    gate = RiskGate(cfg, KillSwitch(cfg))
    gateway = ExecutionGateway(cfg, broker, store, gate, Metrics())
    return store, broker, gateway


def test_executes_once_and_replays_idempotently(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings()
        store, broker, gateway = build(tmp_path, cfg)
        await store.init()
        await broker.start()

        first = await gateway.process("1-0", fields())
        assert first.ack is True
        assert first.status == "EXECUTED"

        replay = await gateway.process("1-0", fields())
        assert replay.status == "REPLAY"

        duplicate = await gateway.process("2-0", fields())
        assert duplicate.status == "DUPLICATE"

        snapshot = await broker.account_snapshot()
        assert snapshot.open_positions == 1
        await store.close()

    asyncio.run(scenario())


def test_disabled_mode_never_reaches_broker(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings(TRADING_MODE="disabled")
        store, broker, gateway = build(tmp_path, cfg)
        await store.init()
        await broker.start()

        outcome = await gateway.process("1-0", fields())
        assert outcome.status == "REJECTED"
        assert outcome.reason == "TRADING_DISABLED"
        snapshot = await broker.account_snapshot()
        assert snapshot.open_positions == 0
        await store.close()

    asyncio.run(scenario())


def test_stale_signal_is_rejected(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings()
        store, broker, gateway = build(tmp_path, cfg)
        await store.init()
        await broker.start()

        outcome = await gateway.process("1-0", fields(timestamp="2020-01-01T00:00:00Z"))
        assert outcome.status == "REJECTED"
        assert outcome.reason == "SIGNAL_STALE"
        snapshot = await broker.account_snapshot()
        assert snapshot.open_positions == 0
        await store.close()

    asyncio.run(scenario())


def test_invalid_payload_is_acked_and_dead_lettered(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings()
        store, broker, gateway = build(tmp_path, cfg)
        await store.init()
        await broker.start()

        outcome = await gateway.process("1-0", fields(timestamp=None))
        assert outcome.ack is True
        assert outcome.dead_letter is True
        assert outcome.reason == "TIMESTAMP_MISSING"
        await store.close()

    asyncio.run(scenario())


def test_inconsistent_execution_surface_is_dead_lettered(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings()
        store, broker, gateway = build(tmp_path, cfg)
        await store.init()
        await broker.start()

        outcome = await gateway.process("1-0", fields(dispatchable=False))
        assert outcome.ack is True
        assert outcome.status == "REJECTED"
        assert outcome.reason == "NOT_DISPATCHABLE"
        assert outcome.dead_letter is True
        await store.close()

    asyncio.run(scenario())


def test_transient_failure_is_retried_on_redelivery(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings()
        broker = FlakyBroker(cfg)
        store, broker, gateway = build(tmp_path, cfg, broker)
        await store.init()
        await broker.start()

        first = await gateway.process("1-0", fields())
        assert first.ack is False
        assert first.status == "RETRY"

        second = await gateway.process("1-0", fields())
        assert second.ack is True
        assert second.status == "EXECUTED"

        record = await store.get_by_event("1-0")
        assert record is not None
        assert record.status == OrderStatus.FILLED.value
        await store.close()

    asyncio.run(scenario())


def test_non_executable_signal_is_skipped_without_dead_letter(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings()
        store, broker, gateway = build(tmp_path, cfg)
        await store.init()
        await broker.start()

        outcome = await gateway.process("1-0", fields(executable=False))
        assert outcome.ack is True
        assert outcome.status == "SKIPPED"
        assert outcome.dead_letter is False
        await store.close()

    asyncio.run(scenario())


def test_waiting_rider_is_skipped_without_dead_letter(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings()
        store, broker, gateway = build(tmp_path, cfg)
        await store.init()
        await broker.start()

        outcome = await gateway.process(
            "1-0",
            fields(signal_type=None, market_waiting=True, executable=True),
        )
        assert outcome.ack is True
        assert outcome.status == "SKIPPED"
        assert outcome.dead_letter is False
        await store.close()

    asyncio.run(scenario())


class RejectingBroker(PaperBroker):
    async def place_order(self, intent: OrderIntent) -> BrokerOrder:
        return BrokerOrder(
            client_order_id=intent.client_order_id,
            broker_order_id=None,
            status=OrderStatus.REJECTED,
            reason="venue rejected",
        )


def test_stale_pending_intent_is_not_resubmitted(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings()
        broker = FlakyBroker(cfg)
        store, broker, gateway = build(tmp_path, cfg, broker)
        await store.init()
        await broker.start()

        first = await gateway.process("1-0", fields())
        assert first.ack is False
        assert first.status == "RETRY"

        connection = sqlite3.connect(tmp_path / "orders.db")
        connection.execute(
            "UPDATE orders SET signal_ts = ? WHERE event_id = ?",
            ("2020-01-01T00:00:00+00:00", "1-0"),
        )
        connection.commit()
        connection.close()

        replay = await gateway.process("1-0", fields())
        assert replay.ack is True
        assert replay.status == "MANUAL_REVIEW"
        assert replay.reason == "PENDING_TOO_OLD"

        record = await store.get_by_event("1-0")
        assert record is not None
        assert record.status == OrderStatus.MANUAL_REVIEW.value
        await store.close()

    asyncio.run(scenario())


def test_venue_rejection_is_terminal_but_not_counted_as_executed(tmp_path: Path) -> None:
    async def scenario() -> None:
        cfg = settings()
        broker = RejectingBroker(cfg)
        store, broker, gateway = build(tmp_path, cfg, broker)
        await store.init()
        await broker.start()

        outcome = await gateway.process("1-0", fields())
        assert outcome.ack is True
        assert outcome.status == "CLOSED"
        assert outcome.reason == OrderStatus.REJECTED.value

        record = await store.get_by_event("1-0")
        assert record is not None
        assert record.status == OrderStatus.REJECTED.value
        await store.close()

    asyncio.run(scenario())
