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
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except Exception:  # pragma: no cover - dotenv is optional at runtime
    pass

logger = logging.getLogger("pocket_bridge.config")


def parse_ssid(value: str) -> dict:
    """Return the canonical Pocket Option auth fields from either SSID form."""
    raw = (value or "").strip()
    if raw.startswith("'") and raw.endswith("'"):
        raw = raw[1:-1].strip()
    elif raw.startswith('"') and raw.endswith('"'):
        raw = raw[1:-1].strip()
    raw = raw.strip()
    if not raw:
        return {}
    if not raw.startswith("42["):
        return {
            "session": raw,
            "isDemo": int(os.getenv("POCKET_OPTION_IS_DEMO", "0")),
            "uid": int(os.getenv("POCKET_OPTION_UID", "0")),
            "platform": 2,
            "isFastHistory": True,
        }
    try:
        message = json.loads(raw[2:])
        if (
            not isinstance(message, list)
            or len(message) != 2
            or message[0] != "auth"
            or not isinstance(message[1], dict)
            or not message[1].get("session")
        ):
            raise ValueError("expected 42[\"auth\",{...}]")
        payload = dict(message[1])
        payload.setdefault("uid", int(os.getenv("POCKET_OPTION_UID", "0")))
        payload.setdefault("isDemo", int(os.getenv("POCKET_OPTION_IS_DEMO", "0")))
        payload.setdefault("platform", 2)
        payload.setdefault("isFastHistory", True)
        return payload
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        logger.critical(
            "invalid POCKET_OPTION_SSID value=%s error=%s",
            mask_secret(raw, 16),
            exc,
        )
        raise ValueError(
            "POCKET_OPTION_SSID must be a raw session or valid 42[auth,...] message"
        ) from exc


def auth_message(auth: dict) -> str:
    return "42" + json.dumps(["auth", auth], separators=(",", ":"))

# ════════════════════════════════════════════════════════════════════
# PERSISTED BROWSER SESSION (manual capture -> reuse)
# ════════════════════════════════════════════════════════════════════
SESSION_DIR = Path(__file__).resolve().parents[1] / "session"
PO_SESSION_PATH: str = os.getenv(
    "PO_SESSION_PATH", str(SESSION_DIR / "po_session.json")
)
"""Path to the manually-captured Pocket Option browser session (cookies +
localStorage + sessionStorage + user-agent). Captured once by
``session/capture_session.py``; refreshed by ``session/refresh_ssid.py``."""


def mask_secret(value: str, head: int = 8) -> str:
    """Mask a secret to its first ``head`` characters — never a full value."""
    s = str(value or "")
    return s[:head] + "..." if s else "(empty)"


def _fernet():
    """Optional Fernet ring (PO_SESSION_KEY) for encrypting the session file."""
    key = os.getenv("PO_SESSION_KEY", "").strip()
    if not key:
        return None
    try:
        from cryptography.fernet import Fernet

        return Fernet(key.encode("ascii"))
    except Exception:  # noqa: BLE001 - encryption is best-effort only
        return None


def decrypt_session_data(raw: str) -> str:
    """Decrypt ``FERNET:``-prefixed session bytes; passthrough for plaintext."""
    f = _fernet()
    if f is None or not raw.startswith("FERNET:"):
        return raw
    try:
        return f.decrypt(raw[len("FERNET:") :].encode("ascii")).decode("utf-8")
    except Exception:  # noqa: BLE001 - fall back to plaintext payload
        return raw


def encrypt_session_data(text: str) -> str:
    """Encrypt to ``FERNET:`` (only when PO_SESSION_KEY is configured)."""
    f = _fernet()
    if f is None:
        return text
    return "FERNET:" + f.encrypt(text.encode("utf-8")).decode("ascii")


