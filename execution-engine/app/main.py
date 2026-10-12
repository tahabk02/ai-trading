import json
import asyncio
import os
import logging
from contextlib import suppress
from pathlib import Path

import redis.asyncio as redis
import structlog
from pydantic_settings import BaseSettings, SettingsConfigDict
from app.broker.binance_client import ExchangeClient
from app.broker.order_manager import OrderManager
from app.risk.position_sizing import RiskManager
from app.risk.stop_loss_manager import StopLossManager
from app.reconciliation.trade_logger import TradeLogger

# ── Environment file isolation ───────────────────────────────────────────────
# `<repo>/execution-engine`, derived from THIS file's location so it is
# identical under python, Docker, and a packaged image regardless of cwd.
EXECUTION_ENGINE_ROOT = Path(__file__).resolve().parents[1]
_logger = logging.getLogger(__name__)


def _execution_engine_env_files() -> tuple[Path, ...]:
    """
    execution-engine-local env files, HIGHEST precedence first.

    pydantic-settings merges a tuple left-to-right with later entries losing, so
    the highest-priority file is placed first. A real environment variable
    always wins over every file, which keeps docker-compose injection
    authoritative.
    """
    environment = os.environ.get("ENVIRONMENT") or os.environ.get("NODE_ENV") or "development"
    candidates = [
        EXECUTION_ENGINE_ROOT / ".env.local",
        EXECUTION_ENGINE_ROOT / f".env.{environment}",
        EXECUTION_ENGINE_ROOT / ".env",
    ]
    return tuple(p for p in candidates if p.is_file())


EXECUTION_ENGINE_ROOT_ENV = _execution_engine_env_files()

_PARENT_DOTENV = EXECUTION_ENGINE_ROOT.parent / ".env"
if _PARENT_DOTENV.is_file() and os.environ.get("EXECUTION_ENGINE_ALLOW_PARENT_DOTENV") != "true":
    _logger.warning(
        "execution-engine: ignoring parent %s — it is another service's "
        "configuration (it may carry exchange-adjacent credentials). Set values "
        "in %s or the real environment.",
        _PARENT_DOTENV,
        EXECUTION_ENGINE_ROOT / ".env",
    )


# Settings
class Settings(BaseSettings):
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    # Required once Redis runs with `requirepass` (the hardened production
    # stack does). The URL was previously assembled without any credential
    # support, so enabling Redis auth would have made this service fail every
    # connect with NOAUTH — it looked like a Redis outage rather than a config
    # gap.
    REDIS_PASSWORD: str = ""
    REDIS_DB: int = 0
    # A pre-built URL (e.g. rediss:// for TLS) overrides HOST/PORT/PASSWORD.
    REDIS_URL: str = ""
    EXCHANGE_ID: str = "binance"
    # Empty by default. The previous values ("YOUR_API_KEY"/"YOUR_API_SECRET")
    # were placeholder STRINGS that are non-empty, so every guard that checked
    # `if not api_key` passed and the engine happily constructed a broker client
    # with a literal fake key — surfacing later as an opaque exchange 401
    # instead of an honest "no credentials configured".
    API_KEY: str = ""
    API_SECRET: str = ""
    # Health/liveness port for the tiny stdlib probe server (see start_health_server).
    HEALTH_PORT: int = 8081
    # When true, refuse to boot without exchange credentials. Enabled by
    # docker-compose.prod.yml; the engine can then never place orders with a
    # placeholder credential.
    REQUIRE_CREDENTIALS: bool = False
    MIN_CONFIDENCE: float = 0.90
    DEFAULT_BALANCE: float = 1000.0

    # Absolute path resolved from THIS FILE, not the process working directory.
    # A bare env_file=".env" is relative to cwd, so launching this engine from
    # the repo root silently loaded the ROOT .env — another service's
    # credentials — and the same image behaved differently depending on where it
    # was started. Only files inside execution-engine/ are read; a real
    # environment variable still beats every file, so docker-compose.prod.yml
    # injection remains authoritative.
    model_config = SettingsConfigDict(
        env_file=EXECUTION_ENGINE_ROOT_ENV,
        extra='ignore',
    )

settings = Settings()
logger = structlog.get_logger(__name__)

