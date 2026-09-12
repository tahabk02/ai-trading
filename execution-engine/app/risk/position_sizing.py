import structlog

logger = structlog.get_logger(__name__)

class RiskManager:
    """
    Handles position sizing and stop loss calculations.
    """

    def __init__(self, account_balance: float, risk_per_trade: float = 0.02):
        self.account_balance = account_balance
        self.risk_per_trade = risk_per_trade # 2% risk

    def calculate_position_size(self, price: float, stop_loss_pct: float = 0.01) -> float:
        """
        Calculates how much to buy based on risk parameters.
        Risk = Balance * RiskPerTrade
        Position Size = Risk / StopLossDistance
        """
        risk_amount = self.account_balance * self.risk_per_trade
        stop_loss_distance = price * stop_loss_pct
        
        if stop_loss_distance == 0:
            return 0
            
        quantity = risk_amount / stop_loss_distance
        return round(quantity, 6)

    def get_stop_loss_price(self, entry_price: float, side: str, stop_loss_pct: float = 0.02) -> float:
        if side.upper() == 'BUY':
            return entry_price * (1 - stop_loss_pct)
        else:
            return entry_price * (1 + stop_loss_pct)
