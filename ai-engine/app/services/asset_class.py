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
  * CRYPTO — 24/7 majors (BTC/ETH). Neither of the above: no FX session, no
             reliable L2 book in this stack, and volatility on a completely
             different scale (tens of percent daily, not fractions of a pip).
             → ``CryptoMarketStrategy`` (momentum breakout + HF volatility
               bands + crypto tick cadence).

CRYPTO CLASSIFICATION HISTORY (behaviour-changing)
-------------------------------------------------
BTC/USD and ETH/USD were previously members of ``REAL_ASSET_CLASS_SYMBOLS``,
which routed them into ``real_liquidity_gate``. That gate demands a
bid/ask spread-to-ATR margin, 160 clean closes, and M1/M5/H1 trend alignment —
all designed for ECB-sourced wholesale FX with a session and a real book. On a
24/7 crypto tape it is the wrong instrument: crypto has no FX session
resumption, its ATR/price is orders of magnitude larger than the FX bands, and
this stack has no consolidated L2 feed for it. The result was crypto being
graded by an FX microstructure filter.

They are now classified ``CRYPTO`` and gated by a crypto-specific strategy.
Wholesale FX pairs are unaffected: ``REAL`` is still exactly the 10 EUR/SEK…
USD/CZK pairs.

Symbols are matched case-insensitively against the canonical whitelist.
Unknown / unlisted symbols resolve to OTC — the OTC filter is the safe default
for untrusted data (it cannot fabricate institutional liquidity).
"""

from __future__ import annotations

from typing import Any, Dict, Set

ASSET_CLASS_OTC = "OTC"
ASSET_CLASS_REAL = "REAL"
ASSET_CLASS_CRYPTO = "CRYPTO"

# REAL CLASS — 10 wholesale FX pairs on a genuine, deep, session-bound tape.
# BTC/USD and ETH/USD were REMOVED here (see module docstring).
REAL_ASSET_CLASS_SYMBOLS: Set[str] = {
    "EUR/SEK", "EUR/NOK", "EUR/DKK", "EUR/PLN", "EUR/CZK", "EUR/HUF",
    "USD/SEK", "USD/NOK", "USD/PLN", "USD/CZK",
}

# CRYPTO CLASS — 24/7 majors. Kept as an explicit set rather than a prefix rule
# so a new listing is a deliberate, reviewable edit (matching the bridge's
# pocket-bridge/pocket_bridge/config.py crypto set).
CRYPTO_ASSET_CLASS_SYMBOLS: Set[str] = {
    "BTC/USD", "ETH/USD",
    # Quote-currency variants that can reach the engine via a raw vendor symbol.
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
    ``X/USDT`` onto the ``X/USD`` key so a vendor spelling cannot silently
    demote a crypto major into the OTC class. Unknown symbols fall back to OTC
    (safe default — the OTC HF filter cannot fabricate institutional liquidity
    for data we do not trust).
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
    Use :func:`is_crypto_asset` for the 24/7 majors.
    """
    return resolve_asset_class(symbol) == ASSET_CLASS_REAL


def is_otc_asset(symbol: Any) -> bool:
    """True when ``symbol`` belongs to the OTC (synthetic) class."""
    return resolve_asset_class(symbol) == ASSET_CLASS_OTC


def is_crypto_asset(symbol: Any) -> bool:
    """True when ``symbol`` belongs to the CRYPTO (24/7 majors) class."""
    return resolve_asset_class(symbol) == ASSET_CLASS_CRYPTO
