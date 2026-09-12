import json
import asyncio
import redis.asyncio as redis
import structlog
from pydantic_settings import BaseSettings, SettingsConfigDict
from app.broker.binance_client import ExchangeClient
from app.broker.order_manager import OrderManager
from app.risk.position_sizing import RiskManager
from app.risk.stop_loss_manager import StopLossManager
from app.reconciliation.trade_logger import TradeLogger

# Settings
class Settings(BaseSettings):
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    EXCHANGE_ID: str = "binance"
    API_KEY: str = "YOUR_API_KEY"
    API_SECRET: str = "YOUR_API_SECRET"
    MIN_CONFIDENCE: float = 0.90
    DEFAULT_BALANCE: float = 1000.0

    model_config = SettingsConfigDict(env_file=".env", extra='ignore')

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

    async def run(self):
        self.redis_client = redis.from_url(f"redis://{settings.REDIS_HOST}:{settings.REDIS_PORT}/0")
        pubsub = self.redis_client.pubsub()
        await pubsub.subscribe("trading_signals")
        
        logger.info("EXECUTION_ENGINE_READY", min_confidence=settings.MIN_CONFIDENCE)

        try:
            async for message in pubsub.listen():
                if message['type'] == 'message':
                    await self.process_signal(message['data'])
        except Exception as e:
            logger.error("Main loop error", error=str(e))
        finally:
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

if __name__ == "__main__":
    engine = ExecutionEngine()
    asyncio.run(engine.run())
