from __future__ import annotations

import asyncio
import logging
import signal
import sys

import redis.asyncio as redis
import structlog

from app.broker.base import Broker, PermanentBrokerError, TransientBrokerError
from app.broker.ccxt_broker import CcxtBroker
from app.broker.paper import PaperBroker
from app.config import Settings
from app.execution.gateway import ExecutionGateway
from app.health import serve_health
from app.infra.stream_consumer import StreamConsumer
from app.observability import Metrics
from app.risk.gate import KillSwitch, RiskGate
from app.state.store import OrderStore

logger = structlog.get_logger(__name__)


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(message)s",
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def _build_broker(settings: Settings) -> Broker:
    if settings.TRADING_MODE == "live":
        return CcxtBroker(settings)
    return PaperBroker(settings)


async def _validate_live_symbols(broker: Broker, settings: Settings) -> None:
    symbols = sorted(settings.allowed_symbols)
    if not symbols:
        raise SystemExit(
            "[FATAL] TRADING_MODE=live requires a non-empty ALLOWED_SYMBOLS list"
        )
    unsupported: list[str] = []
    for symbol in symbols:
        try:
            await broker.validate_symbol(symbol)
        except PermanentBrokerError:
            unsupported.append(symbol)
    if unsupported:
        raise SystemExit(
            "[FATAL] the configured venue cannot trade these symbols: "
            + ", ".join(unsupported)
            + ". Point EXECUTION at a venue that supports them or run paper mode."
        )


def _install_signal_handlers(loop: asyncio.AbstractEventLoop, stop_event: asyncio.Event) -> None:
    def _stop(*_args) -> None:
        loop.call_soon_threadsafe(stop_event.set)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _stop)
        except (NotImplementedError, RuntimeError):
            try:
                signal.signal(sig, _stop)
            except (ValueError, OSError):
                pass


async def _reconcile_loop(
    gateway: ExecutionGateway,
    settings: Settings,
    stop_event: asyncio.Event,
) -> None:
    interval = settings.ORDER_POLL_INTERVAL_MS / 1000.0
    while not stop_event.is_set():
        if settings.TRADING_MODE != "disabled":
            try:
                await gateway.reconcile_pending()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("order reconciliation failed: %s", exc)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue


async def _run() -> None:
    settings = Settings()
    _configure_logging(settings.LOG_LEVEL)
    metrics = Metrics()
    stop_event = asyncio.Event()

    redis_client = redis.from_url(
        settings.redis_url,
        decode_responses=True,
        health_check_interval=30,
    )
    broker = _build_broker(settings)
    store = OrderStore(settings.resolved_sqlite_path)
    kill_switch = KillSwitch(settings, redis_client)
    gate = RiskGate(settings, kill_switch)
    gateway = ExecutionGateway(settings, broker, store, gate, metrics)
    consumer = StreamConsumer(settings, redis_client, gateway.process, metrics)

    broker_ready = False
    health_task: asyncio.Task | None = None
    reconcile_task: asyncio.Task | None = None
    consumer_task: asyncio.Task | None = None

    try:
        await redis_client.ping()
        await store.init()
        await broker.start()
        broker_ready = True
        if settings.TRADING_MODE == "live":
            await _validate_live_symbols(broker, settings)
            await broker.account_snapshot()
        await consumer.connect()

        def report() -> tuple[int, dict]:
            ready = consumer.ready and broker_ready
            payload = {
                "status": "ok" if ready else "starting",
                "mode": settings.TRADING_MODE,
                "venue": broker.capabilities().venue,
                "stream": settings.SIGNAL_STREAM,
                "group": settings.SIGNAL_GROUP,
                "consumer": settings.SIGNAL_CONSUMER,
                "ready": ready,
                **metrics.snapshot(),
            }
            return (200 if ready else 503), payload

        loop = asyncio.get_running_loop()
        _install_signal_handlers(loop, stop_event)

        health_task = asyncio.create_task(
            serve_health(settings.HEALTH_HOST, settings.HEALTH_PORT, report, stop_event)
        )
        reconcile_task = asyncio.create_task(
            _reconcile_loop(gateway, settings, stop_event)
        )
        consumer_task = asyncio.create_task(consumer.run(stop_event))
        consumer_task.add_done_callback(lambda _task: stop_event.set())

        logger.info(
            "EXECUTION_ENGINE_STARTED",
            mode=settings.TRADING_MODE,
            venue=broker.capabilities().venue,
            symbols=sorted(settings.allowed_symbols),
            min_confidence=settings.MIN_CONFIDENCE,
            max_notional=settings.MAX_NOTIONAL_PER_TRADE,
        )
        await stop_event.wait()
    finally:
        stop_event.set()
        for task in (consumer_task, reconcile_task, health_task):
            if task is not None and not task.done():
                task.cancel()
        for task in (consumer_task, reconcile_task, health_task):
            if task is not None:
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        try:
            await broker.close()
        finally:
            await store.close()
            await redis_client.close()
        logger.info("EXECUTION_ENGINE_STOPPED")


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass
    except (PermanentBrokerError, TransientBrokerError) as exc:
        logger.error("EXECUTION_ENGINE_BOOT_FAILED", error=str(exc))
        sys.exit(1)
    except Exception as exc:
        logging.getLogger(__name__).exception("EXECUTION_ENGINE_CRASHED")
        sys.exit(1)


if __name__ == "__main__":
    main()
