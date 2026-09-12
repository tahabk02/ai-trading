"""Configurable candle aggregation engine with strict last-valid-price hold.

This is the core of the Pocket Option bridge. It consumes raw, real-time
ticks and buckets them into configurable time windows using the exact formula:

    bucket_start = (timestamp // interval_ms) * interval_ms

Supported intervals:
    20ms  — micro-tick (ultra-fast binary options micro-moves)
    100ms — sub-second
    1s    — second candles
    20s   — default M20 (Pocket Option style)
    1m    — 1-minute candles
    2m    — 2-minute candles
    3m    — 3-minute candles
    5m    — 5-minute candles

Timestamps are aligned to Pocket Option server time by subtracting
``PLATFORM_TIME_OFFSET`` (7200s) before bucketing.

Last-valid-price hold semantics:
    If no new tick arrives inside the current window, the candle's
    close (and the streamed "live price") is held at the most recent *valid*
    tick price instead of collapsing to a static default.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .config import M20_MS, PLATFORM_TIME_OFFSET


# ── Supported candle intervals (timeframe string → milliseconds) ──
SUPPORTED_INTERVALS: Dict[str, int] = {
    "20ms": 20,
    "100ms": 100,
    "1s": 1_000,
    "20s": M20_MS,           # default Pocket Option M20
    "1m": 60_000,
    "2m": 120_000,
    "3m": 180_000,
    "5m": 300_000,
}

DEFAULT_INTERVAL_MS = M20_MS


@dataclass(frozen=True)
class M20Candle:
    """A closed or forming candle (fields in the relay schema)."""

    symbol: str
    time: int                         # bucket_start in epoch MILLISECONDS
    open: float
    high: float
    low: float
    close: float
    closed: bool
    asset_type: str = "otc"           # "otc" | "forex" | "crypto"
    ts_utc: int = 0                   # bucket_start in epoch SECONDS (relay convenience)
    ts_ms: int = 0                    # exact bucket_close millisecond timestamp

    def to_dict(self) -> Dict:
        return {
            "symbol": self.symbol,
            "time": self.time,
            "open": round(self.open, 8),
            "high": round(self.high, 8),
            "low": round(self.low, 8),
            "close": round(self.close, 8),
            "closed": self.closed,
            "asset_type": self.asset_type,
            "ts_utc": self.ts_utc,
            "ts_ms": self.ts_ms,
        }


@dataclass
class _Bucket:
    start_ms: int
    open: float
    high: float
    low: float
    close: float

    def update(self, price: float) -> None:
        self.high = max(self.high, price)
        self.low = min(self.low, price)
        self.close = price

    def to_candle(self, symbol: str, closed: bool, asset_type: str = "otc", interval_ms: int = M20_MS) -> M20Candle:
        return M20Candle(
            symbol=symbol,
            time=self.start_ms,
            open=self.open,
            high=self.high,
            low=self.low,
            close=self.close,
            closed=closed,
            asset_type=asset_type,
            ts_utc=self.start_ms // 1000,
            ts_ms=self.start_ms + interval_ms,  # exact bucket-close ms boundary
        )


@dataclass
class SymbolFeed:
    """Per-symbol accumulation state."""

    symbol: str
    interval_ms: int = M20_MS
    asset_type: str = "otc"
    current: Optional[_Bucket] = None
    last_valid_price: Optional[float] = None
    last_valid_at: Optional[int] = None
    #: deque of the most recent closed candles, oldest first.
    history: List[M20Candle] = field(default_factory=list)
    max_history: int = 500

    def push_tick(self, price: float, ts_ms: int) -> Optional[M20Candle]:
        """Ingest one raw tick.

        Returns the candle that just closed (if the tick advanced to a new
        bucket), or ``None`` while the forming bucket is simply updated.
        """
        if price is None or price <= 0:
            return None
        bucket_start = (ts_ms // self.interval_ms) * self.interval_ms

        if self.current is None:
            self.current = _Bucket(bucket_start, price, price, price, price)
        elif bucket_start > self.current.start_ms:
            closed_candle = self.current.to_candle(
                self.symbol, closed=True, asset_type=self.asset_type,
                interval_ms=self.interval_ms,
            )
            self._append_closed(closed_candle)
            self.current = _Bucket(bucket_start, price, price, price, price)
            self.last_valid_price = price
            self.last_valid_at = ts_ms
            return closed_candle
        elif bucket_start == self.current.start_ms:
            self.current.update(price)
        else:
            # Out-of-order / late tick for an already-closed window: ignore
            # for the forming candle but still refresh the valid-price hold.
            self.last_valid_price = price
            self.last_valid_at = ts_ms
            return None

        self.last_valid_price = price
        self.last_valid_at = ts_ms
        return None

    def _append_closed(self, candle: M20Candle) -> None:
        self.history.append(candle)
        if len(self.history) > self.max_history:
            del self.history[: len(self.history) - self.max_history]

    def forming_candle(self) -> Optional[M20Candle]:
        """Forming candle, falling back to held last-valid price on gaps.

        The close always equals the most recent valid tick price; when no new
        tick arrived since the window opened, ``close`` is the *held*
        previous valid price (never a static default).
        """
        if self.current is None:
            if self.last_valid_price is None or self.last_valid_at is None:
                return None
            # No open bucket yet but we have a valid held price.
            # Use last_valid_at (PO-adjusted) to stay on the same grid as ticks.
            start_ms = (self.last_valid_at // self.interval_ms) * self.interval_ms
            return M20Candle(
                symbol=self.symbol,
                time=start_ms,
                open=self.last_valid_price,
                high=self.last_valid_price,
                low=self.last_valid_price,
                close=self.last_valid_price,
                closed=False,
                asset_type=self.asset_type,
                ts_utc=start_ms // 1000,
                ts_ms=start_ms + self.interval_ms,
            )
        candle = self.current.to_candle(
            self.symbol, closed=False, asset_type=self.asset_type,
            interval_ms=self.interval_ms,
        )
        if self.last_valid_price is not None:
            candle = M20Candle(
                symbol=candle.symbol,
                time=candle.time,
                open=candle.open,
                high=candle.high,
                low=candle.low,
                close=self.last_valid_price,
                closed=False,
                asset_type=self.asset_type,
                ts_utc=candle.ts_utc,
                ts_ms=candle.ts_ms,
            )
        return candle

    def snapshot(self) -> Dict:
        """Relay-ready snapshot: closed history + forming candle + held price."""
        closed = [c.to_dict() for c in self.history]
        forming = self.forming_candle()
        return {
            "symbol": self.symbol,
            "asset_type": self.asset_type,
            "interval_ms": self.interval_ms,
            "closed_candles": closed,
            "forming": forming.to_dict() if forming else None,
            "last_valid_price": self.last_valid_price,
            "last_valid_at": self.last_valid_at,
        }


class M20Engine:
    """Thread-safe aggregation engine across all subscribed symbols."""

    def __init__(
        self,
        symbols: List[str],
        max_history: int = 500,
        interval_ms: int = M20_MS,
        asset_types: Optional[Dict[str, str]] = None,
    ) -> None:
        self.interval_ms = interval_ms
        self.max_history = max_history
        self.asset_types: Dict[str, str] = asset_types or {}
        self.feeds: Dict[str, SymbolFeed] = {}
        for symbol in symbols:
            self.feeds[symbol] = SymbolFeed(
                symbol=symbol,
                interval_ms=interval_ms,
                asset_type=self.asset_types.get(symbol, "otc"),
                max_history=max_history,
            )
        self._lock = threading.RLock()

    def ensure_feed(self, symbol: str, asset_type: str = "otc") -> SymbolFeed:
        """Register a per-symbol feed on demand (idempotent).

        The bridge arms subscriptions DYNAMICALLY (the initial-handshake
        subscription push can target any whitelisted pair, not just the static
        startup set), so a symbol outside ``symbols`` must be registered HERE
        before its ticks can be bucketed or held. An existing feed (with its
        live bucket state) is returned untouched.
        """
        with self._lock:
            feed = self.feeds.get(symbol)
            if feed is None:
                feed = SymbolFeed(
                    symbol=symbol,
                    interval_ms=self.interval_ms,
                    asset_type=asset_type or "otc",
                    max_history=self.max_history,
                )
                self.feeds[symbol] = feed
                self.asset_types[symbol] = feed.asset_type
            return feed

    def set_interval(self, interval_ms: int) -> None:
        """Reset the aggregation interval on all feeds (re-bucket starts fresh).

        A timeframe switch through the selector matrix must not carry stale
        buckets across widths — each feed drops its forming bucket and reopens
        on the next tick at the new width's exact boundary.
        """
        if interval_ms <= 0:
            return
        with self._lock:
            self.interval_ms = interval_ms
            for feed in self.feeds.values():
                feed.interval_ms = interval_ms
                feed.current = None

    def handle_tick(self, symbol: str, price: float, ts_ms: int) -> Optional[M20Candle]:
        """Thread-safe ingest of one raw tick for a symbol.

        Returns the candle that just closed on bucket rollover (or ``None``
        while the forming bucket is simply updated) so callers can relay the
        authoritative closed OHLC event in real time — not only via snapshots.
        """
        feed = self.feeds.get(symbol)
        if feed is None:
            return None
        with self._lock:
            return feed.push_tick(price, ts_ms)

    def handle_gap(self, symbol: str, ts_ms: int) -> Optional[M20Candle]:
        """Return the current forming candle so downstream holds last price.

        Called periodically even with no incoming ticks so the relay keeps a
        fresh (held) close instead of going stale. Returns the forming candle
        (or ``None`` if the symbol is unknown / nothing to hold), letting the
        caller forward it without polling ``forming`` separately.
        """
        feed = self.feeds.get(symbol)
        if feed is None:
            return None
        with self._lock:
            return feed.forming_candle()

    def hold_price(self, symbol: str, price: float, ts_ms: int) -> None:
        feed = self.feeds.get(symbol)
        if feed is None:
            return
        with self._lock:
            feed.last_valid_price = price
            feed.last_valid_at = ts_ms

    def forming(self, symbol: str) -> Optional[M20Candle]:
        feed = self.feeds.get(symbol)
        if feed is None:
            return None
        with self._lock:
            return feed.forming_candle()

    def snapshot(self, symbol: str) -> Optional[Dict]:
        feed = self.feeds.get(symbol)
        if feed is None:
            return None
        with self._lock:
            return feed.snapshot()

    def snapshots(self) -> List[Dict]:
        with self._lock:
            return [f.snapshot() for f in self.feeds.values()]

    @property
    def symbols(self) -> List[str]:
        return list(self.feeds.keys())
