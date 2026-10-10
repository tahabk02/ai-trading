"""Connect/handshake resilience for the Pocket Option bridge.

Regression cover for the live ``PocketOptionError, General error: Connection
initialization timed out`` crash loop:

  * the SDK's native handshake budget is raised from its 60s default, so a
    blocked regional host is walked through to a healthy one instead of
    aborting the whole rotation;
  * the bridge's own wait can no longer cancel a live handshake (the old race
    had both deadlines pinned at 60s);
  * a handshake/transport failure is NEVER escalated to the terminal
    ``session_expired`` state, so readers stay armed and the stream self-heals;
  * a genuine auth rejection still escalates (no silent regression).
"""

import asyncio

import pytest

from pocket_bridge.bridge import (
    CONNECT_DEADLINE_GRACE,
    PocketOptionBridge,
    TRANSIENT_CONNECT_ATTEMPTS,
)
from pocket_bridge.config import BridgeSettings
from pocket_bridge.m20_engine import M20Engine

TIMEOUT_ERROR = (
    "PocketOptionError, General error: Connection initialization timed out"
)


def _settings(monkeypatch, tmp_path, **overrides) -> BridgeSettings:
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    monkeypatch.delenv("PO_SESSION_PATH", raising=False)
    monkeypatch.delenv("POCKET_OPTION_WS_URLS", raising=False)
    return BridgeSettings(
        symbols=[],
        session_path=str(tmp_path / "po_session.json"),
        refresh_at_startup=False,
        **overrides,
    )


def _bridge(monkeypatch, tmp_path, **overrides) -> PocketOptionBridge:
    bridge = PocketOptionBridge(
        _settings(monkeypatch, tmp_path, **overrides), M20Engine([], max_history=10)
    )
    # Claim a credential exists so the connect path runs (no file on disk ->
    # _run_refresh short-circuits without spawning a browser).
    bridge.session.raw_ssid = "not-a-real-ssid"
    bridge.session.cookies.append(
        {"name": "ssid", "value": "not-a-real-ssid", "domain": ".pocketoption.com"}
    )
    return bridge


class _FakeClient:
    """Stands in for PocketOptionAsync: records config, always fails to auth."""

    instances: list = []

    def __init__(self, payload, config=None, url=None, **kwargs):
        self.payload = payload
        self.config = config
        self.url = url
        self.disconnected = False
        type(self).instances.append(self)

    async def wait_for_assets(self, timeout=None):
        raise RuntimeError(TIMEOUT_ERROR)

    def is_connected(self):
        return False

    async def disconnect(self):
        self.disconnected = True


@pytest.fixture
def fake_client(monkeypatch):
    from BinaryOptionsToolsV2 import pocketoption as po

    _FakeClient.instances = []
    monkeypatch.setattr(po, "PocketOptionAsync", _FakeClient)
    monkeypatch.setattr(PocketOptionBridge, "_run_refresh_once",
                        _no_refresh)
    return _FakeClient


async def _no_refresh(self=None) -> bool:
    return False


def test_sdk_config_raises_handshake_budget(monkeypatch, tmp_path, fake_client):
    """The native handshake budget must be OURS and larger than 60s — the SDK
    default is what aborts the rotation with 'Connection initialization timed
    out'."""
    bridge = _bridge(monkeypatch, tmp_path, po_init_timeout=120.0)
    asyncio.run(bridge._import_client())
    cfg = fake_client.instances[-1].config
    assert cfg["connection_initialization_timeout_secs"] == 120
    assert cfg["connection_initialization_timeout_secs"] > 60
    assert cfg["reconnect_time"] == bridge.settings.po_reconnect_time
    assert cfg["timeout_secs"] == int(bridge.settings.po_request_timeout)


def test_no_endpoints_pinned_uses_sdk_default(monkeypatch, tmp_path, fake_client):
    """Unset POCKET_OPTION_WS_URLS keeps the SDK's own streaming defaults
    (pinning url= previously killed the tick stream) while still shipping the
    tuned timeouts."""
    bridge = _bridge(monkeypatch, tmp_path)
    asyncio.run(bridge._import_client())
    fake = fake_client.instances[-1]
    assert fake.url is None
    assert "urls" not in fake.config
    assert fake.config["connection_initialization_timeout_secs"] > 60


