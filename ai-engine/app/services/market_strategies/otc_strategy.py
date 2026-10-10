"""market_strategies/otc_strategy.py — OTC (synthetic / retail-class) strategy."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..asset_class import ASSET_CLASS_OTC
from ..data_sanitization import MIN_OTC_TICKS
from ..otc_hf_quality import evaluate_otc_hf_quality
from .base import MarketStrategy


class OtcMarketStrategy(MarketStrategy):
    """Broker OTC book: fast, thin, mean-reverting.

    Wraps the existing ``otc_hf_quality`` gate unchanged. The OTC gate never
    accepts a quote-proxy relaxation — a synthetic tape has no institutional
    liquidity to approximate — so ``allow_quote_proxy`` is intentionally
    ignored here.
    """

    asset_class = ASSET_CLASS_OTC
    filter_name = "otc_hf_quality"
    min_history = MIN_OTC_TICKS

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
        return evaluate_otc_hf_quality(
            closes, direction, bid=bid, ask=ask, live_price=live_price
        )
