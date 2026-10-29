"""Real-account ``sessionToken`` frames (no legacy PHP ``session`` field).

Pocket Option's current browser capture authenticates real accounts with a
direct 32-hex token::

    42["auth",{"sessionToken":"...","uid":1,"isDemo":0,"platform":2}]

That value must never reach the PHP parser. Demo / legacy captures still use
``session`` and must keep working unchanged.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "session"))

import capture_session  # noqa: E402
import refresh_ssid  # noqa: E402
from pocket_bridge.config import (  # noqa: E402
    BridgeSettings,
    auth_message,
    load_ssid,
    normalize_auth_fields,
    parse_ssid,
)

TOKEN = "6e30054c164f3a345b4b93a27d65d808"
# Production browser captures also emit an opaque 20-char token (alphanumeric
# plus ``_``) rather than the historical 32-hex form.
OPAQUE_TOKEN = "Zx9_Qw2Er7Ty4Ui6Op8A"
LEGACY = "abc123def456session"


def _token_frame(token: str = TOKEN, **over) -> str:
    payload = {
        "sessionToken": token,
        "uid": 123456789,
        "isDemo": 0,
        "platform": 2,
        "isFastHistory": True,
    }
    payload.update(over)
    return "42" + json.dumps(["auth", payload], separators=(",", ":"))


def _assert_wrapped_session(payload, token: str) -> None:
    """The pinned SDK requires ``session`` and parses it as PHP."""
    assert "sessionToken" not in payload
    assert "session_token" not in payload
    session = payload["session"]
    assert session.startswith("a:")
    assert f's:10:"session_id";s:{len(token)}:"{token}"' in session


def test_token_frame_is_parsed_without_php_normalization(monkeypatch):
    import pocket_bridge.config as config

    def _boom(value, *args, **kwargs):
        raise AssertionError("sessionToken must not reach the PHP sanitizer")

    monkeypatch.setattr(config, "sanitize_php_session", _boom)
    parsed = parse_ssid(_token_frame())

    assert parsed["sessionToken"] == TOKEN
    assert parsed["session"] == TOKEN
    assert parsed["uid"] == 123456789
    assert parsed["isDemo"] == 0


def test_auth_message_wraps_the_token_as_a_php_session_id():
    parsed = parse_ssid(_token_frame())
    frame = auth_message(parsed)
    payload = json.loads(frame[2:])[1]

    assert frame.startswith('42["auth",')
    _assert_wrapped_session(payload, TOKEN)
    assert payload["uid"] == 123456789
    assert payload["isDemo"] == 0


def test_clean_32_hex_raw_token_is_inferred_for_real_accounts(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_IS_DEMO", raising=False)
    monkeypatch.delenv("PO_IS_DEMO", raising=False)
    parsed = parse_ssid(TOKEN)

    assert parsed["sessionToken"] == TOKEN
    assert parsed["session"] == TOKEN
    assert parsed["isDemo"] == 0


def test_opaque_20_char_frame_token_is_inferred_for_real_accounts():
    parsed = parse_ssid(
        '42["auth",{"session":"%s","uid":138336943,"isDemo":0,'
        '"platform":2,"isFastHistory":true}]' % OPAQUE_TOKEN
    )

    assert parsed["sessionToken"] == OPAQUE_TOKEN
    assert parsed["session"] == OPAQUE_TOKEN
    assert parsed["isDemo"] == 0
    payload = json.loads(auth_message(parsed)[2:])[1]
    _assert_wrapped_session(payload, OPAQUE_TOKEN)


def test_opaque_20_char_raw_token_is_inferred_for_real_accounts(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_IS_DEMO", raising=False)
    monkeypatch.delenv("PO_IS_DEMO", raising=False)
    monkeypatch.setenv("POCKET_OPTION_UID", "138336943")
    parsed = parse_ssid(OPAQUE_TOKEN)

    assert parsed["sessionToken"] == OPAQUE_TOKEN
    assert parsed["session"] == OPAQUE_TOKEN
    assert parsed["uid"] == 138336943


def test_cookie_style_ssid_with_equals_is_not_reclassified():
    parsed = parse_ssid("ugjBRO5HNlUR=s7zjXv1aAm7LeLJYp6hKJxPN")

    assert parsed["session"] == "ugjBRO5HNlUR=s7zjXv1aAm7LeLJYp6hKJxPN"
    assert "sessionToken" not in parsed


def test_po_ssid_alias_is_used_when_canonical_is_absent(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SSID_FILE", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("POCKET_OPTION_IS_DEMO", raising=False)
    monkeypatch.setenv("PO_SSID", OPAQUE_TOKEN)
    monkeypatch.setenv("PO_IS_DEMO", "0")
    monkeypatch.setenv("PO_USER_ID", "138336943")

    settings = BridgeSettings()

    assert settings.ssid == OPAQUE_TOKEN
    assert settings.ssid_source == "env"
    assert settings.auth["sessionToken"] == OPAQUE_TOKEN
    assert settings.uid == 138336943


def test_canonical_ssid_wins_over_po_ssid_alias(monkeypatch):
    monkeypatch.setenv("POCKET_OPTION_SSID", TOKEN)
    monkeypatch.setenv("PO_SSID", OPAQUE_TOKEN)

    assert load_ssid() == TOKEN


def test_demo_account_keeps_the_legacy_session_field_even_for_32_hex():
    parsed = parse_ssid(
        '42["auth",{"session":"%s","uid":1,"isDemo":1}]' % TOKEN
    )

    assert parsed["session"] == TOKEN
    assert "sessionToken" not in parsed
    assert "sessionToken" not in json.loads(auth_message(parsed)[2:])[1]


def test_legacy_non_hex_raw_token_stays_a_session():
    parsed = normalize_auth_fields({"session": LEGACY, "uid": 1, "isDemo": 0})

    assert parsed["session"] == LEGACY
    assert "sessionToken" not in parsed


def test_explicit_prefix_marks_an_opaque_token_even_when_demo_is_unset(monkeypatch):
    monkeypatch.setenv("POCKET_OPTION_IS_DEMO", "1")
    parsed = parse_ssid("sessionToken:opaque-token")

    assert parsed["sessionToken"] == "opaque-token"
    assert parsed["session"] == "opaque-token"
    assert parsed["isDemo"] == 1


def test_explicit_session_token_env_is_loaded_and_prefixed(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SSID_FILE", raising=False)
    monkeypatch.setenv("POCKET_OPTION_SESSION_TOKEN", TOKEN)

    assert load_ssid() == "sessionToken:" + TOKEN
    settings = BridgeSettings()
    assert settings.ssid_source == "token"
    assert settings.auth["sessionToken"] == TOKEN
    _assert_wrapped_session(
        json.loads(settings.auth_payload[2:])[1], TOKEN
    )


def test_json_wrapper_with_session_token_preserves_account_fields(tmp_path, monkeypatch):
    path = tmp_path / "ssid.json"
    path.write_text(
        json.dumps(
            {
                "sessionToken": TOKEN,
                "uid": 987654321,
                "isDemo": 0,
                "isOptimized": True,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN", raising=False)

    settings = BridgeSettings()
    assert settings.uid == 987654321
    assert settings.auth["sessionToken"] == TOKEN
    assert settings.auth["isOptimized"] is True
    payload = json.loads(settings.auth_payload[2:])[1]
    _assert_wrapped_session(payload, TOKEN)
    assert payload["isOptimized"] is True


def test_json_wrapper_with_only_session_token_stays_a_token(tmp_path, monkeypatch):
    path = tmp_path / "ssid.json"
    path.write_text(json.dumps({"sessionToken": TOKEN}), encoding="utf-8")
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))
    monkeypatch.setenv("POCKET_OPTION_IS_DEMO", "1")
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN", raising=False)

    settings = BridgeSettings()
    assert settings.auth["sessionToken"] == TOKEN
    assert settings.auth["isDemo"] == 1
    _assert_wrapped_session(
        json.loads(settings.auth_payload[2:])[1], TOKEN
    )


def test_capture_extractor_reads_session_token():
    assert capture_session._extract_auth_ssid(_token_frame()) == TOKEN


def test_refresh_extractor_reads_session_token():
    assert refresh_ssid.extract_ssid_from_frame(_token_frame()) == TOKEN


@pytest.mark.parametrize("bad", ["", "42[not json", '42["notauth",{}]'])
def test_refresh_extractor_still_rejects_non_auth_frames(bad):
    assert refresh_ssid.extract_ssid_from_frame(bad) is None
