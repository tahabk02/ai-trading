"""Regression: a successful refresh must not crash while logging adoption.

``_run_refresh_once`` used to call ``logger.info("SSID_ADOPTED_FROM_ENV",
uid=..., is_demo=..., format=...)``. The stdlib logger rejects those keyword
arguments with ``TypeError``, so the first successful SSID rotation could kill
the startup path (and the backend then failed downstream with 502s).
"""

from __future__ import annotations

import asyncio
import json
import logging

from pocket_bridge import bridge as bridge_module
from pocket_bridge.bridge import PocketOptionBridge
from pocket_bridge.config import BridgeSettings
from pocket_bridge.m20_engine import M20Engine

OLD = '42["auth",{"session":"abc123def456session","uid":1,"isDemo":0}]'
NEW_TOKEN = "Zx9_Qw2Er7Ty4Ui6Op8A"


def test_successful_refresh_adopts_without_logger_kwargs(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="pocket_bridge.bridge")
    settings = BridgeSettings(ssid=OLD, symbols=[])
    bridge = PocketOptionBridge(settings, M20Engine([], max_history=10))

    async def _ok() -> bool:
        return True

    async def _reload():
        return bridge.session

    monkeypatch.setattr(bridge, "_run_refresh", _ok)
    monkeypatch.setattr(bridge, "reload_session", _reload)
    monkeypatch.setattr(
        bridge_module,
        "read_env_ssid",
        lambda _path: '42["auth",{"session":"%s","uid":1,"isDemo":0}]' % NEW_TOKEN,
    )

    assert asyncio.run(bridge._run_refresh_once()) is True
    assert bridge.settings.auth["sessionToken"] == NEW_TOKEN
    payload = json.loads(bridge.settings.auth_payload[2:])[1]
    assert "sessionToken" not in payload
    assert (
        f's:10:"session_id";s:{len(NEW_TOKEN)}:"{NEW_TOKEN}"'
        in payload["session"]
    )
    assert "SSID_ADOPTED_FROM_ENV" in caplog.text
