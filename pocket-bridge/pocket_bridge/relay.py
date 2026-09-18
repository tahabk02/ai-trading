"""Local WebSocket relay that streams cleared PO data to the Node backend.

The Node.js backend connects to this endpoint as a WebSocket client
(``/relay``). The relay pushes framed message types — ``tick``, ``candle``,
``status``, ``snapshot``, ``ready``, ``subscribed``, ``heartbeat`` plus the
control frames ``hello`` / ``pong``. Every outbound message is emitted through
ONE unified path that stamps a monotonic ``seq`` and a UTC-millisecond
``ts_utc`` on top of the frame, so consumers can detect drops / reordering
even across reconnects.

Zero-drop, no-backpressure design:

* Each connected client gets a bounded outbound queue drained by its own
  writer task — a slow consumer can NEVER stall the broker tick stream for the
  other clients (or for the bridge). ``broadcast``/``send`` are O(1) enqueues.
* Only a catastrophically slow client (queue overflow) is disconnected — never
  silently deprioritised, never blocking the rest.
* On every new client connection the relay sends a full snapshot so the
  backend can rebuild the SSOT immediately (no historical fetch required).
* Once the bridge has authenticated and loaded its authoritative asset list it
  broadcasts (and replies to each new client with) ``ready`` — the Node
  backend gates its subscribe pushes on that frame so it never races Python's
  startup.
"""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import os
import socket
import time
from http import HTTPStatus
from typing import Callable, Dict, Optional

import websockets
from websockets.datastructures import Headers
from websockets.http11 import Response

from .config import BridgeSettings
from .m20_engine import M20Engine

logger = logging.getLogger("pocket_bridge.relay")

#: Per-client outbound queue cap. Larger than any realistic burst between
#: two consecutive TCP flushes; overflow only fires for a truly wedged client.
OUTBOX_MAX_FRAMES = 10_000


class _Outbox:
    """Bounded FIFO of serialized frames drained by a dedicated writer task."""

    def __init__(self, ws, maxlen: int = OUTBOX_MAX_FRAMES) -> None:
        self.ws = ws
        self._q: "asyncio.Queue[str]" = asyncio.Queue(maxsize=maxlen)
        self.task: Optional[asyncio.Task] = None
        self.overflow = 0

    def start(self) -> None:
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            data = await self._q.get()
            try:
                await self.ws.send(data)
            except Exception:  # noqa: BLE001 - dead conn stops this writer only
                break
            finally:
                self._q.task_done()

    def put(self, data: str) -> bool:
        """Enqueue one serialized frame; False when the client is falling behind."""
        try:
            self._q.put_nowait(data)
            return True
        except asyncio.QueueFull:
            self.overflow += 1
            return False


