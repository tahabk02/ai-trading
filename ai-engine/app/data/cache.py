"""
cache.py

In-memory and Redis-backed cache layer for the AI Engine.
Provides a unified interface so callers don't need to know the backend.

This is used to:
  - Cache fetched OHLCV data to reduce exchange API calls.
  - Cache indicator calculations across repeated analyses.
  - Store temporary freeze states when Redis is unavailable.
"""

import time
import structlog
from typing import Dict, Any, Optional
from app.core.config import settings

logger = structlog.get_logger(__name__)


class InMemoryCache:
    """Simple TTL-based in-memory cache.

    Falls back gracefully if Redis is not configured.
    """

    def __init__(self):
        self._store: Dict[str, tuple[Any, float]] = {}  # {key: (value, expires_at)}
        logger.info("InMemoryCache initialised")

    def get(self, key: str) -> Optional[Any]:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if expires_at > 0 and time.time() > expires_at:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any, ttl_seconds: int = 300) -> None:
        expires_at = time.time() + ttl_seconds if ttl_seconds > 0 else 0
        self._store[key] = (value, expires_at)

    def delete(self, key: str) -> None:
        self._store.pop(key, None)

    def clear(self) -> None:
        self._store.clear()

    def has(self, key: str) -> bool:
        return self.get(key) is not None


class DataCache:
    """High-level cache for market data and computed indicators.

    Wraps InMemoryCache (or Redis in production) with domain-specific methods.
    """

    def __init__(self):
        self._cache = InMemoryCache()

    # ── OHLCV data ──

    def get_candles(self, symbol: str, interval: str) -> Optional[list]:
        return self._cache.get(f"candles:{symbol}:{interval}")

    def set_candles(self, symbol: str, interval: str, candles: list, ttl: int = 300) -> None:
        self._cache.set(f"candles:{symbol}:{interval}", candles, ttl)

    # ── Indicator results ──

    def get_indicators(self, symbol: str) -> Optional[Dict[str, float]]:
        return self._cache.get(f"indicators:{symbol}")

    def set_indicators(self, symbol: str, indicators: Dict[str, float], ttl: int = 120) -> None:
        self._cache.set(f"indicators:{symbol}", indicators, ttl)

    # ── Freeze state (news barrier) ──

    def get_freeze_until(self, symbol: str) -> float:
        val = self._cache.get(f"freeze:{symbol}")
        return float(val) if val is not None else 0.0

    def set_freeze(self, symbol: str, until_ts: float) -> None:
        self._cache.set(f"freeze:{symbol}", until_ts, ttl=7200)

    # ── Health ──

    def clear_all(self) -> None:
        self._cache.clear()
        logger.info("DataCache cleared")


# Singleton
data_cache = DataCache()

