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

# ── Environment file isolation ───────────────────────────────────────────────
# `<repo>/pocket-bridge`, resolved from THIS file so it is cwd-independent.
# Only files inside pocket-bridge/ are read; the repository-root .env is a
# different service's configuration and is never consulted.
POCKET_BRIDGE_ROOT = Path(__file__).resolve().parents[1]


def _pocket_bridge_env_files() -> list[Path]:
    """pocket-bridge-local env files, HIGHEST precedence first.

    `load_dotenv` never overwrites an already-set variable, so loading
    high-to-low yields the intended precedence: a real environment variable
    (container / operator injected) beats every file, then `.env.local`, then
    `.env.<environment>`, then `.env`.
    """
    environment = os.environ.get("ENVIRONMENT") or os.environ.get("NODE_ENV") or "development"
    candidates = [
        POCKET_BRIDGE_ROOT / ".env.local",
        POCKET_BRIDGE_ROOT / f".env.{environment}",
        POCKET_BRIDGE_ROOT / ".env",
    ]
    return [p for p in candidates if p.is_file()]


try:
    from dotenv import load_dotenv
    for _env_file in _pocket_bridge_env_files():
        load_dotenv(_env_file, override=False)
    _PARENT_DOTENV = POCKET_BRIDGE_ROOT.parent / ".env"
    if _PARENT_DOTENV.is_file() and os.environ.get("POCKET_BRIDGE_ALLOW_PARENT_DOTENV") != "true":
        logging.getLogger("pocket_bridge.config").warning(
            "pocket-bridge: ignoring parent %s — it is another service's configuration. "
            "Set values in %s or the real environment.",
            _PARENT_DOTENV,
            POCKET_BRIDGE_ROOT / ".env",
        )
except Exception:  # pragma: no cover - dotenv is optional at runtime
    pass

logger = logging.getLogger("pocket_bridge.config")

DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"

#: A 25s application heartbeat keeps the PO socket alive well inside the
#: server's 60s idle window while avoiding the old 5s log/relay churn.
DEFAULT_HEARTBEAT_INTERVAL_SECS = 25.0
#: Reconnect before the server's ~60s idle timeout can kill a silent stream.
#: A 5s watchdog checks this, so a silent tape is recycled by ~55s worst case.
DEFAULT_STREAM_STALE_AFTER_SECS = 50.0
#: The SDK's native default is 60s, which is the exact timeout we must never
#: inherit again. Enforce a floor even if an older deployment exports 60.
MIN_PO_INIT_TIMEOUT_SECS = 90.0
DEFAULT_PO_KEEPALIVE_MESSAGE = '42["ping"]'


def resolve_user_agent(value: str | None) -> str:
    """Resolve unset or SDK-placeholder User-Agents to the pinned browser UA."""
    user_agent = (value or "").strip()
    if not user_agent or "(sdk default)" in user_agent.lower():
        return DEFAULT_UA
    return user_agent


class _PhpSessionParser:
    """Minimal, length-aware PHP container parser for Pocket Option sessions.

    The SDK's Rust parser trusts declared ``a:N`` / ``O:N`` headers and only
    supports PHP arrays at the top level. Pocket Option can emit a newer session
    with more fields while the header still says ``a:4``; PHP then expects ``}``
    after four entries and crashes on the fifth string key (``Expected '}' but
    got 's'``). It can also wrap newer metadata in PHP objects, or use a stale
    string byte-length. This parser consumes entries until the closing brace,
    accepts objects, and tolerates a string length that disagrees with the
    actual quoted payload so the session can be re-serialized canonically.
    """

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0
        self.depth = 0
        self.top_level_count = 0
        self.container_kind = ""
        self.repaired_strings = False

    def _expect(self, token: bytes) -> None:
        if not self.data.startswith(token, self.pos):
            raise ValueError("unexpected PHP session token")
        self.pos += len(token)

    def _read_until(self, delimiter: bytes) -> bytes:
        end = self.data.find(delimiter, self.pos)
        if end < 0:
            raise ValueError("unterminated PHP session value")
        value = self.data[self.pos:end]
        self.pos = end + len(delimiter)
        return value

    def _read_int(self, delimiter: bytes) -> int:
        raw = self._read_until(delimiter)
        if not raw.isdigit():
            raise ValueError("invalid PHP session integer")
        return int(raw)

    def _read_string(self) -> bytes:
        self._expect(b"s:")
        length = self._read_int(b":")
        self._expect(b'"')
        expected_end = self.pos + length
        if (
            expected_end <= len(self.data)
            and self.data.startswith(b'";', expected_end)
        ):
            end = expected_end
        else:
            end = self.data.find(b'";', self.pos)
            if end < 0:
                raise ValueError("unterminated PHP session string")
            self.repaired_strings = True
        value = self.data[self.pos:end]
        self.pos = end + 2
        return value

    def _read_object_name(self) -> bytes:
        length = self._read_int(b":")
        self._expect(b'"')
        end = self.pos + length
        if end > len(self.data):
            raise ValueError("invalid PHP object class length")
        value = self.data[self.pos:end]
        self.pos = end
        self._expect(b'":')
        return value

    def _read_entries(self) -> Dict[bytes, object]:
        entries: Dict[bytes, object] = {}
        count = 0
        while not self.data.startswith(b"}", self.pos):
            key = self._read_string()
            entries[key] = self._read_value()
            count += 1
            if count > 10_000:
                raise ValueError("PHP session array is too large")
        self._expect(b"}")
        return entries

    def _read_value(self) -> object:
        if self.data.startswith(b"s:", self.pos):
            return self._read_string()
        if self.data.startswith(b"i:", self.pos):
            self.pos += 2
            return int(self._read_until(b";"))
        if self.data.startswith(b"d:", self.pos):
            self.pos += 2
            return float(self._read_until(b";"))
        if self.data.startswith(b"b:", self.pos):
            self.pos += 2
            return self._read_until(b";") == b"1"
        if self.data.startswith(b"N;", self.pos):
            self.pos += 2
            return None
        if self.data.startswith(b"a:", self.pos):
            return self._read_array()
        if self.data.startswith(b"O:", self.pos):
            return self._read_object()
        raise ValueError("unsupported PHP session value")

    def _read_array(self) -> Dict[bytes, object]:
        top_level = self.depth == 0
        self.depth += 1
        self._expect(b"a:")
        self._read_int(b":")  # count is advisory only (see class docstring)
        self._expect(b"{")
        entries = self._read_entries()
        self.depth -= 1
        if top_level:
            self.container_kind = "array"
            self.top_level_count = len(entries)
        return entries

    def _read_object(self) -> Dict[bytes, object]:
        top_level = self.depth == 0
        self.depth += 1
        self._expect(b"O:")
        self._read_object_name()
        self._read_int(b":")  # property count is advisory only
        self._expect(b"{")
        entries = self._read_entries()
        self.depth -= 1
        if top_level:
            self.container_kind = "object"
            self.top_level_count = len(entries)
        return entries

    def parse(self) -> tuple[Dict[bytes, object], bytes]:
        if self.data.startswith(b"a:"):
            entries = self._read_array()
        elif self.data.startswith(b"O:"):
            entries = self._read_object()
        else:
            raise ValueError("unsupported PHP session container")
        return entries, self.data[self.pos:]


