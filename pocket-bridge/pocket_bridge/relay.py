"""Local WebSocket relay that streams cleared PO data to the Node backend.

The Node.js backend connects to this endpoint as a WebSocket client
(``/relay``). The relay pushes two framed message types:

    {"type": "tick",  "payload": {...raw tick + symbol...}}
    {"type": "candle","payload": {...M20 candle + symbol...}}
    {"type": "status","payload": {"status": ..., "error": ...}}
    {"type": "snapshot","payload": {...per-symbol M20 snapshots...}}
    {"type": "ready", "payload": {"assets_initialized": true}}

On every new client connection the relay sends a full snapshot so the backend
can rebuild the SSOT immediately (no historical fetch required). Once the bridge
has authenticated and loaded its authoritative asset list it broadcasts (and
replies to each new client with) ``ready`` — the Node backend gates its
subscribe pushes on that frame so it never races Python's startup.
"""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import os
import socket
from typing import Callable, Dict, List, Optional, Set

import websockets

from .config import BridgeSettings
from .m20_engine import M20Engine

logger = logging.getLogger("pocket_bridge.relay")


class RelayServer:
    def __init__(self, settings: BridgeSettings, engine: M20Engine) -> None:
        self.settings = settings
        self.engine = engine
        self.clients: Set = set()
        self.server = None
        #: async callback (websocket, payload_dict) -> None invoked on every
        #: ``{"type": "subscribe", "payload": {...}}`` frame. Wired by the
        #: entrypoint so the bridge can dynamically arm the requested symbol
        #: and reply with its ``subscribed`` confirmation.
        self.on_subscribe = None
        #: optional sync callback () -> bool reporting whether the bridge has
        #: finished authenticating + loading its asset list. When True, the
        #: relay tells each new client immediately with a ``ready`` frame so the
        #: backend can release its staged subscribes without waiting for the
        #: next global broadcast.
        self.is_ready: Optional[Callable[[], bool]] = None

    async def handler(self, websocket) -> None:
        self.clients.add(websocket)
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
                    {"type": "ready", "payload": {"assets_initialized": True}},
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
                if not isinstance(frame, dict) or frame.get("type") != "subscribe":
                    continue
                payload = (
                    frame.get("payload")
                    if isinstance(frame.get("payload"), dict)
                    else {}
                )
                if self.on_subscribe is not None:
                    try:
                        await self.on_subscribe(websocket, payload)
                    except Exception:  # noqa: BLE001 - a broken subscribe must
                        # never kill the relay handler loop.
                        logger.exception("relay subscribe handler failed")
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            logger.info("relay client disconnected (%d total)", len(self.clients))

    async def send(self, websocket, frame: Dict) -> None:
        try:
            await websocket.send(json.dumps(frame))
        except Exception:  # noqa: BLE001
            self.clients.discard(websocket)

    async def broadcast(self, frame: Dict) -> None:
        if not self.clients:
            return
        data = json.dumps(frame)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send(data)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

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
