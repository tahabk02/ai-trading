"""Last-resort credential-login recovery (PO_EMAIL / PO_PASSWORD).

These cover the pieces verifiable WITHOUT a browser or network:
  * the credential config gate (opt-in + both halves present),
  * the last-resort decision (never attempted while a session SSID exists),
  * the ``42["auth",{...}]`` frame parser reused by both tiers,
  * the login-form selector contract,
  * the non-secret /health status (masked email, never the password).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "session"))

import refresh_ssid  # noqa: E402
from pocket_bridge.config import (  # noqa: E402
    CredentialLogin,
    credential_login_status,
    load_credential_login,
)


def _frame(session: str, **over) -> str:
    import json

    payload = {"session": session, "uid": 1, "isDemo": 0, "platform": 2}
    payload.update(over)
    return '42' + json.dumps(["auth", payload], separators=(",", ":"))


class TestCredentialConfig:
    def test_disabled_by_default(self, monkeypatch):
        for k in ("PO_EMAIL", "PO_PASSWORD", "PO_EMAIL_LOGIN"):
            monkeypatch.delenv(k, raising=False)
        cfg = load_credential_login()
        assert cfg.enabled is False
        assert cfg.usable is False

    def test_enabled_requires_both_halves(self, monkeypatch):
        monkeypatch.setenv("PO_EMAIL_LOGIN", "1")
        monkeypatch.setenv("PO_EMAIL", "trader@example.com")
        monkeypatch.delenv("PO_PASSWORD", raising=False)
        cfg = load_credential_login()
        assert cfg.enabled is True
        assert cfg.configured is False
        assert cfg.usable is False

    def test_fully_configured_is_usable(self, monkeypatch):
        monkeypatch.setenv("PO_EMAIL_LOGIN", "true")
        monkeypatch.setenv("PO_EMAIL", "trader@example.com")
        monkeypatch.setenv("PO_PASSWORD", "s3cret")
        cfg = load_credential_login()
        assert cfg.usable is True
        assert cfg.email == "trader@example.com"

    @pytest.mark.parametrize("flag", ["1", "true", "yes", "on", "TRUE", "On"])
    def test_enabled_flag_parsing(self, monkeypatch, flag):
        monkeypatch.setenv("PO_EMAIL_LOGIN", flag)
        assert load_credential_login().enabled is True

    @pytest.mark.parametrize("flag", ["0", "false", "no", "off", ""])
    def test_disabled_flag_parsing(self, monkeypatch, flag):
        monkeypatch.setenv("PO_EMAIL_LOGIN", flag)
        assert load_credential_login().enabled is False

    def test_password_is_not_in_the_repr(self):
        cfg = CredentialLogin(email="a@b.c", password="topsecret", enabled=True)
        assert "topsecret" not in repr(cfg)


class TestLastResortDecision:
    def test_a_usable_session_never_triggers_credential_login(self):
        cfg = CredentialLogin(email="a@b.c", password="pw", enabled=True)
        assert refresh_ssid.should_attempt_credential_login(cfg, "SESSION_TOKEN") is False

    def test_attempted_only_when_session_failed_and_usable(self):
        cfg = CredentialLogin(email="a@b.c", password="pw", enabled=True)
        assert refresh_ssid.should_attempt_credential_login(cfg, None) is True

    def test_not_attempted_when_disabled(self):
        cfg = CredentialLogin(email="a@b.c", password="pw", enabled=False)
        assert refresh_ssid.should_attempt_credential_login(cfg, None) is False

    def test_not_attempted_when_incomplete(self):
        cfg = CredentialLogin(email="a@b.c", password="", enabled=True)
        assert refresh_ssid.should_attempt_credential_login(cfg, None) is False


class TestAuthFrameParsing:
    def test_extracts_the_session_token(self):
        assert refresh_ssid.extract_ssid_from_frame(_frame("abc123")) == "abc123"

    @pytest.mark.parametrize(
        "bad", ["", "hello", '42["notauth",{"session":"x"}]', "42[not json", "null"]
    )
    def test_rejects_non_auth_frames(self, bad):
        assert refresh_ssid.extract_ssid_from_frame(bad) is None

    def test_tolerates_a_namespace_byte_before_the_array(self):
        assert refresh_ssid.extract_ssid_from_frame('42/nsp,["auth",{"session":"T"}]') == "T"


class TestLoginSelectors:
    def test_email_and_password_selectors_present(self):
        assert any("email" in s for s in refresh_ssid.LOGIN_EMAIL_SELECTORS)
        assert any("password" in s for s in refresh_ssid.LOGIN_PASSWORD_SELECTORS)
        assert refresh_ssid.LOGIN_SUBMIT_SELECTORS

    def test_cabinet_url_is_pocketoption(self):
        assert "pocketoption.com" in refresh_ssid.CABINET_URL


class TestHealthStatus:
    def test_status_is_masked_and_never_leaks_the_password(self, monkeypatch):
        monkeypatch.setenv("PO_EMAIL_LOGIN", "1")
        monkeypatch.setenv("PO_EMAIL", "trader@example.com")
        monkeypatch.setenv("PO_PASSWORD", "s3cret")
        status = credential_login_status()
        assert status["credential_login_enabled"] is True
        assert status["credential_login_configured"] is True
        assert status["credential_login_available"] is True
        assert "s3cret" not in str(status)
        assert "trader@example.com" not in str(status)
