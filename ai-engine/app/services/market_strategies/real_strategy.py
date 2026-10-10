"""market_strategies/real_strategy.py — REAL (institutional wholesale FX) strategy."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..asset_class import ASSET_CLASS_REAL
from ..data_sanitization import MIN_REAL_CLOSES
from ..real_liquidity_gate import evaluate_real_liquidity_gate
from .base import MarketStrategy


class RealMarketStrategy(MarketStrategy):
    """Institutional wholesale FX: deep, session-bound, genuine two-sided quotes.

    Wraps the existing ``real_liquidity_gate`` unchanged, including its
    quote-proxy relaxation (``allow_quote_proxy``), which is an
    FX-institutional concept and stays scoped to this strategy alone.
    """

    asset_class = ASSET_CLASS_REAL
    filter_name = "real_liquidity_gate"
    min_history = MIN_REAL_CLOSES
    # The ONLY strategy that understands the FX-institutional quote-proxy
    # relaxation. OTC and CRYPTO inherit no such relaxation.
    accepts_quote_proxy = True

    def evaluate(
        self,
        *,
        closes: List[Any],
        direction: Optional[str],
        bid: Optional[float] = None,
        ask: Optional[float] = None,
        live_price: Optional[float] = None,
        allow_quote_proxy: bool = False,
    ) -> Dict[str, Any]:
        return evaluate_real_liquidity_gate(
            closes,
            direction,
            bid=bid,
            ask=ask,
            live_price=live_price,
            allow_proxy_quotes=allow_quote_proxy,
        )
