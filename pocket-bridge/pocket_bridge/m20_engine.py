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
from collections import deque
from dataclasses import dataclass, field
from decimal import Decimal
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
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    closed: bool
    asset_type: str = "otc"           # "otc" | "forex" | "crypto"
    ts_utc: int = 0                   # bucket_start in epoch SECONDS (relay convenience)
    ts_ms: int = 0                    # exact bucket_close millisecond timestamp
    tick_count: int = 0
    volume: Optional[Decimal] = None
    is_gap: bool = False
    is_synthetic: bool = True
    is_otc: bool = True
    first_tick_ts: Optional[int] = None
    last_tick_ts: Optional[int] = None

    def to_dict(self) -> Dict:
        """Relay-ready dict with NUMBER primary fields + ``*_exact`` string
        (full Decimal precision) so the Node client's ``typeof price ===
        "number"`` contract never silently drops a frame (zero-drop L1)."""
        open_exact = format(self.open, "f")
        high_exact = format(self.high, "f")
        low_exact = format(self.low, "f")
        close_exact = format(self.close, "f")
        volume_exact = format(self.volume, "f") if self.volume is not None else None
        return {
            "symbol": self.symbol,
            "time": self.time,
            "open": float(open_exact),
            "high": float(high_exact),
            "low": float(low_exact),
            "close": float(close_exact),
            "open_exact": open_exact,
            "high_exact": high_exact,
            "low_exact": low_exact,
            "close_exact": close_exact,
            "closed": self.closed,
            "asset_type": self.asset_type,
            "ts_utc": self.ts_utc,
            "ts_ms": self.ts_ms,
            "tick_count": self.tick_count,
            "volume": float(volume_exact) if volume_exact is not None else None,
            "volume_exact": volume_exact,
            "is_gap": self.is_gap,
            "is_synthetic": self.is_synthetic,
            "is_otc": self.is_otc,
            "source": "pocket_option",
            "first_tick_ts": self.first_tick_ts,
            "last_tick_ts": self.last_tick_ts,
        }


@dataclass
class _Bucket:
    start_ms: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    tick_count: int = 0
    volume: Optional[Decimal] = None
    first_tick_ts: Optional[int] = None
    last_tick_ts: Optional[int] = None

    def update(self, price: Decimal, ts_ms: int, volume: Optional[Decimal]) -> None:
        self.high = max(self.high, price)
        self.low = min(self.low, price)
        self.close = price
        self.tick_count += 1
        self.last_tick_ts = ts_ms
        if volume is not None:
            self.volume = (self.volume or Decimal("0")) + volume

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
            tick_count=self.tick_count,
            volume=self.volume,
            is_otc=asset_type == "otc",
            first_tick_ts=self.first_tick_ts,
            last_tick_ts=self.last_tick_ts,
        )


