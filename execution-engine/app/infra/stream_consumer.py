from __future__ import annotations

import asyncio
import json

import structlog

from app.config import Settings
from app.domain import ProcessOutcome
from app.observability import Metrics

logger = structlog.get_logger(__name__)


class StreamConsumer:
    def __init__(self, settings: Settings, redis_client, handler, metrics: Metrics) -> None:
        self._settings = settings
        self._redis = redis_client
        self._handler = handler
        self._metrics = metrics
        self.ready = False

    async def connect(self) -> None:
        await self._redis.ping()
        await self._ensure_group()
        self.ready = True
        logger.info(
            "STREAM_CONSUMER_READY",
            stream=self._settings.SIGNAL_STREAM,
            group=self._settings.SIGNAL_GROUP,
            consumer=self._settings.SIGNAL_CONSUMER,
        )

    async def _ensure_group(self) -> None:
        try:
            await self._redis.xgroup_create(
                name=self._settings.SIGNAL_STREAM,
                groupname=self._settings.SIGNAL_GROUP,
                id="$",
                mkstream=True,
            )
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def reclaim(self) -> None:
        try:
            result = await self._redis.xautoclaim(
                name=self._settings.SIGNAL_STREAM,
                groupname=self._settings.SIGNAL_GROUP,
                consumername=self._settings.SIGNAL_CONSUMER,
                min_idle_time=self._settings.RECLAIM_MIN_IDLE_MS,
                start_id="0-0",
                count=self._settings.RECLAIM_COUNT,
            )
        except Exception as exc:
            self._metrics.error(f"xautoclaim: {exc}")
            logger.warning("STREAM_RECLAIM_FAILED", error=str(exc))
            return

        entries = result[1] if isinstance(result, (list, tuple)) and len(result) > 1 else []
        for entry_id, fields in entries:
            await self._dispatch(entry_id, fields)

    async def run(self, stop_event: asyncio.Event) -> None:
        reclaim_task = asyncio.create_task(self._reclaim_loop(stop_event))
        try:
            while not stop_event.is_set():
                try:
                    reply = await self._redis.xreadgroup(
                        groupname=self._settings.SIGNAL_GROUP,
                        consumername=self._settings.SIGNAL_CONSUMER,
                        streams={self._settings.SIGNAL_STREAM: ">"},
                        count=self._settings.SIGNAL_BATCH,
                        block=self._settings.SIGNAL_BLOCK_MS,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self._metrics.error(f"xreadgroup: {exc}")
                    self.ready = False
                    logger.error("STREAM_READ_FAILED", error=str(exc))
                    try:
                        await asyncio.wait_for(stop_event.wait(), timeout=1.0)
                    except asyncio.TimeoutError:
                        pass
                    continue

                self.ready = True
                if not reply:
                    continue
                for _stream, entries in reply:
                    for entry_id, fields in entries:
                        await self._dispatch(entry_id, fields)
        finally:
            reclaim_task.cancel()
            try:
                await reclaim_task
            except (asyncio.CancelledError, Exception):
                pass
            self.ready = False

    async def _reclaim_loop(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                await self.reclaim()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._metrics.error(f"reclaim_loop: {exc}")
                logger.error("STREAM_RECLAIM_LOOP_FAILED", error=str(exc))
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=30.0)
            except asyncio.TimeoutError:
                continue

    async def _dispatch(self, entry_id: str, fields: dict) -> None:
        try:
            outcome: ProcessOutcome = await self._handler(entry_id, fields)
        except Exception as exc:
            self._metrics.error(f"handler: {exc}")
            logger.error("SIGNAL_HANDLER_FAILED", event_id=entry_id, error=str(exc))
            return

        if outcome.dead_letter:
            await self._dead_letter(entry_id, fields, outcome)
        if outcome.ack:
            try:
                await self._redis.xack(
                    self._settings.SIGNAL_STREAM,
                    self._settings.SIGNAL_GROUP,
                    entry_id,
                )
                self._metrics.inc("stream.acked")
            except Exception as exc:
                self._metrics.error(f"xack: {exc}")
                logger.error("STREAM_ACK_FAILED", event_id=entry_id, error=str(exc))
        else:
            self._metrics.inc("stream.deferred")

    async def _dead_letter(self, entry_id: str, fields: dict, outcome: ProcessOutcome) -> None:
        try:
            await self._redis.xadd(
                self._settings.DEAD_LETTER_STREAM,
                {
                    "payload": json.dumps(
                        {
                            "event_id": entry_id,
                            "reason": outcome.reason,
                            "detail": outcome.detail,
                            "fields": fields,
                        },
                        default=str,
                    )
                },
                maxlen=10_000,
                approximate=True,
            )
            self._metrics.inc("stream.dead_lettered")
        except Exception as exc:
            self._metrics.error(f"dead_letter: {exc}")
