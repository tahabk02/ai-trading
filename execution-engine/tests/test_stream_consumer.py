from __future__ import annotations

import asyncio

from app.config import Settings
from app.domain import ProcessOutcome
from app.infra.stream_consumer import StreamConsumer
from app.observability import Metrics


class FakeRedis:
    def __init__(self) -> None:
        self.acked: list[str] = []
        self.dead: list[tuple[str, dict]] = []
        self.group_call: dict | None = None

    async def ping(self) -> bool:
        return True

    async def xgroup_create(self, **kwargs):
        self.group_call = kwargs
        return "OK"

    async def xack(self, stream: str, group: str, entry_id: str) -> int:
        self.acked.append(entry_id)
        return 1

    async def xadd(self, stream: str, fields: dict, **kwargs) -> str:
        self.dead.append((stream, fields))
        return "1-0"


def consumer(handler, redis_client) -> StreamConsumer:
    settings = Settings(
        _env_file=None,
        TRADING_MODE="disabled",
        SIGNAL_STREAM="signals",
        SIGNAL_GROUP="group",
        SIGNAL_CONSUMER="consumer",
    )
    return StreamConsumer(settings, redis_client, handler, Metrics())


def test_acks_executed_outcome() -> None:
    async def handler(entry_id: str, fields: dict) -> ProcessOutcome:
        return ProcessOutcome(ack=True, status="EXECUTED")

    async def scenario() -> None:
        redis_client = FakeRedis()
        stream = consumer(handler, redis_client)
        await stream.connect()
        assert redis_client.group_call is not None
        assert redis_client.group_call["id"] == "$"
        await stream._dispatch("1-0", {})
        assert redis_client.acked == ["1-0"]

    asyncio.run(scenario())


def test_defers_transient_outcome() -> None:
    async def handler(entry_id: str, fields: dict) -> ProcessOutcome:
        return ProcessOutcome(ack=False, status="RETRY")

    async def scenario() -> None:
        redis_client = FakeRedis()
        stream = consumer(handler, redis_client)
        await stream.connect()
        await stream._dispatch("1-0", {})
        assert redis_client.acked == []

    asyncio.run(scenario())


def test_dead_letters_and_acks_rejected_outcome() -> None:
    async def handler(entry_id: str, fields: dict) -> ProcessOutcome:
        return ProcessOutcome(
            ack=True,
            status="REJECTED",
            reason="NOT_EXECUTABLE",
            dead_letter=True,
        )

    async def scenario() -> None:
        redis_client = FakeRedis()
        stream = consumer(handler, redis_client)
        await stream.connect()
        await stream._dispatch("1-0", {"payload": "{}"})
        assert redis_client.acked == ["1-0"]
        assert len(redis_client.dead) == 1
        assert redis_client.dead[0][0] == "execution:dead_letter"

    asyncio.run(scenario())


def test_handler_exception_leaves_entry_pending() -> None:
    async def handler(entry_id: str, fields: dict) -> ProcessOutcome:
        raise RuntimeError("boom")

    async def scenario() -> None:
        redis_client = FakeRedis()
        stream = consumer(handler, redis_client)
        await stream.connect()
        await stream._dispatch("1-0", {})
        assert redis_client.acked == []

    asyncio.run(scenario())
