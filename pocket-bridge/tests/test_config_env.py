"""Environment parsing: aliases, type errors and port validation."""

from __future__ import annotations

import hashlib

import pytest

from pocket_bridge.config import (
    DEFAULT_SYMBOLS,
    MAX_LIVE_STREAMS,
    BridgeSettings,
    load_ssid,
    mask_secret_preview,
    read_env_ssid,
    ssid_diagnostics,
)

SSID = '42["auth",{"session":"abc123def456session","uid":1,"isDemo":0}]'
TOKEN = "opaque-session-token-123"


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


def test_symbols_env_override_keeps_order_and_normalises(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_SYMBOLS", raising=False)
    monkeypatch.setenv("PO_SYMBOLS", " eur/usd , USD/JPY,, ")

    settings = BridgeSettings(ssid=SSID)

    assert settings.symbols == ["EUR/USD", "USD/JPY"]


def test_symbols_default_to_full_universe_not_stream_budget(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_SYMBOLS", raising=False)
    monkeypatch.delenv("PO_SYMBOLS", raising=False)

    settings = BridgeSettings(ssid=SSID)

    assert MAX_LIVE_STREAMS == 30
    assert settings.symbols == list(DEFAULT_SYMBOLS)
    assert len(settings.symbols) == len(DEFAULT_SYMBOLS)
    # The eager startup set is bounded, but the universe is not discarded.
    assert settings.static_symbols() == list(DEFAULT_SYMBOLS[:MAX_LIVE_STREAMS])


def test_symbols_override_is_not_truncated_to_cap(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_SYMBOLS", raising=False)
    symbols = [f"EUR/{c}" for c in "USD GBP JPY CHF CAD AUD NZD SEK NOK PLN".split()]
    monkeypatch.setenv("PO_SYMBOLS", ",".join(symbols))

    settings = BridgeSettings(ssid=SSID)

    assert settings.symbols == symbols
    assert len(settings.symbols) == len(symbols)
    assert len(settings.static_symbols(3)) == 3


def test_po_ssid_file_alias_is_read(monkeypatch, tmp_path):
    path = tmp_path / "ssid.txt"
    path.write_text(SSID, encoding="utf-8")
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN", raising=False)
    monkeypatch.setenv("PO_SSID_FILE", str(path))

    assert load_ssid() == SSID


def test_empty_canonical_ssid_does_not_mask_po_ssid_alias(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_SSID_FILE", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN_FILE", raising=False)
    monkeypatch.setenv("POCKET_OPTION_SSID", "''")
    monkeypatch.setenv("PO_SSID", SSID)

    assert load_ssid() == SSID


def test_quoted_numeric_env_values_are_normalised(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_UID", raising=False)
    monkeypatch.delenv("POCKET_OPTION_IS_DEMO", raising=False)
    monkeypatch.setenv("POCKET_OPTION_UID", "'42'")
    monkeypatch.setenv("POCKET_OPTION_IS_DEMO", '"1"')

    settings = BridgeSettings(ssid="opaque-raw-session")

    assert settings.uid == 42
    assert settings.is_demo == 1


def test_po_session_token_file_alias_is_read(monkeypatch, tmp_path):
    path = tmp_path / "token.txt"
    path.write_text(TOKEN + "\n", encoding="utf-8")
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SSID_FILE", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN", raising=False)
    monkeypatch.setenv("PO_SESSION_TOKEN_FILE", str(path))

    assert load_ssid() == "sessionToken:" + TOKEN


def test_ssid_diagnostics_report_source_length_and_hashes(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_SSID_FILE", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("POCKET_OPTION_SESSION_TOKEN_FILE", raising=False)
    monkeypatch.setenv("POCKET_OPTION_SSID", SSID)

    diagnostic = ssid_diagnostics()
    credential = "abc123def456session"

    assert diagnostic["present"] is True
    assert "POCKET_OPTION_SSID" in diagnostic["source"]
    assert diagnostic["format"] == "full"
    assert diagnostic["payload_len"] == len(SSID)
    assert (
        diagnostic["payload_sha256"]
        == hashlib.sha256(SSID.encode()).hexdigest()[:12]
    )
    assert SSID not in diagnostic["payload"]
    assert diagnostic["credential_len"] == len(credential)
    assert (
        diagnostic["credential_sha256"]
        == hashlib.sha256(credential.encode()).hexdigest()[:12]
    )
    assert credential not in diagnostic["credential"]
    assert "sha256=" in diagnostic["payload"]
    assert "sha256=" in diagnostic["credential"]
    assert diagnostic["parse_error"] == ""


def test_mask_secret_preview_never_echoes_the_full_value():
    secret = "abcdefghijklmnop"
    preview = mask_secret_preview(secret)

    assert preview.startswith("abcd...mnop")
    assert f"len={len(secret)}" in preview
    assert secret not in preview
    assert preview.count("sha256=") == 1

    short = mask_secret_preview("abcd")
    assert "abcd" not in short
    assert short.startswith("****")


def test_settings_repr_does_not_expose_the_ssid():
    settings = BridgeSettings(ssid=SSID)

    assert SSID not in repr(settings)


def test_read_env_ssid_accepts_alias_and_strips_quotes(tmp_path):
    env = tmp_path / ".env"
    env.write_text(f"PO_SSID='{SSID}'\n", encoding="utf-8")

    assert read_env_ssid(env) == SSID
