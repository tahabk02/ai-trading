"""Real-account PHP session normalization for BinaryOptionsToolsV2.

The Rust SDK's PHP parser trusts declared ``a:N`` counts and string byte-lengths,
and accepts only arrays at the top level. Pocket Option can append fields while
the header still says ``a:4``, wrap fields in PHP objects, or emit a stale string
length, all of which can produce ``Expected '}' but got 's'``. These tests pin
count/length repair, object-to-array conversion, field preservation, and
supported wrapper fallbacks.
"""

from __future__ import annotations

import json
import logging
from urllib.parse import quote

from pocket_bridge.config import (
    auth_message,
    force_php_array_header,
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

#: Object-valued session: the Rust SDK only accepts a top-level PHP array.
OBJECT_SESSION = (
    'O:8:"stdClass":4:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:48:"' + ("x" * 48) + '";'
    's:13:"last_activity";i:1732926685;}'
) + HASH

OBJECT_SESSION_AS_ARRAY = 'a:4:{' + OBJECT_SESSION[len('O:8:"stdClass":4:{'):]

#: Nested object value: the SDK's parser supports nested arrays, not objects.
NESTED_OBJECT_FIELD = (
    'a:5:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:48:"' + ("x" * 48) + '";'
    's:13:"last_activity";i:1732926685;'
    's:9:"device_id";O:8:"stdClass":2:{s:1:"a";s:1:"b";s:1:"c";s:1:"d";}}'
) + HASH

NESTED_OBJECT_FIELD_FIXED = (
    'a:5:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:48:"' + ("x" * 48) + '";'
    's:13:"last_activity";i:1732926685;'
    's:9:"device_id";a:2:{s:1:"a";s:1:"b";s:1:"c";s:1:"d";}}'
) + HASH

#: Stale PHP string byte-length while the array count itself is correct.
STALE_STRING_LENGTH = (
    'a:4:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:999:"' + ("x" * 48) + '";'
    's:13:"last_activity";i:1732926685;}'
) + HASH

STALE_STRING_LENGTH_FIXED = (
    'a:4:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:48:"' + ("x" * 48) + '";'
    's:13:"last_activity";i:1732926685;}'
) + HASH

#: A camelCase key plus an unknown PHP value type defeats the old
#: snake_case-only fallback regex. The forced scanner must count five entries.
CAMEL_CASE_UNKNOWN_VALUE = (
    'a:4:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:48:"' + ("x" * 48) + '";'
    's:13:"last_activity";i:1732926685;'
    's:8:"deviceId";C:5:"Extra":3:{abc}}'
) + HASH

CAMEL_CASE_UNKNOWN_FIXED = CAMEL_CASE_UNKNOWN_VALUE.replace("a:4:{", "a:5:{", 1)

EMBEDDED_SESSION = "cookie=ssid=" + MISMATCHED_264


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


def test_object_values_are_converted_to_arrays():
    normalized = normalize_php_session(NESTED_OBJECT_FIELD)
    assert normalized == NESTED_OBJECT_FIELD_FIXED


def test_top_level_object_session_is_converted_to_array():
    normalized = normalize_php_session(OBJECT_SESSION)
    assert normalized == OBJECT_SESSION_AS_ARRAY
    assert normalized.startswith("a:4:{")


def test_stale_php_string_length_is_recalculated():
    normalized = normalize_php_session(STALE_STRING_LENGTH)
    assert normalized == STALE_STRING_LENGTH_FIXED


def test_forced_fallback_counts_camel_case_keys_and_unknown_values():
    normalized = normalize_php_session(CAMEL_CASE_UNKNOWN_VALUE)
    assert normalized == CAMEL_CASE_UNKNOWN_FIXED
    assert normalized.endswith(HASH)


def test_embedded_session_is_extracted_and_repaired():
    assert normalize_php_session(EMBEDDED_SESSION) == MISMATCHED_264.replace(
        "a:4:{", "a:5:{", 1
    )


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


def test_normalizer_strips_a_full_socketio_frame():
    assert normalize_php_session(_frame(MISMATCHED)) == MISMATCHED_FIXED


def test_auth_message_never_forwards_the_bad_php_count():
    payload = auth_message(
        {"session": MISMATCHED, "uid": "12345678", "isDemo": "0", "platform": 2}
    )
    parsed = json.loads(payload[2:])
    assert parsed[0] == "auth"
    assert parsed[1]["session"] == MISMATCHED_FIXED


def test_auth_message_logs_the_forced_header_mutation(caplog):
    with caplog.at_level(logging.WARNING, logger="pocket_bridge.config"):
        payload = auth_message(
            {"session": MISMATCHED, "uid": 12345678, "isDemo": 0, "platform": 2}
        )

    assert "PHP_SESSION_NORMALIZED - header=a:4 corrected=a:5" in caplog.text
    assert "AUTH_FRAME_SESSION_MUTATED before=a:4 after=a:5" in caplog.text
    assert json.loads(payload[2:])[1]["session"] == MISMATCHED_FIXED


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


def test_forced_header_preserves_body_and_trailing_hash():
    forced = force_php_array_header(CANONICAL, 5)
    assert forced == CANONICAL.replace("a:4:{", "a:5:{", 1)
    assert forced.endswith(HASH)


def test_unparseable_php_is_left_for_the_sdk_error():
    broken = 'a:4:{s:10:"session_id";s:32:"0123456789abcdef";}'
    assert normalize_php_session(broken) == broken
    assert not broken.startswith("42[")