_PHP_REQUIRED_SESSION_FIELDS = frozenset(
    {
        b"session_id",
        b"ip_address",
        b"user_agent",
        b"last_activity",
    }
)


def _php_declared_count(text: str) -> Optional[int]:
    match = re.match(r"a:(\d+):", text)
    return int(match.group(1)) if match else None


def _php_session_header(text: str) -> str:
    match = re.match(r"([aO]):(\d+):", text)
    return f"{match.group(1)}:{match.group(2)}" if match else "unknown"


def _find_php_body(data: bytes) -> tuple[int, int]:
    """Return the opening/closing brace indexes of the first PHP body."""
    start = data.find(b"{")
    if start < 0:
        raise ValueError("missing PHP session body")
    depth = 0
    in_string = False
    for index in range(start, len(data)):
        char = data[index]
        if in_string:
            if char == 0x22:  # double quote
                in_string = False
            continue
        if char == 0x22:
            in_string = True
        elif char == 0x7B:  # {
            depth += 1
        elif char == 0x7D:  # }
            depth -= 1
            if depth == 0:
                return start, index
    raise ValueError("unterminated PHP session body")


def _skip_php_string(data: bytes, index: int) -> int:
    if not data.startswith(b"s:", index):
        raise ValueError("expected PHP string token")
    colon = data.find(b":", index + 2)
    if colon < 0 or not data[index + 2:colon].isdigit():
        raise ValueError("invalid PHP string length")
    length = int(data[index + 2:colon])
    quote = colon + 1
    if quote >= len(data) or data[quote:quote + 1] != b'"':
        raise ValueError("invalid PHP string opening quote")
    content = quote + 1
    expected = content + length
    if expected + 2 <= len(data) and data[expected:expected + 2] == b'";':
        return expected + 2
    closing = data.find(b'";', content)
    if closing < 0:
        raise ValueError("unterminated PHP string")
    return closing + 2


def _skip_php_value(data: bytes, index: int) -> int:
    if data.startswith(b"s:", index):
        return _skip_php_string(data, index)
    if data.startswith((b"i:", b"d:", b"b:"), index):
        end = data.find(b";", index)
        if end < 0:
            raise ValueError("unterminated PHP scalar")
        return end + 1
    if data.startswith(b"N;", index):
        return index + 2
    if data.startswith((b"a:", b"O:", b"C:"), index):
        _, end = _find_php_body(data[index:])
        next_index = index + end + 1
        if data[next_index:next_index + 1] == b";":
            next_index += 1
        return next_index
    if data.startswith((b"R:", b"r:"), index):
        end = data.find(b";", index)
        if end < 0:
            raise ValueError("unterminated PHP reference")
        return end + 1
    end = data.find(b";", index)
    if end < 0:
        raise ValueError("unknown PHP value")
    return end + 1


def _count_php_top_level_keys(data: bytes) -> int:
    """Count direct key/value entries, independent of nested values/types."""
    start, end = _find_php_body(data)
    index = start + 1
    count = 0
    while index < end:
        while index < end and data[index] in b" \t\r\n":
            index += 1
        if index >= end:
            break
        if data.startswith(b"s:", index):
            index = _skip_php_string(data, index)
        elif data.startswith(b"i:", index):
            end_key = data.find(b";", index)
            if end_key < 0 or end_key > end:
                raise ValueError("unterminated PHP integer key")
            index = end_key + 1
        else:
            raise ValueError("unexpected PHP session key token")
        count += 1
        while index < end and data[index] in b" \t\r\n":
            index += 1
        if index >= end:
            raise ValueError("PHP session key without value")
        index = _skip_php_value(data, index)
    return count


