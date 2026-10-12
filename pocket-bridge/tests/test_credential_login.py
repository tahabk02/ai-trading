"""Last-resort credential-login recovery (PO_EMAIL / PO_PASSWORD).

These cover the pieces verifiable WITHOUT a browser or network:
  * the credential config gate (opt-in + both halves + recorded PO_TOS_CONSENT),
  * file-mounted secrets (PO_EMAIL_FILE / PO_PASSWORD_FILE, PART 43.6 [481]),
  * the last-resort decision (never attempted while a session SSID exists),
  * the captcha/2FA challenge classifier (PART 43.6 [480] stop-never-retry),
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


def _usable_credential() -> CredentialLogin:
    return CredentialLogin(email="a@b.c", password="pw", enabled=True, tos_consent=True)


class TestCredentialConfig:
    def test_disabled_by_default(self, monkeypatch):
        for k in ("PO_EMAIL", "PO_PASSWORD", "PO_EMAIL_LOGIN", "PO_TOS_CONSENT"):
            monkeypatch.delenv(k, raising=False)
        cfg = load_credential_login()
        assert cfg.enabled is False
        assert cfg.usable is False

    def test_enabled_requires_both_halves(self, monkeypatch):
        monkeypatch.setenv("PO_EMAIL_LOGIN", "1")
        monkeypatch.setenv("PO_EMAIL", "trader@example.com")
        monkeypatch.delenv("PO_PASSWORD", raising=False)
        monkeypatch.delenv("PO_TOS_CONSENT", raising=False)
        cfg = load_credential_login()
        assert cfg.enabled is True
        assert cfg.configured is False
        assert cfg.usable is False

    def test_fully_configured_requires_recorded_tos_consent(self, monkeypatch):
        monkeypatch.setenv("PO_EMAIL_LOGIN", "true")
        monkeypatch.setenv("PO_EMAIL", "trader@example.com")
        monkeypatch.setenv("PO_PASSWORD", "s3cret")
        monkeypatch.delenv("PO_TOS_CONSENT", raising=False)
        cfg = load_credential_login()
        assert cfg.enabled is True
        assert cfg.configured is True
        assert cfg.tos_consent is False
        assert cfg.usable is False  # PART 43.6 [482]: no consent, no login

    def test_fully_configured_with_consent_is_usable(self, monkeypatch):
        monkeypatch.setenv("PO_EMAIL_LOGIN", "true")
        monkeypatch.setenv("PO_EMAIL", "trader@example.com")
        monkeypatch.setenv("PO_PASSWORD", "s3cret")
        monkeypatch.setenv("PO_TOS_CONSENT", "true")
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


class TestSecretFiles:
    def test_file_secrets_win_over_env(self, monkeypatch, tmp_path):
        email_file = tmp_path / "po_email"
        pw_file = tmp_path / "po_password"
        email_file.write_text("file@example.com\n")
        pw_file.write_text("file-secret")
        monkeypatch.setenv("PO_EMAIL_FILE", str(email_file))
        monkeypatch.setenv("PO_PASSWORD_FILE", str(pw_file))
        # Decoy env values must be ignored when the file is present.
        monkeypatch.setenv("PO_EMAIL", "env@example.com")
        monkeypatch.setenv("PO_PASSWORD", "env-secret")
        cfg = load_credential_login()
        assert cfg.email == "file@example.com"
        assert cfg.password == "file-secret"

    def test_missing_secret_file_falls_back_to_env(self, monkeypatch):
        monkeypatch.setenv("PO_EMAIL_FILE", str(ROOT / "definitely-absent.txt"))
        monkeypatch.setenv("PO_EMAIL", "env@example.com")
        assert load_credential_login().email == "env@example.com"

    def test_secret_file_contents_never_logged(self, monkeypatch, tmp_path, capsys):
        pw_file = tmp_path / "po_password"
        pw_file.write_text("ultra-secret-pw")
        monkeypatch.setenv("PO_PASSWORD_FILE", str(pw_file))
        monkeypatch.setenv("PO_EMAIL_LOGIN", "1")
        monkeypatch.setenv("PO_EMAIL", "a@b.c")
        monkeypatch.setenv("PO_TOS_CONSENT", "true")
        status = credential_login_status()
        assert "ultra-secret-pw" not in str(status)
        assert "ultra-secret-pw" not in capsys.readouterr().out


class TestLastResortDecision:
    def test_a_usable_session_never_triggers_credential_login(self):
        assert refresh_ssid.should_attempt_credential_login(_usable_credential(), "SESSION_TOKEN") is False

    def test_attempted_only_when_session_failed_and_usable(self):
        assert refresh_ssid.should_attempt_credential_login(_usable_credential(), None) is True

    def test_not_attempted_when_disabled(self):
        cfg = CredentialLogin(email="a@b.c", password="pw", enabled=False, tos_consent=True)
        assert refresh_ssid.should_attempt_credential_login(cfg, None) is False

    def test_not_attempted_when_incomplete(self):
        cfg = CredentialLogin(email="a@b.c", password="", enabled=True, tos_consent=True)
        assert refresh_ssid.should_attempt_credential_login(cfg, None) is False

    def test_not_attempted_without_recorded_tos_consent(self):
        cfg = CredentialLogin(email="a@b.c", password="pw", enabled=True)
        assert refresh_ssid.should_attempt_credential_login(cfg, None) is False


class TestChallengeDetection:
    @pytest.mark.parametrize(
        "text,expected",
        [
            ("Please enter the verification code sent to your phone", "2fa"),
            ("Two-factor authentication required", "2fa"),
            ("Enter your TOTP code", "2fa"),
            ("We need to verify you are a human", "captcha"),
            ("g-recaptcha failed, try again", "captcha"),
            ("Security check in progress", "captcha"),
            ("Good morning, enjoy your trading", None),
            ("", None),
        ],
    )
    def test_parse_challenge_text(self, text, expected):
        assert refresh_ssid.parse_challenge_text(text) == expected

    def test_2fa_keywords_take_priority_over_captcha(self):
        # 2FA keywords are checked first; a 2FA phrase wins even past tense.
        assert refresh_ssid.parse_challenge_text("verification code") == "2fa"
        # A bare "code" (no 2FA phrase) with a captcha keyword is captcha.
        assert refresh_ssid.parse_challenge_text("captcha code") == "captcha"

    def test_challenge_selectors_cover_captcha_and_2fa(self):
        selectors = " ".join(refresh_ssid.CHALLENGE_SELECTORS)
        assert any(k in selectors for k in ("captcha", "recaptcha", "geetest"))
        assert any(k in selectors for k in ("2fa", "totp", "otp", "code"))

    def test_challenge_exception_carries_the_type(self):
        exc = refresh_ssid._ChallengeDetected("captcha")
        assert exc.challenge_type == "captcha"
        assert "captcha" in str(exc)

    def test_contract_markers_are_stable(self):
        # The orchestrator parses these exact tokens (Node matches
        # LOGIN_ATTEMPTED=1 / CHALLENGE_DETECTED=<type>); a refactor must keep
        # them byte-identical.
        assert refresh_ssid.LOGIN_ATTEMPTED_MARKER == "LOGIN_ATTEMPTED=1"
        assert refresh_ssid.CHALLENGE_MARKER == "CHALLENGE_DETECTED="


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
        monkeypatch.setenv("PO_TOS_CONSENT", "true")
        status = credential_login_status()
        assert status["credential_login_enabled"] is True
        assert status["credential_login_configured"] is True
        assert status["credential_login_tos_consent"] is True
        assert status["credential_login_available"] is True
        assert "s3cret" not in str(status)
        assert "trader@example.com" not in str(status)

    def test_status_reflects_missing_consent(self, monkeypatch):
        monkeypatch.setenv("PO_EMAIL_LOGIN", "1")
        monkeypatch.setenv("PO_EMAIL", "trader@example.com")
        monkeypatch.setenv("PO_PASSWORD", "s3cret")
        monkeypatch.delenv("PO_TOS_CONSENT", raising=False)
        status = credential_login_status()
        assert status["credential_login_available"] is False
        assert status["credential_login_tos_consent"] is False
