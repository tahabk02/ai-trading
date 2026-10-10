"""market_strategies/crypto_strategy.py — CRYPTO (24/7 majors) strategy."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..asset_class import ASSET_CLASS_CRYPTO
from ..crypto_hf_quality import evaluate_crypto_hf_quality
from ..data_sanitization import MIN_CRYPTO_TICKS
from .base import MarketStrategy


class CryptoMarketStrategy(MarketStrategy):
    """24/7 crypto majors: trend expansions, no FX session, no consolidated L2.

    Wraps the crypto-specific ``crypto_hf_quality`` gate (Donchian breakout +
    momentum + crypto volatility band + trend structure).

    ``allow_quote_proxy`` is intentionally ignored: the FX proxy relaxation
    models a notional spread from a one-bar ATR move for a session-bound
    order-book. Crypto is graded on breakout/volatility-band structure and its
    optional flow check already falls back to the tick-position proxy when no
    bid/ask exists, so no relaxation is needed or appropriate here.
    """

    asset_class = ASSET_CLASS_CRYPTO
    filter_name = "crypto_hf_quality"
    min_history = MIN_CRYPTO_TICKS

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
        return evaluate_crypto_hf_quality(
            closes, direction, bid=bid, ask=ask, live_price=live_price
        )
