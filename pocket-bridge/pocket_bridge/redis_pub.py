"""Additive Redis publisher — the SECOND half of a dual-path data pipeline.

ALPHA.5 PRO: the Pocket Option bridge must fan its live tape out to Redis
(``radar_bus``) so core-backend / ai-engine / monitoring can consume ticks,
candles and feed status without each of them holding its own bridge socket.

NON-NEGOTIABLE: this is ADDITIVE. The WebSocket relay (``RelayServer``) stays
the SSOT transport that core-backend already consumes; nothing here may ever
change, slow, drop or reorder a frame on that path. Design consequences:

* Every publish goes through a bounded in-memory outbox drained by ONE
  background worker. A slow/unreachable Redis therefore degrades to a dropped
  publish (counted), NEVER a stalled broker tick stream — exactly the same
  contract the relay's per-client ``_Outbox`` enforces.
* Any import/connect/operation failure is swallowed and logged ONCE. Redis is
  optional: with it absent the bridge streams to the relay exactly as before.
* Writes are bounded: the ``SET`` side only ever holds ONE key per symbol
  (plus status/heartbeat), so it cannot grow against Redis's ``noeviction``
  memory ceiling; ``EXPIRE`` bounds each key further.

Key layout (prefix defaults to ``po``)::

    po:tick:EUR/USD      latest tick JSON            (PUBLISH po:ticks)
    po:candle:EUR/USD    latest candle JSON          (PUBLISH po:candles)
    po:status            current feed status         (PUBLISH po:status)
    po:heartbeat         last 5s liveness frame      (PUBLISH po:heartbeat)
    po:meta              publisher/runtime metadata  (for probes)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("pocket_bridge.redis_pub")

#: Outbox depth. Generous enough that a Redis blip never surfaces as a drop
#: under normal operation, but bounded so a wedged Redis cannot eat memory.
OUTBOX_MAX = 10_000

#: Default TTL for the ``SET`` side (seconds). A bridge that dies leaves stale
#: keys only briefly; probes that see them age out read the feed as down.
DEFAULT_TTL_SECONDS = 3_600


def _env_flag(name: str, default: bool = False) -> bool:
    raw = (os.getenv(name, "") or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    try:
        return float((os.getenv(name, "") or "").strip() or default)
    except (TypeError, ValueError):
        return default


class RedisPublisher:
    """Fire-and-forget publisher for the bridge's live tape.

    Constructed unconditionally by the entrypoint; when Redis is not configured
    the instance is simply *disabled* and every ``publish_*`` is a no-op, so
    call sites never need a null check.
    """

    def __init__(
        self,
        url: Optional[str] = None,
        *,
        prefix: Optional[str] = None,
        ttl_seconds: Optional[int] = None,
        outbox_max: int = OUTBOX_MAX,
    ) -> None:
        self.url = (url if url is not None else (os.getenv("REDIS_URL", "") or "")).strip()
        self.prefix = (prefix or os.getenv("PO_BRIDGE_REDIS_PREFIX", "po") or "po").strip().rstrip(":")
        self.ttl = int(
            ttl_seconds
            if ttl_seconds is not None
            else _env_float("PO_BRIDGE_REDIS_TTL_SECONDS", DEFAULT_TTL_SECONDS)
        )
        # Explicit opt-out wins; otherwise REDIS_URL alone enables the path.
        self.enabled = bool(self.url) and _env_flag("PO_BRIDGE_REDIS_ENABLED", True)

        self._outbox: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=outbox_max)
        self._worker: Optional[asyncio.Task] = None
        self._client = None
        self._connecting = False
        #: After a publish failure the client is torn down and delivery is
        #: SUSPENDED for this many seconds. Without the cooldown a long Redis
        #: outage would re-attempt a ~3s connect on every queued job, pinning
        #: the drain worker to nothing but failing connects while the outbox
        #: fills. With it, the worker empties the outbox as counted drops and
        #: retries once per cooldown window instead — the tape stays free and
        #: recovery is automatic.
        self.cooldown = max(0.0, _env_float("PO_BRIDGE_REDIS_COOLDOWN", 2.0))
        self._down_until = 0.0

        # Diagnostics (surfaced on /health).
        self.published = 0
        self.dropped = 0
        self.errors = 0
        self._last_error = ""
        self._last_error_at = 0.0
        self._connected_once = False
        self._warned_missing = False

    # ── Lifecycle ──────────────────────────────────────────────────────
    @property
    def available(self) -> bool:
        """True when the client socket is established (or still to be tried)."""
        return self.enabled

    @property
    def connected(self) -> bool:
        return self._client is not None

    async def start(self) -> None:
        """Spawn the outbox drain worker (idempotent, never raises)."""
        if not self.enabled:
            if not self._warned_missing:
                self._warned_missing = True
                logger.info(
                    "redis publisher DISABLED (no REDIS_URL) — relay remains the "
                    "only transport"
                )
            return
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())
            logger.info(
                "redis publisher started prefix=%s target=%s",
                self.prefix,
                _mask_url(self.url),
            )

    async def stop(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - cleanup
                pass
            self._worker = None
        client, self._client = self._client, None
        if client is not None:
            try:
                await client.aclose()
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass

    # ── Producers (never raise, never block on the network) ────────────
    def _offer(self, job: Dict[str, Any]) -> None:
        """Enqueue one job; drop (and count) when the outbox is saturated."""
        if not self.enabled:
            return
        try:
            self._outbox.put_nowait(job)
        except asyncio.QueueFull:
            self.dropped += 1

    async def publish_tick(self, payload: Dict[str, Any]) -> None:
        symbol = str(payload.get("symbol", "")).upper().strip()
        if not symbol:
            return
        self._offer({"kind": "tick", "symbol": symbol, "data": payload})

    async def publish_candle(self, payload: Dict[str, Any]) -> None:
        symbol = str(payload.get("symbol", "")).upper().strip()
        if not symbol:
            return
        self._offer({"kind": "candle", "symbol": symbol, "data": payload})

    async def publish_status(self, payload: Dict[str, Any]) -> None:
        self._offer({"kind": "status", "data": payload})

    async def publish_heartbeat(self, payload: Dict[str, Any]) -> None:
        self._offer({"kind": "heartbeat", "data": payload})

    # ── Consumer ───────────────────────────────────────────────────────
    async def _run(self) -> None:
        """Drain the outbox forever; every failure is contained here."""
        while True:
            job = await self._outbox.get()
            try:
                await self._deliver(job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - Redis may come and go
                self.errors += 1
                self._last_error = f"{type(exc).__name__}: {exc}"
                now = time.time()
                self._last_error_at = now
                self._down_until = now + self.cooldown
                # Drop the broken socket so the next (post-cooldown) job rebuilds
                # it.
                client, self._client = self._client, None
                if client is not None:
                    try:
                        await client.aclose()
                    except Exception:  # noqa: BLE001 - teardown must not mask
                        pass
            finally:
                self._outbox.task_done()

    async def _client_or_none(self):
        """Return a live client, connecting lazily. ``None`` when unavailable."""
        if not self.enabled:
            return None
        if self._client is not None:
            return self._client
        if self._connecting:
            return None
        self._connecting = True
        try:
            try:
                import redis.asyncio as aioredis  # type: ignore
            except ImportError:
                if not self._warned_missing:
                    self._warned_missing = True
                    logger.error(
                        "REDIS_URL set but the `redis` package is missing — "
                        "run `pip install -r pocket-bridge/requirements.txt`. "
                        "Falling back to the relay-only path."
                    )
                self.enabled = False
                return None
            client = aioredis.from_url(
                self.url,
                socket_connect_timeout=3.0,
                socket_timeout=3.0,
                # A wedged Redis must never wedge the outbox drain.
                health_check_interval=30,
            )
            self._client = client
            if not self._connected_once:
                self._connected_once = True
                logger.info("redis publisher connected target=%s", _mask_url(self.url))
            return client
        except Exception as exc:  # noqa: BLE001 - connect errors are non-fatal
            self.errors += 1
            self._last_error = f"{type(exc).__name__}: {exc}"
            self._last_error_at = time.time()
            return None
        finally:
            self._connecting = False

    async def _deliver(self, job: Dict[str, Any]) -> None:
        # Cooling down after a failure: count the loss and move on rather than
        # re-attempting a slow connect for every queued job.
        if self._down_until and time.time() < self._down_until:
            if self.enabled:
                self.dropped += 1
            return
        client = await self._client_or_none()
        if client is None:
            # Not connected (yet): count the loss so /health tells the truth
            # rather than silently pretending the second path is healthy.
            if self.enabled:
                self.dropped += 1
            return

        kind = job.get("kind")
        symbol = job.get("symbol") or ""
        data = job.get("data") or {}
        body = json.dumps(data, separators=(",", ":"), default=str)

        set_key: Optional[str] = None
        channels: list[str] = []
        if kind == "tick":
            set_key = f"{self.prefix}:tick:{symbol}"
            channels = [f"{self.prefix}:ticks"]
        elif kind == "candle":
            set_key = f"{self.prefix}:candle:{symbol}"
            channels = [f"{self.prefix}:candles"]
        elif kind == "status":
            set_key = f"{self.prefix}:status"
            channels = [f"{self.prefix}:status"]
        elif kind == "heartbeat":
            set_key = f"{self.prefix}:heartbeat"
            channels = [f"{self.prefix}:heartbeat"]
        else:
            return

        pipe = client.pipeline(transaction=False)
        if set_key is not None:
            if self.ttl > 0:
                pipe.set(set_key, body, ex=self.ttl)
            else:
                pipe.set(set_key, body)
        for channel in channels:
            pipe.publish(channel, body)
        await pipe.execute()
        self.published += 1

    # ── Diagnostics ────────────────────────────────────────────────────
    def status(self) -> Dict[str, Any]:
        """Non-secret publisher status for /health and verify-bridge.sh."""
        return {
            "enabled": self.enabled,
            "connected": self.connected,
            "published": self.published,
            "dropped": self.dropped,
            "errors": self.errors,
            "depth": self._outbox.qsize(),
            "prefix": self.prefix,
            "cooldown_s": self.cooldown,
            # Seconds left in the post-failure cooldown (0 = not cooling down).
            "down_for": round(max(0.0, self._down_until - time.time()), 2),
            "last_error": self._last_error or None,
            "last_error_at": self._last_error_at or None,
        }


def _mask_url(url: str) -> str:
    """Log-safe target: strip any ``user:password@`` userinfo from the URL."""
    raw = (url or "").strip()
    scheme, sep, rest = raw.partition("://")
    if sep and "@" in rest:
        return f"{scheme}://***@{rest.rsplit('@', 1)[-1]}"
    return raw
