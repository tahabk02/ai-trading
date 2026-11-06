from __future__ import annotations

import asyncio
import json
from typing import Callable

import structlog

logger = structlog.get_logger(__name__)

Report = Callable[[], tuple[int, dict]]


async def serve_health(
    host: str,
    port: int,
    report: Report,
    stop_event: asyncio.Event,
) -> None:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=5.0)
                if line in (b"\r\n", b"\n", b""):
                    break

            parts = request_line.decode("latin-1").strip().split(" ")
            path = parts[1].split("?")[0] if len(parts) >= 2 else "/"
            if path not in ("/health", "/metrics"):
                status, body = "404 Not Found", {"error": "not found"}
            else:
                status_code, payload = report()
                status = f"{status_code} {'OK' if status_code == 200 else 'Service Unavailable'}"
                body = payload

            encoded = json.dumps(body, default=str).encode("utf-8")
            writer.write(
                (
                    f"HTTP/1.1 {status}\r\n"
                    "Content-Type: application/json\r\n"
                    f"Content-Length: {len(encoded)}\r\n"
                    "Cache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n"
                ).encode("ascii")
                + encoded
            )
            await writer.drain()
        except (asyncio.TimeoutError, ConnectionError):
            pass
        except Exception as exc:
            logger.warning("HEALTH_HANDLER_FAILED", error=str(exc))
        finally:
            try:
                writer.close()
            except Exception:
                pass

    server = await asyncio.start_server(handle, host, port)
    logger.info("HEALTH_LISTENING", host=host, port=port)
    async with server:
        serve_task = asyncio.create_task(server.serve_forever())
        stop_task = asyncio.create_task(stop_event.wait())
        done, pending = await asyncio.wait(
            {serve_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            try:
                task.result()
            except (asyncio.CancelledError, Exception):
                pass
        server.close()
        await server.wait_closed()
