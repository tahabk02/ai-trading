"""Tests for the browser-session persistence layer (capture once, reuse).

Covers the pieces that can be verified WITHOUT a browser or network:
  * loading the captured ``po_session.json`` (cookies / ssid / user-agent),
  * the ``Cookie`` header built from live cookies,
  * env-SSID fallback when no session file exists,
  * hot-reload change detection (mtime),
  * the raw SSID auth-payload parser,
  * the atomic ``POCKET_OPTION_SSID`` .env writer (refresh_ssid.py's core),
  * the bridge's fail-loud behavior with no credential at all,
  * the terminal ``session_expired`` + stop-retry path on auth failure.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pocket_bridge.bridge import PocketOptionBridge  # noqa: E402
from pocket_bridge.config import (  # noqa: E402
    BridgeSettings,
    load_stored_session,
    parse_ssid,
    session_reload_needed,
    write_env_ssid,
)
from pocket_bridge.m20_engine import M20Engine  # noqa: E402

# A realistic, FIXED (non-secret) ssid cookie captured from a session file.
SSID_VALUE = "ugjBRO5HNlUR=s7zjXv1aAm7LeLJYp6hKJxPN"


def _session_file(path: Path, ssid: str = SSID_VALUE) -> dict:
    return {
        "cookies": [
            {
                "name": "ssid",
                "value": ssid,
                "domain": ".pocketoption.com",
                "path": "/",
                "expires": -1,
                "httpOnly": True,
                "secure": True,
                "sameSite": "Lax",
            },
            {
                "name": "session-uid",
                "value": "138336943",
                "domain": ".pocketoption.com",
                "path": "/",
                "expires": -1,
                "httpOnly": False,
            },
            {
                "name": "expired-cookie",
                "value": "gone",
                "domain": ".pocketoption.com",
                "path": "/",
                "expires": 1_500_000_000,  # long past
            },
        ],
        "origins": [
            {
                "origin": "https://pocketoption.com",
                "localStorage": [{"name": "deviceId", "value": "abc123"}],
            }
        ],
        "sessionStorage": {"lang": "en"},
        "userAgent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        ),
        "capturedAt": "2026-09-13T10:00:00Z",
    }


def test_load_session_parses_cookies_and_ssid(tmp_path):
    session = _session_file(tmp_path / "po_session.json")
    (tmp_path / "po_session.json").write_text(json.dumps(session), encoding="utf-8")
    stored = load_stored_session(tmp_path / "po_session.json", fallback_env=False)
    assert stored.exists
    assert stored.has_ssid
    assert stored.raw_ssid == SSID_VALUE
    assert stored.captured_at == "2026-09-13T10:00:00Z"
    assert len(stored.cookies) == 3
    assert "Chrome/126" in stored.user_agent
    assert stored.session_storage.get("lang") == "en"
    assert stored.age_days > 0


def test_cookie_header_joins_non_expired(tmp_path):
    session = _session_file(tmp_path / "po_session.json")
    (tmp_path / "po_session.json").write_text(json.dumps(session), encoding="utf-8")
    stored = load_stored_session(tmp_path / "po_session.json", fallback_env=False)
    header = stored.cookie_header()
    # Expired cookie dropped, live ones joined.
    assert "expired-cookie=gone" not in header
    assert f"ssid={SSID_VALUE}" in header
    assert "session-uid=138336943" in header
    assert ";" in header


def test_no_session_file_falls_back_to_env_ssid(monkeypatch, tmp_path):
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    payload = '42["auth",{"session":"envSSID123","uid":138336943,"isDemo":1}]'
    monkeypatch.setenv("POCKET_OPTION_SSID", payload)
    stored = load_stored_session(tmp_path / "missing.json")
    assert not stored.exists
    assert stored.has_ssid
    assert stored.raw_ssid == "envSSID123"


def test_as_auth_returns_full_env_payload_with_is_optimized(monkeypatch, tmp_path):
    """FINAL MISSION — as_auth() sends the FULL parsed message (incl.
    isOptimized) when the .env SSID is the fallback, never a subset."""
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    payload = (
        '42["auth",{"session":"envFull123","uid":138336943,"isDemo":1,'
        '"platform":2,"isFastHistory":true,"isOptimized":true}]'
    )
    monkeypatch.setenv("POCKET_OPTION_SSID", payload)
    stored = load_stored_session(tmp_path / "missing.json")
    assert stored.has_ssid
    auth = stored.as_auth()
    assert auth["session"] == "envFull123"
    assert auth["isOptimized"] is True
    assert auth["isFastHistory"] is True
    assert auth["platform"] == 2
    assert auth["uid"] == 138336943


def test_reload_needed_detects_mtime_change(tmp_path):
    f = tmp_path / "po_session.json"
    f.write_text(json.dumps(_session_file(f)), encoding="utf-8")
    stored = load_stored_session(f, fallback_env=False)
    old_mtime = stored.mtime  # snapshot: .mtime is a live property
    assert not session_reload_needed(stored, old_mtime)
    assert session_reload_needed(stored, old_mtime - 10.0)
    # Model a capture refresh rewriting the file (new mtime).
    from os import utime

    f.write_text(json.dumps(_session_file(f)), encoding="utf-8")
    utime(f, (old_mtime + 2.0, old_mtime + 2.0))
    reloaded = load_stored_session(f, fallback_env=False)
    assert session_reload_needed(reloaded, old_mtime)


def test_ssid_extracted_from_full_auth_payload():
    payload = (
        '42["auth",{"session":"ugjBRO5HNlUR=s7zjXv1aAm7LeLJYp6hKJxPN",'
        '"uid":138336943,"isDemo":1}]'
    )
    parsed = parse_ssid(payload)
    assert parsed["session"] == SSID_VALUE
    assert parsed["uid"] == 138336943
    assert parsed["isDemo"] == 1


def test_refresh_writes_env_ssid_atomically(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "POCKET_BRIDGE_HOST=127.0.0.1\nPOCKET_BRIDGE_PORT=8788\n"
        "POCKET_OPTION_SSID=old-value\nTZ=UTC\n",
        encoding="utf-8",
)
    write_env_ssid(env, "new-value-123")
    assert env.exists()
    # Everything else preserved, SSID replaced in place (single-quoted, per
    # FINAL MISSION 1.2 — the writer always stores the quoted form).
    assert "POCKET_BRIDGE_HOST=127.0.0.1" in env.read_text(encoding="utf-8")
    assert "POCKET_OPTION_SSID=old-value" not in env.read_text(encoding="utf-8")
    assert (
        "POCKET_OPTION_SSID='new-value-123'"
        in env.read_text(encoding="utf-8")
    )
    assert env.read_text(encoding="utf-8").count("POCKET_OPTION_SSID=") == 1


def _settings(monkeypatch, tmp_path, **overrides) -> BridgeSettings:
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    monkeypatch.delenv("PO_SESSION_PATH", raising=False)
    env_path = str(tmp_path / "po_session.json")
    return BridgeSettings(symbols=[], session_path=env_path, **overrides)


def test_fails_loud_without_session_and_env(monkeypatch, tmp_path):
    """Any bridge start() with NO stored session AND no env SSID must land in
    ``awaiting_session`` (never fabricate prices), not crash or spin."""
    settings = _settings(monkeypatch, tmp_path, refresh_at_startup=False)
    engine = M20Engine([], max_history=10)
    bridge = PocketOptionBridge(settings, engine)
    stored = load_stored_session(settings.session_path_resolved, fallback_env=True)
    assert not stored.exists and not stored.has_ssid
    bridge.session = stored
    asyncio.run(bridge.start())
    assert bridge.status == "awaiting_session"
    assert "NO_SESSION" in bridge.last_error
    asyncio.run(bridge.stop())


def test_sets_session_expired_and_stops_retry_on_auth_failure(monkeypatch, tmp_path):
    """Auth failure MUST flip the terminal flag, stop reconnect retries and
    surface ``session_expired`` (the /health watchdog reads this)."""
    settings = _settings(monkeypatch, tmp_path, refresh_at_startup=False)
    bridge = PocketOptionBridge(settings, M20Engine([], max_history=10))
    # Claim a credential exists so the handler runs the expiry path (no file on
    # disk -> _run_refresh short-circuits without spawning a browser).
    bridge.session.raw_ssid = "not-a-real-ssid"
    bridge.session.cookies.append(
        {"name": "ssid", "value": "not-a-real-ssid", "domain": ".pocketoption.com"}
    )

    async def _no_refresh() -> bool:
        return False

    bridge._run_refresh = _no_refresh  # type: ignore[method-assign]
    asyncio.run(bridge._enter_session_expired("Invalid session"))
    assert bridge.session_expired is True
    assert bridge._retry_stopped is True
    assert bridge.status == "session_expired"

# ── MASTER MISSION 3.5 named tests ─────────────────────────────────


def test_session_file_loaded(tmp_path):
    """test_session_file_loaded — verify StoredSession.dataclass.load_stored_session() reads po_session.json
    and exposes all session fields including session_file_present."""
    from pocket_bridge.config import StoredSession

    data = _session_file(tmp_path / "po_session.json")
    (tmp_path / "po_session.json").write_text(json.dumps(data), encoding="utf-8")
    stored = load_stored_session(tmp_path / "po_session.json", fallback_env=False)
    assert stored.exists is True
    assert stored.session_file_present is True
    assert stored.has_ssid is True
    assert stored.raw_ssid == SSID_VALUE
    assert stored.user_agent.startswith("Mozilla/")
    assert len(stored.cookies) == 3
    assert stored.age_days >= 0


def test_cookie_header_built(tmp_path):
    """test_cookie_header_built — cookie_header() returns a semicolon-delimited string of
    name=value pairs, dropping expired cookies and including ssid + session-uid."""
    data = _session_file(tmp_path / "po_session.json")
    (tmp_path / "po_session.json").write_text(json.dumps(data), encoding="utf-8")
    stored = load_stored_session(tmp_path / "po_session.json", fallback_env=False)
    header = stored.cookie_header()
    assert isinstance(header, str)
    parts = [p.strip() for p in header.split(";") if p.strip()]
    names = [p.split("=", 1)[0] for p in parts]
    assert "ssid" in names
    assert "session-uid" in names
    assert "expired-cookie" not in names


def test_ssid_from_cookies(tmp_path):
    """test_ssid_from_cookies — raw_ssid is parsed out of the ssid cookie in po_session.json,
    NOT from the environment variable."""
    data = _session_file(tmp_path / "po_session.json", ssid="FROM_COOKIES_ONLY")
    (tmp_path / "po_session.json").write_text(json.dumps(data), encoding="utf-8")
    stored = load_stored_session(tmp_path / "po_session.json", fallback_env=False)
    assert stored.raw_ssid == "FROM_COOKIES_ONLY"
    assert stored.has_ssid is True
    assert stored.as_auth().get("session") == "FROM_COOKIES_ONLY"


# ── FINAL MISSION 1.7 named tests ─────────────────────────────────


def test_ssid_parses_raw_and_full():
    """test_ssid_parses_raw_and_full — parse_ssid() accepts BOTH forms:
    the raw session string (with or without quotes) and the full
    `42["auth",{...}]` WebSocket message, returning the canonical payload."""
    raw = parse_ssid(SSID_VALUE)
    assert raw["session"] == SSID_VALUE
    assert raw["platform"] == 2
    assert raw["isFastHistory"] is True

    single_quoted = parse_ssid(f"'{SSID_VALUE}'")
    assert single_quoted["session"] == SSID_VALUE

    double_quoted = parse_ssid(f'"{SSID_VALUE}"')
    assert double_quoted["session"] == SSID_VALUE

    full = parse_ssid(
        '42["auth",{"session":"' + SSID_VALUE + '","uid":138336943,"isDemo":1,'
        '"platform":2,"isFastHistory":true,"isOptimized":true}]'
    )
    assert full["session"] == SSID_VALUE
    assert full["uid"] == 138336943
    assert full["isDemo"] == 1
    assert full["platform"] == 2
    assert full["isFastHistory"] is True
    assert full["isOptimized"] is True

    assert parse_ssid("") == {}
    assert parse_ssid("   ") == {}


def test_ssid_missing_logs_critical(caplog):
    """test_ssid_missing_logs_critical — an unparseable POCKET_OPTION_SSID logs
    CRITICAL with a MASKED value (first 16 chars, never the full payload) and
    raises ValueError."""
    import pytest as _pytest

    from pocket_bridge.config import logger as config_logger
    import logging as _logging

    bad = '42["auth",{"session":]}'
    with caplog.at_level(_logging.CRITICAL, logger=config_logger.name):
        with _pytest.raises(ValueError):
            parse_ssid(bad)
    assert any(rec.levelno == _logging.CRITICAL for rec in caplog.records)
    assert "invalid POCKET_OPTION_SSID" in caplog.text
    assert bad not in caplog.text  # never the full raw payload in logs
    assert "..." in caplog.text  # masked head + ellipsis


def test_capture_writes_env_without_bom(tmp_path):
    """test_capture_writes_env_without_bom — write_env_ssid() persists
    POCKET_OPTION_SSID atomically as UTF-8 with NO BOM, preserving the other
    variables and ordering."""
    env = tmp_path / ".env"
    env.write_text(
        "POCKET_BRIDGE_HOST=127.0.0.1\nPOCKET_BRIDGE_PORT=8788\nTZ=UTC\n",
        encoding="utf-8",
    )
    write_env_ssid(env, "fresh-captured-ssid")
    raw = env.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")  # no UTF-8 BOM
    text = raw.decode("utf-8")
    assert "POCKET_OPTION_SSID='fresh-captured-ssid'" in text
    assert "POCKET_BRIDGE_HOST=127.0.0.1" in text
    assert "POCKET_BRIDGE_PORT=8788" in text
    # Old value fully replaced, exactly one SSID line.
    assert text.count("POCKET_OPTION_SSID=") == 1