def atomic_write_text(path: Path, text: str, mode: int = 0o600) -> None:
    """Write ``text`` to ``path`` atomically; mask world-read on POSIX (0600)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    if os.name == "posix":
        os.chmod(tmp, mode)
    os.replace(tmp, path)
    if os.name == "posix":
        try:
            os.chmod(path, mode)
        except OSError:  # noqa: BLE001 - non-fatal on host platforms
            pass


def write_env_ssid(env_path: Path, ssid: str) -> None:
    """Atomically set POCKET_OPTION_SSID in an .env file.

    Every other key, comment and ordering is preserved; the SSID line is
    replaced in place (or appended when absent). The bridge refreshes the SSID
    through this single writer so the file is never left half-updated.
    """
    env_path = Path(env_path)
    value = (ssid or "").strip()
    if value.startswith("'") and value.endswith("'"):
        value = value[1:-1].strip()
    elif value.startswith('"') and value.endswith('"'):
        value = value[1:-1].strip()
    quoted = f"POCKET_OPTION_SSID='{value}'"
    existing = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    out: List[str] = []
    replaced = False
    for line in existing:
        name = ""
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            name = stripped.split("=", 1)[0].strip()
        if name == "POCKET_OPTION_SSID":
            out.append(quoted)
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(quoted)
    atomic_write_text(env_path, "\n".join(out) + "\n")


def read_env_ssid(env_path: Path) -> str:
    """Read the POCKET_OPTION_SSID value currently on disk in an .env file.

    Used after a refresh (which may run inside a read-only-mounted container)
    so the bridge can adopt the freshly written SSID even when the session
    FILE could not be rotated.
    """
    env_path = Path(env_path)
    if not env_path.is_file():
        return ""
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        name, _, value = stripped.partition("=")
        if name.strip() == "POCKET_OPTION_SSID":
            return value.strip()
    return ""


@dataclass
class StoredSession:
    """The persisted browser session captured by ``capture_session.py``.

    Fields mirror ``po_session.json`` (Playwright storage_state plus extra keys):
    cookies, origins/localStorage, sessionStorage, userAgent, capturedAt.
    """

    path: Path
    cookies: List[Dict[str, Any]] = field(default_factory=list)
    origins: List[Dict[str, Any]] = field(default_factory=list)
    session_storage: Dict[str, List[Dict[str, str]]] = field(default_factory=dict)
    user_agent: str = ""
    captured_at: str = ""
    raw_ssid: str = ""
    #: Full parsed ``42["auth",{...}]`` payload when known (e.g. the .env
    #: fallback once parsed), so a rebuild of the auth message NEVER drops
    #: extra keys such as ``isOptimized``.
    auth_seed: Dict[str, Any] = field(default_factory=dict)

    @property
    def exists(self) -> bool:
        return bool(self.path) and self.path.is_file()

    @property
    def session_file_present(self) -> bool:
        """MASTER MISSION 3.5 — explicit po_session.json presence flag."""
        return self.exists

    @property
    def has_ssid(self) -> bool:
        return bool(self.raw_ssid)

    @property
    def mtime(self) -> float:
        try:
            return self.path.stat().st_mtime
        except OSError:  # noqa: BLE001
            return 0.0

    @property
    def age_days(self) -> float:
        """Freshness in days since ``capturedAt`` (0 when unknown)."""
        if not self.captured_at:
            return 0.0
        try:
            captured = datetime.fromisoformat(
                self.captured_at.replace("Z", "+00:00")
            )
            return max(
                0.0,
                (datetime.now(timezone.utc) - captured).total_seconds() / 86_400.0,
            )
        except (ValueError, TypeError):
            return 0.0

    def mask(self, value: str, head: int = 8) -> str:
        return mask_secret(value, head)

    def cookie_header(self) -> str:
        """HTTP ``Cookie`` header built from live (non-expired) stored cookies."""
        parts = []
        now = time.time()
        for c in self.cookies:
            if not isinstance(c, dict) or not c.get("name"):
                continue
            value = c.get("value")
            if value in (None, ""):
                continue
            expires = c.get("expires")
            if isinstance(expires, (int, float)) and expires > 0 and expires < now:
                continue  # never send an expired cookie
            parts.append(f"{c['name']}={value}")
        return "; ".join(parts)

    def as_auth(self) -> Dict[str, Any]:
        """Build the ``42["auth",{...}]`` payload to send to Pocket Option.

        When the full parsed message is known (``auth_seed`` from the env
        SSID) it is returned VERBATIM — every key (including ``isOptimized``)
        is preserved. Otherwise (cookie-only session) the session value is
        reconstructed with the standard env-managed metadata as defaults.
        """
        if self.auth_seed:
            auth = dict(self.auth_seed)
            if self.raw_ssid:
                auth["session"] = self.raw_ssid
            return auth
        if not self.raw_ssid:
            return {}
        base: Dict[str, Any] = {"session": self.raw_ssid}
        base.setdefault("isDemo", int(os.getenv("POCKET_OPTION_IS_DEMO", "0")))
        base.setdefault("uid", int(os.getenv("POCKET_OPTION_UID", "0")))
        base.setdefault("platform", 2)
        base.setdefault("isFastHistory", True)
        return base

    def auth_payload(self) -> str:
        auth = self.as_auth()
        return auth_message(auth) if auth.get("session") else ""


def session_reload_needed(stored: StoredSession, last_mtime: float) -> bool:
    """True when ``po_session.json`` changed on disk since ``last_mtime``."""
    if not stored.exists:
        return False
    try:
        return stored.mtime != last_mtime
    except OSError:  # noqa: BLE001
        return False


def load_stored_session(
    path: Path | str | None = None,
    fallback_env: bool = True,
) -> StoredSession:
    """Load the persisted session (cookies / user-agent / ssid) from disk.

    ``ssid`` is extracted from the ``ssid`` cookie captured on
    ``pocketoption.com``. When no ``ssid`` cookie exists but ``fallback_env`` is
    set, the bridge's existing ``POCKET_OPTION_SSID`` path stays available.
    Returns an empty (non-existent) session when the file is missing.
    """
    resolved = Path(
        str(path or PO_SESSION_PATH).strip() or PO_SESSION_PATH
    ).expanduser().resolve()
    session = StoredSession(path=resolved)
    if not resolved.is_file():
        if fallback_env:
            env_ssid = (os.getenv("POCKET_OPTION_SSID") or "").strip()
            try:
                parsed = parse_ssid(env_ssid)
            except ValueError:
                parsed = {}
            if parsed:
                # Keep the FULL parsed payload (all keys, incl. isOptimized)
                # so any later auth rebuild is byte-faithful, never a subset.
                session.auth_seed = dict(parsed)
                session.raw_ssid = parsed.get("session", "")
        return session
    try:
        raw = resolved.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):  # noqa: BLE001
        return session
    data = decrypt_session_data(raw)
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            return session
    if not isinstance(data, dict):
        return session
    session.cookies = [
        c for c in (data.get("cookies") or []) if isinstance(c, dict)
    ]
    session.origins = [
        o for o in (data.get("origins") or []) if isinstance(o, dict)
    ]
    session.session_storage = data.get("sessionStorage") or {}
    session.user_agent = str(data.get("userAgent") or "")
    session.captured_at = str(data.get("capturedAt") or "")
    for c in session.cookies:
        if c.get("name") == "ssid" and c.get("value"):
            session.raw_ssid = str(c["value"])
            break
    return session

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
    ssid: str = field(
        default_factory=lambda: (os.getenv("POCKET_OPTION_SSID", "") or "")
        .strip()
        .strip("'\"")
        .strip()
    )

    auth: dict = field(init=False, repr=False)

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
    relay_host: str = field(default_factory=lambda: os.getenv("POCKET_BRIDGE_HOST", "0.0.0.0"))
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

    #: Path to the persisted browser session (see PO_SESSION_PATH).
    session_path: str = field(
        default_factory=lambda: os.getenv("PO_SESSION_PATH", "")
    )
    #: How often refresh_ssid.py is re-run (seconds).
    session_refresh_interval: float = field(
        default_factory=lambda: float(
            os.getenv("PO_SESSION_REFRESH_INTERVAL", "1800")
        )
    )
    #: Age (days) after which a captured session is treated as stale.
    session_max_age_days: int = field(
        default_factory=lambda: int(os.getenv("PO_SESSION_MAX_AGE_DAYS", "7"))
    )
    #: Run refresh_ssid.py once at startup (only when a session file exists).
    refresh_at_startup: bool = field(
        default_factory=lambda: os.getenv("PO_REFRESH_AT_STARTUP", "1").strip()
        .lower()
        in {"1", "true", "yes", "on"}
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
    def ssid_format(self) -> str:
        return "full" if self.ssid.startswith("42[") else "raw"

    @property
    def uid(self) -> int:
        return int(self.auth.get("uid", 0) or 0)

    @property
    def is_demo(self) -> int:
        return int(self.auth.get("isDemo", 0) or 0)

    @property
    def platform(self) -> int:
        return int(self.auth.get("platform", 2) or 2)

    @property
    def is_fast_history(self) -> bool:
        return bool(self.auth.get("isFastHistory", True))

    def __post_init__(self) -> None:
        object.__setattr__(self, "auth", parse_ssid(self.ssid))

    @property
    def auth_payload(self) -> str:
        return auth_message(self.auth)

    @property
    def num_symbols(self) -> int:
        return len(self.symbols)

    @property
    def session_path_resolved(self) -> Path:
        """Absolute po_session.json path (explicit PO_SESSION_PATH or default)."""
        if self.session_path and self.session_path.strip():
            return Path(self.session_path).expanduser().resolve()
        return Path(PO_SESSION_PATH).expanduser().resolve()

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
