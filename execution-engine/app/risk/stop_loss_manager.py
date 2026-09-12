import structlog
from typing import Dict, Any

logger = structlog.get_logger(__name__)

class StopLossManager:
    """
    Advanced stop-loss and take-profit manager.
    Dynamic trailing stops based on ATR or fixed percentages.
    """

    def __init__(self, trailing_stop: bool = True):
        self.trailing_stop = trailing_stop

    def calculate_exit_levels(self, entry_price: float, side: str, atr: float = None) -> Dict[str, float]:
        """
        Calculates SL and TP levels.
        If ATR is provided, uses 2*ATR for SL and 3*ATR for TP.
        """
        sl_pct = 0.02 # 2% fixed fallback
        tp_pct = 0.04 # 4% fixed fallback
        
        if atr:
            sl_distance = 2 * atr
            tp_distance = 4 * atr
        else:
            sl_distance = entry_price * sl_pct
            tp_distance = entry_price * tp_pct

        if side.lower() == 'buy':
            return {
                "stop_loss": entry_price - sl_distance,
                "take_profit": entry_price + tp_distance
            }
        else:
            return {
                "stop_loss": entry_price + sl_distance,
                "take_profit": entry_price - tp_distance
            }