def _serialize_php_value(value: object) -> bytes:
    if isinstance(value, bytes):
        return b's:%d:"' % len(value) + value + b'";'
    if isinstance(value, bool):
        return b"b:1;" if value else b"b:0;"
    if isinstance(value, int):
        return b"i:%d;" % value
    if isinstance(value, float):
        return b"d:" + repr(value).encode("ascii") + b";"
    if value is None:
        return b"N;"
    if isinstance(value, dict):
        return _serialize_php_array(value)
    raise ValueError("unsupported PHP session value")


def _serialize_php_array(entries: Dict[bytes, object]) -> bytes:
    body = b"".join(
        _serialize_php_value(key) + _serialize_php_value(value)
        for key, value in entries.items()
    )
    return b"a:%d:{%s}" % (len(entries), body)


def _fix_php_session(text: str) -> tuple[str, _PhpSessionParser]:
    """Re-serialize a PHP session with correct headers and string lengths."""
    data = text.encode("utf-8", "surrogatepass")
    parser = _PhpSessionParser(data)
    entries, trailing = parser.parse()
    if not _PHP_REQUIRED_SESSION_FIELDS.issubset(entries):
        raise ValueError("incomplete PHP session")
    normalized = _serialize_php_array(entries) + trailing
    return normalized.decode("utf-8", "surrogatepass"), parser


def _fix_php_session_count_fallback(text: str) -> str:
    """Force an exact header count when the strict parser cannot tokenize.

    Counts direct top-level key/value entries with a brace/string-aware
    scanner, so nested arrays, objects, camelCase keys and unknown value types
    cannot inflate or suppress the count. The original body is preserved.
    """
    data = text.encode("utf-8", "surrogatepass")
    start, end = _find_php_body(data)
    body = data[start + 1:end]
    missing = [
        field.decode("ascii")
        for field in _PHP_REQUIRED_SESSION_FIELDS
        if b'"' + field + b'"' not in body
    ]
    if missing:
        raise ValueError(
            "incomplete PHP session (missing " + ", ".join(sorted(missing)) + ")"
        )
    actual = _count_php_top_level_keys(data)
    if actual < len(_PHP_REQUIRED_SESSION_FIELDS):
        raise ValueError("could not count PHP session entries")
    normalized = b"a:%d:{%s}" % (actual, body) + data[end + 1:]
    return normalized.decode("utf-8", "surrogatepass")


def _extract_php_session_text(value: str) -> str:
    """Strip wrappers/escaping and locate the actual PHP session header."""
    text = (value or "").lstrip("\ufeff").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        text = text[1:-1].strip()
    if not text:
        return text
    if text.startswith("42["):
        text = text[2:].strip()
    if text.startswith(("[", "{")):
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError, json.JSONDecodeError):
            parsed = None
        if isinstance(parsed, list) and len(parsed) >= 2:
            if parsed[0] == "auth" and isinstance(parsed[1], dict):
                parsed = parsed[1]
            elif (
                len(parsed) >= 3
                and parsed[0] in ("42", 42)
                and parsed[1] == "auth"
                and isinstance(parsed[2], dict)
            ):
                parsed = parsed[2]
        if isinstance(parsed, dict):
            for key in ("session", "ssid"):
                if isinstance(parsed.get(key), str) and parsed[key].strip():
                    text = parsed[key].strip()
                    break
    if not re.match(r"(?:a|O):", text):
        if "%3" in text.upper():
            try:
                from urllib.parse import unquote

                text = unquote(text)
            except Exception:  # noqa: BLE001 - best-effort unwrapping
                pass
        match = re.search(r"(?:a|O):\d+:", text)
        if match:
            text = text[match.start():]
    return text


def force_php_array_header(value: str, count: int = 5) -> str:
    """Force a PHP array header while preserving the body and trailing hash.

    This is intentionally NOT part of normal normalization: forcing the wrong
    count corrupts the SDK parse. It exists only as a last-resort retry after
    the SDK has rejected an otherwise normalized frame.
    """
    if count < 0:
        raise ValueError("PHP array count must be non-negative")
    text = _extract_php_session_text(value)
    if not text or not re.match(r"(?:a|O):", text):
        return text
    data = text.encode("utf-8", "surrogatepass")
    try:
        start, end = _find_php_body(data)
    except ValueError:
        return text
    forced = b"a:%d:{%s}" % (count, data[start + 1:end]) + data[end + 1:]
    return forced.decode("utf-8", "surrogatepass")


def normalize_php_session(value: str) -> str:
    """Unconditionally repair a PHP object/array session for the Rust SDK.

    Strips outer wrappers, corrects stale ``a:N`` counts, converts PHP objects
    (including nested object-valued fields) to arrays, rewrites string
    byte-lengths from the actual quoted payload, and preserves the trailing
    32-hex hash. The strict parser is primary; a top-level key scanner forces
    the exact count when an unknown value type blocks full tokenization. A value
    that cannot be identified as a PHP session is returned unchanged.
    """
    text = _extract_php_session_text(value)
    if not text or not re.match(r"(?:a|O):", text):
        return text
    candidates = []
    if '\\"' in text:
        unescaped = text
        for _ in range(3):
            repaired = unescaped.replace('\\"', '"').replace("\\\\", "\\")
            if repaired == unescaped:
                break
            unescaped = repaired
            candidates.append(unescaped)
    candidates.append(text)
    seen = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            normalized, parser = _fix_php_session(candidate)
        except (TypeError, ValueError):
            try:
                normalized = _fix_php_session_count_fallback(candidate)
            except (TypeError, ValueError):
                continue
            parser = None
        before_header = _php_session_header(text)
        after_header = _php_session_header(normalized)
        if normalized != text:
            logger.warning(
                "PHP_SESSION_NORMALIZED - header=%s corrected=%s "
                "container=%s strings_repaired=%s "
                "(all session fields preserved)",
                before_header,
                after_header,
                parser.container_kind if parser else "forced-count",
                parser.repaired_strings if parser else False,
            )
        else:
            logger.debug(
                "PHP_SESSION_VERIFIED header=%s count=%s",
                after_header,
                _php_declared_count(normalized),
            )
        return normalized
    return text


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc


def _coerce_int(value: object, default: int, field: str) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Pocket Option auth field {field} must be an integer") from exc


def normalize_auth_fields(auth: dict) -> dict:
    """Normalize session + account metadata into the SDK's expected shape."""
    payload = dict(auth)
    session = payload.get("session")
    if isinstance(session, str):
        payload["session"] = normalize_php_session(session)

    uid = payload.get("uid")
    if uid is None or uid == "":
        uid = _env_int("POCKET_OPTION_UID", 0)
    payload["uid"] = _coerce_int(uid, 0, "uid")

    demo_value = payload.get("isDemo", payload.get("is_demo"))
    if demo_value is None or demo_value == "":
        demo_value = _env_int("POCKET_OPTION_IS_DEMO", 0)
    payload["isDemo"] = _coerce_int(demo_value, 0, "isDemo")
    payload.pop("is_demo", None)

    payload["platform"] = _coerce_int(payload.get("platform"), 2, "platform")
    payload.setdefault("isFastHistory", True)
    return payload


def parse_ssid(value: str) -> dict:
    """Return canonical auth fields from a raw session or any captured frame.

    Accepted forms: a bare session token, ``42["auth",{...}]``, ``["auth",{...}]``
    (the frame with the Socket.IO ``42`` prefix already stripped), and
    ``["42","auth",{...}]`` (a JSON-dumped capture). Raw tokens take ``uid`` /
    ``isDemo`` from the environment, which is why demo mode must be forwarded.
    """
    raw = (value or "").strip()
    if raw.startswith("'") and raw.endswith("'"):
        raw = raw[1:-1].strip()
    elif raw.startswith('"') and raw.endswith('"'):
        raw = raw[1:-1].strip()
    raw = raw.strip()
    if not raw:
        return {}
    if raw.startswith("42["):
        raw = raw[2:]

    if raw.startswith("["):
        try:
            message = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            logger.critical(
                "invalid POCKET_OPTION_SSID value=%s error=%s",
                mask_secret(raw, 16),
                exc,
            )
            raise ValueError(
                "POCKET_OPTION_SSID must be a raw session or valid 42[\"auth\",{...}] message"
            ) from exc

        payload = None
        if (
            isinstance(message, list)
            and len(message) == 2
            and message[0] == "auth"
            and isinstance(message[1], dict)
        ):
            payload = dict(message[1])
        elif (
            isinstance(message, list)
            and len(message) == 3
            and message[0] in ("42", 42)
            and message[1] == "auth"
            and isinstance(message[2], dict)
        ):
            payload = dict(message[2])

        if payload is None or not payload.get("session"):
            logger.critical(
                "invalid POCKET_OPTION_SSID value=%s error=%s",
                mask_secret(raw, 16),
                "expected 42[\"auth\",{...}]",
            )
            raise ValueError(
                "POCKET_OPTION_SSID must contain a 42[\"auth\",{...}] session"
            )

        return normalize_auth_fields(payload)

    if raw.startswith("{") or raw.startswith("]"):
        raise ValueError(
            "POCKET_OPTION_SSID looks like JSON but is not a 42[\"auth\",{...}] frame"
        )

    return normalize_auth_fields(
        {
            "session": raw,
            "isDemo": _env_int("POCKET_OPTION_IS_DEMO", 0),
            "uid": _env_int("POCKET_OPTION_UID", 0),
            "platform": 2,
            "isFastHistory": True,
        }
    )


def auth_message(auth: dict) -> str:
    """Serialize the ONLY frame BinaryOptionsToolsV2 accepts for auth.

    The session is normalized one final time HERE, synchronously at the
    packaging boundary, so no caller can hand a stale PHP header to the SDK.
    """
    raw_session = auth.get("session") if isinstance(auth, dict) else ""
    before = _php_session_header(raw_session) if isinstance(raw_session, str) else "unknown"
    normalized = normalize_auth_fields(auth)
    session = normalized.get("session")
    if isinstance(session, str) and session:
        session = normalize_php_session(session)
        normalized["session"] = session
        after = _php_session_header(session)
        if before != after:
            logger.warning(
                "AUTH_FRAME_SESSION_MUTATED before=%s after=%s len=%d",
                before,
                after,
                len(session),
            )
        logger.info(
            "AUTH_FRAME_PACKAGED session_header=%s declared=%s len=%d",
            after,
            _php_declared_count(session),
            len(session),
        )
    return "42" + json.dumps(
        ["auth", normalized],
        separators=(",", ":"),
    )


# ════════════════════════════════════════════════════════════════════
# CREDENTIAL LOGIN (LAST-RESORT SSID RECOVERY)
# ════════════════════════════════════════════════════════════════════
# The bridge authenticates with a captured SESSION, never a raw credential,
# and refreshes that session headlessly (see session/refresh_ssid.py). The
# credential login below is a DELIBERATE LAST RESORT used only when the stored
# session is dead and a fresh `42["auth",{...}]` frame cannot be captured — it
# is never attempted while the session path works, so the normal steady state
# never sends email/password anywhere.
#
# It is opt-in (PO_EMAIL_LOGIN=1) AND requires both PO_EMAIL and PO_PASSWORD
# AND a recorded written answer from Pocket Option on automated login
# (PO_TOS_CONSENT, PART 43.6 [482] — see docs/legal/po-automated-login-tos-consent.md).
# Keep them in the gitignored `pocket-bridge/.env` or—in a container—in mounted
# secret FILES (PO_EMAIL_FILE / PO_PASSWORD_FILE, PART 43.6 [481]); this
# repository's `.env.example` only documents the names.
CREDENTIAL_LOGIN_URL = "https://pocketoption.com/en/login"