def test_handshake_timeout_never_escalates_to_session_expired(
    monkeypatch, tmp_path, fake_client
):
    """A blocked handshake is TRANSPORT: surface connection_error, keep the
    readers armed, and do NOT declare a live SSID dead."""
    bridge = _bridge(monkeypatch, tmp_path, reconnect_delay=0.0)
    asyncio.run(bridge._ensure_connected())
    assert bridge.session_expired is False
    assert bridge._retry_stopped is False
    assert bridge.status == "connection_error"
    assert "retrying" in (bridge.last_error or "")
    # One ladder = TRANSIENT_CONNECT_ATTEMPTS fresh clients, then a clean bail.
    assert len(fake_client.instances) == TRANSIENT_CONNECT_ATTEMPTS


def test_bridge_wait_never_cancels_a_live_handshake(
    monkeypatch, tmp_path, fake_client
):
    """The bridge-side deadline must exceed the SDK handshake budget, otherwise
    asyncio.wait_for cancels an initialisation that is still in progress."""
    settings_deadline = (
        max(60.0, 120.0) + CONNECT_DEADLINE_GRACE
    )
    assert settings_deadline > 120.0
    seen: list = []

    class _SlowClient(_FakeClient):
        async def wait_for_assets(self, timeout=None):
            seen.append(timeout)
            raise asyncio.TimeoutError()

    fake_client.__bases__  # noqa: B018 - keep reference explicit
    monkeypatch.setattr(
        "BinaryOptionsToolsV2.pocketoption.PocketOptionAsync", _SlowClient
    )
    bridge = _bridge(monkeypatch, tmp_path, reconnect_delay=0.0)
    asyncio.run(bridge._ensure_connected())
    assert seen and all(t >= 120.0 for t in seen)
    assert bridge.session_expired is False
    assert bridge.status == "connection_error"


def test_timeout_error_classified_as_transport():
    assert PocketOptionBridge._is_transport_error(RuntimeError(TIMEOUT_ERROR))
    assert PocketOptionBridge._is_transport_error(asyncio.TimeoutError())
    assert PocketOptionBridge._is_transport_error(
        RuntimeError("client not connected after wait_for_assets (dead channel reused)")
    )
    assert not PocketOptionBridge._is_transport_error(
        RuntimeError("PocketOptionError, General error: Invalid session")
    )
    assert not PocketOptionBridge._is_transport_error(None)


def test_endpoints_rotate_between_attempts(monkeypatch, tmp_path, fake_client):
    """A failing host is bypassed on the next attempt, not re-probed first."""
    urls = [
        "wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket",
        "wss://api-asia.po.market/socket.io/?EIO=4&transport=websocket",
        "wss://api-us-south.po.market/socket.io/?EIO=4&transport=websocket",
    ]
    bridge = _bridge(monkeypatch, tmp_path, urls=urls)
    bridge._endpoint_rotation = 1
    asyncio.run(bridge._import_client())
    assert fake_client.instances[-1].config["urls"] == [urls[1], urls[2], urls[0]]
    bridge.client = None  # drop the cached client so a fresh one is built
    bridge._endpoint_rotation = 3
    asyncio.run(bridge._import_client())
    assert fake_client.instances[-1].config["urls"] == urls


def test_genuine_auth_failure_still_escalates(monkeypatch, tmp_path, fake_client):
    """Auth rejection keeps the terminal path (no silent ban-avoid regression)."""

    class _AuthFailClient(_FakeClient):
        async def wait_for_assets(self, timeout=None):
            raise RuntimeError("PocketOptionError, General error: Invalid session")

    monkeypatch.setattr(
        "BinaryOptionsToolsV2.pocketoption.PocketOptionAsync", _AuthFailClient
    )
    bridge = _bridge(monkeypatch, tmp_path, reconnect_delay=0.0)
    asyncio.run(bridge._ensure_connected())
    assert bridge.session_expired is True
    assert bridge._retry_stopped is True
    assert bridge.status == "session_expired"
