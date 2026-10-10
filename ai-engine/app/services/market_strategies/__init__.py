"""
market_strategies/__init__.py — ENGINE ROUTER (multi-logic signal engine)

Resolves an incoming symbol to exactly ONE :class:`MarketStrategy` and runs it.
This is the single dispatch point that replaces the previous inline
``if asset_class == "OTC": ... else: ...`` chain in ``execution_gate.py``.

Three strategies, three microstructures:

  ==============  ==========================  =========================================
  asset class     strategy                    what it qualifies
  ==============  ==========================  =========================================
  ``OTC``         ``OtcMarketStrategy``       HF price-action, synthetic volatility band
                                            [0.0008, 0.0050], mean-reversion boundaries
  ``REAL``        ``RealMarketStrategy``      spread-to-ATR safety margin, order-flow
                                            imbalance, M1/M5/H1 alignment
  ``CRYPTO``      ``CryptoMarketStrategy``    Donchian breakout, momentum, crypto
                                            volatility band [0.0015, 0.0600], trend
                                            structure
  ==============  ==========================  =========================================

Unknown symbols route to OTC — the OTC filter is the safe default because it
cannot fabricate institutional liquidity from data the engine does not trust.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Type

from ..asset_class import (
    ASSET_CLASS_CRYPTO,
    ASSET_CLASS_OTC,
    ASSET_CLASS_REAL,
    resolve_asset_class,
)
from .base import MarketStrategy
from .crypto_strategy import CryptoMarketStrategy
from .otc_strategy import OtcMarketStrategy
from .real_strategy import RealMarketStrategy

__all__ = [
    "MarketStrategy",
    "OtcMarketStrategy",
    "RealMarketStrategy",
    "CryptoMarketStrategy",
    "STRATEGY_REGISTRY",
    "resolve_strategy",
    "evaluate_for_symbol",
    "describe_registry",
]

# ── THE REGISTRY ────────────────────────────────────────────────────────────
# Class-keyed, not if/else: adding a market type is one entry here plus one
# subclass. The registry is the router's only knowledge of market types.
STRATEGY_REGISTRY: Dict[str, Type[MarketStrategy]] = {
    ASSET_CLASS_OTC: OtcMarketStrategy,
    ASSET_CLASS_REAL: RealMarketStrategy,
    ASSET_CLASS_CRYPTO: CryptoMarketStrategy,
}

# The class an unrecognised asset class string falls back to. OTC is the safe
# default (it cannot manufacture institutional liquidity from untrusted data).
FALLBACK_ASSET_CLASS = ASSET_CLASS_OTC

# Strategy instances are stateless and therefore shared — one per market type,
# not one per request.
_STRATEGY_INSTANCES: Dict[str, MarketStrategy] = {}


def _instance_for(asset_class: str) -> MarketStrategy:
    strategy = _STRATEGY_INSTANCES.get(asset_class)
    if strategy is None:
        cls = STRATEGY_REGISTRY.get(asset_class, STRATEGY_REGISTRY[FALLBACK_ASSET_CLASS])
        strategy = cls()
        _STRATEGY_INSTANCES[asset_class] = strategy
    return strategy


def resolve_strategy(symbol: Any) -> MarketStrategy:
    """Route ``symbol`` to its market strategy.

    Classification is delegated to
    :func:`app.services.asset_class.resolve_asset_class` so there is exactly
    ONE place in the engine that decides what a symbol is.
    """
    asset_class = resolve_asset_class(symbol)
    return _instance_for(asset_class)


def evaluate_for_symbol(
    symbol: Any,
    *,
    closes: Any,
    direction: Optional[str],
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    live_price: Optional[float] = None,
    allow_quote_proxy: bool = False,
) -> Dict[str, Any]:
    """Resolve + evaluate in one call.

    Returns the standard class-gate verdict, with ``asset_class`` and
    ``class_filter`` stamped on for the audit trail.
    """
    strategy = resolve_strategy(symbol)
    verdict = strategy.evaluate(
        closes=list(closes or []),
        direction=direction,
        bid=bid,
        ask=ask,
        live_price=live_price,
        allow_quote_proxy=allow_quote_proxy,
    )
    verdict["asset_class"] = strategy.asset_class
    verdict["class_filter"] = strategy.filter_name
    return verdict


def describe_registry() -> Dict[str, Any]:
    """Introspection: every registered strategy and its minimum window."""
    return {
        "fallback": FALLBACK_ASSET_CLASS,
        "strategies": {
            name: _instance_for(name).describe() for name in STRATEGY_REGISTRY
        },
    }