def _bool_env(name: str, default: bool = False) -> bool:
    """Parse a boolean environment flag ("1"/"true"/"yes"/"on" -> True)."""
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def read_secret_file(path: Optional[str], fallback: str = "") -> str:
    """Read a mounted SECRET FILE (Docker secret / read-only volume).

    PART 43.6 [481]: the value travels as a *file's contents*, a path in the
    environment — never the secret itself in the env. The contents are returned
    trimmed and are NEVER logged. A missing/unreadable file falls back to
    ``fallback`` (used by the dev/local env form).
    """
    p = (path or "").strip()
    if not p:
        return fallback
    try:
        text = Path(p).read_text(encoding="utf-8")
        return text.strip()
    except OSError:
        return fallback


def resolve_secret(env_file: str, env_value: str) -> str:
    """File-mounted secret first, then the plain env value (dev fallback)."""
    file_val = read_secret_file(os.getenv(env_file, ""))
    if file_val:
        return file_val
    return (os.getenv(env_value, "") or "").strip()


@dataclass(frozen=True)
class CredentialLogin:
    """Resolved last-resort credential-login configuration.

    ``password`` is excluded from ``repr`` so a stray ``print(settings)`` or a
    logged exception can never leak it.
    """

    email: str = ""
    password: str = field(default="", repr=False)
    enabled: bool = False
    tos_consent: bool = False
    login_url: str = CREDENTIAL_LOGIN_URL
    timeout_s: float = 45.0

    @property
    def configured(self) -> bool:
        """True when BOTH halves of the credential are present."""
        return bool(self.email.strip() and self.password)

    @property
    def usable(self) -> bool:
        """Trimmed-down usable: opted-in AND fully configured AND the broker's
        written answer on automated login is recorded (PO_TOS_CONSENT, PART
        43.6 [482]). Without consent the tier is inert no matter the credentials."""
        return self.enabled and self.configured and self.tos_consent


def load_credential_login() -> CredentialLogin:
    """Read the last-resort credential-login settings from the environment.

    PART 43.6 [481]: in a container, ``PO_EMAIL``/``PO_PASSWORD`` come from
    mounted secret files (``PO_EMAIL_FILE``/``PO_PASSWORD_FILE`` — Docker
    secrets), never from the env or an image layer.
    """
    try:
        timeout = float(os.getenv("PO_LOGIN_TIMEOUT", "45"))
    except (TypeError, ValueError):
        timeout = 45.0
    return CredentialLogin(
        email=resolve_secret("PO_EMAIL_FILE", "PO_EMAIL"),
        password=resolve_secret("PO_PASSWORD_FILE", "PO_PASSWORD"),
        enabled=_bool_env("PO_EMAIL_LOGIN", False),
        tos_consent=_bool_env("PO_TOS_CONSENT", False),
        login_url=(os.getenv("PO_LOGIN_URL", "") or CREDENTIAL_LOGIN_URL).strip()
        or CREDENTIAL_LOGIN_URL,
        timeout_s=max(5.0, timeout),
    )


def credential_login_status() -> Dict[str, Any]:
    """Non-secret status for /health — never includes the credential itself."""
    cfg = load_credential_login()
    return {
        "credential_login_enabled": cfg.enabled,
        "credential_login_configured": cfg.configured,
        "credential_login_tos_consent": cfg.tos_consent,
        "credential_login_available": cfg.usable,
        "credential_login_email": mask_secret(cfg.email, 3),
    }


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


def mask_uid(value) -> str:
    """PART 44 [499] — mask a Pocket Option account id in logs/diagnostics.

    Shows at most the first three digits; the remainder (or every last digit
    when the id is ≤3 chars) is replaced with ``*``. Accounts never appear in
    full in any log line, and the result is deterministic for tests:
    ``138336943 → "138******"``, ``123 → "123*"``.
    """
    s = str(value if value is not None else "").strip()
    if not s:
        return "(empty)"
    return s[:3] + "*" * max(1, len(s) - 3)


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


SSID_FILE_ENV = "POCKET_OPTION_SSID_FILE"
_SSID_JSON_KEYS = ("POCKET_OPTION_SSID", "ssid", "value")


def normalize_ssid_value(value: str) -> str:
    """Trim file/env wrapping without touching the session frame internals."""
    text = (value or "").lstrip("\ufeff").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        text = text[1:-1].strip()
    return text


