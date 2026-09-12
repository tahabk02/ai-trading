"""Configuration for the Pocket Option live data bridge.

The bridge connects to Pocket Option using the SSID cookie (the full
`42["auth",{...}]` session payload that BinaryOptionsToolsV2 requires),
subscribes to raw live ticks, aggregates them into strict M20 (20-second)
candles, and relays them to the Node.js backend as the single source of
truth (SSOT) for real, non-fabricated prices.

All values may be overridden via environment variables (loaded first from a
local `.env` file, matching the rest of the monorepo).
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except Exception:  # pragma: no cover - dotenv is optional at runtime
    pass

PLATFORM_TIME_OFFSET: int = int(os.getenv("POCKET_BRIDGE_TIME_OFFSET", "7200"))
"""Seconds Pocket Option's server clock is ahead of UTC. Applied to every
raw tick timestamp so bridge-side buckets align with PO's own candles.
Configurable via ``POCKET_BRIDGE_TIME_OFFSET``; validated to a sane range
(0..86400) at startup so a corrupt value cannot silently skew the grid."""
if not (0 <= PLATFORM_TIME_OFFSET <= 86_400):
    raise ValueError(
        f"POCKET_BRIDGE_TIME_OFFSET={PLATFORM_TIME_OFFSET}s is out of range"
        " (0..86400). Refusing to run on a corrupt timebase."
    )

M20_MS: int = 20_000
"""Length of one M20 candle in milliseconds (strict 20-second window)."""

# ════════════════════════════════════════════════════════════════════
# SUPPORTED CANDLE INTERVALS (timeframe selector matrix)
# ════════════════════════════════════════════════════════════════════
SUPPORTED_INTERVAL_MS = {
    "20ms": 20,
    "100ms": 100,
    "1s": 1_000,
    "20s": M20_MS,
    "1m": 60_000,
    "2m": 120_000,
    "3m": 180_000,
    "5m": 300_000,
}

# ── STRICT ASSET CLASSIFICATION ──────────────────────────────────────
# Pocket Option OTC forex pairs trade ONLY on the `_otc` instrument and are
# a different venue/pricing model from the standard wholesale forex book.
# Standard (non-OTC) forex pairs resolve to the bare symbol. Crypto maps
# directly. The classification below drives: (1) the `_otc` suffix priority
# in asset resolution, (2) the ``asset_type`` tag stamped on every relayed
# tick/candle so downstream services never mix OTC pricing into the standard
# forex pipeline or vice-versa.
OTC_FOREX_SYMBOLS: frozenset = frozenset({
    "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "USD/CAD",
    "AUD/USD", "NZD/USD", "EUR/GBP", "EUR/JPY", "EUR/CHF",
    "EUR/AUD", "EUR/CAD", "EUR/NZD", "EUR/TRY", "GBP/JPY",
    "GBP/CHF", "GBP/AUD", "GBP/CAD", "AUD/JPY", "CAD/JPY",
    "CHF/JPY", "AUD/CAD", "AUD/CHF", "AUD/NZD", "NZD/JPY", "NZD/CAD",
    "CAD/CHF",
    "EUR/RUB", "USD/TRY", "USD/ZAR", "USD/MXN", "USD/SGD",
    "MAD/USD", "KES/USD",
})

CRYPTO_SYMBOLS: frozenset = frozenset({"BTC/USD", "ETH/USD"})


def canonical_symbol(raw: str) -> str:
    """Map any backend/UI symbol variant onto the canonical ``BASE/QUOTE`` form.

    Mirrors the core backend's symbol normalizer so a subscription pushed down
    from the browser ("EUR/USD OTC", "EURUSD", "EUR-USD", "EUR/USD=X") lands on
    the EXACT tick/room key the bridge streams ("EUR/USD"):
      * trailing ``OTC`` display suffix is stripped first,
      * Yahoo/exchange qualifiers (=X, .FX, .FOREX) are removed,
      * every separator style is unified onto ``/``.
    """
    s = (raw or "").strip().upper()
    s = re.sub(r"\s*OTC\s*$", "", s)
    s = s.replace("=X", "")
    s = s.replace(".FX", "").replace(".FOREX", "").replace(".CS", "").replace(".TO", "")
    s = re.sub(r"[-_.\s]+", "/", s)
    s = re.sub(r"/{2,}", "/", s).strip("/")
    # Compact 6-char form: "EURUSD" -> "EUR/USD" (mirrors the client normalizer).
    if "/" not in s and len(s) == 6 and s.isalpha():
        s = f"{s[:3]}/{s[3:]}"
    return s


def asset_type_for_symbol(symbol: str) -> str:
    """Strict asset classification: ``forex`` | ``otc`` | ``crypto``.

    Every symbol that resolves to a Pocket Option OTC instrument is tagged
    ``otc`` (its OTC attribute is preserved explicitly). Standard wholesale
    forex pairs (non-OTC venue/pricing) are tagged ``forex``. Crypto majors
    are tagged ``crypto``. Nothing is mixed across these classes.
    """
    normalized = symbol.replace("/", "").upper()
    if normalized in {"BTCUSD", "ETHUSD", "BTCUSDT", "ETHUSDT"}:
        return "crypto"
    if symbol.replace(" ", "").replace("/", "/").upper() in OTC_FOREX_SYMBOLS:
        return "otc"
    # Any other pair with a `/`-separated base/quote is standard forex.
    if "/" in (symbol or ""):
        return "forex"
    return "otc"


def asset_candidates(symbol: str) -> List[str]:
    """Priority-ordered Pocket Option asset candidates for a backend symbol.

    Classification is strict and explicit:
      • OTC forex pairs resolve to the ``_otc`` suffix first (e.g.
        ``EURUSD_otc``) — the OTC instrument is a distinct pricing model that
        must never be mixed into the standard forex book. The bare fallback is
        retained ONLY for sessions where the broker does not list the OTC
        form (rotating availability), not as a pricing-mix path.
      • Standard forex pairs resolve to the bare symbol.
      • Crypto majors map directly (``BTCUSD`` / ``ETHUSD``).

    Returns at least one candidate so the mapping never silently drops a
    configured symbol.
    """
    normalized = symbol.replace("/", "").upper()
    if normalized in {"BTCUSD", "ETHUSD", "BTCUSDT", "ETHUSDT"}:
        return [normalized]
    if asset_type_for_symbol(symbol) == "otc":
        return [f"{normalized}_otc", normalized]
    return [normalized]


def asset_for_symbol(symbol: str) -> str:
    """Map a backend symbol (e.g. "EUR/USD") to its preferred PO asset.

    OTC pairs resolve to the ``_otc`` form; standard forex resolves to the
    bare pair. Prefer :func:`asset_candidates` when the full priority list is
    needed to resolve against what the broker actually lists.
    """
    return asset_candidates(symbol)[0]


@dataclass(frozen=True)
class BridgeSettings:
    """Resolved runtime settings for the bridge process."""

    #: Full `42["auth",{...}]` session cookie for BinaryOptionsToolsV2.
    ssid: str = field(default_factory=lambda: os.getenv("POCKET_OPTION_SSID", ""))

    #: Comma-separated backend symbols the bridge must subscribe to.
    symbols: List[str] = field(default_factory=lambda: [
        "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "USD/CAD",
        "AUD/USD", "NZD/USD", "EUR/GBP", "EUR/JPY", "EUR/CHF",
        "EUR/AUD", "EUR/CAD", "EUR/NZD", "GBP/JPY", "GBP/CHF",
        "AUD/JPY", "AUD/CAD", "AUD/CHF", "NZD/JPY", "NZD/CAD",
    ])

    #: Reconnect / subscription tuning (seconds).
    connect_timeout: float = 60.0
    reconnect_delay: float = 5.0
    reconnect_max_delay: float = 60.0

    #: Local WebSocket relay the Node backend connects to.
    relay_host: str = field(default_factory=lambda: os.getenv("POCKET_BRIDGE_HOST", "127.0.0.1"))
    relay_port: int = field(default_factory=lambda: int(os.getenv("POCKET_BRIDGE_PORT", "8788")))

    #: Maximum number of M20 candles retained per symbol in the relay.
    max_m20_history: int = 500

    #: Candidate Pocket Option WebSocket server URLs (falls back to default).
    urls: List[str] = field(default_factory=lambda: [
        u for u in os.getenv("POCKET_OPTION_WS_URLS", "").split(",") if u.strip()
    ])

    #: Candle aggregation interval. Accepts a timeframe token
    #: ("20ms" | "100ms" | "1s" | "20s" | "1m" | "2m" | "3m" | "5m") or a raw
    #: millisecond integer. Defaults to the canonical Pocket Option 20s M20.
    candle_timeframe: str = field(
        default_factory=lambda: os.getenv("POCKET_BRIDGE_CANDLE_TIMEFRAME", "20s")
    )

    @property
    def candle_interval_ms(self) -> int:
        """Resolve the configured timeframe token to exact milliseconds."""
        token = (self.candle_timeframe or "20s").strip().lower()
        if token in SUPPORTED_INTERVAL_MS:
            return SUPPORTED_INTERVAL_MS[token]
        try:
            return int(float(token))
        except (TypeError, ValueError):
            return M20_MS

    @property
    def has_ssid(self) -> bool:
        return bool(self.ssid and self.ssid.strip())

    @property
    def num_symbols(self) -> int:
        return len(self.symbols)

    def assets(self) -> Dict[str, str]:
        """Return `{backend_symbol: po_asset}` mapping for all symbols."""
        return {s: asset_for_symbol(s) for s in self.symbols}

    def asset_types(self) -> Dict[str, str]:
        """Return `{backend_symbol: "otc"|"forex"|"crypto"}` classification."""
        return {s: asset_type_for_symbol(s) for s in self.symbols}


def load_settings(overrides: dict | None = None) -> BridgeSettings:
    base = BridgeSettings()
    if not overrides:
        return base
    merged = {k: v for k, v in vars(base).items()}
    for key, value in (overrides or {}).items():
        if value is not None:
            merged[key] = value
    return BridgeSettings(**merged)
