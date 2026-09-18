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
import sys
import time
from decimal import Decimal
from pathlib import Path
from typing import Dict, Optional, Tuple

from .config import (
    BridgeSettings,
    StoredSession,
    asset_candidates,
    asset_for_symbol,
    asset_type_for_symbol,
    canonical_active_asset,
    auth_message,
    canonical_symbol,
    load_stored_session,
    mask_secret,
    parse_ssid,
    read_env_ssid,
    session_reload_needed,
)
from .m20_engine import M20Engine, M20Candle

logger = logging.getLogger("pocket_bridge.bridge")
DEFAULT_PO_WS_URL = "wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket"

#: Fresh PocketOptionAsync attempts before a repeat auth failure is treated as
#: a TERMINAL expired/invalid SSID (instead of a transient transport drop).
#: Each retry constructs a brand-new client (auths on construction), so a
#: momentary network blip self-heals without ever spinning into an endless
#: reconnect storm that could look like brute-forcing.
TRANSIENT_CONNECT_ATTEMPTS = 3
RECONNECT_BACKOFF_SECONDS = (1, 2, 5, 10, 30, 60)


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

    received_ms = now_ms if now_ms is not None else time.time_ns() // 1_000_000
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
        session: Optional[StoredSession] = None,
    ) -> None:
        self.settings = settings
        self.engine = engine
        #: Persisted PO browser session (cookies / UA / raw ssid). Loaded from
        #: po_session.json; the stored ``ssid`` cookie authenticates the bridge.
        self.session = (
            session
            if session is not None
            else load_stored_session(settings.session_path_resolved)
        )
        self.session_expired = False
        self._retry_stopped = False
        self._session_last_mtime = self.session.mtime
        #: HTTP Cookie header built from the stored cookies (masked when logged).
        self.cookie_header: str = self.session.cookie_header()
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
        self._available_asset_records: list[Dict[str, object]] = []
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
        #: async callback (payload_dict) -> None invoked every 5s heartbeat with
        #: {status, ticks_received, last_tick_ts, symbols_subscribed}. Wired by
        #: the entrypoint to relay.broadcast({"type": "heartbeat", ...}) so the
        #: backend applies its heartbeat-age rule (feed == disconnected when the
        #: gap exceeds the stale threshold).
        self.on_heartbeat = None
        #: async callback () -> None invoked once the bridge is ready (PO client
        #: authenticated + asset list loaded). Wired by the entrypoint to emit
        #: the relay ``ready`` frame the Node backend gates its subscribes on.
        self.on_ready = None
        #: real-time tick validation state per symbol
        self._last_tick_ts: Dict[str, float] = {}
        self._last_tick_price: Dict[str, float] = {}
        self._last_tick_source_ts: Dict[str, int] = {}
        self._tick_count: Dict[str, int] = {}
        #: total closed-candle frames relayed to clients (MASTER MISSION 2.x —
        #: surfaces on /health as ``candles_emitted``; incremented only when a
        #: bucket actually rolls over, never fabricated).
        self._candle_count: int = 0
        self._last_log_ts: Dict[str, float] = {}
        self._first_tick = asyncio.Event()
        self._tick_watch_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._session_watch_task: Optional[asyncio.Task] = None
        self._refresh_task: Optional[asyncio.Task] = None
        #: monotonically-increasing emit counter on every relayed live tick
        #: (unified-emit diagnostics contract; the relay adds its own seq too).
        self._tick_seq = 0
        #: number of times a clean (re)auth succeeded this process lifetime.
        self.connect_epoch = 0
        #: attempts consumed by the last transient auth retry ladder.
        self._transient_connect_retries = 0
        #: symbols armed DYNAMICALLY via a client subscription push (not in the
        #: static startup set). Survives teardowns so a credential swap /
        #: reconnect re-arms exactly the streams a browser had asked for.
        self._dynamic_symbols: set = set()
        #: symbols that currently own a reader task (re-arm guard: never spawn
        #: two readers for the same symbol).
        self._reader_symbols: set = set()
        self._reader_tasks: Dict[str, asyncio.Task] = {}

    @property
    def is_connected(self) -> bool:
        return self.client is not None and bool(self.client.is_connected())

    def health_payload(self) -> Dict:
        ticks = sum(self._tick_count.values())
        last_tick_ts = max(self._last_tick_source_ts.values(), default=None)
        if self.status in {"awaiting_ssid", "awaiting_session"}:
            status = "awaiting_ssid"
        elif self.session_expired or self.status == "session_expired":
            status = "auth_failed"
        elif ticks > 0 and self.is_connected:
            status = "live"
        else:
            status = "degraded"
        return {
            "status": status,
            "ssid_present": self.has_credential,
            "ssid_format": self.settings.ssid_format,
            "last_tick_ts": last_tick_ts,
            "ticks_received": ticks,
            "candles_emitted": self._candle_count,
            "session_file_present": bool(self.session.exists),
            "is_optimized": bool(self.settings.auth.get("isOptimized")),
            "symbols": sorted(self._subs),
        }

    @property
    def assets_ready(self) -> bool:
        """True once the PO client is authenticated and the authoritative asset
        list is loaded — the relay only signals ``ready`` when this is set."""
        return self._assets_ready

    def available_assets_payload(self) -> list[Dict[str, object]]:
        """Return the broker-authoritative active asset registry for clients."""
        return [dict(record) for record in self._available_asset_records]

    # Highest-priority optional dependency; used in the clean actionable message
    # emitted when it is missing (never auto-installed, never retried in a loop).
    def _dependency_install_hint(self) -> str:
        return (
            "Install the Pocket Option library with:  "
            "python -m pip install 'BinaryOptionsToolsV2==0.2.14'  "
            "(from the .venv-1 virtualenv). Run pocket-bridge\\verify_env.py to "
            "pre-flight the environment."
        )

    def _log_feed_transition(self, prev: str, status: str, error: Optional[str]) -> None:
        """Emit the FEED_DISCONNECTED / FEED_RECONNECTING / FEED_LIVE transition
        lines on every feed-state change — the operator-facing trace proving the
        bridge never silently drops the live feed."""
        live = {"connected"}
        down = {
            "connection_error", "disconnected", "stalled",
            "session_expired", "awaiting_ssid", "stopped",
        }
        if status in live and prev not in live:
            logger.info("FEED_LIVE status=%s (was %s)", status, prev)
        elif status in down and prev in live:
            logger.info(
                "FEED_DISCONNECTED status=%s error=%s (was %s)", status, error, prev
            )
        elif status == "connecting" and prev not in {"connecting", "connected"}:
            logger.info("FEED_RECONNECTING status=%s (was %s)", status, prev)

    async def _set_status(self, status: str, error: Optional[str] = None) -> None:
        self._log_feed_transition(self.status, status, error)
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
        # Only pin an explicit PO endpoint when POCKET_OPTION_WS_URLS is
        # configured. Empirically the library's own default URL authenticates
        # AND streams live ticks, whereas overriding url= to
        # DEFAULT_PO_WS_URL broke subscriptions entirely
        # (Core(ChannelReceiver(Closed)); auth still reported OK but the tick
        # stream died instantly). The constant above remains the raw-socket
        # probe / health target, never a stream override here.
        ws_url = self.settings.urls[0] if self.settings.urls else ""
        if ws_url:
            kwargs["url"] = ws_url
        if len(self.settings.urls) > 1:
            kwargs["config"] = {"urls": self.settings.urls}
        payload = self._auth_payload()
        if self.settings.has_ssid:
            # The env SSID is the authoritative full message — byte-faithful.
            via = "env"
            auth_dict = self.settings.auth
        else:
            via = "session"
            auth_dict = self.session.as_auth()
        session_len = len(str(auth_dict.get("session", "")))
        logger.info("connecting url=%s", ws_url)
        logger.info(
            "auth_payload_sent via=%s session_len=%d uid=%s isDemo=%s isOptimized=%s",
            via, session_len,
            auth_dict.get("uid"), auth_dict.get("isDemo"),
            auth_dict.get("isOptimized", False),
        )
        if self.session.exists:
            logger.info(
                "session_reused captured_at=%s ua=%s cookies=%d",
                self.session.captured_at or "(none)",
                mask_secret(self.session.user_agent),
                len(self.session.cookies),
            )
        self.cookie_header = self.session.cookie_header()
        self.client = PocketOptionAsync(payload, **kwargs)
        return self.client

    def _auth_payload(self) -> str:
        """SSID source of truth: send the EXACT configured auth message.

        The .env holds the frame captured verbatim from Pocket Option (with
        every field — session/isDemo/uid/platform/isFastHistory/isOptimized);
        it is sent as-is, never re-built or key-reduced. The stored-session
        cookie path is used ONLY when no env SSID exists.
        """
        if self.settings.has_ssid:
            return self.settings.auth_payload
        auth = self.session.as_auth()
        if auth.get("session"):
            return auth_message(auth)
        return ""

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
        self._last_tick_source_ts[symbol] = int(ts_ms)
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
        self._available_asset_records = []
        for raw in sorted(symbols):
            canonical = canonical_active_asset(str(raw))
            if not canonical:
                continue
            asset_type = asset_type_for_symbol(canonical)
            self._available_asset_records.append({
                "symbol": canonical,
                "name": canonical,
                "label": f"{canonical}{' OTC' if asset_type == 'otc' else ''}",
                "assetSubType": asset_type,
                "type": "crypto" if asset_type == "crypto" else "otc",
            })
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
        if not self.has_credential:
            # Clean degraded state: no stored session ssid AND no .env SSID.
            await self._set_status(
                "awaiting_session",
                "no session (po_session.json) and no POCKET_OPTION_SSID — "
                "refusing to fabricate prices",
            )
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
        logger.info("SUBSCRIBED symbols=%s", sorted(self._subs))
        async for tick in stream:
            # NOTE: PO's raw `timestamp` is the broker's own clock, which runs
            # ahead of real UTC by ~PLATFORM_TIME_OFFSET (7200s) — so an
            # absolute-age window against `time.time()` would reject EVERY live
            # tick (silent zero-drop violation). The broker stream is the single
            # authoritative source here; parse without the absolute window
            # (latency_ms still clamps skew to 0) — see parse_tick().
            quote = parse_quote(tick, validate_window=False)
            if quote is None:
                logger.debug("TICK [%s] unparseable, skipping: %r", symbol, tick)
                continue
            ts_ms = int(quote["ts_ms"])
            price = Decimal(str(quote["price"]))
            bid = Decimal(str(quote["bid"]))
            ask = Decimal(str(quote["ask"]))
            volume = quote["volume"]
            received_utc_ms = time.time_ns() // 1_000_000
            await self._log_tick(symbol, price, ts_ms)
            if not self._first_tick.is_set():
                self._first_tick.set()
                logger.info(
                    "TICK_RECEIVED symbol=%s price=%s ts=%s",
                    symbol, quote["price"], ts_ms,
                )
            self._tick_seq += 1
            # Zero-drop closed-candle emit: every bucket finalized by this tick
            # is streamed in order (handle_tick_all), never only the last one.
            closed = self.engine.handle_tick_all(symbol, price, ts_ms, bid, ask, volume)
            if closed and self.on_candle is not None:
                self._candle_count += len(closed)
                for candle in closed:
                    # Emit the authoritative closed-candle event in real time
                    # (on bucket rollover), not only inside reconnect snapshots.
                    await self.on_candle(candle)
            cb = self.on_tick
            if cb is not None:
                await cb(
                    {
                        "symbol": symbol,
                        "asset": asset,
                        "asset_type": asset_type_for_symbol(symbol),
                        # NUMBER primary fields — the Node client's registered
                        # contract (`typeof price === "number"`) must never
                        # silently drop a live frame (zero-drop L1).
                        "price": float(quote["price"]),
                        "bid": float(quote["bid"]),
                        "ask": float(quote["ask"]),
                        "mid": float(quote["price"]),
                        "price_exact": quote["price"],
                        "bid_exact": quote["bid"],
                        "ask_exact": quote["ask"],
                        "volume": (
                            float(quote["volume"]) if quote["volume"] is not None else None
                        ),
                        # Pocket Option server epoch-milliseconds (UTC); the
                        # local receipt wall-clock (UTC ms) + monotonic seq for
                        # drop/latency diagnostics.
                        "ts_ms": ts_ms,
                        "ts_utc": ts_ms // 1000,
                        "received_utc_ms": received_utc_ms,
                        "seq": self._tick_seq,
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

        if not self.has_credential:
            return {
                **base,
                "status": "awaiting_session",
                "error": "no stored session and no POCKET_OPTION_SSID — capturing a session first",
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
        self._dynamic_symbols.add(canonical)
        self._spawn_reader(canonical, asset)
        logger.info(
            "subscription push [%s] -> asset %s armed (dynamic reader started)",
            canonical, asset,
        )
        await self._set_status("connected",
                               f"subscription armed for {canonical}")
        return base

    async def _ensure_connected(self) -> None:
        """Connect (or reconnect) the PO client with transient-error awareness.

        On a clean break or network drop the old half-open socket is
        immediately released and a brand-new ``PocketOptionAsync`` (which
        authenticates on construction) is created.  Up to
        ``TRANSIENT_CONNECT_ATTEMPTS`` fresh constructions are attempted with a
        geometric back-off so a brief network hiccup self-heals without ever
        flipping into a terminal ``session_expired`` state that could appear
        to be an SSID ban.  Only once every attempt has failed is the SSID
        declared dead and the error escalated.
        """
        if self.is_connected:
            # The whole point of `ready` is that assets are initialised — the
            # Node backend gates its staged subscribes on it. A concurrent
            # reader that finds the socket connected but assets not yet loaded
            # must WAIT for `_mark_ready` below instead of racing forward into
            # an "Uninitialized, Assets not initialized yet" active_assets().
            if self._assets_ready:
                return
            timeout = time.monotonic() + self.settings.connect_timeout
            while not self._assets_ready:
                if time.monotonic() > timeout:
                    logger.warning(
                        "bridge assets not ready after %.0fs — proceeding with "
                        "subscribe-error asset resolution fallback",
                        self.settings.connect_timeout,
                    )
                    break
                await asyncio.sleep(0.25)
            return
        if not self.has_credential:
            await self._set_status(
                "awaiting_session",
                "no session (po_session.json) and no POCKET_OPTION_SSID — "
                "refusing to fabricate prices",
            )
            return
        last_error: Optional[str] = None
        for attempt in range(1, TRANSIENT_CONNECT_ATTEMPTS + 1):
            # A client whose SDK channel died (Core(ChannelReceiver(Closed)))
            # still returns instantly from wait_for_assets (assets preloaded)
            # but its is_connected() is False and it can never stream again.
            # Release it BEFORE trying so each attempt builds a fresh auth.
            if self.client is not None and not self.is_connected:
                try:
                    await self.client.disconnect()
                except Exception:  # noqa: BLE001 - best-effort teardown
                    pass
                self.client = None
            client = await self._import_client()
            try:
                await asyncio.wait_for(
                    client.wait_for_assets(timeout=self.settings.connect_timeout),
                    timeout=self.settings.connect_timeout,
                )
                if not client.is_connected():
                    raise RuntimeError(
                        "client not connected after wait_for_assets "
                        "(dead channel reused)"
                    )
                break
            except Exception as exc:  # noqa: BLE001 - retried transiently below
                last_error = str(exc)[:500]
                logger.error("auth_response=%s", last_error)
                logger.warning(
                    "auth_attempt[%d/%d] failed reason=%s — "
                    "releasing stale client and retrying transient",
                    attempt, TRANSIENT_CONNECT_ATTEMPTS, last_error,
                )
                try:
                    await client.disconnect()
                except Exception:  # noqa: BLE001 - best-effort teardown
                    pass
                self.client = None
                self._transient_connect_retries = attempt
                if attempt < TRANSIENT_CONNECT_ATTEMPTS:
                    await asyncio.sleep(self.settings.reconnect_delay * attempt)
        if not self.is_connected:
            logger.error("auth_failed reason=%s", last_error)
            await self._enter_session_expired(last_error or "authentication failed")
            return
        self.connected_at = time.time()
        self.connect_epoch += 1
        self._transient_connect_retries = 0
        logger.info("AUTH_SUCCESS uid=%s isDemo=%s", self.settings.uid, self.settings.is_demo)
        logger.info("auth_response=authenticated and assets_ready pending")
        # Load the authoritative asset list NOW, while the client is
        # guaranteed authenticated, so no later active_assets() call can hit
        # the "Uninitialized, Assets not initialized yet" transient — every
        # reader consumes the warm cache instead of re-querying mid-flight.
        await self._load_available_assets(client)
        await self._set_status("connected")
        await self._mark_ready()
        # Re-arm streams for symbols a browser client previously pushed while
        # the old socket was still alive — stale reader tasks died with the
        # teardown; a fresh pair is needed to pick up the live tape.
        self._rearm_dynamic_readers()
        if self._tick_watch_task is None or self._tick_watch_task.done():
            self._tick_watch_task = asyncio.create_task(self._watch_first_tick())

    async def start(self) -> None:
        """Launch all per-symbol raw tick readers with reconnect handling.

        1. FAIL LOUD when there is no usable credential:
             - no po_session.json AND no .env SSID  -> awaiting_session
               (CRITICAL NO_SESSION, never fabricates ticks)
             - session present but older than 7 days -> SESSION_OLD warn,
               continues until auth actually fails.
          2. Start the 10s session-file hot-reload watcher (po_session.json
             mtime) and the 30-min refresh scheduler.
          3. Run refresh_ssid.py once at startup (when a session file exists).
        """
        self._assets = self.settings.assets()

        # ── FAIL-LOUD SESSION CHECK ──
        if not self.has_credential:
            if not self.session.exists:
                logger.critical("NO_SESSION — run capture_session.py first")
                await self._set_status(
                    "awaiting_session",
                    "NO_SESSION — run capture_session.py first",
                )
            else:
                await self._set_status(
                    "awaiting_ssid",
                    "PO session has no ssid cookie and no env SSID",
                )
            self._start_session_tasks()
            return
        if self.session.exists and not self.session.has_ssid and self.settings.has_ssid:
            logger.warning(
                "SESSION_MISSING_SSID — stored session has no ssid cookie; "
                "using POCKET_OPTION_SSID from .env (run capture_session.py "
                "to persist a full session)"
            )
        if self.session.exists and self.session.age_days > self.settings.session_max_age_days:
            logger.warning(
                "SESSION_OLD — consider re-capturing (age=%.1f days > %d days)",
                self.session.age_days, self.settings.session_max_age_days,
            )

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
            self._start_session_tasks()
            return
        await self._set_status("connecting")

        self._start_static_readers()

        self._start_session_tasks()

        # Refresh the SSID once at startup (3.2), only when there IS a session
        # file to refresh from — otherwise there is nothing to extract.
        if self.settings.refresh_at_startup and self.session.exists:
            await self._run_refresh_once()

    def _spawn_reader(self, symbol: str, asset: str) -> Optional[asyncio.Task]:
        """Spawn ONE reader task per symbol (idempotent).

        Tracks the symbol in ``self._reader_symbols`` and removes it via a
        done-callback, so reconnect / re-arm logic can restart exactly the
        readers that died without ever double-subscribing a live one.
        """
        if symbol in self._reader_symbols:
            return None
        task = asyncio.create_task(self._reader_loop(symbol, asset))
        self._reader_tasks[symbol] = task
        self._reader_symbols.add(symbol)

        def _done(_t: asyncio.Task) -> None:
            self._reader_symbols.discard(symbol)
            self._reader_tasks.pop(symbol, None)

        task.add_done_callback(_done)
        self._tasks.append(task)
        return task

    async def request_unsubscription(self, symbol: str) -> None:
        canonical = canonical_symbol(symbol)
        if not canonical or canonical not in self._dynamic_symbols:
            return
        self._dynamic_symbols.discard(canonical)
        self._subs.pop(canonical, None)
        task = self._reader_tasks.get(canonical)
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        logger.info("dynamic subscription removed [%s]", canonical)

    def _start_static_readers(self) -> None:
        """Spawn reader tasks for the configured startup pairs (idempotent)."""
        self._assets = self.settings.assets()
        for symbol, asset in self._assets.items():
            self._spawn_reader(symbol, asset) if symbol not in self._reader_symbols else None

    def _rearm_dynamic_readers(self) -> None:
        """Re-spawn readers for symbols armed DYNAMICALLY by a client
        subscription push, after a reconnect / credential swap tore them down.

        Dynamic readers live only in ``self._tasks`` (they are not part of the
        static startup set), so a teardown would permanently lose the browser's
        live arm without this re-arm on the next successful connect.
        """
        for symbol in list(self._dynamic_symbols):
            if symbol in self._reader_symbols:
                continue
            asset = self._assets.setdefault(symbol, asset_for_symbol(symbol))
            self.engine.ensure_feed(symbol, asset_type_for_symbol(symbol))
            logger.info(
                "subscription re-arm [%s] -> asset %s (dynamic reader restored)",
                symbol, asset,
            )
            self._spawn_reader(symbol, asset)

    def _start_session_tasks(self) -> None:
        """Idempotent: heartbeat + session-file watcher + refresh scheduler."""
        if self._heartbeat_task is None or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(self._heartbeat())
        if self._session_watch_task is None or self._session_watch_task.done():
            self._session_watch_task = asyncio.create_task(
                self._watch_session_file()
            )
        if self._refresh_task is None or self._refresh_task.done():
            self._refresh_task = asyncio.create_task(self._refresh_loop())

    @property
    def has_credential(self) -> bool:
        """Stored session ssid OR the .env fallback SSID."""
        return self.session.has_ssid or self.settings.has_ssid

    async def reload_session(self) -> StoredSession:
        """Reload po_session.json from disk (hot reload on mtime change)."""
        self.session = load_stored_session(self.settings.session_path_resolved)
        self.cookie_header = self.session.cookie_header()
        return self.session

    async def _release_client(self) -> None:
        """Tear down a stale / broken PO client WITHOUT touching reader tasks.

        A dead SDK channel (e.g. ``Core(ChannelReceiver(Closed))``) leaves a
        half-open client whose ``is_connected()`` may still read True. Reusing
        it makes the next auth hang and then falsely escalate to
        ``session_expired`` even though the SSID is fine. On ANY reader crash
        the client is released here so the retry loop rebuilds a fresh
        ``PocketOptionAsync`` (authenticates on construction) instead.
        """
        if self.client is not None:
            try:
                await self.client.disconnect()
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass
        self.client = None
        self._subs.clear()
        self._assets_ready = False
        self._available_assets = None
        self._available_asset_records = []
        self._first_tick.clear()

    async def _teardown_client(self) -> None:
        """Disconnect the PO client + stop all reader tasks (for a credential
        swap after hot-reload). Readers respawn on the next connect."""
        self._first_tick.clear()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()
        self._subs.clear()
        self._reader_symbols.clear()
        self._assets_ready = False
        self._available_assets = None
        self._available_asset_records = []
        if self.client is not None:
            try:
                await self.client.disconnect()
            except Exception:  # noqa: BLE001 - best-effort
                pass
            self.client = None

    async def _watch_session_file(self) -> None:
        """2.3 HOT-RELOAD: poll po_session.json mtime every 10s.

        On change, reload cookies + SSID, then reconnect readers with the new
        credentials. The relay/backend keep running throughout.
        """
        while True:
            await asyncio.sleep(10.0)
            if not self.session.exists:
                self._session_last_mtime = 0.0
                continue
            if not session_reload_needed(self.session, self._session_last_mtime):
                continue
            self._session_last_mtime = self.session.mtime
            before = self.session.captured_at
            await self.reload_session()
            logger.info(
                "SESSION_RELOADED captured_at=%s (was %s) cookies=%d",
                self.session.captured_at or "?",
                before or "?",
                len(self.session.cookies),
            )
            if self.has_credential:
                self.session_expired = False
                self._retry_stopped = False
                await self._teardown_client()
                await self._ensure_connected()
                # _ensure_connected already spawned dynamic readers via
                # _rearm_dynamic_readers(); re-arm the static set too.
                if self.is_connected:
                    self._start_static_readers()

    async def _run_refresh(self) -> bool:
        """Run ``session/refresh_ssid.py`` (headless Playwright) as a subprocess.

        Never blocks the event loop; subprocess timeout of 180s.
        """
        script = Path(__file__).resolve().parents[1] / "session" / "refresh_ssid.py"
        if not script.is_file():
            logger.warning("refresh_ssid.py not found at %s", script)
            return False
        if not self.session.exists:
            logger.warning("refresh skipped — no po_session.json to refresh from")
            return False
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable,
                str(script),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=180)
            text = out.decode("utf-8", "replace") if out else ""
            for line in text.splitlines():
                logger.info("refresh> %s", line)
            return proc.returncode == 0
        except Exception as exc:  # noqa: BLE001 - refresh must never crash us
            logger.warning("refresh_ssid.py crashed: %s", exc)
            return False

    async def _run_refresh_once(self) -> bool:
        """Run refresh_ssid.py once (startup/auth-failure). Reload on success."""
        ok = await self._run_refresh()
        if ok:
            await self.reload_session()
            # In a read-only-mounted container the session FILE cannot be
            # rotated, but refresh always wrote the fresh SSID to .env — adopt
            # it so auth uses the new token immediately instead of the stale
            # session cookie.
            env_ssid = read_env_ssid(
                Path(__file__).resolve().parents[1] / ".env"
            )
            if env_ssid:
                try:
                    parsed = parse_ssid(env_ssid)
                except ValueError:
                    parsed = {}
                if parsed.get("session"):
                    self.session.raw_ssid = parsed["session"]
                    self.session.auth_seed = dict(parsed)
            logger.info(
                "SESSION_REFRESHED captured_at=%s",
                self.session.captured_at or "?",
            )
            self.session_expired = False
            self._retry_stopped = False
        return ok

    async def _refresh_loop(self) -> None:
        """3.2 SCHEDULER: re-run refresh_ssid.py every 30 minutes (best-effort)."""
        interval = max(60.0, float(self.settings.session_refresh_interval))
        while True:
            await asyncio.sleep(interval)
            if not self.session.exists:
                continue
            ok = await self._run_refresh_once()
            if not ok and self.session_expired:
                logger.critical("SESSION_EXPIRED — re-run capture_session.py")

    async def _enter_session_expired(self, reason: str) -> None:
        """FAIL LOUD: auth failed and cannot recover.

        Emits the exact actionable line, flips the terminal ``session_expired``
        state, stops all retry loops (avoiding ban), and attempts ONE refresh —
        only a successful refresh re-arms the bridge.
        """
        logger.critical("SSID_EXPIRED — run capture_session.py to refresh")
        self.session_expired = True
        self._retry_stopped = True
        await self._set_status("session_expired", "SSID_EXPIRED — run capture_session.py to refresh")
        ok = await self._run_refresh_once()
        if not ok:
            logger.critical("SESSION_EXPIRED — re-run capture_session.py")
        elif reason:
            logger.critical("AUTH FAILED — SSID expired or invalid (%s)", reason)

    async def _reader_loop(self, symbol: str, asset: str) -> None:
        if not self.has_credential:
            # start() already emitted the awaiting state. Sit idle so adding a
            # captured session (or SSID) and restarting connects cleanly.
            return
        delay_index = 0
        while True:
            if self._retry_stopped:
                # TERMINAL: SSID expired and refresh failed — stop retrying to
                # avoid account/IP bans (5.3). The human re-captures the session.
                logger.warning(
                    "reader(%s) stopped — session expired, waiting for a "
                    "fresh capture (session_expired)", symbol,
                )
                return
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
                # Genuine crash (network loss, malformed stream, dead SDK
                # channel): back off geometrically, bounded by
                # reconnect_max_delay — but NEVER permanently stall, so a plate
                # that recovers is still picked up. Release the broken client
                # so the next loop-gate rebuilds a fresh auth instead of
                # re-using a half-open socket.
                logger.warning("reader(%s) crashed: %s", symbol, exc)
                try:
                    await self._release_client()
                except Exception:  # noqa: BLE001 - teardown must not mask
                    pass
                await self._set_status("connection_error", str(exc))
                delay = RECONNECT_BACKOFF_SECONDS[min(delay_index, len(RECONNECT_BACKOFF_SECONDS) - 1)]
                logger.info("FEED_RECONNECTING attempt=%d", delay_index + 1)
                await asyncio.sleep(delay)
                delay_index += 1
                continue
            # run_reader returned CLEANLY — that is a NORMAL disconnect / stop
            # (no exception, e.g. broker stream ended or session dropped).
            # Reconnect IMMEDIATELY at the base cadence and RESET the backoff so
            # the bridge never lingers in the "stuck at 60s forever" state after
            # a transient drop: reconnect is instant and self-healing.
            logger.info("FEED_DISCONNECTED reason=stream_ended")
            logger.info("FEED_RECONNECTING attempt=%d", delay_index + 1)
            await asyncio.sleep(RECONNECT_BACKOFF_SECONDS[min(delay_index, len(RECONNECT_BACKOFF_SECONDS) - 1)])
            delay_index = min(delay_index + 1, len(RECONNECT_BACKOFF_SECONDS) - 1)

    async def stop(self) -> None:
        for task in (
            self._heartbeat_task,
            self._tick_watch_task,
            self._session_watch_task,
            self._refresh_task,
        ):
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._heartbeat_task = None
        self._tick_watch_task = None
        self._session_watch_task = None
        self._refresh_task = None
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()
        self._reader_symbols.clear()
        self._assets_ready = False
        self._available_assets = None
        if self.client is not None:
            try:
                await self.client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self.client = None
        await self._set_status("stopped")

    async def _watch_first_tick(self) -> None:
        try:
            await asyncio.wait_for(self._first_tick.wait(), timeout=10)
        except asyncio.TimeoutError:
            logger.error("no_ticks_after_auth timeout_s=10")
            logger.error(
                "AUTH OK but no ticks — check isFastHistory, subscription list, "
                "demo/live mode"
            )
            await self._set_status("stalled", "no tick after authentication")

    async def _heartbeat(self) -> None:
        """5s aggregate liveness probe proving the AUTHED stream delivers ticks.

        Logs total raw ticks received, the newest PO tick timestamp, and the
        currently subscribed symbols. A connected-but-silent bridge (auth OK,
        no ticks) is impossible to mistake for a live feed when this fires.
        Also emits a ``heartbeat`` relay frame (status + counters) so the
        backend's heartbeat-age rule can flip the client to ``disconnected``
        when these stop arriving.
        """
        while True:
            await asyncio.sleep(5.0)
            total = sum(self._tick_count.values())
            last_ts = max(self._last_tick_source_ts.values(), default=0)
            subscribed = ",".join(sorted(self._subs.keys())) or "(none)"
            logger.info(
                "HEARTBEAT ticks_received=%d last_tick_ts=%s "
                "symbols_subscribed=%s status=%s",
                total, last_ts, subscribed, self.status,
            )
            cb = self.on_heartbeat
            if cb is not None:
                try:
                    await cb({
                        "status": self.status,
                        "ticks_received": total,
                        "last_tick_ts": last_ts,
                        "symbols_subscribed": subscribed,
                    })
                except Exception:  # noqa: BLE001 - a broken heartbeat relay must
                    # never kill the liveness probe loop.
                    logger.exception("heartbeat relay failed")
