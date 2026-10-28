"""Environment parsing: aliases, type errors and port validation."""

from __future__ import annotations

import pytest

from pocket_bridge.config import BridgeSettings, load_ssid

SSID = '42["auth",{"session":"abc123def456session","uid":1,"isDemo":0}]'


def test_po_user_id_and_po_is_demo_aliases_are_honoured(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_UID", raising=False)
    monkeypatch.delenv("POCKET_OPTION_IS_DEMO", raising=False)
    monkeypatch.setenv("PO_USER_ID", "424242")
    monkeypatch.setenv("PO_IS_DEMO", "1")

    settings = BridgeSettings(ssid="abc123def456session")

    assert settings.uid == 424242
    assert settings.is_demo == 1


def test_malformed_numeric_env_names_the_variable(monkeypatch):
    monkeypatch.setenv("POCKET_OPTION_TIMEOUT_SECS", "thirty")

    with pytest.raises(ValueError, match="POCKET_OPTION_TIMEOUT_SECS"):
        BridgeSettings(ssid=SSID)


def test_malformed_port_is_rejected_at_construction(monkeypatch):
    monkeypatch.setenv("POCKET_BRIDGE_PORT", "not-a-port")

    with pytest.raises(ValueError, match="POCKET_BRIDGE_PORT"):
        BridgeSettings(ssid=SSID)


def test_out_of_range_port_is_rejected(monkeypatch):
    monkeypatch.setenv("POCKET_BRIDGE_PORT", "70000")

    with pytest.raises(ValueError, match="between 1 and 65535"):
        BridgeSettings(ssid=SSID)


def test_po_ssid_file_alias_is_read(monkeypatch, tmp_path):
    path = tmp_path / "ssid.txt"
    path.write_text(SSID, encoding="utf-8")
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN", raising=False)
    monkeypatch.setenv("PO_SSID_FILE", str(path))

    assert load_ssid() == SSID
