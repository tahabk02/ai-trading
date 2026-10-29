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
import hashlib
import json
import logging
import random
import re
import sys
import time
import traceback
from decimal import Decimal
from pathlib import Path
from typing import Dict, Optional, Tuple

from .config import (
    BridgeSettings,
    resolve_user_agent,
    StoredSession,
    asset_candidates,
    asset_for_symbol,
    asset_type_for_symbol,
    broker_symbol_is_otc,
    REAL_FOREX_SYMBOLS,
    canonical_active_asset,
    is_removed_symbol,
    auth_message,
    canonical_symbol,
    credential_login_status,
    force_php_array_header,
    load_stored_session,
    mask_proxy_url,
    mask_secret,
    mask_uid,
    normalize_auth_fields,
    parse_ssid,
    read_env_ssid,
    sanitize_php_session,
    SESSION_TOKEN_FIELD,
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
#: Retained for callers/tests that reference the historical fixed ladder. The
#: live ladder is now exponential + jittered via ``_backoff_delay``.
RECONNECT_BACKOFF_SECONDS = (1, 2, 5, 10, 30, 60)

#: WebSocket close codes surfaced explicitly in the reconnect logs. The SDK
#: does not always expose a structured code, so ``_close_code_for_exception``
#: also infers these from the exception text.
WS_CLOSE_NORMAL = 1000
WS_CLOSE_GOING_AWAY = 1001
WS_CLOSE_PROTOCOL_ERROR = 1002
WS_CLOSE_ABNORMAL = 1006
WS_CLOSE_POLICY_VIOLATION = 1008
WS_CLOSE_TRY_AGAIN_LATER = 1013
WS_CLOSE_MEANINGS: Dict[int, str] = {
    1000: "normal_closure",
    1001: "going_away",
    1002: "protocol_error",
    1003: "unsupported_data",
    1006: "abnormal_closure",
    1007: "invalid_frame_payload",
    1008: "policy_violation",
    1009: "message_too_big",
    1011: "internal_error",
    1012: "service_restart",
    1013: "try_again_later",
    1015: "tls_handshake_failed",
}
#: Close codes after which a reconnect is pointless/forbidden (logged louder).
_TERMINAL_CLOSE_CODES = frozenset({1002, 1003, 1007, 1008, 1009})
_POLICY_ERROR_MARKERS = (
    "policy",
    "forbidden",
    "unauthorized",
    "invalid session",
    "banned",
    "blocked",
    "not authorized",
    "not authorised",
)
_ABNORMAL_CLOSE_MARKERS = (
    "connection closed",
    "connectionclosed",
    "connection reset",
    "connectionreset",
    "broken pipe",
    "eof occurred",
    "abnormal closure",
    "channelreceiver",
    "channel closed",
    "1006",
)

#: Consecutive broker stream timeouts (with ZERO ticks received anywhere)
#: before the bridge treats the session as dead instead of reconnecting
#: forever. The SDK raises "Subscription stream timed out after 60s waiting
#: for data" when the token authenticates but is not authorised to receive
#: market data (expired / incomplete ssid). Retrying that every 60s per symbol
#: is both useless and ban-risky, so after this many strikes we stop and ask
#: for a fresh capture — exactly like a parse-terminal SSID failure.
STREAM_TIMEOUT_STREAK_LIMIT = 3
_STREAM_TIMEOUT_MARKERS = (
    "subscription stream timed out",
    "waiting for data from",
    "timed out waiting for data",
)

#: The SDK raises ``General("Assets not found")`` when the broker asset
#: registry has not been populated yet. That is a TRANSIENT initialisation
#: condition, NOT a bad symbol — subscribing in that state makes every reader
#: fail with the same error and used to flip the whole bridge to
#: ``connection_error``.
_ASSETS_UNINITIALIZED_MARKERS = (
    "assets not initialized",
    "assets not loaded",
    "assets are not initialized",
    "assets not yet initialized",
    "uninitialized, assets",
)

#: A specific candidate the broker's loaded registry does not contain.
_ASSET_REJECTION_MARKERS = (
    "invalid asset",
    "asset not found",
    "assets not found",
    "unknown asset",
    "asset does not exist",
    "no asset available",
)

#: Bounded retry cadence for ``active_assets()`` while the registry warms up.
_ASSET_LIST_RETRY_DELAYS = (0.0, 0.5, 1.0)

#: Extra seconds the bridge waits beyond the SDK's own handshake budget before
#: declaring a transport failure. Without this the Python-side
#: ``asyncio.wait_for`` deadline races the native one and cancels a handshake
#: that was still legitimately initialising.
CONNECT_DEADLINE_GRACE = 15.0

#: Transport-level failures that mean "the socket never came up", NOT "this
#: SSID is dead". These must never escalate to the terminal ``session_expired``
#: state — a regional endpoint being blocked/filtered is indistinguishable
#: from a bad credential at the SDK boundary, but only one of them is real.
_TRANSPORT_ERROR_MARKERS = (
    "connection initialization timed out",
    "connection initialization timeout",
    "timed out",
    "timeout",
    "timedout",
    "handshake",
    "dead channel",
    "channelreceiver(closed)",
    "channelreceiver",
    "websocket",
    "connection closed",
    "connectionreset",
    "eof occurred",
    "tls handshake",
    "dns",
    "unreachable",
    "network is unreachable",
)


_JSON_SESSION_FIELD_RE = re.compile(
    r'("(?:session|sessionToken|session_token|ssid|token|cookie|password|secret)"\s*:\s*)'
    r'"((?:[^"\\]|\\.)*)"',
    re.IGNORECASE,
)
_PHP_SESSION_BLOB_RE = re.compile(
    r'(?:a:\d+:\{|O:\d+:"(?:[^"\\]|\\.)*":\d+:\{).*?\}'
    r"(?:[0-9a-fA-F]{32})?",
    re.DOTALL,
)


def _secret_digest(value: str) -> str:
    return hashlib.sha256(
        value.encode("utf-8", "surrogatepass")
    ).hexdigest()[:12]


def _php_header(value: str) -> str:
    match = re.match(r"([aO]):(\d+):", value or "")
    return f"{match.group(1)}:{match.group(2)}" if match else "unknown"


def _redact_diagnostic_text(text: str, session: str = "") -> str:
    """Remove session material while preserving structural escape artifacts."""
    if not isinstance(text, str):
        text = repr(text)
    placeholder = f"<REDACTED_SESSION len={len(session)} sha256={_secret_digest(session)}>"
    if session:
        # Replace raw, JSON-escaped, and repr-escaped variants. Tracebacks can
        # render exception args at more than one escaping level.
        variants = [session]
        for _ in range(3):
            variants.append(
                json.dumps(variants[-1], ensure_ascii=False)[1:-1]
            )
        for secret in variants:
            if secret:
                text = text.replace(secret, placeholder)
    text = _JSON_SESSION_FIELD_RE.sub(
        lambda match: match.group(1) + f'"{placeholder}"',
        text,
    )
    return _PHP_SESSION_BLOB_RE.sub(placeholder, text)


def _payload_auth(payload: object) -> dict:
    """Best-effort extract the auth object for diagnostics (never logged raw)."""
    if not isinstance(payload, str):
        return {}
    text = payload
    try:
        if text.startswith("42["):
            parsed = json.loads(text[2:])
        elif text.startswith("["):
            parsed = json.loads(text)
        elif text.startswith("{"):
            parsed = json.loads(text)
        else:
            return {}
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    if isinstance(parsed, list) and len(parsed) > 1 and isinstance(parsed[1], dict):
        return parsed[1]
    return parsed if isinstance(parsed, dict) else {}


def _sdk_payload_diagnostics(payload: object, auth: dict) -> str:
    """Build a redacted structural snapshot of the exact SDK input."""
    payload_type = type(payload).__name__
    embedded = _payload_auth(payload)
    effective = embedded or (auth if isinstance(auth, dict) else {})
    session = effective.get("session")
    if not isinstance(session, str) or not session:
        session = effective.get(SESSION_TOKEN_FIELD, "")
    if not isinstance(session, str):
        session = ""
    if isinstance(payload, str) and payload.startswith("a:"):
        session = payload

    uid = effective.get("uid")
    is_demo = effective.get("isDemo", effective.get("is_demo"))
    header_match = re.match(r"([aO]):(\d+):", session)
    header = (
        f"{header_match.group(1)}:{header_match.group(2)}"
        if header_match
        else "n/a"
    )
    if session.startswith("a:"):
        container = "array"
    elif session.startswith("O:"):
        container = "object"
    elif session:
        container = "other"
    else:
        container = "none"
    declared_match = re.match(r"a:(\d+):", session)
    declared = declared_match.group(1) if declared_match else "n/a"
    redacted = _redact_diagnostic_text(str(payload), session)
    text = payload if isinstance(payload, str) else ""
    starts_42_auth = text.startswith('42["auth",')
    return "\n".join(
        (
            "SDK_PAYLOAD_DIAG",
            f"  payload_type={payload_type}",
            f"  payload_len={len(payload) if hasattr(payload, '__len__') else 'n/a'}",
            f"  payload_sha256_12={_secret_digest(text or repr(payload))}",
            f"  payload_starts_42_auth={starts_42_auth}",
            f"  payload_backslashes={text.count(chr(92))}",
            f"  payload_newlines={text.count(chr(10))}",
            f"  payload_carriage_returns={text.count(chr(13))}",
            f"  payload_quotes={text.count(chr(34))}",
            f"  payload_repr={redacted!r}",
            f"  auth_uid={uid!r} auth_uid_type={type(uid).__name__}",
            f"  auth_isDemo={is_demo!r} "
            f"auth_isDemo_type={type(is_demo).__name__}",
            f"  session_type={type(session).__name__}",
            f"  session_len={len(session)}",
            f"  session_sha256_12={_secret_digest(session)}",
            f"  session_php_container={container}",
            f"  session_php_header={header}",
            f"  session_php_declared={declared}",
            f"  session_starts_php={session.startswith('a:')}",
            f"  session_starts_42={session.startswith('42[')}",
        )
    )


def _emit_sdk_payload_diagnostics(payload: object, auth: dict) -> str:
    text = _sdk_payload_diagnostics(payload, auth)
    logger.warning(text)
    print(text, file=sys.stderr, flush=True)
    return text


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
    broker has no matching asset (e.g. ``Invalid asset: AUDCHF_otc``).

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


class AssetsNotReadyError(Exception):
    """Raised when the broker asset registry is not initialised yet.

    This is TRANSIENT: the socket may be authenticated while the SDK's asset
    map is still empty, in which case EVERY ``subscribe_symbol`` call raises
    ``General("Assets not found")``. The reader must back off and retry — it
    must never mark the symbol permanently skipped or degrade the whole feed.
    """

    def __init__(self, symbol: str, detail: str = "") -> None:
        suffix = f": {detail}" if detail else ""
        super().__init__(
            f"broker asset registry not ready for {symbol}{suffix}"
        )
        self.symbol = symbol
        self.detail = detail


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
        #: Set when every repair strategy was attempted and the SDK STILL
        #: rejected the session. The reader loop uses it to stop retrying a
        #: permanently unparseable SSID instead of spinning forever.
        self._ssid_parse_terminal = False
        #: Consecutive SDK "stream timed out waiting for data" failures with no
        #: ticks anywhere. Reset on the first real tick; trips terminal session
        #: expiry at STREAM_TIMEOUT_STREAK_LIMIT.
        self._stream_timeout_streak = 0
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
        #: canonical pair -> {"otc"|"plain": raw broker symbol}. Resolution
        #: uses the broker's OWN spelling instead of a reconstructed guess.
        self._asset_index: Dict[str, Dict[str, str]] = {}
        #: listed-but-inactive variants, tried only when no active variant
        #: matched (broker flips is_active during maintenance windows).
        self._asset_index_inactive: Dict[str, Dict[str, str]] = {}
        #: last failure while loading active_assets() (diagnostics + the
        #: transient/permanent decision in run_reader).
        self._assets_error: Optional[str] = None
        self._assets_loaded_at: float = 0.0
        #: Cooldown so N readers waking together do not each pay the full
        #: active_assets() retry budget while the registry is still warming.
        self._assets_last_attempt_at: float = 0.0
        #: serialises connect + asset initialisation. Without it every reader
        #: raced a fresh PocketOptionAsync construction, which is what produced
        #: the "Assets not initialized yet" / "Assets not found" cascade.
        self._connect_lock = asyncio.Lock()
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
        #: async callback (payload_dict) -> None invoked every heartbeat with
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
        self._last_keepalive_at: float = 0.0
        self._session_watch_task: Optional[asyncio.Task] = None
        self._refresh_task: Optional[asyncio.Task] = None
        #: monotonically-increasing emit counter on every relayed live tick
        #: (unified-emit diagnostics contract; the relay adds its own seq too).
        self._tick_seq = 0
        #: number of times a clean (re)auth succeeded this process lifetime.
        self.connect_epoch = 0
        #: attempts consumed by the last transient auth retry ladder.
        self._transient_connect_retries = 0
        #: rotation offset applied to the configured endpoint list so a host
        #: that is blocked/failing the handshake is bypassed on the very next
        #: attempt instead of being probed first every single time.
        self._endpoint_rotation = 0
        #: last raw exception raised while connecting, inspected by
        #: ``_is_transport_error`` to separate a dead socket from a dead SSID.
        self._last_transport_error: Optional[BaseException] = None
        #: symbols armed DYNAMICALLY via a client subscription push (not in the
        #: static startup set). Survives teardowns so a credential swap /
        #: reconnect re-arms exactly the streams a browser had asked for.
        self._dynamic_symbols: set = set()
        #: symbols that currently own a reader task (re-arm guard: never spawn
        #: two readers for the same symbol).
        self._reader_symbols: set = set()
        self._reader_tasks: Dict[str, asyncio.Task] = {}
        #: wall-clock time each symbol's CURRENT subscription was armed. The
        #: stall watchdog measures "no ticks since" from this anchor, so a fresh
        #: subscription gets one full stale window before it can be recycled.
        self._subscribed_at: Dict[str, float] = {}
        #: serialises stall recoveries so a slow re-auth cannot be started twice
        #: by two concurrent heartbeat probes / reader crashes.
        self._recovery_lock = asyncio.Lock()
        self._recovery_task: Optional[asyncio.Task] = None

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
        now = time.time()
        tick_receipt = max(self._last_tick_ts.values(), default=None)
        stale_window = float(self.settings.stream_stale_after)
        stalled = [
            symbol
            for symbol in self._subs
            if tick_receipt is not None
            and (now - max(
                self._last_tick_ts.get(symbol, 0.0),
                self._subscribed_at.get(symbol, 0.0),
            )) >= stale_window
        ]
        return {
            "status": status,
            "ssid_present": self.has_credential,
            "ssid_format": self.settings.ssid_format,
            "ssid_source": self.settings.ssid_source,
            "last_tick_ts": last_tick_ts,
            "last_tick_age_s": (
                round(max(0.0, now - tick_receipt), 1)
                if tick_receipt is not None
                else None
            ),
            "ticks_received": ticks,
            "candles_emitted": self._candle_count,
            "session_file_present": bool(self.session.exists),
            "is_optimized": bool(self.settings.auth.get("isOptimized")),
            "symbols": sorted(self._subs),
            "stalled_symbols": sorted(stalled),
            "proxy_enabled": bool(self.settings.proxy_url),
            "proxy": mask_proxy_url(self.settings.proxy_url),
            "server_public_ip": self.settings.server_public_ip or None,
            # Last-resort credential-login availability (opt-in, masked) so the
            # operator can see whether an expired session can self-heal without
            # a manual re-capture.
            **credential_login_status(),
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
        if not self._available_assets:
            logger.warning(
                "READY_DEFERRED — broker asset registry is not populated; "
                "`ready` is not advertised and subscribes stay staged"
            )
            return
        self._assets_ready = True
        logger.info("bridge ready — PO client authenticated & assets initialised")
        cb = self.on_ready
        if cb is not None:
            await cb()

    @staticmethod
    def _session_repair_candidates(auth: dict) -> list[tuple[str, str]]:
        """Ordered, de-duplicated session rewrites to try after an SDK reject.

        The legacy ``a:5`` header force is kept first for backwards
        compatibility. The sanitizer is the robust fallback: it rebuilds a
        flat 4/5-element PHP array from recoverable scalar fields, dropping
        objects/nested structures the Rust parser cannot digest.
        """
        if auth.get(SESSION_TOKEN_FIELD):
            # Real-account tokens are valid strings; forcing a PHP header here
            # would corrupt them into an unparseable ``a:5`` body.
            return []
        session = auth.get("session")
        if not isinstance(session, str) or not session:
            return []
        candidates: list[tuple[str, str]] = []
        seen = {session}

        def add(reason: str, candidate: str) -> None:
            if candidate and candidate not in seen:
                seen.add(candidate)
                candidates.append((reason, candidate))

        add("forced_a5", force_php_array_header(session, 5))
        add("sanitized_flat", sanitize_php_session(session))
        # A clean whitelist rebuild also covers the case where the session is
        # already a:5 but still carries unknown/nested tokens.
        add(
            "sanitized_flat",
            sanitize_php_session(session, fallback_fields=auth),
        )
        # Final strict shape: ONLY the four Rust-required fields. This covers
        # the reported case where even a corrected a:5 body is still rejected.
        add(
            "flat_required_only",
            sanitize_php_session(
                session,
                fallback_fields=auth,
                include_device_id=False,
            ),
        )
        return candidates

    def _retry_with_forced_php_header(
        self, exc: Exception, auth: dict, kwargs: Dict[str, object]
    ):
        """Try bounded session repairs after the Rust SDK rejects the session.

        Normal normalization remains exact-count based. This only runs after
        ``Failed to parse ssid``, so a valid four-field session (which still
        parses normally) is never rewritten to an invalid a:5 body. Every
        candidate is attempted at most once; the caller re-raises the ORIGINAL
        SDK exception if none is accepted (and marks the SSID terminal).
        """
        error_text = str(exc).lower()
        if (
            "failed to parse ssid" not in error_text
            and "error parsing session data" not in error_text
        ):
            return None
        from BinaryOptionsToolsV2.pocketoption import PocketOptionAsync  # noqa: E402

        for reason, candidate in self._session_repair_candidates(auth):
            before = _php_header(str(auth.get("session", "")))
            after = _php_header(candidate)
            logger.warning(
                "AUTH_FRAME_SESSION_MUTATED before=%s after=%s "
                "reason=sdk_parse_retry:%s",
                before,
                after,
                reason,
            )
            repaired_auth = normalize_auth_fields(dict(auth))
            # The Rust core treats ``sessionToken`` as an alias of ``session``;
            # emitting both raises ``duplicate field 'session'``. This retry
            # path always sends the repaired PHP ``session``, so the token
            # aliases must never travel alongside it.
            repaired_auth.pop(SESSION_TOKEN_FIELD, None)
            repaired_auth.pop("session_token", None)
            repaired_auth["session"] = candidate
            repaired_payload = "42" + json.dumps(
                ["auth", repaired_auth], separators=(",", ":")
            )
            _emit_sdk_payload_diagnostics(repaired_payload, repaired_auth)
            try:
                client = PocketOptionAsync(repaired_payload, **kwargs)
            except Exception as retry_exc:  # noqa: BLE001 - original error wins
                logger.critical(
                    "AUTH_FRAME_RETRY_FAILED reason=%s forced_header=%s "
                    "error_type=%s error=%s",
                    reason,
                    after,
                    type(retry_exc).__name__,
                    _redact_diagnostic_text(str(retry_exc), candidate),
                )
                continue
            self._ssid_parse_terminal = False
            logger.warning(
                "AUTH_FRAME_RETRY_RECOVERED forced_header=%s reason=%s "
                "session_len=%d",
                after,
                reason,
                len(candidate),
            )
            return client
        return None

    async def _import_client(self):
        if self.client is not None:
            return self.client
        self._check_dependency()
        from BinaryOptionsToolsV2.pocketoption import PocketOptionAsync  # noqa: E402
        # The SDK's own compiled regional endpoint list is used whenever
        # POCKET_OPTION_WS_URLS is unset — it authenticates AND streams live
        # ticks, whereas pinning url= to DEFAULT_PO_WS_URL broke subscriptions
        # entirely (Core(ChannelReceiver(Closed)); auth reported OK but the tick
        # stream died instantly). The constant above stays the raw-socket
        # probe / health target, never a stream override here.
        #
        # The config dict is ALWAYS passed so the native handshake budget is
        # ours, not the SDK default of 60s: the Rust core aborts the whole
        # connection with "General error: Connection initialization timed out"
        # when the endpoint rotation has not authenticated inside
        # connection_initialization_timeout_secs, and 60s is not enough to walk
        # a blocked regional host through to a healthy one.
        sdk_config: Dict[str, object] = {
            "connection_initialization_timeout_secs": int(self.settings.po_init_timeout),
            "timeout_secs": int(self.settings.po_request_timeout),
            "user_agent": resolve_user_agent(self.settings.user_agent),
            # Short rotate delay = a blocked/failing host is bypassed fast
            # instead of costing the full handshake budget on every attempt.
            "reconnect_time": int(self.settings.po_reconnect_time),
        }
        # Route the SDK transport through the configured proxy. This is a pure
        # network-path change: NO TLS cipher/ALPN/JA3 fields are set here, the
        # SDK keeps its own handshake semantics.
        if self.settings.proxy_url:
            sdk_config["proxy"] = self.settings.proxy_url
        urls = list(self.settings.urls)
        if urls:
            if len(urls) > 1 and self._endpoint_rotation:
                cut = self._endpoint_rotation % len(urls)
                urls = urls[cut:] + urls[:cut]
            sdk_config["urls"] = urls
        kwargs: Dict[str, object] = {"config": sdk_config}
        auth_dict = self._auth_dict()
        payload = self._auth_payload()
        via = self.settings.ssid_source if self.settings.has_ssid else "session"
        session_len = len(
            str(auth_dict.get("session") or auth_dict.get(SESSION_TOKEN_FIELD, ""))
        )
        logger.info(
            "connecting urls=%s init_timeout=%ss rotate=%s",
            urls or "(sdk default regional list)",
            sdk_config["connection_initialization_timeout_secs"],
            self._endpoint_rotation,
        )
        logger.info(
            "handshake_fingerprint user_agent=%s proxy=%s",
            sdk_config["user_agent"],
            mask_proxy_url(self.settings.proxy_url),
        )
        logger.info(
            "auth_payload_sent via=%s session_len=%d uid=%s isDemo=%s isOptimized=%s",
            via, session_len,
            mask_uid(auth_dict.get("uid")), auth_dict.get("isDemo"),
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

        diag_auth = _payload_auth(payload) or auth_dict
        diag_session = (
            (diag_auth.get("session") or diag_auth.get(SESSION_TOKEN_FIELD, ""))
            if isinstance(diag_auth, dict)
            else ""
        )
        if not isinstance(diag_session, str):
            diag_session = ""
        if isinstance(payload, str) and payload.startswith("a:"):
            diag_session = payload
        _emit_sdk_payload_diagnostics(payload, auth_dict)

        try:
            from BinaryOptionsToolsV2 import PocketOptionError
        except ImportError:  # pragma: no cover - package checked above
            PocketOptionError = None  # type: ignore[assignment,misc]

        self._ssid_parse_terminal = False
        try:
            self.client = PocketOptionAsync(payload, **kwargs)
            self._ssid_parse_terminal = False
        except Exception as exc:
            recovered = self._retry_with_forced_php_header(
                exc, auth_dict, kwargs
            )
            if recovered is not None:
                self.client = recovered
                self._ssid_parse_terminal = False
                return self.client
            trace = _redact_diagnostic_text(
                traceback.format_exc(), diag_session
            )
            args = repr(
                tuple(
                    _redact_diagnostic_text(str(arg), diag_session)
                    for arg in exc.args
                )
            )
            is_po_error = (
                PocketOptionError is not None
                and isinstance(exc, PocketOptionError)
            )
            detail = (
                "SDK_INIT_EXCEPTION\n"
                f"  exception_type={type(exc).__name__}\n"
                f"  is_pocket_option_error={is_po_error}\n"
                f"  exception_args={args}\n"
                f"  traceback:\n{trace}"
            )
            logger.critical(detail)
            print(detail, file=sys.stderr, flush=True)
            error_text = str(exc).lower()
            parse_failed = (
                "failed to parse ssid" in error_text
                or "error parsing session data" in error_text
            )
            if parse_failed:
                self._ssid_parse_terminal = True
                logger.critical(
                    "SSID_PARSE_FAILED source=%s format=%s session_len=%d "
                    "uid=%s isDemo=%s - the SDK rejected the auth payload",
                    self.settings.ssid_source,
                    self.settings.ssid_format,
                    session_len,
                    mask_uid(auth_dict.get("uid")),
                    auth_dict.get("isDemo"),
                )
                logger.critical(
                    "SSID_PARSE_FAILED_TERMINAL - all sanitizer fallbacks were "
                    "rejected; stopping the reconnect ladder instead of "
                    "spinning forever"
                )
            raise
        return self.client

    def _auth_dict(self) -> dict:
        """Extract the auth object before it is handed to the SDK.

        Env/file credentials win; the stored-session cookie path is used ONLY
        when no env SSID exists.
        """
        if self.settings.has_ssid:
            return self.settings.auth
        return self.session.as_auth()

    def _auth_payload(self) -> str:
        """Build the ONE 42["auth",{...}] frame the SDK accepts.

        The SDK's Python wrapper explicitly requires this outer frame
        (``sanitize_and_validate_ssid`` returns early for anything else), and
        its Rust core parses ``session`` as PHP for real accounts. Passing the
        bare PHP session reaches the core's JSON parser and fails with
        ``JSON parsing error``. The production ``Expected '}' but got 's'``
        comes from a stale ``a:N`` count INSIDE the session, which
        ``auth_message`` repairs while preserving every field.
        """
        auth = self._auth_dict()
        if not (auth.get("session") or auth.get(SESSION_TOKEN_FIELD)):
            return ""
        return auth_message(auth)

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

    @staticmethod
    def _is_assets_uninitialized_error(exc: BaseException) -> bool:
        """True when the SDK says its asset map is not populated YET."""
        text = str(exc).lower()
        return any(marker in text for marker in _ASSETS_UNINITIALIZED_MARKERS)

    def _is_assets_not_ready_error(self, exc: BaseException) -> bool:
        """True when a subscribe failure means "registry not loaded", not "bad
        symbol".

        ``Assets not found`` is ambiguous: it is raised both when the registry
        is empty (transient — the SDK never received the asset dump) and when
        a specific symbol is absent from a loaded registry (per-symbol). The
        presence of an authoritative registry disambiguates them.
        """
        if self._is_assets_uninitialized_error(exc):
            return True
        return (
            self._available_assets is None
            and "assets not found" in str(exc).lower()
        )

    @staticmethod
    async def _is_invalid_asset_error(exc: BaseException) -> bool:
        """True when the client rejects a specific asset name."""
        text = str(exc).lower()
        return any(marker in text for marker in _ASSET_REJECTION_MARKERS)

    @staticmethod
    def _asset_type(symbol: str, asset: Optional[str]) -> str:
        """Classify a resolved stream from the broker's OWN asset spelling.

        A dynamic pair outside the hard-coded OTC set may resolve to an
        ``_otc`` instrument; stamping it "forex" would mix the two pricing
        venues downstream. The resolved asset wins over the static guess.
        """
        if asset and broker_symbol_is_otc(asset):
            return "otc"
        return asset_type_for_symbol(symbol)

    async def _wait_for_assets_quiet(self, client, timeout: float = 5.0) -> bool:
        """Best-effort ``wait_for_assets`` nudge used while the registry warms."""
        try:
            await asyncio.wait_for(
                client.wait_for_assets(timeout=timeout),
                timeout=timeout + 1.0,
            )
            return True
        except Exception:  # noqa: BLE001 - the caller retries the list itself
            return False

    async def _load_available_assets(self, client) -> Optional[set[str]]:
        """Fetch the session's server-authoritative asset symbols (cached).

        Uses ``PocketOptionAsync.active_assets()`` — the exact list the broker
        validates subscriptions against — so we can resolve symbols against the
        broker's OWN spelling instead of reconstructing guesses. Retries a
        warming registry (``Assets not initialized yet``) a few times with a
        bounded ``wait_for_assets`` nudge.

        Returns ``None`` only when the list cannot be loaded at all. An empty
        set means "loaded, but no active assets" (a distinct, non-transient
        state the caller reports cleanly).
        """
        now = time.time()
        if self._available_assets is not None:
            # An empty registry is re-probed after a short cooldown so a
            # maintenance-window dump is picked up without a process restart.
            if self._available_assets or (now - self._assets_loaded_at) < 30:
                return self._available_assets
        elif now - self._assets_last_attempt_at < 2.0:
            # A recent load already failed; let the reader's backoff drive the
            # next attempt instead of re-running the retry budget per reader.
            return None
        self._assets_last_attempt_at = now

        last_exc: Optional[BaseException] = None
        for delay in _ASSET_LIST_RETRY_DELAYS:
            if delay:
                await asyncio.sleep(delay)
            try:
                active = await asyncio.wait_for(
                    client.active_assets(),
                    timeout=min(float(self.settings.connect_timeout), 20.0),
                )
            except Exception as exc:  # noqa: BLE001 - best-effort registry
                last_exc = exc
                self._assets_error = str(exc)
                if self._is_assets_uninitialized_error(exc):
                    await self._wait_for_assets_quiet(client)
                    continue
                logger.warning(
                    "active_assets() unavailable (%s) — resolving assets via "
                    "subscribe_symbol error handling instead", exc,
                )
                return None

            records = [
                a for a in (active or [])
                if isinstance(a, dict) and a.get("symbol")
            ]
            if not records:
                last_exc = RuntimeError("active_assets() returned no assets")
                self._assets_error = str(last_exc)
                await self._wait_for_assets_quiet(client)
                continue

            active_symbols: set[str] = set()
            index: Dict[str, Dict[str, str]] = {}
            inactive_index: Dict[str, Dict[str, str]] = {}
            record_map: Dict[str, Dict[str, object]] = {}
            for item in records:
                raw = str(item.get("symbol") or "").strip()
                canonical = canonical_active_asset(raw)
                if not raw or not canonical or "/" not in canonical:
                    continue
                if is_removed_symbol(canonical):
                    continue
                is_active = item.get("is_active", True)
                if isinstance(is_active, str):
                    is_active = is_active.strip().lower() not in {
                        "false", "0", "no", "off",
                    }
                else:
                    is_active = bool(is_active)

                is_otc = item.get("is_otc")
                if isinstance(is_otc, str):
                    is_otc = is_otc.strip().lower() in {"true", "1", "yes"}
                variant = (
                    "otc"
                    if bool(is_otc) or broker_symbol_is_otc(raw)
                    else "plain"
                )
                target = index if is_active else inactive_index
                target.setdefault(canonical, {}).setdefault(variant, raw)
                if is_active:
                    active_symbols.add(raw)

                if not is_active:
                    # Inactive variants remain resolvable as a last resort but
                    # must NOT be advertised to the backend: it would expose a
                    # symbol the bridge cannot stream.
                    continue
                asset_type = (
                    "otc" if variant == "otc"
                    else asset_type_for_symbol(canonical)
                )
                record = {
                    "symbol": canonical,
                    "name": canonical,
                    "label": f"{canonical}{' OTC' if asset_type == 'otc' else ''}",
                    "assetSubType": asset_type,
                    "type": "otc" if asset_type == "otc" else "forex",
                }
                # One registry entry per canonical pair, OTC preferred: the
                # backend keeps the first record and must never label an OTC
                # instrument as plain forex just because "EURUSD" sorted first.
                previous = record_map.get(canonical)
                if previous is None or (
                    asset_type == "otc"
                    and previous.get("assetSubType") != "otc"
                ):
                    record_map[canonical] = record

            self._asset_index = index
            self._asset_index_inactive = inactive_index
            self._available_asset_records = [
                record_map[key] for key in sorted(record_map)
            ]
            self._available_assets = active_symbols
            self._assets_loaded_at = time.time()
            self._assets_error = None
            logger.info(
                "asset registry loaded active=%d inactive=%d canonical=%d",
                len(active_symbols),
                sum(len(v) for v in inactive_index.values()),
                len(index),
            )
            return self._available_assets

        self._assets_error = str(last_exc) if last_exc else "asset registry unavailable"
        logger.warning(
            "active_assets() unavailable after %d attempts (%s) — deferring "
            "subscriptions until the broker registry is initialised",
            len(_ASSET_LIST_RETRY_DELAYS),
            last_exc,
        )
        return None

    async def _resolve_asset(self, client, symbol: str) -> Optional[str]:
        """Return the broker's OWN asset name for ``symbol``, or ``None``.

        Resolution prefers the venue implied by the symbol classification
        (OTC first for OTC pairs, bare first for standard forex) and falls back
        to the other spelling, then to inactive listings. Without an
        authoritative registry the primary candidate is returned so the
        subscribe error handler can distinguish a bad symbol from a warming
        registry.
        """
        canonical = canonical_symbol(symbol)
        candidates = list(asset_candidates(symbol))
        available = await self._load_available_assets(client)
        if available is None:
            return candidates[0] if candidates else None

        preferred = (
            ("otc", "plain")
            if asset_type_for_symbol(canonical) == "otc"
            else ("plain", "otc")
        )
        if canonical in REAL_FOREX_SYMBOLS:
            # These 5 pairs are ECB-sourced wholesale forex; their broker OTC
            # listing is a different instrument class and must never be used.
            preferred = ("plain",)
        for source in (self._asset_index, self._asset_index_inactive):
            slot = source.get(canonical) or {}
            for variant in preferred:
                raw = slot.get(variant)
                if raw:
                    return raw
            for raw in slot.values():
                if not raw:
                    continue
                if canonical in REAL_FOREX_SYMBOLS and broker_symbol_is_otc(raw):
                    continue
                return raw

        # Last resort: exact (case-insensitive) candidate match against the
        # active list, covering broker spellings that canonicalize differently.
        lowered = {str(item).lower(): str(item) for item in available}
        for candidate in candidates:
            raw = lowered.get(candidate.lower())
            if raw:
                return raw
        return None

    async def _subscribe_first_available(
        self, client, symbol: str, asset: str
    ):
        """Subscribe using the resolved asset, with bounded candidate fallback.

        A broker registry can rotate between resolution and subscribe (or list
        a different suffix for a dynamic pair). Each candidate is attempted
        once; a symbol that is genuinely absent is skipped per-symbol while an
        uninitialised registry is surfaced as transient so the reader retries.
        """
        attempts = [asset]
        for candidate in asset_candidates(symbol):
            if candidate not in attempts:
                attempts.append(candidate)

        last_exc: Optional[BaseException] = None
        for candidate in attempts:
            try:
                stream = await client.subscribe_symbol(candidate)
            except Exception as exc:  # noqa: BLE001 - classified below
                last_exc = exc
                if self._is_assets_not_ready_error(exc):
                    raise AssetsNotReadyError(symbol, str(exc)) from exc
                if not await self._is_invalid_asset_error(exc):
                    raise
                logger.warning(
                    "asset candidate '%s' rejected by broker for [%s] (%s) — "
                    "trying next candidate", candidate, symbol, exc,
                )
                continue
            if candidate != asset:
                logger.info(
                    "asset[%s] fallback %s -> %s (broker registry)",
                    symbol, asset, candidate,
                )
            return candidate, stream

        self._skipped[symbol] = asset
        raise AssetSkippedError(symbol, attempts) from last_exc

    @staticmethod
    def _is_transport_error(exc: Optional[BaseException]) -> bool:
        """True when a connect failure is a socket/handshake problem, NOT auth.

        The native SDK surfaces a blocked or slow websocket as
        ``PocketOptionError, General error: Connection initialization timed
        out`` — textually indistinguishable from a credential rejection at the
        boundary, but semantically a TRANSIENT transport condition. Treating it
        as an expired SSID halts every reader and surfaces
        ``session_expired`` for a perfectly valid credential.
        """
        if exc is None:
            return False
        if isinstance(exc, (asyncio.TimeoutError, TimeoutError, ConnectionError,
                            OSError)):
            return True
        text = f"{type(exc).__name__}: {exc}".lower()
        return any(marker in text for marker in _TRANSPORT_ERROR_MARKERS)

    @staticmethod
    def _extract_close_code(exc: Optional[BaseException]) -> Optional[int]:
        """Best-effort WebSocket close code from an SDK/websockets exception.

        ``websockets.ConnectionClosed`` exposes ``.code`` (and ``.rcvd.code``)
        directly; the native PO SDK mostly carries the code in its message, so
        a numeric scan is the fallback. Returns ``None`` when no code is
        available rather than inventing one.
        """
        if exc is None:
            return None
        for attr in ("code", "close_code"):
            value = getattr(exc, attr, None)
            if isinstance(value, int) and 1000 <= value <= 4999:
                return value
        for attr in ("rcvd", "sent"):
            frame = getattr(exc, attr, None)
            value = getattr(frame, "code", None) if frame is not None else None
            if isinstance(value, int) and 1000 <= value <= 4999:
                return value
        match = re.search(r"\b(1\d{3}|[2-4]\d{3})\b", str(exc))
        if match:
            code = int(match.group(1))
            if 1000 <= code <= 4999:
                return code
        return None

    def _classify_close(
        self, exc: Optional[BaseException], *, clean: bool = False
    ) -> int:
        """Map an exception/clean end onto an explicit WebSocket close code."""
        if clean:
            return WS_CLOSE_NORMAL
        if exc is not None and self._is_stream_timeout(exc):
            # Socket up, broker never streams: the session is not authorised.
            return WS_CLOSE_POLICY_VIOLATION
        code = self._extract_close_code(exc)
        if code is not None:
            return code
        text = f"{type(exc).__name__}: {exc}".lower() if exc is not None else ""
        if any(marker in text for marker in _POLICY_ERROR_MARKERS):
            return WS_CLOSE_POLICY_VIOLATION
        if any(marker in text for marker in _ABNORMAL_CLOSE_MARKERS):
            return WS_CLOSE_ABNORMAL
        return WS_CLOSE_ABNORMAL

    def _log_stream_close(
        self,
        symbol: str,
        code: int,
        exc: Optional[BaseException] = None,
        *,
        clean: bool = False,
    ) -> None:
        """Emit the explicit close-code line required by the runbook."""
        meaning = WS_CLOSE_MEANINGS.get(code, "unknown")
        detail = "" if exc is None else f" error={type(exc).__name__}: {exc}"
        if clean:
            logger.info(
                "FEED_STREAM_CLOSED symbol=%s code=%d meaning=%s (clean end)",
                symbol, code, meaning,
            )
        elif code in _TERMINAL_CLOSE_CODES:
            logger.error(
                "FEED_STREAM_CLOSED symbol=%s code=%d meaning=%s "
                "terminal_code=true%s",
                symbol, code, meaning, detail,
            )
        else:
            logger.warning(
                "FEED_STREAM_CLOSED symbol=%s code=%d meaning=%s%s",
                symbol, code, meaning, detail,
            )

    def _jitter(self, delay: float) -> float:
        """Apply +/- fractional jitter to a reconnect delay."""
        if delay <= 0:
            return 0.0
        spread = max(0.0, min(1.0, float(self.settings.reconnect_jitter)))
        if spread <= 0:
            return delay
        return delay + random.uniform(0.0, delay * spread)

    def _backoff_delay(self, attempt_index: int) -> float:
        """Exponential (base -> max) reconnect delay with randomized jitter."""
        base = max(0.05, float(self.settings.reconnect_base_delay))
        cap = max(base, float(self.settings.reconnect_max_delay))
        exponent = min(max(0, int(attempt_index)), 10)
        raw = min(cap, base * (2 ** exponent))
        return self._jitter(raw)

    async def _guarded_stream(self, symbol: str, stream):
        """Iterate a SDK tick stream, logging its explicit close code/meaning.

        A clean ``for`` exhaustion is a 1000 normal closure; any raised error is
        mapped (1006 abnormal, 1008 policy/session rejection, ...) BEFORE the
        reader loop applies its backoff, so the operator can tell a plain
        network drop from a broker-side authorization refusal.
        """
        try:
            async for tick in stream:
                yield tick
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - classified and re-raised
            self._log_stream_close(symbol, self._classify_close(exc), exc)
            raise
        else:
            self._log_stream_close(symbol, WS_CLOSE_NORMAL, clean=True)

    async def run_reader(self, symbol: str, asset: str) -> None:
        """Subscribe to raw ticks for one asset and feed the M20 engine.

        The broker's own asset list is consulted first: if no candidate for
        this symbol exists the reader raises :class:`AssetSkippedError` — one
        unsupported pair must never flip the whole bridge into
        ``connection_error`` or stop the pairs that DO work.
        """
        if is_removed_symbol(symbol):
            self._skipped[symbol] = "retired_pair"
            logger.info("SKIP [%s] pair retired from platform universe", symbol)
            return
        if not self.has_credential:
            # Clean degraded state: no stored session ssid AND no .env SSID.
            await self._set_status(
                "awaiting_session",
                "no session (po_session.json) and no POCKET_OPTION_SSID — "
                "refusing to fabricate prices",
            )
            return
        await self._ensure_connected()
        client = self.client
        if client is None or not self.is_connected:
            return
        if not self._assets_ready:
            # NEVER call subscribe_symbol() against an uninitialised registry:
            # the SDK raises General("Assets not found") for EVERY symbol,
            # which used to be misread as a global connection failure. Defer
            # instead; the reader loop backs off and retries after `ready`.
            detail = self._assets_error or "broker asset registry not initialised"
            logger.warning(
                "ASSETS_NOT_READY reader=%s detail=%s — deferring subscribe",
                symbol, detail,
            )
            raise AssetsNotReadyError(symbol, detail)
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
            asset, stream = await self._subscribe_first_available(
                client, symbol, asset
            )
        except (AssetSkippedError, AssetsNotReadyError):
            raise
        except Exception as exc:  # noqa: BLE001 - transport/subscribe failure
            logger.error("subscribe_symbol(%s) failed: %s", asset, exc)
            await self._set_status("connection_error", str(exc))
            return
        self._subs[symbol] = stream
        # Anchor the stall watchdog to the moment THIS subscription went live:
        # a fresh subscribe must get a full stale window before it is recycled.
        self._subscribed_at[symbol] = time.time()
        logger.info("SUBSCRIBED symbols=%s", sorted(self._subs))
        async for tick in self._guarded_stream(symbol, stream):
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
            # Any real tick proves the session is authorised for market data;
            # clear the no-data strike counter so a later isolated stall does
            # not inherit strikes from an earlier outage.
            self._stream_timeout_streak = 0
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
                        "asset_type": self._asset_type(symbol, asset),
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
                        "is_otc": self._asset_type(symbol, asset) == "otc",
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
        if is_removed_symbol(canonical):
            return {**base, "status": "subscribe_error",
                    "error": f"symbol {canonical!r} was retired from the universe"}

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
        if not self._assets_ready:
            return {
                **base,
                "status": "subscribe_error",
                "error": (
                    "broker asset registry not initialised yet — "
                    "the backend re-sends staged subscribes on `ready`"
                ),
            }

        # Resolve against the broker's OWN registry BEFORE spawning a reader,
        # so a dynamic OTC pair is armed with the exact listed symbol instead
        # of a reconstructed guess that fails with General("Assets not found").
        resolved = await self._resolve_asset(self.client, canonical)
        if resolved is None:
            return {
                **base,
                "status": "subscribe_error",
                "error": f"broker does not list an asset for {canonical}",
            }
        asset_type = self._asset_type(canonical, resolved)
        base["asset_type"] = asset_type

        # Dynamically register the feed + spawn a dedicated reader for it.
        self.engine.ensure_feed(canonical, asset_type)
        asset = self._assets.get(canonical)
        if not asset or asset != resolved:
            asset = resolved
            self._assets[canonical] = asset
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
        """Serialised connect/asset-initialisation gate.

        Every reader calls this concurrently at startup. Without the lock each
        call built its own ``PocketOptionAsync``, tore down the others'
        half-initialised clients, and then raced into ``subscribe_symbol`` with
        an empty asset map — the exact ``Assets not initialized yet`` ->
        ``Assets not found`` cascade seen in production.
        """
        async with self._connect_lock:
            await self._ensure_connected_locked()

    async def _ensure_connected_locked(self) -> None:
        """Connect (or reconnect) the PO client with transient-error awareness.

        On a clean break or network drop the old half-open socket is
        immediately released and a brand-new ``PocketOptionAsync`` (which
        authenticates on construction) is created.  Up to
        ``TRANSIENT_CONNECT_ATTEMPTS`` fresh constructions are attempted with a
        geometric back-off so a brief network hiccup self-heals without ever
        flipping into a terminal ``session_expired`` state that could appear
        to be an SSID ban.  Only once every attempt has failed is the SSID
        declared dead and the error escalated.

        A handshake that never completed (``General error: Connection
        initialization timed out`` and friends) is TRANSPORT, not credential,
        so it is reported as ``connection_error`` and the bounded reader backoff
        keeps retrying with a rotated endpoint order — escalating it to
        ``session_expired`` would wrongly declare a live SSID dead and halt
        every reader.
        """
        # The Python-side deadline must never be tighter than the SDK's own
        # handshake budget, or ``asyncio.wait_for`` cancels a connection that
        # the native core is still legitimately initialising (that race is what
        # surfaced as a per-symbol crash loop).
        connect_deadline = (
            max(self.settings.connect_timeout, self.settings.po_init_timeout)
            + CONNECT_DEADLINE_GRACE
        )
        if self.is_connected:
            # The whole point of `ready` is that assets are initialised — the
            # Node backend gates its staged subscribes on it. A concurrent
            # reader that finds the socket connected but assets not yet loaded
            # must NEVER race forward into subscribe_symbol with an empty map.
            if self._assets_ready:
                return
            await self._load_available_assets(self.client)
            if self._available_assets:
                await self._set_status("connected")
                await self._mark_ready()
                self._rearm_dynamic_readers()
                return
            # No sleep/wait here: this branch holds ``_connect_lock``, so no
            # other task can flip ``_assets_ready`` while we wait. Return
            # immediately and let the reader's bounded backoff retry the load;
            # serialising 20 readers behind a 5s wait each caused a long stall.
            logger.warning(
                "ASSETS_NOT_READY detail=%s — deferring subscribes and "
                "retrying on the reader backoff",
                self._assets_error or "empty asset list",
            )
            return
        if not self.has_credential:
            await self._set_status(
                "awaiting_session",
                "no session (po_session.json) and no POCKET_OPTION_SSID — "
                "refusing to fabricate prices",
            )
            return
        last_error: Optional[str] = None
        last_error_class: Optional[str] = None
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
                    client.wait_for_assets(timeout=connect_deadline),
                    timeout=connect_deadline,
                )
                if not client.is_connected():
                    raise RuntimeError(
                        "client not connected after wait_for_assets "
                        "(dead channel reused)"
                    )
                break
            except Exception as exc:  # noqa: BLE001 - retried transiently below
                last_error = str(exc)[:500]
                last_error_class = type(exc).__name__
                self._last_transport_error = exc
                # PART 44 [498] — log the EXCEPTION CLASS and the REGIONAL WS
                # endpoint(s)/rotation for the current attempt, so a
                # "PocketOptionError, General error: Connection initialization
                # timed out" is diagnosable at the log line: which region was
                # tried and whether the order had already been rotated onto a
                # different regional host. `rotate=N` is set on attempt 1 (0 =
                # SDK default order) and increments once per failed attempt.
                urls = list(self.settings.urls)
                endpoint_ref = urls or "(sdk default regional list)"
                logger.error(
                    "auth_response=%s class=%s urls=%s rotate=%s",
                    last_error, last_error_class, endpoint_ref,
                    self._endpoint_rotation,
                )
                logger.warning(
                    "auth_attempt[%d/%d] failed reason=%s class=%s urls=%s "
                    "rotate=%s — releasing stale client and retrying transient",
                    attempt, TRANSIENT_CONNECT_ATTEMPTS, last_error,
                    last_error_class, endpoint_ref, self._endpoint_rotation,
                )
                # Rotate the endpoint order so the next attempt starts on a
                # different regional host — a handshake block is bypassed in
                # one attempt instead of costing the full budget every time.
                self._endpoint_rotation = (
                    self._endpoint_rotation + 1
                    if len(self.settings.urls) > 1
                    else self._endpoint_rotation
                )
                try:
                    await client.disconnect()
                except Exception:  # noqa: BLE001 - best-effort teardown
                    pass
                self.client = None
                self._transient_connect_retries = attempt
                if attempt < TRANSIENT_CONNECT_ATTEMPTS:
                    connect_delay = self.settings.reconnect_delay * attempt
                    if connect_delay > 0:
                        await asyncio.sleep(self._jitter(connect_delay))
        if not self.is_connected:
            logger.error(
                "auth_failed reason=%s class=%s", last_error, last_error_class,
            )
            if self._is_transport_error(self._last_transport_error):
                # TRANSPORT, not credential: a blocked/slow handshake, a
                # filtered regional host or a dropped socket. Declaring
                # session_expired here is what turned every reader into a
                # silent dead task, so surface a retryable connection_error and
                # let the reader's bounded backoff retry — the SSID is fine.
                urls = list(self.settings.urls)
                logger.warning(
                    "connect_failed reason=%s class=%s urls=%s rotate=%s — "
                    "transient transport failure, keeping readers armed for "
                    "retry (not session_expired)",
                    last_error, last_error_class,
                    urls or "(sdk default regional list)",
                    self._endpoint_rotation,
                )
                await self._set_status(
                    "connection_error",
                    f"{last_error} (handshake/transport — retrying)",
                )
                return
            await self._enter_session_expired(last_error or "authentication failed")
            return
        self.connected_at = time.time()
        self.connect_epoch += 1
        self._transient_connect_retries = 0
        logger.info("AUTH_SUCCESS uid=%s isDemo=%s", mask_uid(self.settings.uid), self.settings.is_demo)
        logger.info("auth_response=authenticated and assets_ready pending")
        # Load the authoritative asset list NOW, while the client is
        # guaranteed authenticated, so no later active_assets() call can hit
        # the "Uninitialized, Assets not initialized yet" transient — every
        # reader consumes the warm cache instead of re-querying mid-flight.
        await self._load_available_assets(client)
        if not self._available_assets:
            # NEVER advertise `ready` (or subscribe) before the registry is
            # populated: doing so made the backend release staged subscribes
            # into General("Assets not found") for every symbol.
            logger.warning(
                "AUTH_OK_ASSETS_PENDING — broker asset registry not initialised "
                "(%s); readers will retry instead of subscribing",
                self._assets_error or "empty asset list",
            )
            await self._set_status(
                "connecting",
                "broker asset registry not initialised — retrying",
            )
            return
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
        self._subscribed_at.pop(canonical, None)
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
            self.engine.ensure_feed(symbol, self._asset_type(symbol, asset))
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
        self._subscribed_at.clear()
        self._assets_ready = False
        self._available_assets = None
        self._available_asset_records = []
        self._asset_index = {}
        self._asset_index_inactive = {}
        self._assets_error = None
        self._assets_loaded_at = 0.0
        self._assets_last_attempt_at = 0.0
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
        self._subscribed_at.clear()
        self._reader_symbols.clear()
        self._assets_ready = False
        self._available_assets = None
        self._available_asset_records = []
        self._asset_index = {}
        self._asset_index_inactive = {}
        self._assets_error = None
        self._assets_loaded_at = 0.0
        self._assets_last_attempt_at = 0.0
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
            # Adopt it on the SETTINGS too. `self.settings.ssid` was frozen from
            # os.environ at import time and `_auth_payload()` prefers it over
            # `self.session`, so without this the bridge kept authenticating with
            # the expired boot token and the refresh had no effect at all -
            # i.e. the refresh only ever worked when the env var was empty.
            if env_ssid and self.settings.adopt_ssid(env_ssid):
                logger.info(
                    "SSID_ADOPTED_FROM_ENV uid=%s is_demo=%s format=%s",
                    mask_uid(self.settings.uid),
                    self.settings.is_demo,
                    self.settings.ssid_format,
                )
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

    @staticmethod
    def _is_stream_timeout(exc: BaseException) -> bool:
        """True when the SDK reports a subscription that never produced data.

        These are NOT transport crashes: the socket is up but the broker never
        pushes a tick, which means the session is not authorised for market
        data (expired/incomplete ssid). Reconnecting cannot fix that.
        """
        text = str(exc).lower()
        return any(marker in text for marker in _STREAM_TIMEOUT_MARKERS)

    def _stream_progressed(self, auth_epoch: int, tick_seq: int) -> bool:
        """True when a reader authenticated or received ticks since it started.

        This is the anti-stuck signal for the reconnect ladder: a stream that
        genuinely progressed must restart at the 1s backoff, not inherit the
        60s cap from a previous outage (the old "reconnect every 60s" loop).
        """
        return self.connect_epoch != auth_epoch or self._tick_seq > tick_seq

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
            auth_epoch = self.connect_epoch
            tick_seq = self._tick_seq
            subscribed_at = self._subscribed_at.get(symbol, 0.0)
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
            except AssetsNotReadyError as exc:
                # TRANSIENT: the socket/registry is still warming up. Keep the
                # client (do NOT release it — a concurrent connect may be in
                # flight) and retry on the bounded ladder. This is what prevents
                # General("Assets not found") from becoming a global outage.
                logger.warning(
                    "reader(%s) deferred: %s — retrying after registry warm-up",
                    symbol, exc,
                )
                await self._set_status(
                    "connecting", "broker asset registry not initialised — retrying"
                )
                await asyncio.sleep(self._backoff_delay(delay_index))
                delay_index = min(delay_index + 1, 10)
                continue
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
                await asyncio.sleep(
                    self._jitter(self.settings.reconnect_max_delay)
                )
                continue
            except Exception as exc:  # noqa: BLE001 - reconnect forever
                # Permanent SSID rejection: every sanitizer/forced-header
                # fallback already failed, so retrying the SAME bytes can only
                # produce an infinite crash loop (and look like brute force).
                # Stop the ladder and request exactly one fresh capture.
                if self._ssid_parse_terminal:
                    if self._retry_stopped:
                        return
                    logger.critical(
                        "SSID_PARSE_FAILED_TERMINAL reader=%s — all repair "
                        "strategies were rejected; stopping retries and "
                        "requesting a fresh session capture",
                        symbol,
                    )
                    await self._enter_session_expired(str(exc))
                    return
                # Broker accepted the socket but never pushed a tick. That is
                # NOT a transport crash: the session authenticates yet is not
                # authorised for market data (expired/incomplete SSID). The SDK
                # waits 60s per attempt, so an endless per-symbol retry is both
                # useless and ban-risky. Trip terminal only when NO tick has
                # arrived anywhere, and only after N consecutive strikes.
                if self._is_stream_timeout(exc) and self._tick_seq == tick_seq:
                    self._stream_timeout_streak += 1
                    logger.warning(
                        "FEED_STALL_TIMEOUT reader=%s streak=%d/%d - broker "
                        "socket is up but sent no ticks (session may be "
                        "expired or missing ssid authorisation)",
                        symbol,
                        self._stream_timeout_streak,
                        STREAM_TIMEOUT_STREAK_LIMIT,
                    )
                    if self._stream_timeout_streak >= STREAM_TIMEOUT_STREAK_LIMIT:
                        logger.critical(
                            "FEED_STALL_TERMINAL - no ticks after %d attempts; "
                            "stopping retries to request a fresh session capture",
                            self._stream_timeout_streak,
                        )
                        await self._enter_session_expired(str(exc))
                        return
                else:
                    self._stream_timeout_streak = 0
                # Genuine crash (network loss, malformed stream, dead SDK
                # channel): back off geometrically, bounded by
                # reconnect_max_delay — but NEVER permanently stall, so a plate
                # that recovers is still picked up. Release the broken client
                # so the next loop-gate rebuilds a fresh auth instead of
                # re-using a half-open socket.
                close_code = self._classify_close(exc)
                logger.warning(
                    "reader(%s) crashed: %s (close_code=%d meaning=%s)",
                    symbol, exc, close_code,
                    WS_CLOSE_MEANINGS.get(close_code, "unknown"),
                )
                if self._stream_progressed(auth_epoch, tick_seq):
                    if delay_index:
                        logger.info(
                            "FEED_BACKOFF_RESET reader=%s — auth/ticks "
                            "progressed, restarting ladder at 1s", symbol,
                        )
                    delay_index = 0
                try:
                    await self._release_client()
                except Exception:  # noqa: BLE001 - teardown must not mask
                    pass
                await self._set_status("connection_error", str(exc))
                delay = self._backoff_delay(delay_index)
                logger.info(
                    "FEED_RECONNECTING attempt=%d close_code=%d backoff_s=%.2f "
                    "jitter=%.2f",
                    delay_index + 1, close_code, delay,
                    self.settings.reconnect_jitter,
                )
                await asyncio.sleep(delay)
                delay_index = min(delay_index + 1, 10)
                continue
            # run_reader returned CLEANLY — that is a NORMAL disconnect / stop
            # (no exception, e.g. broker stream ended or session dropped).
            # Reconnect IMMEDIATELY at the base cadence and RESET the backoff so
            # the bridge never lingers in the "stuck at 60s forever" state after
            # a transient drop: reconnect is instant and self-healing.
            if self._stream_progressed(auth_epoch, tick_seq):
                if delay_index:
                    logger.info(
                        "FEED_BACKOFF_RESET reader=%s — stream had produced "
                        "progress, restarting ladder at 1s", symbol,
                    )
                delay_index = 0
            else:
                resubscribed = (
                    self._subscribed_at.get(symbol, 0.0) > subscribed_at
                )
                if (
                    resubscribed
                    and self._tick_seq == tick_seq
                    and not self._first_tick.is_set()
                ):
                    # A stream that subscribed, ended without a single tick and
                    # was never authorised for market data is the same signature
                    # as a stream timeout. Count it, so an unusable credential
                    # stops after the strike limit instead of re-subscribing
                    # every ~60s forever.
                    self._stream_timeout_streak += 1
                    logger.warning(
                        "FEED_STALL_STREAM_END reader=%s streak=%d/%d — stream "
                        "ended without a tick (session may be unauthorised)",
                        symbol,
                        self._stream_timeout_streak,
                        STREAM_TIMEOUT_STREAK_LIMIT,
                    )
                    if self._stream_timeout_streak >= STREAM_TIMEOUT_STREAK_LIMIT:
                        logger.critical(
                            "FEED_STALL_TERMINAL - no ticks after %d stream "
                            "attempts; stopping retries to request a fresh "
                            "session capture",
                            self._stream_timeout_streak,
                        )
                        await self._enter_session_expired(
                            "stream ended without ticks"
                        )
                        return
            logger.info("FEED_DISCONNECTED reason=stream_ended close_code=%d",
                        WS_CLOSE_NORMAL)
            delay = self._backoff_delay(delay_index)
            logger.info(
                "FEED_RECONNECTING attempt=%d backoff_s=%.2f jitter=%.2f",
                delay_index + 1, delay, self.settings.reconnect_jitter,
            )
            await asyncio.sleep(delay)
            delay_index = min(delay_index + 1, 10)

    async def stop(self) -> None:
        for task in (
            self._heartbeat_task,
            self._tick_watch_task,
            self._session_watch_task,
            self._refresh_task,
            self._recovery_task,
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
        self._recovery_task = None
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()
        self._reader_symbols.clear()
        self._subscribed_at.clear()
        self._assets_ready = False
        self._available_assets = None
        self._available_asset_records = []
        self._asset_index = {}
        self._asset_index_inactive = {}
        self._assets_error = None
        self._assets_loaded_at = 0.0
        self._assets_last_attempt_at = 0.0
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
        """Periodic keepalive + liveness watchdog for the AUTHED stream.

        Every ``heartbeat_interval`` (25s by default) this:
          1. sends a raw Socket.IO keepalive to Pocket Option so the server's
             ~60s idle cutoff can never expire a quiet-but-live socket;
          2. recycles a half-open client (``is_connected() == False``) instead
             of waiting for each reader to crash independently;
          3. recycles a connected-but-silent stream after
             ``stream_stale_after`` (50s) with no ticks, before the server's
             own 60s timeout fires;
          4. relays a ``heartbeat`` frame with counters so the Node backend can
             apply its heartbeat-age rule.

        A 5s probe cadence checks staleness/half-open sockets; the PO
        keepalive and relay heartbeat remain 25s. The client recycle
        deliberately does NOT clear the M20 engine, ``_dynamic_symbols`` or
        ``_reader_symbols``: dynamic OTC pairs keep their state and are re-armed
        by ``_ensure_connected`` on the next successful auth.
        """
        interval = max(5.0, float(self.settings.heartbeat_interval))
        check_every = min(5.0, interval)
        next_keepalive = time.monotonic() + interval
        while True:
            await asyncio.sleep(check_every)
            now = time.monotonic()
            keepalive_due = now >= next_keepalive
            if keepalive_due:
                next_keepalive = now + interval
            try:
                await self._heartbeat_tick(
                    send_keepalive=keepalive_due,
                    emit=keepalive_due,
                )
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one bad probe must not stop it
                logger.exception("heartbeat probe failed")

    async def _heartbeat_tick(
        self, *, send_keepalive: bool = True, emit: bool = True
    ) -> None:
        """Run one keepalive/staleness probe (testable without sleeping)."""
        total = sum(self._tick_count.values())
        last_ts = max(self._last_tick_source_ts.values(), default=0)
        subscribed = ",".join(sorted(self._subs.keys())) or "(none)"
        wall_now = time.time()
        last_tick_age_s: Optional[float] = None

        connected = False
        try:
            connected = self.is_connected
        except Exception:  # noqa: BLE001 - a broken SDK must not kill the probe
            connected = False

        keepalive_ok: Optional[bool] = None
        if send_keepalive and connected and self.client is not None:
            try:
                await self.client.send_raw_message(self.settings.keepalive_message)
                keepalive_ok = True
                self._last_keepalive_at = wall_now
            except Exception as exc:  # noqa: BLE001 - recycle below
                keepalive_ok = False
                logger.warning(
                    "HEARTBEAT_KEEPALIVE_FAIL message=%s error=%s — "
                    "releasing half-open client for clean re-auth",
                    self.settings.keepalive_message, exc,
                )
                await self._release_client()
                if self.status == "connected":
                    await self._set_status(
                        "connection_error",
                        f"heartbeat keepalive failed: {exc}",
                    )
                connected = False
        elif self.client is not None and not connected and self.status == "connected":
            logger.warning(
                "HEARTBEAT_SOCKET_CLOSED is_connected=False — "
                "releasing client so readers rebuild the socket"
            )
            await self._release_client()
            await self._set_status(
                "connection_error", "socket closed — reconnecting"
            )

        if self._last_tick_ts:
            newest = max(self._last_tick_ts.values())
            last_tick_age_s = max(0.0, wall_now - newest)

        # Per-symbol stream watchdog. A connected socket with live subscriptions
        # but no ticks for a full stale window is dead even if is_connected()
        # still lies. Measured from max(last tick, subscription armed at) so a
        # freshly armed symbol gets one full window before being recycled.
        stale_window = float(self.settings.stream_stale_after)
        global_newest = max(self._last_tick_ts.values(), default=None)
        stalled_ages: Dict[str, float] = {}
        if connected and self._subs:
            for symbol in list(self._subs):
                tick_at = self._last_tick_ts.get(symbol)
                subscribed_at = self._subscribed_at.get(symbol)
                if tick_at is not None and subscribed_at is not None:
                    anchor = max(tick_at, subscribed_at)
                elif subscribed_at is not None:
                    anchor = subscribed_at
                elif tick_at is not None:
                    anchor = tick_at
                else:
                    # Canonicalisation mismatch (or a legacy caller that did not
                    # arm _subscribed_at): fall back to the global newest tick so
                    # a silent tape is still detected.
                    anchor = global_newest
                if anchor is None:
                    continue
                age = max(0.0, wall_now - anchor)
                if age >= stale_window:
                    stalled_ages[symbol] = age

        if stalled_ages:
            stall_age = max(stalled_ages.values())
            logger.warning(
                "WATCHDOG_STALLED symbols=%s no_ticks_for=%.1fs threshold=%.1fs — "
                "clean disconnect -> re-auth -> resubscribe "
                "(engine/dynamic OTC state preserved)",
                ",".join(sorted(stalled_ages)), stall_age, stale_window,
            )
            await self._release_client()
            await self._set_status(
                "stalled",
                f"no ticks for {stall_age:.0f}s — reconnecting",
            )
            connected = False
            self._schedule_stall_recovery(list(stalled_ages))

        if not emit:
            return
        logger.info(
            "HEARTBEAT interval_s=%.0f ticks_received=%d last_tick_ts=%s "
            "last_tick_age_s=%s symbols_subscribed=%s keepalive=%s status=%s",
            self.settings.heartbeat_interval,
            total,
            last_ts,
            f"{last_tick_age_s:.1f}" if last_tick_age_s is not None else "n/a",
            subscribed,
            keepalive_ok,
            self.status,
        )
        cb = self.on_heartbeat
        if cb is not None:
            try:
                await cb({
                    "status": self.status,
                    "ticks_received": total,
                    "last_tick_ts": last_ts,
                    "last_tick_age_s": last_tick_age_s,
                    "heartbeat_interval_s": self.settings.heartbeat_interval,
                    "keepalive_ok": keepalive_ok,
                    "symbols_subscribed": subscribed,
                })
            except Exception:  # noqa: BLE001 - a broken heartbeat relay must
                # never kill the liveness probe loop.
                logger.exception("heartbeat relay failed")

    def _schedule_stall_recovery(self, symbols: list[str]) -> None:
        """Schedule a clean re-auth/resubscribe cycle after a stall.

        The heartbeat probe stays fast (it must not block on a 90s handshake),
        so the actual teardown/reconnect runs in a dedicated task. It is only
        scheduled when reader tasks exist — without readers there is nothing to
        resubscribe and the next connect will arm them normally.
        """
        if not self._reader_tasks:
            return
        if self._recovery_task is not None and not self._recovery_task.done():
            logger.info(
                "STALL_RECOVERY_ALREADY_RUNNING symbols=%s",
                ",".join(sorted(symbols)),
            )
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover - no loop => nothing to schedule
            return
        self._recovery_task = loop.create_task(
            self._recover_after_stall(symbols)
        )

    async def _recover_after_stall(self, symbols: list[str]) -> None:
        """Clean disconnect -> re-authenticate -> resubscribe every symbol."""
        async with self._recovery_lock:
            logger.warning(
                "STALL_RECOVERY_BEGIN symbols=%s — disconnecting, "
                "re-authenticating, resubscribing",
                ",".join(sorted(symbols)),
            )
            try:
                await self._teardown_client()
                await self._ensure_connected()
                # Re-arm BOTH sets: teardown cancelled every reader, including
                # dynamic OTC pairs armed by a browser subscription push.
                self._start_static_readers()
                for symbol in list(self._dynamic_symbols):
                    self._assets.setdefault(symbol, asset_for_symbol(symbol))
                self._rearm_dynamic_readers()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - readers retry themselves
                logger.error(
                    "STALL_RECOVERY_FAILED error_type=%s error=%s — "
                    "readers will continue their own bounded backoff",
                    type(exc).__name__, exc,
                )
                return
            if self.is_connected:
                logger.info(
                    "STALL_RECOVERY_COMPLETE symbols=%s",
                    ",".join(sorted(self._subs)) or "(pending readers)",
                )
            else:
                logger.warning(
                    "STALL_RECOVERY_DEFERRED — re-auth did not complete; "
                    "readers will retry on the exponential ladder"
                )
