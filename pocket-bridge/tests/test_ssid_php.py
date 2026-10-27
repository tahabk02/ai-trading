"""Real-account PHP session normalization for BinaryOptionsToolsV2.

The Rust SDK's PHP parser trusts the declared ``a:N`` count. Pocket Option can
append fields while the header still says ``a:4``, which makes the SDK fail with
``Expected '}' but got 's'`` at the first extra string key. These tests pin the
count correction, field preservation, and supported wrapper fallbacks.
"""

from __future__ import annotations

import json
from urllib.parse import quote

from pocket_bridge.config import (
    auth_message,
    normalize_php_session,
    parse_ssid,
)

SESSION_ID = "0123456789abcdef0123456789abcdef"
IP_ADDRESS = "0.0.0.0"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
)
HASH = "00000000000000000000000000000000"

CANONICAL = (
    'a:4:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:111:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";'
    's:13:"last_activity";i:1732926685;}'
) + HASH

MISMATCHED = (
    'a:4:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:111:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";'
    's:13:"last_activity";i:1732926685;'
    's:9:"device_id";s:5:"abcde";}'
) + HASH

MISMATCHED_FIXED = MISMATCHED.replace("a:4:{", "a:5:{", 1)
TOO_HIGH = CANONICAL.replace("a:4:{", "a:6:{", 1)

#: Production-shaped 264-character session: 48-char UA + device_id under a
#: stale a:4 header.
MISMATCHED_264 = (
    'a:4:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:48:"' + ("x" * 48) + '";'
    's:13:"last_activity";i:1732926685;'
    's:9:"device_id";s:5:"abcde";}'
) + HASH

#: Unknown PHP value type: strict tokenization fails, regex fallback must still
#: count the five top-level keys.
FALLBACK_ONLY = (
    'a:4:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:48:"' + ("x" * 48) + '";'
    's:13:"last_activity";i:1732926685;'
    's:9:"device_id";O:8:"stdClass":0:{};}'
) + HASH


def _frame(session: str, **overrides) -> str:
    auth = {
        "session": session,
        "uid": 12345678,
        "isDemo": 0,
        "platform": 2,
        "isFastHistory": True,
        "isOptimized": True,
        **overrides,
    }
    return "42" + json.dumps(["auth", auth], separators=(",", ":"))


def test_extra_php_fields_are_preserved_while_count_is_corrected():
    normalized = normalize_php_session(MISMATCHED)
    assert normalized == MISMATCHED_FIXED
    assert 's:9:"device_id";s:5:"abcde";' in normalized
    assert normalized.endswith(HASH)


def test_count_that_is_too_high_is_corrected():
    assert normalize_php_session(TOO_HIGH) == CANONICAL


def test_264_char_production_session_count_is_recalculated():
    assert len(MISMATCHED_264) == 264
    normalized = normalize_php_session(MISMATCHED_264)
    assert normalized == MISMATCHED_264.replace("a:4:{", "a:5:{", 1)
    assert normalized.endswith(HASH)


def test_regex_fallback_counts_keys_when_strict_parser_fails():
    normalized = normalize_php_session(FALLBACK_ONLY)
    assert normalized.startswith("a:5:{")
    assert 's:9:"device_id";O:8:"stdClass":0:{};' in normalized


def test_raw_php_session_is_wrapped_with_real_account_metadata(monkeypatch):
    monkeypatch.setenv("POCKET_OPTION_UID", "12345678")
    monkeypatch.setenv("POCKET_OPTION_IS_DEMO", "0")

    auth = parse_ssid(MISMATCHED)

    assert auth["session"] == MISMATCHED_FIXED
    assert auth["uid"] == 12345678
    assert auth["isDemo"] == 0
    assert auth["platform"] == 2


def test_full_frame_with_mismatched_php_session_is_normalized(monkeypatch):
    monkeypatch.setenv("POCKET_OPTION_UID", "12345678")
    monkeypatch.setenv("POCKET_OPTION_IS_DEMO", "0")

    auth = parse_ssid(_frame(MISMATCHED, uid="12345678", isDemo="0"))

    assert auth["session"] == MISMATCHED_FIXED
    assert isinstance(auth["uid"], int)
    assert isinstance(auth["isDemo"], int)


def test_auth_message_never_forwards_the_bad_php_count():
    payload = auth_message(
        {"session": MISMATCHED, "uid": "12345678", "isDemo": "0", "platform": 2}
    )
    parsed = json.loads(payload[2:])
    assert parsed[0] == "auth"
    assert parsed[1]["session"] == MISMATCHED_FIXED


def test_frame_metadata_wins_over_a_broken_env_fallback(monkeypatch):
    monkeypatch.setenv("POCKET_OPTION_UID", "not-an-int")
    monkeypatch.setenv("POCKET_OPTION_IS_DEMO", "also-bad")

    auth = parse_ssid(_frame(MISMATCHED, uid="12345678", isDemo="0"))

    assert auth["uid"] == 12345678
    assert auth["isDemo"] == 0


def test_json_escaped_php_session_is_repaired():
    assert normalize_php_session(CANONICAL.replace('"', '\\"')) == CANONICAL


def test_url_encoded_php_session_is_repaired():
    encoded = quote(MISMATCHED, safe="")
    assert normalize_php_session(encoded) == MISMATCHED_FIXED


def test_canonical_session_is_idempotent():
    assert normalize_php_session(CANONICAL) == CANONICAL


def test_unparseable_php_is_left_for_the_sdk_error():
    broken = 'a:4:{s:10:"session_id";s:32:"0123456789abcdef";}'
    assert normalize_php_session(broken) == broken
    assert not broken.startswith("42[")
