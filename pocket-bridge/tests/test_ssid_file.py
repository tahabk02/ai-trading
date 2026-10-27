"""Quote-safe SSID file loading (Docker secret / mounted file).

The legacy ``POCKET_OPTION_SSID`` env value passes through shell/Compose
parsing, which can corrupt the quotes and backslashes inside a full
``42["auth",{...}]`` frame. These tests pin the file path as byte-faithful and
file-first, with optional JSON and Fernet wrappers.
"""

from __future__ import annotations

import json

import pytest

from pocket_bridge.config import (
    BridgeSettings,
    auth_message,
    load_ssid,
    read_ssid_file,
    write_env_ssid,
)

PHP_SESSION = 'a:4:{s:10:"session_id";s:32:"0123456789abcdef";s:8:"is_demo";i:0;}'
FRAME = auth_message(
    {
        "session": PHP_SESSION,
        "uid": 123456789,
        "isDemo": 0,
        "platform": 2,
        "isOptimized": True,
    }
)


def _write(tmp_path, text: str, name: str = "pocket_option_ssid"):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def test_file_is_byte_faithful_for_php_session_and_escaped_quotes(tmp_path, monkeypatch):
    path = _write(tmp_path, FRAME + "\n")
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))
    monkeypatch.setenv("POCKET_OPTION_SSID", "wrong-env-value")

    assert read_ssid_file(path) == FRAME
    assert load_ssid() == FRAME
    settings = BridgeSettings()
    assert settings.ssid == FRAME
    assert settings.auth["session"] == PHP_SESSION
    assert settings.auth["isDemo"] == 0
    assert settings.uid == 123456789
    assert settings.ssid_source == "file"


def test_utf8_bom_and_outer_quotes_are_ignored(tmp_path, monkeypatch):
    path = _write(tmp_path, "\ufeff'" + FRAME + "'\n")
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))

    assert load_ssid() == FRAME


def test_json_ssid_wrapper_is_unwrapped(tmp_path, monkeypatch):
    path = _write(tmp_path, json.dumps({"ssid": FRAME}))
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))

    assert load_ssid() == FRAME


def test_json_auth_wrapper_preserves_account_fields(tmp_path, monkeypatch):
    path = _write(
        tmp_path,
        json.dumps(
            {
                "session": PHP_SESSION,
                "uid": 123456789,
                "isDemo": 0,
                "isOptimized": True,
            }
        ),
    )
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))

    settings = BridgeSettings()
    assert settings.uid == 123456789
    assert settings.is_demo == 0
    assert settings.auth["isOptimized"] is True


def test_fernet_encrypted_file_uses_session_key(tmp_path, monkeypatch):
    Fernet = pytest.importorskip("cryptography.fernet").Fernet
    key = Fernet.generate_key()
    encrypted = "FERNET:" + Fernet(key).encrypt(FRAME.encode()).decode()
    path = _write(tmp_path, encrypted)
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))
    monkeypatch.setenv("PO_SESSION_KEY", key.decode())

    assert load_ssid() == FRAME


def test_encrypted_file_without_key_fails_closed(tmp_path, monkeypatch):
    Fernet = pytest.importorskip("cryptography.fernet").Fernet
    encrypted = "FERNET:" + Fernet(Fernet.generate_key()).encrypt(FRAME.encode()).decode()
    path = _write(tmp_path, encrypted)
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))
    monkeypatch.delenv("PO_SESSION_KEY", raising=False)

    with pytest.raises(ValueError, match="PO_SESSION_KEY"):
        load_ssid()


def test_missing_file_fails_instead_of_silently_using_stale_env(tmp_path, monkeypatch):
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(tmp_path / "missing"))
    monkeypatch.setenv("POCKET_OPTION_SSID", FRAME)

    with pytest.raises(ValueError, match="cannot be read"):
        load_ssid()


def test_empty_file_fails_closed(tmp_path, monkeypatch):
    path = _write(tmp_path, "\n")
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))

    with pytest.raises(ValueError, match="empty"):
        load_ssid()


def test_malformed_json_wrapper_is_rejected(tmp_path, monkeypatch):
    path = _write(tmp_path, '{"ssid": ')
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(path))

    with pytest.raises(ValueError, match="malformed"):
        load_ssid()


def test_environment_path_still_works_without_file(monkeypatch):
    monkeypatch.delenv("POCKET_OPTION_SSID_FILE", raising=False)
    monkeypatch.setenv("POCKET_OPTION_SSID", "'" + FRAME + "'")

    settings = BridgeSettings()
    assert settings.ssid == FRAME
    assert settings.ssid_source == "env"


def test_rotation_keeps_the_mounted_file_in_sync(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("POCKET_BRIDGE_HOST=127.0.0.1\n", encoding="utf-8")
    secret = _write(tmp_path, FRAME)
    monkeypatch.setenv("POCKET_OPTION_SSID_FILE", str(secret))

    rotated = auth_message({"session": "rotated-token", "uid": 1, "isDemo": 0})
    write_env_ssid(env, rotated)

    assert read_ssid_file(secret) == rotated
    assert "POCKET_OPTION_SSID=" in env.read_text(encoding="utf-8")