@dataclass
class SymbolFeed:
    """Per-symbol accumulation state."""

    symbol: str
    interval_ms: int = M20_MS
    asset_type: str = "otc"
    current: Optional[_Bucket] = None
    last_valid_price: Optional[Decimal] = None
    last_valid_at: Optional[int] = None
    #: deque of the most recent closed candles, oldest first.
    history: List[M20Candle] = field(default_factory=list)
    max_history: int = 500
    reorder_ms: int = 3_000
    max_seen_ts: Optional[int] = None
    pending: List[tuple[int, Decimal, Optional[Decimal]]] = field(default_factory=list)
    seen_keys: deque[str] = field(default_factory=lambda: deque(maxlen=100_000))
    seen_lookup: set[str] = field(default_factory=set)
    finalized_before: Optional[int] = None

    def push_tick(
        self,
        price: Decimal,
        ts_ms: int,
        bid: Optional[Decimal] = None,
        ask: Optional[Decimal] = None,
        volume: Optional[Decimal] = None,
    ) -> List[M20Candle]:
        """Ingest one raw tick.

        Returns every candle that closed as a result of this tick (in order),
        or ``[]`` while the forming bucket is simply updated.
        """
        if price is None or price <= 0 or ts_ms <= 0:
            return None
        bid_key = format(bid, "f") if bid is not None else ""
        ask_key = format(ask, "f") if ask is not None else ""
        key = f"{ts_ms}|{format(price, 'f')}|{bid_key}|{ask_key}"
        if key in self.seen_lookup:
            return None
        if len(self.seen_keys) == self.seen_keys.maxlen:
            self.seen_lookup.discard(self.seen_keys[0])
        self.seen_keys.append(key)
        self.seen_lookup.add(key)
        self.max_seen_ts = max(self.max_seen_ts or ts_ms, ts_ms)
        self.pending.append((ts_ms, price, volume))
        self.pending.sort(key=lambda item: item[0])
        candles = self.flush_ready()
        # The hold MUST always reflect the newest accepted raw print,
        # independent of bucket state — a single sparse tick must still author
        # a held price so the handshake / forming-gap path is never starved
        # (zero-drop last-valid-price hold).
        self.last_valid_price = price
        self.last_valid_at = ts_ms
        return candles

    def flush_ready(self) -> List[M20Candle]:
        """Finalize every bucket whose close boundary the reorder watermark has
        cleared, in chronological order. Returns ALL candles that closed with
        this flush (zero-drop emit: a fast tape that advances through several
        buckets in one call must stream EVERY closed candle, not just the most
        recent one as the old single-return API did)."""
        if self.max_seen_ts is None:
            return []
        watermark = self.max_seen_ts - self.reorder_ms
        closed_candles: List[M20Candle] = []
        while self.pending and self.pending[0][0] <= watermark:
            ts_ms, price, volume = self.pending[0]
            bucket_start = (ts_ms // self.interval_ms) * self.interval_ms
            if self.finalized_before is not None and bucket_start < self.finalized_before:
                self.pending.pop(0)
                continue
            if self.current is None:
                self.pending.pop(0)
                self.current = _Bucket(
                    bucket_start, price, price, price, price,
                    tick_count=1,
                    volume=volume,
                    first_tick_ts=ts_ms,
                    last_tick_ts=ts_ms,
                )
                self.last_valid_price = price
                self.last_valid_at = ts_ms
                continue
            if bucket_start == self.current.start_ms:
                self.pending.pop(0)
                self.current.update(price, ts_ms, volume)
                self.last_valid_price = price
                self.last_valid_at = ts_ms
                continue
            if bucket_start < self.current.start_ms:
                self.pending.pop(0)
                continue
            if watermark <= self.current.start_ms + self.interval_ms:
                break
            closed_candle = self.current.to_candle(
                self.symbol, closed=True, asset_type=self.asset_type,
                interval_ms=self.interval_ms,
            )
            self._append_closed(closed_candle)
            self.finalized_before = self.current.start_ms + self.interval_ms
            self.current = None
            closed_candles.append(closed_candle)
        return closed_candles

    def _append_closed(self, candle: M20Candle) -> None:
        self.history.append(candle)
        if len(self.history) > self.max_history:
            del self.history[: len(self.history) - self.max_history]

    def forming_candle(self) -> Optional[M20Candle]:
        """Forming candle, falling back to held last-valid price on gaps.

        The close always equals the most recent valid tick price; when no new
        tick arrived since the window opened, ``close`` is the *held*
        previous valid price (never a static default).

        ZERO-DROP view: ticks still inside the reorder window (pending, not yet
        flushed into the open bucket) are merged into the forming candle for
        the same bucket — the newest prints are never hidden from the chart.
        """
        preview = self._preview_bucket()
        if preview is not None and (
            self.current is None or preview.start_ms >= self.current.start_ms
        ):
            return self._hold_render(
                preview.to_candle(
                    self.symbol,
                    closed=False,
                    asset_type=self.asset_type,
                    interval_ms=self.interval_ms,
                )
            )
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
                is_otc=self.asset_type == "otc",
            )
        candle = self.current.to_candle(
            self.symbol, closed=False, asset_type=self.asset_type,
            interval_ms=self.interval_ms,
        )
        return self._hold_render(candle)

    def _hold_render(self, candle: M20Candle) -> M20Candle:
        """Apply the held last-valid-price close onto a forming candle."""
        if self.last_valid_price is None:
            return candle
        return M20Candle(
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
            tick_count=candle.tick_count,
            volume=candle.volume,
            is_otc=self.asset_type == "otc",
            first_tick_ts=candle.first_tick_ts,
            last_tick_ts=candle.last_tick_ts,
        )

    def _preview_bucket(self) -> Optional[_Bucket]:
        if not self.pending:
            return None
        start_ms = (self.pending[0][0] // self.interval_ms) * self.interval_ms
        rows = [row for row in self.pending if (row[0] // self.interval_ms) * self.interval_ms == start_ms]
        if self.current is not None and self.current.start_ms == start_ms:
            rows = [(self.current.first_tick_ts or start_ms, self.current.open, self.current.volume)] + rows
        if not rows:
            return None
        first_ts, first_price, first_volume = rows[0]
        bucket = _Bucket(
            start_ms,
            first_price,
            first_price,
            first_price,
            first_price,
            tick_count=1,
            volume=first_volume,
            first_tick_ts=first_ts,
            last_tick_ts=first_ts,
        )
        for ts_ms, price, volume in rows[1:]:
            bucket.update(price, ts_ms, volume)
        return bucket

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
            "last_valid_price": (
                float(format(self.last_valid_price, "f"))
                if self.last_valid_price is not None else None
            ),
            "last_valid_price_exact": (
                format(self.last_valid_price, "f")
                if self.last_valid_price is not None else None
            ),
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

    def handle_tick(
        self,
        symbol: str,
        price: Decimal | str | float,
        ts_ms: int,
        bid: Decimal | str | float | None = None,
        ask: Decimal | str | float | None = None,
        volume: Decimal | str | float | None = None,
    ) -> Optional[M20Candle]:
        """Thread-safe ingest of one raw tick (single-candle view).

        Returns the LAST candle closed by this tick (or ``None``). Prefer
        :meth:`handle_tick_all` from real-time hot paths so every closed bucket
        is streamed, never just the most recent one.
        """
        candles = self.handle_tick_all(symbol, price, ts_ms, bid, ask, volume)
        return candles[-1] if candles else None

    def handle_tick_all(
        self,
        symbol: str,
        price: Decimal | str | float,
        ts_ms: int,
        bid: Decimal | str | float | None = None,
        ask: Decimal | str | float | None = None,
        volume: Decimal | str | float | None = None,
    ) -> List[M20Candle]:
        """Thread-safe ingest of one raw tick (zero-drop list view).

        Returns EVERY candle closed by this tick in chronological order so
        callers can relay the authoritative closed OHLC events in real time —
        a fast tape that crosses several bucket boundaries in one tick must
        emit each closed bucket, not only the last one.
        """
        feed = self.feeds.get(symbol)
        if feed is None:
            return []
        with self._lock:
            try:
                decimal_price = Decimal(str(price))
                decimal_bid = Decimal(str(bid)) if bid is not None else None
                decimal_ask = Decimal(str(ask)) if ask is not None else None
                decimal_volume = Decimal(str(volume)) if volume is not None else None
            except Exception:
                return []
            return feed.push_tick(
                decimal_price,
                int(ts_ms),
                decimal_bid,
                decimal_ask,
                decimal_volume,
            )

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
            feed.last_valid_price = Decimal(str(price))
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
