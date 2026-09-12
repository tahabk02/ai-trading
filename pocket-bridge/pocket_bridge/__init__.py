"""Pocket Option live data bridge for the trading platform."""

__version__ = "1.0.0"

from .config import (
    M20_MS,
    PLATFORM_TIME_OFFSET,
    SUPPORTED_INTERVAL_MS,
    OTC_FOREX_SYMBOLS,
    CRYPTO_SYMBOLS,
    asset_type_for_symbol,
    asset_for_symbol,
    asset_candidates,
    BridgeSettings,
    load_settings,
)
from .m20_engine import M20Candle, M20Engine, SUPPORTED_INTERVALS, DEFAULT_INTERVAL_MS

__all__ = [
    "M20_MS",
    "PLATFORM_TIME_OFFSET",
    "SUPPORTED_INTERVAL_MS",
    "SUPPORTED_INTERVALS",
    "DEFAULT_INTERVAL_MS",
    "OTC_FOREX_SYMBOLS",
    "CRYPTO_SYMBOLS",
    "asset_type_for_symbol",
    "asset_for_symbol",
    "asset_candidates",
    "BridgeSettings",
    "load_settings",
    "M20Candle",
    "M20Engine",
]
