"""Low-latency asynchronous multi-instrument tick pipeline.

The HTTP endpoints remain request/response for compatibility, but the
predictive engine also needs a streaming path for real tick feeds:

    feed -> bounded asyncio queue -> N workers -> per-symbol ring buffer
         -> vectorised microstructure + regime profile -> latest result

Design constraints:

  * bounded memory: fixed-capacity ring buffers and a bounded queue;
  * no unbounded latency: when the queue is full the OLDEST tick is dropped
    (documented and counted, never silently), because stale ticks are less
    useful than fresh ones;
  * many instruments: one ring buffer and one latest-result slot per symbol;
  * no fabrication: a tick must contain a finite positive price; missing
    depths/spreads stay missing and are reported as unavailable.

This module does not own the websocket feed. It is a transport-agnostic
processor that the feed adapter calls, and it is safe to unit-test without a
network.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Deque, Dict, List, Optional, Sequence

import numpy as np

from app.services.microstructure import analyze_tick_stream
from app.services.regime_adaptation import profile_price_regime

DEFAULT_CAPACITY = 2048
DEFAULT_QUEUE_SIZE = 8192
DEFAULT_WORKERS = 2
DEFAULT_BATCH_SIZE = 256
DEFAULT_HISTORY = 256
DEFAULT_DRAIN_TIMEOUT = 2.0


@dataclass(frozen=True)
class TickEvent:
    """One REAL observed tick."""

    symbol: str
    price: float
    timestamp: float = field(default_factory=time.time)
    bid: Optional[float] = None
    ask: Optional[float] = None
    bid_depth: Optional[float] = None
    ask_depth: Optional[float] = None


class RingBuffer:
    """Fixed-capacity FIFO buffer of floats backed by ``collections.deque``."""

    def __init__(self, capacity: int = DEFAULT_CAPACITY) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.capacity = int(capacity)
        self._values: Deque[float] = deque(maxlen=self.capacity)

    def append(self, value: float) -> None:
        self._values.append(float(value))

    def extend(self, values: Sequence[float]) -> None:
        self._values.extend(float(v) for v in values)

    def clear(self) -> None:
        self._values.clear()

    def __len__(self) -> int:
        return len(self._values)

    def latest(self) -> Optional[float]:
        return self._values[-1] if self._values else None

    def to_numpy(self) -> np.ndarray:
        if not self._values:
            return np.zeros(0, dtype=np.float64)
        return np.fromiter(self._values, dtype=np.float64, count=len(self._values))

    def to_list(self) -> List[float]:
        return list(self._values)


class TickStreamProcessor:
    """Bounded async processor for one or many instruments."""

    def __init__(
        self,
        *,
        capacity: int = DEFAULT_CAPACITY,
        queue_size: int = DEFAULT_QUEUE_SIZE,
        workers: int = DEFAULT_WORKERS,
        batch_size: int = DEFAULT_BATCH_SIZE,
        evaluator: Optional[Callable[..., Dict[str, Any]]] = None,
        drain_timeout: float = DEFAULT_DRAIN_TIMEOUT,
    ) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        if queue_size <= 0:
            raise ValueError("queue_size must be positive")
        if workers <= 0:
            raise ValueError("workers must be positive")
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        if drain_timeout <= 0:
            raise ValueError("drain_timeout must be positive")
        self.capacity = int(capacity)
        self.queue_size = int(queue_size)
        self.workers = int(workers)
        self.batch_size = int(batch_size)
        self.drain_timeout = float(drain_timeout)
        self._evaluator = evaluator or default_tick_evaluator
        self._buffers: Dict[str, RingBuffer] = {}
        self._timestamps: Dict[str, RingBuffer] = {}
        self._latest: Dict[str, Dict[str, Any]] = {}
        self._queue: Optional[asyncio.Queue[TickEvent]] = None
        self._tasks: List[asyncio.Task[None]] = []
        self._running = False
        self._processed = 0
        self._evaluated = 0
        self._dropped = 0
        self._errors = 0
        self._latencies: Deque[float] = deque(maxlen=4096)

    # -- lifecycle --------------------------------------------------------
    @property
    def running(self) -> bool:
        return self._running

    async def start(self) -> None:
        if self._running:
            return
        self._queue = asyncio.Queue(maxsize=self.queue_size)
        self._running = True
        self._tasks = [
            asyncio.create_task(self._worker(index), name=f"tick-worker-{index}")
            for index in range(self.workers)
        ]

    async def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        queue = self._queue
        assert queue is not None
        try:
            # Let already-accepted ticks finish, then cancel the now-idle
            # workers. This cannot deadlock when queue_size < workers, unlike
            # the old sentinel-per-worker implementation.
            await asyncio.wait_for(queue.join(), timeout=self.drain_timeout)
        except asyncio.TimeoutError:
            self._dropped += queue.qsize()
        awaited = list(self._tasks)
        self._tasks = []
        for task in awaited:
            task.cancel()
        if awaited:
            await asyncio.gather(*awaited, return_exceptions=True)
        self._queue = None

    def submit(self, event: TickEvent) -> bool:
        """Enqueue a tick without awaiting; drop the OLDEST item if saturated."""
        if not self._running or self._queue is None:
            raise RuntimeError("tick pipeline is not running")
        try:
            self._queue.put_nowait(event)
            return True
        except asyncio.QueueFull:
            try:
                self._queue.get_nowait()
                self._queue.task_done()
                self._dropped += 1
            except asyncio.QueueEmpty:
                pass
            try:
                self._queue.put_nowait(event)
                return True
            except asyncio.QueueFull:
                self._dropped += 1
                return False

    async def asubmit(self, event: TickEvent) -> bool:
        """Async convenience wrapper that yields control after enqueueing."""
        accepted = self.submit(event)
        await asyncio.sleep(0)
        return accepted

    # -- workers ----------------------------------------------------------
    async def _worker(self, index: int) -> None:
        del index
        queue = self._queue
        assert queue is not None
        while True:
            item = await queue.get()
            try:
                batch = [item]
                while len(batch) < self.batch_size:
                    try:
                        nxt = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    batch.append(nxt)
                    queue.task_done()
                for event in batch:
                    self._process_event(event)
            finally:
                queue.task_done()

    # -- evaluation -------------------------------------------------------
    def process_now(self, event: TickEvent) -> Optional[Dict[str, Any]]:
        """Synchronous deterministic processing hook (used by tests/backfills)."""
        return self._process_event(event)

    def _process_event(self, event: TickEvent) -> Optional[Dict[str, Any]]:
        self._processed += 1
        symbol = str(getattr(event, "symbol", "") or "").strip().upper()
        try:
            price = float(getattr(event, "price", None))
            timestamp = float(getattr(event, "timestamp", None))
        except (TypeError, ValueError, OverflowError):
            self._errors += 1
            return None
        if (
            not symbol
            or not np.isfinite(price)
            or price <= 0
            or not np.isfinite(timestamp)
        ):
            self._errors += 1
            return None
        buffer = self._buffers.get(symbol)
        if buffer is None:
            buffer = RingBuffer(self.capacity)
            self._buffers[symbol] = buffer
        times = self._timestamps.get(symbol)
        if times is None:
            times = RingBuffer(self.capacity)
            self._timestamps[symbol] = times
        buffer.append(price)
        times.append(timestamp)

        prices = buffer.to_numpy()
        if len(prices) < 2:
            return None

        stamps = times.to_numpy()
        if len(stamps) == len(prices) and np.all(np.diff(stamps) > 0):
            clock: Optional[np.ndarray] = stamps[-DEFAULT_HISTORY:]
        else:
            clock = None
        window = prices[-DEFAULT_HISTORY:]

        started = time.perf_counter()
        try:
            payload = self._evaluator(
                symbol=symbol,
                prices=window,
                timestamps=clock,
                event=event,
            )
        except Exception as exc:  # noqa: BLE001 - one bad tape must not kill the worker
            self._errors += 1
            payload = {
                "symbol": symbol,
                "available": False,
                "reason": f"evaluation_failed: {type(exc).__name__}",
            }
        if not isinstance(payload, dict):
            self._errors += 1
            payload = {
                "available": False,
                "reason": "evaluator_returned_non_mapping",
            }
        else:
            payload = {str(key): value for key, value in payload.items()}
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        self._latencies.append(elapsed_ms)
        self._evaluated += 1
        # Engine-owned metadata wins over a custom evaluator's fields.
        result = {
            **payload,
            "symbol": symbol,
            "price": float(prices[-1]),
            "timestamp": timestamp,
            "ticks": len(prices),
            "latency_ms": round(elapsed_ms, 3),
        }
        self._latest[symbol] = result
        return result

    # -- read surface -----------------------------------------------------
    def latest(self, symbol: str) -> Optional[Dict[str, Any]]:
        key = str(symbol or "").strip().upper()
        return self._latest.get(key)

    def history(self, symbol: str) -> List[float]:
        key = str(symbol or "").strip().upper()
        buffer = self._buffers.get(key)
        return buffer.to_list() if buffer is not None else []

    def stats(self) -> Dict[str, Any]:
        latencies = np.fromiter(self._latencies, dtype=np.float64) if self._latencies else np.zeros(0)
        p50 = float(np.percentile(latencies, 50)) if len(latencies) else 0.0
        p95 = float(np.percentile(latencies, 95)) if len(latencies) else 0.0
        return {
            "running": self._running,
            "workers": self.workers,
            "queue_depth": self._queue.qsize() if self._queue is not None else 0,
            "queue_capacity": self.queue_size,
            "instruments": len(self._buffers),
            "buffers": {
                symbol: len(buffer) for symbol, buffer in self._buffers.items()
            },
            "processed": self._processed,
            "evaluated": self._evaluated,
            "dropped": self._dropped,
            "errors": self._errors,
            "latency_ms_p50": round(p50, 3),
            "latency_ms_p95": round(p95, 3),
        }


def default_tick_evaluator(
    *,
    symbol: str,
    prices: Sequence[float],
    timestamps: Optional[Sequence[float]],
    event: TickEvent,
) -> Dict[str, Any]:
    """Cheap per-batch evaluation: microstructure plus a price-based regime."""
    micro = analyze_tick_stream(
        prices,
        timestamps=timestamps,
        bid_depth=event.bid_depth,
        ask_depth=event.ask_depth,
    )
    payload: Dict[str, Any] = {
        "available": True,
        "microstructure": micro,
    }
    if len(prices) >= 6:
        try:
            profile = profile_price_regime(
                symbol=symbol,
                prices=prices,
                tick_timestamps=timestamps,
                bid=event.bid,
                ask=event.ask,
                bid_depth=event.bid_depth,
                ask_depth=event.ask_depth,
            )
            payload["regime"] = {
                "asset_class": profile.get("asset_class"),
                "regime": profile.get("regime"),
                "directional_bias": profile.get("directional_bias"),
                "suppression": profile.get("suppression"),
            }
        except ValueError:
            payload["regime"] = {"available": False, "reason": "insufficient_history"}
    return payload
