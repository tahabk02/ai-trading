import structlog
from datetime import datetime

logger = structlog.get_logger(__name__)

class TradeLogger:
    """
    Industrial-grade audit trail for all execution activities.
    Logs to both local files and potentially a central logging service.
    """

    @staticmethod
    def log_trade(trade_data: dict):
        timestamp = datetime.utcnow().isoformat()
        entry = {
            "timestamp": timestamp,
            "event": "TRADE_EXECUTED",
            **trade_data
        }
        
        # Log to structured logger
        logger.info("TRADE_AUDIT", **entry)
        
        # In a real environment, we'd also write to a dedicated trade_audit database table
        # or a CSV file for compliance reconciliation.
        with open("trade_history.log", "a") as f:
            f.write(f"{timestamp} | {trade_data['symbol']} | {trade_data['side']} | {trade_data['amount']} | {trade_data.get('price')}\n")