def _decode_ssid_payload(raw: str, depth: int = 0) -> str:
    """Decode a raw/file SSID payload, including optional wrapper/encryption.

    The frame is never rebuilt or unescaped here: a raw file is byte-faithful
    apart from a BOM, surrounding whitespace and optional outer quotes. JSON
    object wrappers (``{"ssid": "..."}`` / ``{"POCKET_OPTION_SSID": "..."}``)
    and Fernet-encrypted values are accepted for mounted secrets.
    """
    if depth > 3:
        raise ValueError("POCKET_OPTION_SSID_FILE wrapper nesting is too deep")
    text = normalize_ssid_value(raw)
    if not text:
        return ""
    if text.startswith("FERNET:"):
        decrypted = decrypt_session_data(text)
        if decrypted == text:
            raise ValueError(
                "POCKET_OPTION_SSID_FILE is encrypted but PO_SESSION_KEY is "
                "missing or invalid"
            )
        return _decode_ssid_payload(decrypted, depth + 1)
    if text.startswith("{"):
        try:
            wrapped = json.loads(text)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError(
                "POCKET_OPTION_SSID_FILE looks like JSON but is malformed"
            ) from exc
        if not isinstance(wrapped, dict):
            raise ValueError(
                "POCKET_OPTION_SSID_FILE JSON must be an object wrapper"
            )
        session = wrapped.get("session")
        if isinstance(session, str) and session.strip():
            auth_fields = {
                key: wrapped[key]
                for key in (
                    "session",
                    "uid",
                    "isDemo",
                    "platform",
                    "isFastHistory",
                    "isOptimized",
                )
                if key in wrapped
            }
            if len(auth_fields) > 1:
                return auth_message(normalize_auth_fields(auth_fields))
            return _decode_ssid_payload(session, depth + 1)
        for key in _SSID_JSON_KEYS:
            value = wrapped.get(key)
            if isinstance(value, str) and value.strip():
                return _decode_ssid_payload(value, depth + 1)
        raise ValueError(
            "POCKET_OPTION_SSID_FILE JSON must contain "
            "POCKET_OPTION_SSID/ssid/session/value"
        )
    return text


def read_ssid_file(path: str | Path) -> str:
    """Read the exact SSID payload from a mounted/read-only secret FILE."""
    resolved = Path(path).expanduser()
    if not resolved.is_absolute():
        resolved = POCKET_BRIDGE_ROOT / resolved
    try:
        raw = resolved.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise ValueError(
            f"POCKET_OPTION_SSID_FILE cannot be read: {resolved}"
        ) from exc
    value = _decode_ssid_payload(raw)
    if not value:
        raise ValueError(f"POCKET_OPTION_SSID_FILE is empty: {resolved}")
    return value


def load_ssid() -> str:
    """Resolve the SSID from a file FIRST, then the legacy environment value."""
    file_path = (os.getenv(SSID_FILE_ENV, "") or "").strip()
    if file_path:
        return read_ssid_file(file_path)
    return _decode_ssid_payload(os.getenv("POCKET_OPTION_SSID", "") or "")


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

    file_path = (os.getenv(SSID_FILE_ENV, "") or "").strip()
    if not file_path or not value:
        return
    target = Path(file_path).expanduser()
    if not target.is_absolute():
        target = POCKET_BRIDGE_ROOT / target
    if target.resolve() == env_path.resolve():
        return
    try:
        atomic_write_text(target, value + "\n")
    except OSError as exc:
        logger.warning(
            "POCKET_OPTION_SSID_FILE is not writable (%s) - rotated SSID "
            "persisted to %s only; update the mounted file before the next "
            "restart",
            target,
            env_path,
        )


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
        """Freshness in days since ``capturedAt``.

        FAILS CLOSED. A missing or unparseable ``capturedAt`` used to report
        ``0.0`` - indistinguishable from "captured just now" - so the
        ``PO_SESSION_MAX_AGE_DAYS`` guard silently accepted a session whose age
        it could not determine, i.e. exactly the case where the token is most
        likely to be expired. Unknown age is treated as infinitely old, so the
        caller refuses it and demands a fresh capture.
        """
        if not self.captured_at:
            return float("inf")
        try:
            captured = datetime.fromisoformat(
                self.captured_at.replace("Z", "+00:00")
            )
        except (ValueError, TypeError):
            logger.warning(
                "session_captured_at_unparseable age_reported=inf captured_at=%s",
                str(self.captured_at)[:64],
            )
            return float("inf")
        if captured.tzinfo is None:
            captured = captured.replace(tzinfo=timezone.utc)
        return max(
            0.0,
            (datetime.now(timezone.utc) - captured).total_seconds() / 86_400.0,
        )

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
# Standard (non-OTC) forex pairs resolve to the bare symbol. The classification
# below drives: (1) the `_otc` suffix priority
# in asset resolution, (2) the ``asset_type`` tag stamped on every relayed
# tick/candle so downstream services never mix OTC pricing into the standard
# forex pipeline or vice-versa.
OTC_FOREX_SYMBOLS: frozenset = frozenset({
    "EUR/USD", "USD/JPY", "USD/CHF", "USD/CAD",
    "AUD/USD", "EUR/JPY", "EUR/CHF",
    "EUR/AUD", "EUR/CAD", "AUD/JPY", "CAD/JPY",
    "CHF/JPY", "AUD/CAD", "AUD/CHF", "AUD/NZD", "NZD/CAD",
    "CAD/CHF",
    "EUR/RUB", "USD/TRY", "USD/MXN", "USD/SGD",
    "MAD/USD", "KES/USD",
})

# Pairs explicitly retired from the platform universe. They must never be
# subscribed, relayed, or exposed in the broker asset list again.
REMOVED_SYMBOLS: frozenset = frozenset({
    "USD/ZAR", "EUR/NOK", "EUR/DKK", "ETH/USD", "EUR/GBP",
    "GBP/USD", "GBP/JPY", "GBP/CHF", "GBP/AUD", "GBP/CAD",
    "NZD/USD", "BTC/USD", "EUR/TRY", "EUR/CZK", "EUR/PLN",
    "USD/SEK", "EUR/NZD", "NZD/JPY",
})

