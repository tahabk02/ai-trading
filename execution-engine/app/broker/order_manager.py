import structlog
from typing import Dict, Any
from .binance_client import ExchangeClient

logger = structlog.get_logger(__name__)

class OrderManager:
    """
    Stateful manager for active orders.
    Handles order tracking, cancellation, and status updates.
    """

    def __init__(self, exchange_client: ExchangeClient):
        self.exchange = exchange_client.exchange
        self.active_orders: Dict[str, Any] = {}

    async def track_order(self, order_id: str, symbol: str):
        """
        Polls or listens for order status updates.
        """
        try:
            order = await self.exchange.fetch_order(order_id, symbol)
            logger.info("Order status update", id=order_id, status=order['status'])
            return order
        except Exception as e:
            logger.error("Failed to fetch order", id=order_id, error=str(e))
            return None

    async def cancel_all_orders(self, symbol: str):
        """
        Emergency stop: cancels all open orders for a symbol.
        """
        try:
            await self.exchange.cancel_all_orders(symbol)
            logger.warning("All orders cancelled", symbol=symbol)
        except Exception as e:
            logger.error("Cancellation failed", symbol=symbol, error=str(e))
