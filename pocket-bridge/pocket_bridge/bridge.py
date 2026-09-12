"""Pocket Option live feed bridge.

Establishes an authenticated connection using BinaryOptionsToolsV2
(``PocketOptionAsync``), subscribes to raw live ticks via
``subscribe_symbol``, aligns timestamps to Pocket Option server time
(``PLATFORM_TIME_OFFSET``), feeds the M20 aggregation engine, and exposes the
cleaned result to the relay.

No SSID: the bridge runs in a clean "awaiting SSID" state rather than
fabricating prices. If ``POCKET_OPTION_SSID`` is unset the connection simply
never authenticates and the relay reports ``status: awaiting_ssid``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from decimal import Decimal
from typing import Dict, Optional, Tuple

from .config import (
    BridgeSettings,
    asset_candidates,
    asset_for_symbol,
    asset_type_for_symbol,
    canonical_symbol,
)
from .m20_engine import M20Engine, M20Candle

logger = logging.getLogger("pocket_bridge.bridge")


class ModuleUnavailableError(Exception):
    """Raised when an optional third-party dependency (BinaryOptionsToolsV2)
    needed for live PO ticks is missing or broken.

    This is a permanent, non-retryable condition (reconnecting cannot install a
    package) — the reader loops catch it and PAUSE in a clean degraded state
    instead of spinning in an endless reconnect loop.
    """

    def __init__(self, message: str, install_hint: str) -> None:
        super().__init__(message)
        self.install_hint = install_hint


class AssetSkippedError(Exception):
    """Raised when a single configured symbol can NOT be subscribed because the
    broker has no matching asset (e.g. ``Invalid asset: GBPCHF_otc``).

    This is a permanent, per-symbol condition: the reader for that symbol
    stops (no endless retry) while all other symbols keep streaming, and the
    bridge does NOT enter a global ``connection_error`` state.
    """

    def __init__(self, symbol: str, candidates: list[str]) -> None:
        super().__init__(
            f"no Pocket Option asset available for {symbol} "
            f"(tried candidates: {', '.join(candidates)})"
        )
        self.symbol = symbol
        self.candidates = candidates


def parse_quote(
    payload: Dict,
    now_ms: Optional[int] = None,
    validate_window: bool = True,
) -> Optional[Dict[str, object]]:
    """Normalize and validate one Pocket Option quote in UTC milliseconds."""
    if not isinstance(payload, dict):
        return None

    received_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    raw_ts = payload.get("timestamp", payload.get("time"))
    timestamp_fallback = raw_ts is None
    try:
        ts_ms = received_ms if timestamp_fallback else int(float(raw_ts))
    except (TypeError, ValueError, OverflowError):
        return None
    if ts_ms < 10_000_000_000:
        ts_ms *= 1000
    if validate_window and (ts_ms > received_ms + 2_000 or ts_ms < received_ms - 10_000):
        return None

    def decimal_value(*keys: str) -> Optional[Decimal]:
        for key in keys:
            value = payload.get(key)
            if value is not None:
                try:
                    parsed = Decimal(str(value))
                except Exception:
                    return None
                if not parsed.is_finite() or parsed <= 0:
                    return None
                return parsed
        return None

    bid = decimal_value("bid")
    ask = decimal_value("ask")
    price = decimal_value("mid", "close", "price")
    if bid is not None and ask is not None:
        if bid > ask:
            return None
        price = (bid + ask) / Decimal("2")
    if price is None or price <= 0:
        return None
    if bid is None:
        bid = price
    if ask is None:
        ask = price

    volume = decimal_value("volume", "qty")
    return {
        "ts_ms": ts_ms,
        "price": format(price, "f"),
        "bid": format(bid, "f"),
        "ask": format(ask, "f"),
        "volume": format(volume, "f") if volume is not None else None,
        "timestamp_fallback": timestamp_fallback,
        "synthetic_quote": bid == ask,
        "latency_ms": max(0, received_ms - ts_ms),
    }


def parse_tick(payload: Dict, now_ms: Optional[int] = None) -> Optional[Tuple[int, float]]:
    """Extract ``(timestamp_ms, price)`` from a raw PO tick dict.

    The library's raw ticks carry either ``close``/``price`` and
    ``timestamp``/``time`` keys. Values are float prices and epoch
    milliseconds. Returns ``None`` if the tick cannot be parsed.
    """
    if not isinstance(payload, dict) or payload.get("timestamp", payload.get("time")) is None:
        return None
    quote = parse_quote(payload, now_ms, validate_window=now_ms is not None)
    if quote is None:
        return None
    return int(quote["ts_ms"]), float(quote["price"])


class PocketOptionBridge:
    """Wraps the PO client, per-symbol raw tick readers, and the callback API
    the relay uses to publish updates."""

    def __init__(
        self,
        settings: BridgeSettings,
        engine: M20Engine,
    ) -> None:
        self.settings = settings
        self.engine = engine
        self.client = None
        self._subs: Dict[str, object] = {}
        self._tasks: list = []
        self._assets: Dict[str, str] = {}
        self.status = "awaiting_ssid"
        self.last_error: Optional[str] = None
        self.connected_at: Optional[float] = None
        #: server-authoritative asset symbols fetched from active_assets(), or
        #: None if the list could not be loaded (subscribe-error fallback then).
        self._available_assets: Optional[set[str]] = None
        #: True once the PO client is authenticated AND the authoritative asset
        #: list has been loaded. The relay broadcasts a ``ready`` frame based on
        #: this so the Node backend can safely release its staged subscribes.
        self._assets_ready = False
        #: configured symbols permanently skipped (broker has no matching asset).
        self._skipped: Dict[str, str] = {}
        #: callbacks: on_tick(payload_dict), on_candle(candle), on_status(status)
        self.on_tick = None
        self.on_candle = None
        self.on_status = None
        #: async callback () -> None invoked once the bridge is ready (PO client
        #: authenticated + asset list loaded). Wired by the entrypoint to emit
        #: the relay ``ready`` frame the Node backend gates its subscribes on.
        self.on_ready = None
        #: real-time tick validation state per symbol
        self._last_tick_ts: Dict[str, float] = {}
        self._last_tick_price: Dict[str, float] = {}
        self._tick_count: Dict[str, int] = {}
        self._last_log_ts: Dict[str, float] = {}

    @property
    def is_connected(self) -> bool:
        return self.client is not None and bool(self.client.is_connected())

    @property
    def assets_ready(self) -> bool:
        """True once the PO client is authenticated and the authoritative asset
        list is loaded — the relay only signals ``ready`` when this is set."""
        return self._assets_ready

    # Highest-priority optional dependency; used in the clean actionable message
    # emitted when it is missing (never auto-installed, never retried in a loop).
    def _dependency_install_hint(self) -> str:
        return (
            "Install the Pocket Option library with:  "
            "python -m pip install 'BinaryOptionsToolsV2==0.2.14'  "
            "(from the .venv-1 virtualenv). Run pocket-bridge\\verify_env.py to "
            "pre-flight the environment."
        )

    async def _set_status(self, status: str, error: Optional[str] = None) -> None:
        self.status = status
        self.last_error = error
        logger.info("bridge status -> %s%s", status, f" ({error})" if error else "")
        cb = self.on_status
        if cb is not None:
            await cb({"status": status, "error": error})

    async def _mark_ready(self) -> None:
        """Flip the assets-ready flag and notify the relay — idempotent.

        Emitted ONLY after the PO client is authenticated AND the authoritative
        asset list has been loaded, so the Node backend knows it is safe to
        release the subscribes it has staged instead of racing startup.
        """
        if self._assets_ready:
            return
        self._assets_ready = True
        logger.info("bridge ready — PO client authenticated & assets initialised")
        cb = self.on_ready
        if cb is not None:
            await cb()

    async def _import_client(self):
        if self.client is not None:
            return self.client
        self._check_dependency()
        from BinaryOptionsToolsV2.pocketoption import PocketOptionAsync  # noqa: E402
        kwargs = {}
        if self.settings.urls:
            kwargs["url"] = self.settings.urls[0]
        if len(self.settings.urls) > 1:
            kwargs["config"] = {"urls": self.settings.urls}
        self.client = PocketOptionAsync(self.settings.ssid, **kwargs)
        return self.client

    def _check_dependency(self) -> None:
        """Import (without instantiating) the PO dependency.

        Raises :class:`ModuleUnavailableError` when the package is missing or
        broken so callers can degrade cleanly instead of hot-retrying.
        """
        try:
            from BinaryOptionsToolsV2.pocketoption import (  # noqa: F401
                PocketOptionAsync,
            )
        except ImportError as exc:  # module missing / broken install
            hint = self._dependency_install_hint()
            logger.error("Pocket Option library unavailable: %s. %s", exc, hint)
            raise ModuleUnavailableError(str(exc), hint) from exc

    async def _log_tick(self, symbol: str, price: float, ts_ms: int) -> None:
        """Log every raw tick (DEBUG) with a throttled INFO summary, and flag
        any suspicious static / delayed / duplicative price.

        This is the real-time price validation probe: it proves live ticks are
        actually arriving from Pocket Option (not stuck / cached), shows the exact
        unformatted float, and warns when a price appears frozen or delayed.
        """
        now = time.time()
        prev_ts = self._last_tick_ts.get(symbol)
        prev_price = self._last_tick_price.get(symbol)
        self._last_tick_ts[symbol] = now
        self._last_tick_price[symbol] = price
        self._tick_count[symbol] = self._tick_count.get(symbol, 0) + 1
        count = self._tick_count[symbol]

        if prev_ts is not None:
            gap_s = now - prev_ts
            if gap_s > 2.0:
                logger.warning(
                    "TICK STALL [%s] gap=%.1fs since last tick (price=%.8f) — "
                    "feed may be stalled or delayed",
                    symbol, gap_s, price,
                )
            if prev_price is not None and price == prev_price:
                logger.warning(
                    "TICK STATIC [%s] #%d price unchanged=%.8f — verifying liveness",
                    symbol, count, price,
                )

        # Throttle the INFO line to ~5/s per symbol to avoid log flooding while
        # still proving continuous real-time arrival; every tick is at DEBUG.
        prev_log = self._last_log_ts.get(symbol)
        if prev_log is None or (now - prev_log) >= 0.2:
            self._last_log_ts[symbol] = now
            logger.info(
                "TICK [%s] #%d price=%.8f ts_ms=%d (raw float, unformatted)",
                symbol, count, price, ts_ms,
            )
        else:
            logger.debug(
                "TICK [%s] #%d price=%.8f ts_ms=%d (raw float, unformatted)",
                symbol, count, price, ts_ms,
            )

    async def _load_available_assets(self, client) -> Optional[set[str]]:
        """Fetch the session's server-authoritative asset symbols (cached).

        Uses ``PocketOptionAsync.active_assets()`` — the exact list the broker
        validates subscriptions against — so we can skip unsupported pairs
        BEFORE attempting ``subscribe_symbol``. Returns ``None`` when the list
        cannot be loaded (subscription itself then decides and falls back).
        """
        if self._available_assets is not None:
            return self._available_assets
        try:
            active = await asyncio.wait_for(
                client.active_assets(),
                timeout=self.settings.connect_timeout,
            )
        except Exception as exc:  # noqa: BLE001 - asset list is best-effort
            logger.warning(
                "active_assets() unavailable (%s) — resolving assets via "
                "subscribe_symbol error handling instead", exc,
            )
            return None
        symbols = {
            a.get("symbol")
            for a in active
            if isinstance(a, dict) and a.get("symbol") and a.get("is_active", True)
        }
        self._available_assets = symbols or None
        return self._available_assets

    async def _resolve_asset(self, client, symbol: str) -> Optional[str]:
        """Return the first PO asset for ``symbol`` the broker actually lists.

        Walks :func:`asset_candidates` (OTC form first, then the bare pair)
        against the session's available assets. Without an authoritative list
        the primary candidate is returned so the subscribe error handler can
        distinguish an invalid asset and skip it cleanly.
        """
        candidates = list(asset_candidates(symbol))
        available = await self._load_available_assets(client)
        if available:
            for cand in candidates:
                if cand in available:
                    return cand
            return None
        return candidates[0]

    async def _is_invalid_asset_error(self, exc: Exception) -> bool:
        """True when the client reports an unknown/unsupported asset name."""
        return "invalid asset" in str(exc).lower()

    async def run_reader(self, symbol: str, asset: str) -> None:
        """Subscribe to raw ticks for one asset and feed the M20 engine.

        The broker's own asset list is consulted first: if no candidate for
        this symbol exists (e.g. ``Invalid asset: GBPCHF_otc``) the reader
        raises :class:`AssetSkippedError` — one unsupported pair must never
        flip the whole bridge into ``connection_error`` or stop the pairs that
        DO work (EUR/USD, USD/CHF, ...).
        """
        if not self.settings.has_ssid:
            # Clean "awaiting_ssid" state: no client, no fabricated prices.
            await self._set_status("awaiting_ssid",
                                   "POCKET_OPTION_SSID not set; refusing to fabricate prices")
            return
        await self._ensure_connected()
        client = await self._import_client()
        if not self.is_connected:
            return
        resolved = await self._resolve_asset(client, symbol)
        if resolved is None:
            candidates = list(asset_candidates(symbol))
            logger.warning(
                "SKIP [%s] broker has no asset among candidates %s — "
                "not subscribing, keeping other pairs running",
                symbol, candidates,
            )
            self._skipped[symbol] = ",".join(candidates)
            raise AssetSkippedError(symbol, candidates)
        if resolved != asset:
            logger.info(
                "asset[%s] resolved %s -> %s (authoritative broker list)",
                symbol, asset, resolved,
            )
            asset = resolved
        try:
            stream = await client.subscribe_symbol(asset)
        except Exception as exc:  # noqa: BLE001
            if await self._is_invalid_asset_error(exc):
                logger.warning(
                    "SKIP [%s] asset '%s' rejected by broker (%s) — not "
                    "retrying, keeping other pairs running", symbol, asset, exc,
                )
                self._skipped[symbol] = asset
                raise AssetSkippedError(symbol, [asset]) from exc
            logger.error("subscribe_symbol(%s) failed: %s", asset, exc)
            await self._set_status("connection_error", str(exc))
            return
        self._subs[symbol] = stream
        async for tick in stream:
            quote = parse_quote(tick)
            if quote is None:
                logger.debug("TICK [%s] unparseable, skipping: %r", symbol, tick)
                continue
            ts_ms = int(quote["ts_ms"])
            price = Decimal(str(quote["price"]))
            bid = Decimal(str(quote["bid"]))
            ask = Decimal(str(quote["ask"]))
            volume = quote["volume"]
            await self._log_tick(symbol, price, ts_ms)
            closed = self.engine.handle_tick(symbol, price, ts_ms, bid, ask, volume)
            if closed is not None and self.on_candle is not None:
                # Emit the authoritative closed-candle event in real time (on
                # bucket rollover), not only inside reconnect snapshots.
                await self.on_candle(closed)
            cb = self.on_tick
            if cb is not None:
                await cb(
                    {
                        "symbol": symbol,
                        "asset": asset,
                        "asset_type": asset_type_for_symbol(symbol),
                        "price": quote["price"],
                        "bid": quote["bid"],
                        "ask": quote["ask"],
                        "mid": quote["price"],
                        "volume": quote["volume"],
                        "ts_ms": ts_ms,
                        "ts_utc": ts_ms // 1000,
                        "source": "pocket_option",
                        "is_otc": asset_type_for_symbol(symbol) == "otc",
                        "is_synthetic": True,
                        "synthetic_quote": quote["synthetic_quote"],
                        "timestamp_fallback": quote["timestamp_fallback"],
                        "latency_ms": quote["latency_ms"],
                        "raw": dict(tick) if isinstance(tick, dict) else None,
                    }
                )

    async def request_subscription(self, symbol: str) -> Dict:
        """FORCE INITIAL TICK HANDSHAKE — dynamically arm a live PO stream.

        When the backend pushes an active subscription for a selected symbol
        (browser "SYNCHRONISÉ" -> Socket.IO join -> relay subscribe frame), this
        guarantees that symbol's tick reader is LIVE even if it is NOT part of
        the static startup set: a dedicated reader is spawned on demand through
        the exact same reconnect-aware loop as the configured pairs.

        Idempotent — a symbol already streaming (static start or a prior dynamic
        request) is confirmed with its current engine snapshot and is NEVER
        double-read.

        Returns a relay-ready ``subscribed`` payload:
            {status, symbol, asset, asset_type, last_valid_price,
             last_valid_at, closed_candles, forming}
        ``status`` is ``subscribed`` (armed), ``awaiting_ssid`` (no live feed
        possible) or ``subscribe_error`` (indecipherable symbol).
        """
        canonical = canonical_symbol(symbol)
        base: Dict = {
            "status": "subscribed",
            "symbol": canonical,
            "asset": None,
            "asset_type": asset_type_for_symbol(canonical),
            "last_valid_price": None,
            "last_valid_at": None,
            "closed_candles": [],
            "forming": None,
        }
        if not canonical or "/" not in canonical:
            return {**base, "status": "subscribe_error",
                    "error": f"cannot resolve symbol {symbol!r}"}

        if not self.settings.has_ssid:
            return {
                **base,
                "status": "awaiting_ssid",
                "error": "POCKET_OPTION_SSID not set; refusing to fabricate prices",
            }

        # Already streaming (configured pair or a prior dynamic armed reader).
        if canonical in self._subs:
            snap = self.engine.snapshot(canonical) or {}
            return {
                **base,
                "asset": self._assets.get(canonical),
                "status": "subscribed",
                "last_valid_price": snap.get("last_valid_price"),
                "last_valid_at": snap.get("last_valid_at"),
                "closed_candles": snap.get("closed_candles", []),
                "forming": snap.get("forming"),
            }

        # WAIT until the PO client is authenticated AND the asset list is loaded
        # before arming a NEW reader. Otherwise the reader's very first
        # subscribe attempt races active_assets()/asset resolution while assets
        # are still initialising ("Uninitialized, Assets not initialized yet.")
        if not self.is_connected:
            await self._ensure_connected()
        if not self.is_connected:
            return {
                **base,
                "status": "subscribe_error",
                "error": "Pocket Option bridge not connected — cannot arm subscription",
            }

        # Dynamically register the feed + spawn a dedicated reader for it.
        self.engine.ensure_feed(canonical, asset_type_for_symbol(canonical))
        asset = self._assets.setdefault(canonical, asset_for_symbol(canonical))
        base["asset"] = asset
        self._tasks.append(asyncio.create_task(self._reader_loop(canonical, asset)))
        logger.info(
            "subscription push [%s] -> asset %s armed (dynamic reader started)",
            canonical, asset,
        )
        await self._set_status("connected",
                               f"subscription armed for {canonical}")
        return base

    async def _ensure_connected(self) -> None:
        if self.is_connected:
            return
        if not self.settings.has_ssid:
            await self._set_status("awaiting_ssid",
                                   "POCKET_OPTION_SSID not set; refusing to fabricate prices")
            return
        client = await self._import_client()
        try:
            # PocketOptionAsync connects on construction and keeps the session
            # alive with its internal 20s Socket.IO ping. wait_for_assets
            # guarantees the asset list is ready before we subscribe.
            await asyncio.wait_for(
                client.wait_for_assets(timeout=self.settings.connect_timeout),
                timeout=self.settings.connect_timeout,
            )
        except Exception as exc:  # noqa: BLE001
            await self._set_status("connection_error", str(exc))
            return
        if self.is_connected:
            self.connected_at = time.time()
            # Load the authoritative asset list NOW, while the client is
            # guaranteed authenticated, so no later active_assets() call can hit
            # the "Uninitialized, Assets not initialized yet" transient — every
            # reader consumes the warm cache instead of re-querying mid-flight.
            await self._load_available_assets(client)
            await self._set_status("connected")
            await self._mark_ready()
        else:
            await self._set_status("disconnected")

    async def start(self) -> None:
        """Launch all per-symbol raw tick readers with reconnect handling.

        Before spawning readers, verify the optional PO dependency is importable.
        If it is missing, transition the whole bridge to a clean degraded state
        (relay stays up, backend stays online) instead of entering an endless
        retry loop — the platform remains fully operational without live ticks.
        """
        self._assets = self.settings.assets()
        if self.settings.has_ssid:
            try:
                self._check_dependency()
            except ModuleUnavailableError as exc:
                # Dependency permanently unavailable: pause ALL readers cleanly.
                await self._set_status(
                    "connection_error",
                    f"BinaryOptionsToolsV2 unavailable — {exc.install_hint}",
                )
                logger.warning(
                    "Pocket Option bridge degraded: %s. %s",
                    exc, exc.install_hint,
                )
                return
            await self._set_status("connecting")
        else:
            await self._set_status("awaiting_ssid")

        for symbol, asset in self._assets.items():
            self._tasks.append(asyncio.create_task(self._reader_loop(symbol, asset)))

    async def _reader_loop(self, symbol: str, asset: str) -> None:
        if not self.settings.has_ssid:
            # start() already emitted awaiting_ssid. Sit idle so adding an SSID
            # and restarting connects without spamming per-symbol status.
            return
        delay = self.settings.reconnect_delay
        while True:
            try:
                await self.run_reader(symbol, asset)
            except asyncio.CancelledError:
                raise
            except AssetSkippedError as exc:
                # Permanent per-symbol condition: stop this reader so the pair
                # is not retried forever, but do NOT degrade globally for a
                # single valid pair. Only if EVERY configured symbol is skipped
                # (nothing can stream) is that surfaced as connection_error.
                logger.warning(
                    "reader(%s) stopped: %s — this symbol is skipped; "
                    "other pairs continue streaming", symbol, exc,
                )
                if len(self._skipped) == len(self._assets) and self.status != "connected":
                    await self._set_status(
                        "connection_error",
                        f"No Pocket Option assets available for any configured "
                        f"symbol: {', '.join(sorted(self._skipped)) or 'n/a'}",
                    )
                return
            except ModuleUnavailableError as exc:
                # Permanent dependency failure — PAUSE, never hot-loop. Emit ONE
                # consolidated status the relay/backend surfaces to the UI, then
                # sleep on a long stable cadence so the process stays alive and
                # the rest of the platform remains fully operational.
                logger.error("reader(%s) paused: missing dependency — %s", symbol, exc)
                await self._set_status(
                    "connection_error",
                    f"BinaryOptionsToolsV2 unavailable — {exc.install_hint}",
                )
                await asyncio.sleep(self.settings.reconnect_max_delay)
                continue
            except Exception as exc:  # noqa: BLE001 - reconnect forever
                # Genuine crash (network loss, malformed stream, ...): back off
                # geometrically, bounded by reconnect_max_delay — but NEVER
                # permanently stall, so a plate that recovers is still picked up.
                logger.warning("reader(%s) crashed: %s", symbol, exc)
                await self._set_status("connection_error", str(exc))
                await asyncio.sleep(delay)
                delay = min(delay * 2, self.settings.reconnect_max_delay)
                continue
            # run_reader returned CLEANLY — that is a NORMAL disconnect / stop
            # (no exception, e.g. broker stream ended or session dropped).
            # Reconnect IMMEDIATELY at the base cadence and RESET the backoff so
            # the bridge never lingers in the "stuck at 60s forever" state after
            # a transient drop: reconnect is instant and self-healing.
            await asyncio.sleep(self.settings.reconnect_delay)
            delay = self.settings.reconnect_delay

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()
        self._assets_ready = False
        self._available_assets = None
        if self.client is not None:
            try:
                await self.client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self.client = None
        await self._set_status("stopped")