# ── REAL NON-OTC FOREX (PART 14) ──────────────────────────────────────
# Standard wholesale forex pairs resolved via the already-integrated ECB feed
# (Frankfurter + open.er-api), assetSubType "forex" — NOT the Pocket Option
# OTC venue. Classification is explicit so OTC vs standard-forex pricing never
# mixes on the relay.
REAL_FOREX_SYMBOLS: frozenset = frozenset({
    "EUR/SEK", "EUR/HUF", "USD/NOK", "USD/PLN", "USD/CZK",
})


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
    s = re.sub(r"[_\-\s]OTC$", "", s)
    s = re.sub(r"\s*OTC\s*$", "", s)
    s = s.replace("=X", "")
    s = s.replace(".FX", "").replace(".FOREX", "").replace(".CS", "").replace(".TO", "")
    s = re.sub(r"[-_.\s]+", "/", s)
    s = re.sub(r"/{2,}", "/", s).strip("/")
    # Compact 6-char form: "EURUSD" -> "EUR/USD" (mirrors the client normalizer).
    if "/" not in s and len(s) == 6 and s.isalpha():
        s = f"{s[:3]}/{s[3:]}"
    return s


def canonical_active_asset(raw: str) -> str:
    """Convert a broker asset name into a frontend/backend symbol key."""
    value = (raw or "").strip().upper()
    value = re.sub(r"[_\-\s]OTC$", "", value)
    return canonical_symbol(value)


def is_removed_symbol(symbol: str) -> bool:
    """True when ``symbol`` is a retired pair or a BTC/ETH quote variant."""
    canonical = canonical_symbol(symbol)
    if canonical in REMOVED_SYMBOLS:
        return True
    base = canonical.split("/", 1)[0]
    return base in {"BTC", "ETH"}


