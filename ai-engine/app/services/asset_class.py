"""
asset_class.py — OTC / REAL / CRYPTO instrument classification

The platform loads three structurally different market microstructures, and each
one is gated by a DIFFERENT execution strategy (see ``market_strategies/``):

  * OTC    — synthetic / retail-class instruments. Fast, thin, mean-reverting.
             → ``OtcMarketStrategy`` (HF price-action + synthetic volatility
               band + mean-reversion boundaries).  app/services/otc_hf_quality.py
  * REAL   — institutional wholesale FX. Deep, session-bound, genuine spreads.
             → ``RealMarketStrategy`` (spread-to-ATR safety margin, order-flow
               imbalance, M1/M5/H1 alignment resampled from the forwarded tape).
               app/services/real_liquidity_gate.py
  * CRYPTO — 24/7 majors. Retained for classification/strategy compatibility,
             but these instruments are retired from the tradable universe and
             are rejected at the API boundary before reaching a gate.

Wholesale FX: ``REAL`` is exactly the 5 EUR/SEK…USD/CZK pairs.

Symbols are matched case-insensitively against the canonical whitelist.
Unknown / unlisted symbols resolve to OTC — the OTC filter is the safe default
for untrusted data (it cannot fabricate institutional liquidity).
"""

from __future__ import annotations

from typing import Any, Dict, Set

ASSET_CLASS_OTC = "OTC"
ASSET_CLASS_REAL = "REAL"
ASSET_CLASS_CRYPTO = "CRYPTO"

# REAL CLASS — 5 wholesale FX pairs on a genuine, deep, session-bound tape.
REAL_ASSET_CLASS_SYMBOLS: Set[str] = {
    "EUR/SEK", "EUR/HUF", "USD/NOK", "USD/PLN", "USD/CZK",
}

# CRYPTO CLASS — classification retained for compatibility. These symbols are
# rejected by the API whitelist and never fetched or traded.
CRYPTO_ASSET_CLASS_SYMBOLS: Set[str] = {
    "BTC/USD", "ETH/USD",
    "BTC/USDT", "ETH/USDT",
}

# OTC CLASS — synthetic / retail-class instruments (default for the rest).
OTC_ASSET_CLASS_SYMBOLS: Set[str] = {
    # All remaining whitelisted instruments resolve OTC by fallback; the
    # explicit set is kept for documentation/override.
}

_CLASS_CACHE: Dict[str, str] = {}


def resolve_asset_class(symbol: Any) -> str:
    """Resolve ``symbol`` to its execution asset class.

    Returns "OTC" | "REAL" | "CRYPTO".

    Matching is case-insensitive and tolerant of whitespace. Quote-normalizes
    ``X/USDT`` onto the ``X/USD`` key. Unknown symbols fall back to OTC (safe
    default — the OTC HF filter cannot fabricate institutional liquidity for
    data we do not trust).
    """
    if symbol is None:
        return ASSET_CLASS_OTC
    key = str(symbol).strip().upper()
    if not key:
        return ASSET_CLASS_OTC
    cached = _CLASS_CACHE.get(key)
    if cached is not None:
        return cached
    resolved = _classify(key)
    if len(_CLASS_CACHE) < 4096:
        _CLASS_CACHE[key] = resolved
    return resolved


def _classify(key: str) -> str:
    if key in CRYPTO_ASSET_CLASS_SYMBOLS:
        return ASSET_CLASS_CRYPTO
    # USDT quotes are economically the same major as USD for gate purposes.
    usdt_key = key[:-1] if key.endswith("T") else key
    if usdt_key.endswith("/USD") and usdt_key in CRYPTO_ASSET_CLASS_SYMBOLS:
        return ASSET_CLASS_CRYPTO
    if key in REAL_ASSET_CLASS_SYMBOLS:
        return ASSET_CLASS_REAL
    return ASSET_CLASS_OTC


def is_real_asset(symbol: Any) -> bool:
    """True for the REAL (institutional wholesale FX) class only.

    NOTE: crypto majors are NOT "real" here. This predicate means
    *institutional FX* — the spread/MTF liquidity gate applies to it alone.
    """
    return resolve_asset_class(symbol) == ASSET_CLASS_REAL


def is_otc_asset(symbol: Any) -> bool:
    """True when ``symbol`` belongs to the OTC (synthetic) class."""
    return resolve_asset_class(symbol) == ASSET_CLASS_OTC


def is_crypto_asset(symbol: Any) -> bool:
    """True when ``symbol`` belongs to the CRYPTO classification class."""
    return resolve_asset_class(symbol) == ASSET_CLASS_CRYPTO
