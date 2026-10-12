"""SSID rotation + session-freshness regressions.

The bridge builds ``BridgeSettings`` ONCE from ``os.environ`` (a frozen
dataclass), and ``_auth_payload`` prefers ``settings.ssid`` over the reloaded
session file. So a token rotated by capture_session.py / refresh_ssid.py wrote
the new value to .env but the running process kept authenticating with the
token it booted with — the refresh had NO effect for the remaining lifetime of
the process, which is exactly when it matters (the old token has expired).
"""

from __future__ import annotations

import json

import pytest

from pocket_bridge.config import (
    BridgeSettings,
    auth_message,
    load_stored_session,
)

RAW = "abc123def456session"


def _frame(session: str, **over) -> str:
    """A real ``42["auth",{...}]`` message, as the wire actually carries."""
    payload = {"session": session, "uid": 4242, "isDemo": 0, "platform": 2}
    payload.update(over)
    return auth_message(payload)


def _settings_with_env_ssid(monkeypatch, value):
    monkeypatch.setenv("POCKET_OPTION_SSID", value)
    return BridgeSettings()


class TestRuntimeSsidAdoption:
    def test_boot_reads_the_env_token(self, monkeypatch):
        s = _settings_with_env_ssid(monkeypatch, RAW)
        assert s.ssid == RAW
        assert s.has_ssid is True

    def test_adopting_a_rotated_token_replaces_the_booted_one(self, monkeypatch):
        s = _settings_with_env_ssid(monkeypatch, RAW)
        assert s.ssid == RAW

        new_raw = _frame("ROTATED999session", uid=4242)
        assert s.adopt_ssid(new_raw) is True

        # The boot value must be GONE, or the stale token keeps authenticating.
        assert s.ssid == new_raw
        assert "ROTATED999session" in s.ssid
        assert RAW not in s.ssid
        # Derived properties must track the ADOPTED token.
        assert s.uid == 4242
        assert s.auth["session"] == "ROTATED999session"

    def test_adopted_token_is_what_the_wire_payload_carries(self, monkeypatch):
        """The auth frame is built from ``auth``, so adoption must be visible
        on the wire, not only in the ``ssid`` attribute."""
        s = _settings_with_env_ssid(monkeypatch, RAW)
        assert RAW in s.auth_payload

        assert s.adopt_ssid(_frame("NEWTOKEN")) is True
        assert "NEWTOKEN" in s.auth_payload
        assert RAW not in s.auth_payload

    @pytest.mark.parametrize(
        "bad", ["", "   ", "\n", "42[not json", '42["nope",{}]', '42["auth",{}]']
    )
    def test_an_unusable_token_keeps_the_previous_credentials(self, monkeypatch, bad):
        s = _settings_with_env_ssid(monkeypatch, RAW)
        assert s.adopt_ssid(bad) is False
        # Must NOT downgrade to an unauthenticated frame.
        assert s.ssid == RAW
        assert s.has_ssid is True
        assert RAW in s.auth_payload

    def test_a_malformed_frame_is_rejected_not_silently_adopted(self, monkeypatch):
        """A corrupt .env must not overwrite working credentials."""
        s = _settings_with_env_ssid(monkeypatch, RAW)
        assert s.adopt_ssid('42["auth",{"session":""}]') is False
        assert s.ssid == RAW


class TestSsidFormatReporting:
    def test_full_frame_is_reported_as_full(self, monkeypatch):
        s = _settings_with_env_ssid(monkeypatch, _frame(RAW))
        assert s.ssid_format == "full"

    def test_raw_token_is_reported_as_raw(self, monkeypatch):
        s = _settings_with_env_ssid(monkeypatch, RAW)
        assert s.ssid_format == "raw"

    def test_session_cookie_path_does_not_understate_the_wire_format(self, monkeypatch):
        """No env SSID means a full auth frame is built from the session file.

        Reporting "raw" there made /health and the boot log claim a weaker
        payload than is actually sent, misleading anyone debugging auth.
        """
        monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
        s = BridgeSettings()
        assert s.adopt_ssid(_frame("FROMCAPTURE")) is True
        assert s.ssid_format == "full"
        assert s.auth_payload.startswith("42[")


class TestSessionAgeFailsClosed:
    def test_missing_captured_at_is_not_treated_as_fresh(self, tmp_path):
        p = tmp_path / "po_session.json"
        p.write_text(json.dumps({"cookies": []}), encoding="utf-8")
        s = load_stored_session(p, fallback_env=False)
        # 0.0 meant "captured just now" and defeated PO_SESSION_MAX_AGE_DAYS.
        assert s.age_days == float("inf")

    def test_unparseable_captured_at_is_not_treated_as_fresh(self, tmp_path):
        p = tmp_path / "po_session.json"
        p.write_text(
            json.dumps({"capturedAt": "not-a-date", "cookies": []}), encoding="utf-8"
        )
        s = load_stored_session(p, fallback_env=False)
        assert s.age_days == float("inf")

    def test_a_real_timestamp_still_reports_a_real_age(self, tmp_path):
        p = tmp_path / "po_session.json"
        p.write_text(
            json.dumps({"capturedAt": "2020-01-01T00:00:00Z", "cookies": []}),
            encoding="utf-8",
        )
        s = load_stored_session(p, fallback_env=False)
        assert s.age_days > 1_000

    def test_unknown_age_is_json_safe_for_health_payloads(self, tmp_path):
        """round(inf, 1) is inf, and json.dumps would emit invalid `Infinity`."""
        p = tmp_path / "po_session.json"
        p.write_text(json.dumps({"cookies": []}), encoding="utf-8")
        s = load_stored_session(p, fallback_env=False)
        payload = None if s.age_days == float("inf") else round(s.age_days, 1)
        json.dumps({"session_age_days": payload})  # must not raise