def asset_type_for_symbol(symbol: str) -> str:
    """Strict asset classification: ``forex`` | ``otc``.

    Every symbol that resolves to a Pocket Option OTC instrument is tagged
    ``otc`` (its OTC attribute is preserved explicitly). Standard wholesale
    forex pairs (non-OTC venue/pricing, including the 5 REAL_FOREX_SYMBOLS)
    are tagged ``forex``. Nothing is mixed across these classes.
    """
    if symbol.replace(" ", "").replace("/", "/").upper() in OTC_FOREX_SYMBOLS:
        return "otc"
    if symbol.upper() in REAL_FOREX_SYMBOLS:
        return "forex"
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

    Returns at least one candidate so the mapping never silently drops a
    configured symbol.
    """
    if is_removed_symbol(symbol):
        return []
    normalized = symbol.replace("/", "").upper()
    if asset_type_for_symbol(symbol) == "otc":
        return [f"{normalized}_otc", normalized]
    return [normalized]


def asset_for_symbol(symbol: str) -> str:
    """Map a backend symbol (e.g. "EUR/USD") to its preferred PO asset.

    OTC pairs resolve to the ``_otc`` form; standard forex resolves to the
    bare pair. Retired symbols return ``""``. Prefer :func:`asset_candidates`
    when the full priority list is needed to resolve against what the broker
    actually lists.
    """
    candidates = asset_candidates(symbol)
    return candidates[0] if candidates else ""


@dataclass(frozen=True)
class BridgeSettings:
    """Resolved runtime settings for the bridge process."""

    #: Full `42["auth",{...}]` session cookie for BinaryOptionsToolsV2.
    ssid: str = field(default_factory=load_ssid)

    auth: dict = field(init=False, repr=False)

    #: Comma-separated backend symbols the bridge must subscribe to.
    #:
    #: PART 38.2 — expanded from the original majors/crosses to every
    #: whitelist symbol Pocket Option's live ``active_assets()`` dump actually
    #: lists. Pairs PO does NOT list (USD/TRY, USD/MXN, USD/SGD, USD/NOK,
    #: USD/PLN, USD/CZK) are deliberately NOT added — a reader armed against
    #: an asset the broker has never heard of can only produce
    #: ``no_ssot_cache`` noise; those pairs must be served (and LABELLED) by
    #: the REST fallback tier instead. Retired pairs are never re-added.
    symbols: List[str] = field(default_factory=lambda: [
        # PO OTC majors / crosses
        "EUR/USD", "USD/JPY", "USD/CHF", "USD/CAD",
        "AUD/USD", "EUR/JPY", "EUR/CHF",
        "EUR/AUD", "EUR/CAD",
        "AUD/JPY", "AUD/CAD", "AUD/CHF", "NZD/CAD",
        # PART 38.2 — PO-listed whitelist symbols that were never subscribed
        "CAD/JPY", "CHF/JPY",
        "AUD/NZD", "CAD/CHF", "EUR/RUB", "MAD/USD", "KES/USD",
        # PART 38.2 — PO-listed standard-forex (non-OTC venue) pairs
        "EUR/SEK", "EUR/HUF",
    ])

    #: Reconnect / subscription tuning (seconds).
    connect_timeout: float = 60.0
    reconnect_delay: float = 5.0
    reconnect_max_delay: float = 60.0

    #: Active PO application heartbeat (seconds). The heartbeat is also
    #: relayed to the Node backend as a liveness frame, so this value must stay
    #: comfortably below the backend's heartbeat-age threshold.
    heartbeat_interval: float = field(
        default_factory=lambda: float(
            os.getenv(
                "POCKET_BRIDGE_HEARTBEAT_INTERVAL",
                str(DEFAULT_HEARTBEAT_INTERVAL_SECS),
            )
        )
    )

    #: Force a clean client recycle when a connected stream has produced zero
    #: ticks for this long. Set below the Pocket Option 60s idle cutoff so the
    #: bridge reconnects on its own terms instead of waiting for the socket to
    #: die. Per-symbol state and the dynamic OTC subscription set are retained.
    stream_stale_after: float = field(
        default_factory=lambda: float(
            os.getenv(
                "POCKET_BRIDGE_STREAM_STALE_SECS",
                str(DEFAULT_STREAM_STALE_AFTER_SECS),
            )
        )
    )

    #: Raw Socket.IO keepalive event sent to Pocket Option every heartbeat.
    keepalive_message: str = field(
        default_factory=lambda: (
            os.getenv("POCKET_OPTION_KEEPALIVE_MESSAGE", DEFAULT_PO_KEEPALIVE_MESSAGE)
            or DEFAULT_PO_KEEPALIVE_MESSAGE
        ).strip()
        or DEFAULT_PO_KEEPALIVE_MESSAGE
    )

    #: Local WebSocket relay the Node backend connects to.
    relay_host: str = field(default_factory=lambda: os.getenv("POCKET_BRIDGE_HOST", "0.0.0.0"))
    relay_port: int = field(default_factory=lambda: int(os.getenv("POCKET_BRIDGE_PORT", "8788")))

    #: Maximum number of M20 candles retained per symbol in the relay.
    max_m20_history: int = 500

    #: Candidate Pocket Option WebSocket server URLs (falls back to the SDK's
    #: own compiled regional list when empty).
    urls: List[str] = field(default_factory=lambda: [
        u for u in os.getenv("POCKET_OPTION_WS_URLS", "").split(",") if u.strip()
    ])

    #: User-Agent presented on the Pocket Option WebSocket handshake.
    #: Blank or unset values use a pinned browser fingerprint.
    user_agent: str = field(
        default_factory=lambda: resolve_user_agent(
            os.getenv("POCKET_OPTION_USER_AGENT")
        )
    )

    #: Native SDK handshake budget (seconds). The Rust core raises
    #: "General error: Connection initialization timed out" when the whole
    #: endpoint rotation has not authenticated inside this window; its default
    #: is only 60s, which a blocked/geo-sharded handshake can exhaust. MUST stay
    #: above the bridge's own wait so Python never cancels a live handshake.
    po_init_timeout: float = field(
        default_factory=lambda: float(os.getenv("POCKET_OPTION_INIT_TIMEOUT", "120"))
    )

    #: Per-socket request timeout handed to the SDK (seconds).
    po_request_timeout: float = field(
        default_factory=lambda: float(os.getenv("POCKET_OPTION_TIMEOUT_SECS", "30"))
    )

    #: Seconds the SDK waits before rotating to the next endpoint after a failed
    #: handshake. Kept short so a blocked host is bypassed quickly.
    po_reconnect_time: float = field(
        default_factory=lambda: float(os.getenv("POCKET_OPTION_RECONNECT_TIME", "3"))
    )

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
    def ssid_source(self) -> str:
        """Where boot credentials came from: file, env, or the session file."""
        if (os.getenv(SSID_FILE_ENV, "") or "").strip():
            return "file"
        if self.ssid.strip():
            return "env"
        return "session"

    @property
    def ssid_format(self) -> str:
        # Report the format actually SENT on the wire, not merely the shape of
        # the env string. ``_auth_payload`` falls back to a full
        # ``42["auth",{...}]`` frame built from the session cookie, so a
        # settings-level ``ssid`` of "" does NOT mean the bridge sends a raw
        # token - it means it sends a full frame sourced elsewhere. Reporting
        # "raw" there made /health and the boot log understate the payload and
        # actively misled anyone debugging an auth failure.
        if self.ssid.strip():
            return "full" if self.ssid.strip().startswith("42[") else "raw"
        return "full" if self.auth else "none"

    def adopt_ssid(self, raw: str) -> bool:
        """Adopt a freshly captured/refreshed SSID at runtime.

        ``BridgeSettings`` is a frozen dataclass built once from ``os.environ``
        at import time, and ``_auth_payload`` prefers ``self.settings.ssid`` over
        the reloaded session file. So a token rotated by ``capture_session.py`` /
        ``refresh_ssid.py`` wrote the new value to .env, but the running process
        kept authenticating with the token it booted with — the refresh silently
        had no effect for the rest of the process lifetime, which is precisely
        when a refresh matters most (the old token has expired).

        Both ``ssid`` and the derived ``auth`` are replaced together so the
        uid/isDemo/platform/isFastHistory properties stay consistent with the
        token actually in use. Returns False when the new value is unusable, in
        which case the caller keeps the previous credentials rather than
        downgrading to an unauthenticated frame.
        """
        value = (raw or "").strip().strip("'\"").strip()
        if not value:
            return False
        try:
            parsed = parse_ssid(value)
        except ValueError:
            return False
        if not parsed.get("session"):
            return False
        object.__setattr__(self, "ssid", value)
        object.__setattr__(self, "auth", parsed)
        return True

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
        # A 60s native handshake budget is the known regression that produced
        # the recurring "Connection initialization timed out" loop. Clamp it
        # even when an old .env/compose file still exports 60.
        if self.po_init_timeout < MIN_PO_INIT_TIMEOUT_SECS:
            object.__setattr__(self, "po_init_timeout", MIN_PO_INIT_TIMEOUT_SECS)
        if self.heartbeat_interval < 5.0:
            object.__setattr__(self, "heartbeat_interval", 5.0)
        # Leave at least two heartbeat windows for a quiet tape before treating
        # the stream as dead; otherwise a single missed frame causes churn.
        if self.stream_stale_after <= self.heartbeat_interval:
            object.__setattr__(
                self, "stream_stale_after", self.heartbeat_interval + 5.0
            )

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
        """Return `{backend_symbol: "otc"|"forex"}` classification."""
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