class RelayServer:
    def __init__(self, settings: BridgeSettings, engine: M20Engine) -> None:
        self.settings = settings
        self.engine = engine
        self.clients: Dict = {}
        self.server = None
        self._seq = 0
        #: async callback (websocket, payload_dict) -> None invoked on every
        #: ``{"type": "subscribe", "payload": {...}}`` frame. Wired by the
        #: entrypoint so the bridge can dynamically arm the requested symbol
        #: and reply with its ``subscribed`` confirmation.
        self.on_subscribe = None
        self.on_unsubscribe = None
        #: optional sync callback () -> bool reporting whether the bridge has
        #: finished authenticating + loading its asset list. When True, the
        #: relay tells each new client immediately with a ``ready`` frame so the
        #: backend can release its staged subscribes without waiting for the
        #: next global broadcast.
        self.is_ready: Optional[Callable[[], bool]] = None
        self.asset_provider: Optional[Callable[[], list]] = None
        self.health_provider: Optional[Callable[[], Dict]] = None
        #: total frames of type "candle" pushed through broadcast() this
        #: process (MASTER MISSION 2.x — surfaced on /health). Incremented in
        #: broadcast(), which is the single funnel for every client-visible
        #: candle frame regardless of which producer emitted it.
        self.candles_emitted: int = 0

    async def process_request(self, _connection, request):
        if request.path.rstrip("/") != "/health":
            return None
        payload = self.health_provider() if self.health_provider else {"status": "degraded"}
        payload = dict(payload)
        payload["candles_emitted"] = self.candles_emitted
        body = json.dumps(payload).encode("utf-8")
        headers = Headers()
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(body))
        return Response(HTTPStatus.OK.value, "OK", headers, body)

    def _frame(self, frame: Dict) -> Dict:
        """UNIFIED EMIT: decorate every outbound frame with diagnostics.

        ``ts_utc`` — UTC wall-clock (epoch ms) at emission time,
        ``seq``     — per-process monotonic emit counter (drop detection).

        Consumer keys (``type`` / ``payload``) are never touched.
        """
        self._seq += 1
        out = dict(frame)
        out.setdefault("ts_utc", time.time_ns() // 1_000_000)
        out.setdefault("seq", self._seq)
        return out

    async def _drain_outbox(self, outbox: Optional[_Outbox]) -> None:
        if outbox is None or outbox.task is None:
            return
        outbox.task.cancel()
        try:
            await outbox.task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - cleanup
            pass

    def _register(self, ws) -> _Outbox:
        outbox = self.clients.get(ws)
        if outbox is None:
            outbox = _Outbox(ws)
            self.clients[ws] = outbox
        outbox.start()
        return outbox

    async def handler(self, websocket) -> None:
        outbox = self._register(websocket)
        logger.info("relay client connected (%d total)", len(self.clients))
        try:
            # Initial full snapshot so the backend can rebuild the SSOT.
            await self.send(
                websocket,
                {"type": "snapshot", "payload": self.engine.snapshots()},
            )
            await self.send(websocket, {"type": "hello", "payload": {"ok": True}})
            # If the bridge already authenticated + loaded its assets, tell this
            # newcomer immediately so its staged subscribes get released now
            # instead of waiting for the next global `ready` broadcast.
            if self.is_ready is not None and self.is_ready():
                await self.send(
                    websocket,
                    {"type": "ready", "payload": {
                        "assets_initialized": True,
                        "assets": self.asset_provider() if self.asset_provider else [],
                    }},
                )
            while True:
                message = await websocket.recv()
                text = (
                    message
                    if isinstance(message, str)
                    else message.decode("utf-8", "replace")
                )
                trimmed = text.strip()
                if trimmed == "ping":
                    await self.send(websocket, {"type": "pong", "payload": {"ok": True}})
                    continue
                try:
                    frame = json.loads(trimmed)
                except (ValueError, TypeError):
                    continue
                if not isinstance(frame, dict) or frame.get("type") not in {"subscribe", "unsubscribe"}:
                    continue
                payload = (
                    frame.get("payload")
                    if isinstance(frame.get("payload"), dict)
                    else {}
                )
                callback = self.on_subscribe if frame.get("type") == "subscribe" else self.on_unsubscribe
                if callback is not None:
                    try:
                        await callback(websocket, payload)
                    except Exception:  # noqa: BLE001 - a broken subscribe must
                        # never kill the relay handler loop.
                        logger.exception("relay subscribe handler failed")
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.pop(websocket, None)
            await self._drain_outbox(outbox)
            logger.info("relay client disconnected (%d total)", len(self.clients))

    async def send(self, websocket, frame: Dict) -> None:
        """Enqueue one frame for a single client (never blocks the tick stream)."""
        outbox = self._register(websocket)
        if not outbox.put(json.dumps(self._frame(frame))):
            # Catastrophically slow consumer: drop the client, never stall the
            # broker stream for everyone else.
            self.clients.pop(websocket, None)
            await self._drain_outbox(outbox)
            try:
                await websocket.close()
            except Exception:  # noqa: BLE001 - best-effort
                pass

    async def broadcast(self, frame: Dict) -> None:
        if not self.clients:
            return
        if frame.get("type") == "candle":
            self.candles_emitted += 1
        data = json.dumps(self._frame(frame))
        dead = []
        for ws, outbox in list(self.clients.items()):
            if not outbox.put(data):
                dead.append(ws)
        for ws in dead:
            outbox = self.clients.pop(ws, None)
            await self._drain_outbox(outbox)

    @staticmethod
    def _is_port_bound(host: str, port: int) -> bool:
        """Return True if something is already listening on (host, port)."""
        sock = None
        try:
            for res in socket.getaddrinfo(
                host, port, socket.AF_UNSPEC, socket.SOCK_STREAM
            ):
                af, socktype, proto, _, sa = res
                sock = socket.socket(af, socktype, proto)
                try:
                    sock.bind(sa)
                    return False  # bind succeeded -> port is free
                except OSError:
                    pass
                finally:
                    sock.close()
                    sock = None
        except OSError:
            pass
        finally:
            if sock is not None:
                sock.close()
        return True

    def _build_socket(self, host: str, port: int) -> socket.socket:
        """Create a listening socket with SO_REUSEADDR (where safe) enabled.

        On POSIX this lets a freshly-restarted process immediately rebind the
        relay port even if a previous instance left a socket in TIME_WAIT,
        avoiding the classic ``Errno 98`` / ``Errno 10048`` restart crash.
        On Windows SO_REUSEADDR behaves differently (it can hijack an active
        server), so it is intentionally not set there; Windows instead relies
        on the pre-bind conflict check in :meth:`start`.
        """
        family = socket.AF_INET if ":" not in host else socket.AF_INET6
        sock = socket.socket(family, socket.SOCK_STREAM)
        if os.name == "posix":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setblocking(False)
        sock.bind((host, port))
        sock.listen()
        return sock

    async def start(self, host: Optional[str] = None, port: Optional[int] = None) -> None:
        host = host or self.settings.relay_host
        port = port or self.settings.relay_port

        if self._is_port_bound(host, port):
            logger.warning(
                "relay port %s:%d is already in use by another process; "
                "refusing to bind and shutting down cleanly (was it left "
                "running from a previous session?)",
                host,
                port,
            )
            raise RuntimeError(
                f"relay port {host}:{port} is already in use by another process"
            )

        sock = self._build_socket(host, port)
        try:
            self.server = await websockets.serve(
                self.handler,
                sock=sock,
                process_request=self.process_request,
                ping_interval=20,
                ping_timeout=30,
            )
        except OSError as exc:
            sock.close()
            if exc.errno in (errno.EADDRINUSE, errno.EADDRNOTAVAIL, 10048):
                logger.warning(
                    "relay port %s:%d could not be bound (errno %s); "
                    "another process is likely holding the port",
                    host,
                    port,
                    exc.errno,
                )
            raise
        logger.info("relay listening on ws://%s:%d", host, port)

    async def close(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None