# ═══════════════════════════════════════════════════════════════════
# STRICT OTC WHITELIST — FULL 34-PAIR UNIVERSE (0 DEMO, 100% REAL)
# Mirrors core-backend symbolRegistry.service.ts EXACTLY. Includes the
# CRYPTO MAJORS (BTC/USD, ETH/USD) so crypto signals are never rejected
# at the execution boundary.
# ═══════════════════════════════════════════════════════════════════
OTC_WHITELIST = {
    # Forex Majors (7)
    "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "USD/CAD", "AUD/USD", "NZD/USD",
    # Crypto Majors (2)
    "BTC/USD", "ETH/USD",
    # Euro Crosses (7)
    "EUR/GBP", "EUR/JPY", "EUR/CHF", "EUR/AUD", "EUR/CAD", "EUR/NZD", "EUR/TRY",
    # Pound Crosses (4)
    "GBP/JPY", "GBP/CHF", "GBP/AUD", "GBP/CAD",
    # Yen Crosses (3)
    "AUD/JPY", "CAD/JPY", "CHF/JPY",
    # Other Minors (5)
    "AUD/CAD", "AUD/NZD", "NZD/JPY", "CAD/CHF", "EUR/RUB",
    # Emerging / OTC Variants (6)
    "USD/TRY", "USD/ZAR", "USD/MXN", "USD/SGD", "MAD/USD", "KES/USD",
}

def _is_whitelisted(symbol: str) -> bool:
    """Strict membership check — only the 34 whitelisted pairs pass."""
    return (symbol or "").strip().upper() in OTC_WHITELIST

class ExecutionEngine:
    def __init__(self):
        self.broker = ExchangeClient(settings.EXCHANGE_ID, settings.API_KEY, settings.API_SECRET)
        self.order_manager = OrderManager(self.broker)
        self.risk = RiskManager(account_balance=settings.DEFAULT_BALANCE)
        self.sl_manager = StopLossManager()
        self.trade_logger = TradeLogger()
        self.redis_client = None
        # Readiness signals surfaced by /health. A container that is running but
        # has no Redis subscription is NOT ready, and compose must be able to
        # see that instead of assuming "process alive == working".
        self.ready = False
        self.started_at = None

    def _redis_url(self) -> str:
        """Resolve the Redis URL, percent-encoding the password.

        A password containing '@', ':' or '/' MUST be escaped, otherwise the
        URL parser silently truncates it and the connection fails auth.
        """
        if settings.REDIS_URL:
            return settings.REDIS_URL
        if settings.REDIS_PASSWORD:
            from urllib.parse import quote
            auth = f":{quote(settings.REDIS_PASSWORD, safe='')}@"
        else:
            auth = ""
        return f"redis://{auth}{settings.REDIS_HOST}:{settings.REDIS_PORT}/{settings.REDIS_DB}"

    async def run(self):
        self.redis_client = redis.from_url(self._redis_url())
        pubsub = self.redis_client.pubsub()
        await pubsub.subscribe("trading_signals")

        self.started_at = asyncio.get_event_loop().time()
        self.ready = True
        logger.info("EXECUTION_ENGINE_READY", min_confidence=settings.MIN_CONFIDENCE)

        try:
            async for message in pubsub.listen():
                if message['type'] == 'message':
                    await self.process_signal(message['data'])
        except Exception as e:
            logger.error("Main loop error", error=str(e))
        finally:
            self.ready = False
            await self.redis_client.close()

    async def process_signal(self, raw_data: str):
        try:
            signal = json.loads(raw_data)
            symbol = signal.get("symbol")
            confidence = signal.get("confidence", 0)
            side = "buy" if signal.get("signal_type") == "BUY" else "sell"
            price = signal.get("price")
            atr = signal.get("indicators", {}).get("atr")

            # ── STRICT OTC WHITELIST GATE ──
            # Reject ANY non-whitelisted signal (stocks/unlisted pairs)
            # before risk/execution. The 34-pair universe (incl. BTC/USD,
            # ETH/USD) passes through.
            if not _is_whitelisted(symbol):
                logger.warning(
                    "REJECTED_NON_OTC_SIGNAL",
                    symbol=symbol,
                    reason="not_in_strict_otc_whitelist",
                )
                return

            if confidence < settings.MIN_CONFIDENCE:
                return

            # 1. Risk & Exit Levels
            amount = self.risk.calculate_position_size(price)
            exit_levels = self.sl_manager.calculate_exit_levels(price, side, atr)

            # 2. Execution
            logger.info("PLACING_REAL_TRADE", symbol=symbol, side=side, amount=amount)
            order = self.broker.execute_market_order(symbol, side, amount)
            
            # 3. Audit & Logging
            self.trade_logger.log_trade({
                "symbol": symbol,
                "side": side,
                "amount": amount,
                "price": price,
                "sl": exit_levels["stop_loss"],
                "tp": exit_levels["take_profit"],
                "order_id": order.get("id"),
                "confidence": confidence
            })

            # 4. Track Order status
            asyncio.create_task(self.order_manager.track_order(order.get("id"), symbol))

        except Exception as e:
            logger.error("Execution failed", error=str(e))


