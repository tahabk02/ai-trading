import ccxt
import structlog
from typing import Dict, Any

logger = structlog.get_logger(__name__)

class ExchangeClient:
    """
    Unified broker client using CCXT to interact with crypto exchanges.
    """

    def __init__(self, exchange_id: str, api_key: str, secret: str):
        if not hasattr(ccxt, exchange_id):
            raise ValueError(f"Exchange {exchange_id} not supported by CCXT")
        
        self.exchange = getattr(ccxt, exchange_id)({
            'apiKey': api_key,
            'secret': secret,
            'enableRateLimit': True,
            # 'options': {'defaultType': 'future'} # Uncomment for futures
        })

    def execute_market_order(self, symbol: str, side: str, amount: float) -> Dict[str, Any]:
        """
        Executes a market order (BUY or SELL).
        """
        try:
            logger.info("Placing market order", symbol=symbol, side=side, amount=amount)
            
            # In production, we'd use self.exchange.create_market_order
            # For this "vraie" implementation, we wrap it in a safety check
            if self.exchange.apiKey == 'YOUR_API_KEY':
                logger.warning("DRY RUN: API keys not set. Simulating order.")
                return {"id": "mock-order-id", "status": "simulated", "symbol": symbol, "side": side}

            order = self.exchange.create_market_order(symbol, side, amount)
            logger.info("Order executed successfully", order_id=order['id'])
            return order

        except Exception as e:
            logger.error("Order execution failed", error=str(e), symbol=symbol)
            raise
