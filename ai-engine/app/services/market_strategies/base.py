"""
market_strategies/base.py — MARKET STRATEGY CONTRACT

One interface every market type implements. The engine router
(``market_strategies/__init__.py``) resolves a symbol to exactly one strategy
and asks it for a class-gate verdict; the strict execution gate and the
execution audit then consume that verdict unchanged.

The verdict shape is deliberately IDENTICAL to the pre-existing
``otc_hf_quality`` / ``real_liquidity_gate`` output so that:

  * ``apply_strict_execution_gate`` needs no awareness of market type,
  * the audit record schema is unchanged,
  * adding a market type is additive — no existing consumer is edited.

Adding a fourth market type means subclassing ``MarketStrategy`` and
registering it; it does NOT mean editing the router's if/else chain.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


class MarketStrategy(ABC):
    """Per-market-type execution strategy.

    Subclasses declare WHICH market they serve and HOW that market is
    qualified. They must never decide the final tier, confidence or
    executable verdict — that authority belongs to
    ``signal_gatekeeper.apply_strict_execution_gate``.
    """

    #: Execution asset class this strategy serves ("OTC" | "REAL" | "CRYPTO").
    asset_class: str = ""

    #: Stable identifier stamped onto ``surface["class_filter"]`` and the audit.
    filter_name: str = ""

    #: Minimum clean closes required before this strategy may pass.
    min_history: int = 0

    #: Whether this strategy understands the institutional-FX quote-proxy
    #: relaxation (grade a notional spread from a one-bar ATR move when no
    #: bid/ask exists). The gate consults THIS instead of testing
    #: ``asset_class != "OTC"``, which silently widened when CRYPTO was added
    #: and handed crypto an FX-institutional relaxation it must not inherit.
    #: Default False: only a strategy that opts in gets the relaxation.
    accepts_quote_proxy: bool = False

    @abstractmethod
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
        """Return the standard class-gate verdict for one evaluation.

        Implementations MUST return::

            {
              "passes":  bool,
              "reason":  str | None,
              "score":   float,          # 0..1
              "factors": {name: 0|1},
              "metrics": {...},
            }
        """

    def describe(self) -> Dict[str, Any]:
        """Introspection for the audit trail / diagnostics endpoint."""
        return {
            "asset_class": self.asset_class,
            "filter_name": self.filter_name,
            "min_history": self.min_history,
            "accepts_quote_proxy": self.accepts_quote_proxy,
        }

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"<{type(self).__name__} class={self.asset_class} filter={self.filter_name}>"