# ═══════════════════════════════════════════════════════════════════
#  HEALTH ENDPOINT
#  The engine is a Redis pub/sub subscriber with NO HTTP surface at all,
#  so `depends_on: {condition: service_healthy}` and the orchestrator's
#  health checks had nothing to probe and the service was indistinguishable
#  from one that crashed on startup. A ~30-line stdlib server (no new
#  dependency, no FastAPI import cost on a 4 GB VPS) exposes /health.
# ═══════════════════════════════════════════════════════════════════

async def _handle_health(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Answer `GET /health` with a JSON readiness report."""
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
        # Drain the request headers so the client sees a clean response.
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            if line in (b"\r\n", b"\n", b""):
                break

        method, path = "GET", "/"
        parts = request_line.decode("latin-1").strip().split(" ")
        if len(parts) >= 2:
            method, path = parts[0], parts[1]

        if path.split("?")[0] != "/health":
            status, body = "404 Not Found", {"error": "not found"}
        elif not engine.ready:
            # 503: the process is up but has NOT completed the Redis
            # subscription, so it cannot process a signal yet.
            status, body = "503 Service Unavailable", {
                "status": "starting",
                "service": "execution-engine",
            }
        else:
            status, body = "200 OK", {
                "status": "ok",
                "service": "execution-engine",
                "exchange_id": settings.EXCHANGE_ID,
                # Never echo key material — only whether it is configured.
                "credentials_configured": bool(settings.API_KEY and settings.API_SECRET),
                "min_confidence": settings.MIN_CONFIDENCE,
            }

        payload = json.dumps(body).encode()
        writer.write(
            f"HTTP/1.1 {status}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\n"
            f"Cache-Control: no-store\r\n"
            f"Connection: close\r\n\r\n".encode()
            + payload
        )
        await writer.drain()
    except (asyncio.TimeoutError, ConnectionError):
        pass
    except Exception as exc:  # noqa: BLE001 — a probe must never kill the loop
        logger.warning("health handler error", error=str(exc))
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


async def start_health_server() -> asyncio.AbstractEventLoop:
    """Serve /health on HEALTH_PORT until cancelled."""
    server = await asyncio.start_server(_handle_health, "0.0.0.0", settings.HEALTH_PORT)
    logger.info("health_endpoint_listening", port=settings.HEALTH_PORT)
    async with server:
        await server.serve_forever()


engine: ExecutionEngine | None = None


async def main() -> None:
    global engine

    # Fail fast rather than trade with a placeholder credential. In production
    # (REQUIRE_CREDENTIALS=true) an unconfigured exchange must stop the boot:
    # silently running with a fake key produces orders that can never fill and
    # an audit trail that looks legitimate.
    if settings.REQUIRE_CREDENTIALS and not (settings.API_KEY and settings.API_SECRET):
        raise SystemExit(
            "[FATAL] REQUIRE_CREDENTIALS is set but API_KEY/API_SECRET are empty. "
            "Refusing to start the execution engine without exchange credentials."
        )

    engine = ExecutionEngine()
    # The health server starts FIRST and stays independent of the Redis loop, so
    # a Redis outage is reported as "starting" instead of "container not found".
    health_task = asyncio.create_task(start_health_server())
    try:
        await engine.run()
    finally:
        health_task.cancel()
        with suppress(asyncio.CancelledError):
            await health_task


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
