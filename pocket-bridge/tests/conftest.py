"""Test isolation for Pocket Option credentials loaded from the local .env."""

from __future__ import annotations

import pytest

AUTH_ENV_KEYS = (
    "POCKET_OPTION_SSID",
    "PO_SSID",
    "POCKET_OPTION_SESSION_TOKEN",
    "PO_SESSION_TOKEN",
    "POCKET_OPTION_SSID_FILE",
    "PO_SSID_FILE",
    "POCKET_OPTION_SESSION_TOKEN_FILE",
    "PO_SESSION_TOKEN_FILE",
)


@pytest.fixture(autouse=True)
def _clear_pocket_option_auth_env(monkeypatch):
    for key in AUTH_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
