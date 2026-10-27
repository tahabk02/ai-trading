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
import json
import logging

import pytest

import pocket_bridge.bridge as bridge_mod

from pocket_bridge.bridge import (
    CONNECT_DEADLINE_GRACE,
    PocketOptionBridge,
    TRANSIENT_CONNECT_ATTEMPTS,
)
from pocket_bridge.config import BridgeSettings, DEFAULT_UA
from pocket_bridge.m20_engine import M20Engine

TIMEOUT_ERROR = (
    "PocketOptionError, General error: Connection initialization timed out"
)

PHP_SSID_WITH_STALE_COUNT = (
    'a:4:{s:10:"session_id";s:32:"0123456789abcdef0123456789abcdef";'
    's:10:"ip_address";s:7:"0.0.0.0";'
    's:10:"user_agent";s:111:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";'
    's:13:"last_activity";i:1732926685;'
    's:9:"device_id";s:5:"abcde";}'
    '00000000000000000000000000000000'
)


def _settings(monkeypatch, tmp_path, **overrides) -> BridgeSettings:
    monkeypatch.delenv("POCKET_OPTION_SSID", raising=False)
    monkeypatch.delenv("POCKET_OPTION_USER_AGENT", raising=False)
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


def test_real_php_ssid_is_sent_as_a_full_42_auth_frame(
    monkeypatch, tmp_path, fake_client
):
    """The SDK needs ``42["auth",{...}]``, never the bare PHP session.

    Pocket Option can append fields while leaving the PHP header at ``a:4``;
    the SDK then stops after four entries and reports ``Expected '}' but got
    's'``. The payload handed to PocketOptionAsync must already be repaired.
    """
    monkeypatch.setenv("POCKET_OPTION_UID", "12345678")
    monkeypatch.setenv("POCKET_OPTION_IS_DEMO", "0")
    bridge = _bridge(monkeypatch, tmp_path, ssid=PHP_SSID_WITH_STALE_COUNT)

    asyncio.run(bridge._import_client())

    payload = fake_client.instances[-1].payload
    assert payload.startswith('42["auth",')
    auth = json.loads(payload[2:])[1]
    assert auth["session"].startswith("a:5:{")
    assert 's:9:"device_id";s:5:"abcde";' in auth["session"]
    assert auth["session"].endswith("00000000000000000000000000000000")
    assert auth["uid"] == 12345678
    assert isinstance(auth["uid"], int)
    assert auth["isDemo"] == 0
    assert isinstance(auth["isDemo"], int)


def test_sdk_payload_diagnostics_are_loud_and_redacted(
    monkeypatch, tmp_path, fake_client, capsys
):
    monkeypatch.setenv("POCKET_OPTION_UID", "12345678")
    monkeypatch.setenv("POCKET_OPTION_IS_DEMO", "0")
    bridge = _bridge(monkeypatch, tmp_path, ssid=PHP_SSID_WITH_STALE_COUNT)

    asyncio.run(bridge._import_client())

    err = capsys.readouterr().err
    assert "SDK_PAYLOAD_DIAG" in err
    assert "payload_type=str" in err
    assert "payload_len=" in err
    assert "payload_repr=" in err
    assert "auth_uid=12345678 auth_uid_type=int" in err
    assert "auth_isDemo=0 auth_isDemo_type=int" in err
    assert "session_php_container=array" in err
    assert "session_php_header=a:5" in err
    assert "session_php_declared=5" in err
    assert "session_starts_php=True" in err
    assert "<REDACTED_SESSION" in err
    assert PHP_SSID_WITH_STALE_COUNT not in err
    assert "device_id" not in err


def test_object_php_session_is_redacted_without_known_session():
    object_session = (
        'O:8:"stdClass":1:{s:10:"session_id";s:32:'
        '"0123456789abcdef0123456789abcdef";}'
    )
    redacted = bridge_mod._redact_diagnostic_text(object_session)

    assert "<REDACTED_SESSION" in redacted
    assert "session_id" not in redacted
    assert "0123456789abcdef" not in redacted


def test_sdk_init_exception_logs_trace_and_redacts_session(
    monkeypatch, tmp_path, capsys
):
    from BinaryOptionsToolsV2 import PocketOptionError
    from BinaryOptionsToolsV2 import pocketoption as po

    class _BoomClient:
        def __init__(self, payload, **kwargs):
            raise PocketOptionError(f"Failed to parse ssid: {payload}")

    monkeypatch.setattr(po, "PocketOptionAsync", _BoomClient)
    monkeypatch.setenv("POCKET_OPTION_UID", "12345678")
    monkeypatch.setenv("POCKET_OPTION_IS_DEMO", "0")
    bridge = _bridge(monkeypatch, tmp_path, ssid=PHP_SSID_WITH_STALE_COUNT)

    with pytest.raises(PocketOptionError):
        asyncio.run(bridge._import_client())

    err = capsys.readouterr().err
    assert "SDK_INIT_EXCEPTION" in err
    assert "exception_type=PocketOptionError" in err
    assert "is_pocket_option_error=True" in err
    assert "exception_args=" in err
    assert "Traceback (most recent call last)" in err
    assert "<REDACTED_SESSION" in err
    assert PHP_SSID_WITH_STALE_COUNT not in err
    assert "device_id" not in err


def test_no_endpoints_pinned_uses_sdk_default(monkeypatch, tmp_path, fake_client):
    """Unset POCKET_OPTION_WS_URLS keeps the SDK's own streaming defaults
    (pinning url= previously killed the tick stream) while still shipping the
    tuned timeouts."""
    monkeypatch.delenv("POCKET_OPTION_USER_AGENT", raising=False)
    bridge = _bridge(monkeypatch, tmp_path)
    asyncio.run(bridge._import_client())
    fake = fake_client.instances[-1]
    assert fake.url is None
    assert "urls" not in fake.config
    assert fake.config["connection_initialization_timeout_secs"] > 60
    assert fake.config["user_agent"] == DEFAULT_UA


def test_configured_user_agent_is_sent_to_sdk(monkeypatch, tmp_path, fake_client):
    bridge = _bridge(monkeypatch, tmp_path, user_agent="CustomUA/1.0")
    asyncio.run(bridge._import_client())
    assert fake_client.instances[-1].config["user_agent"] == "CustomUA/1.0"


def test_user_agent_is_read_from_environment(monkeypatch):
    monkeypatch.setenv("POCKET_OPTION_USER_AGENT", "CustomUA/1.0")
    assert BridgeSettings().user_agent == "CustomUA/1.0"


@pytest.mark.parametrize(
    "environment_value",
    [None, "", "   ", "(sdk default)", "Chrome/100 (sdk default)"],
)
def test_sdk_default_user_agent_sentinel_always_uses_pinned_ua(
    monkeypatch, tmp_path, fake_client, environment_value
):
    if environment_value is None:
        monkeypatch.delenv("POCKET_OPTION_USER_AGENT", raising=False)
    else:
        monkeypatch.setenv("POCKET_OPTION_USER_AGENT", environment_value)

    settings = BridgeSettings()
    bridge = _bridge(monkeypatch, tmp_path, user_agent=settings.user_agent)
    asyncio.run(bridge._import_client())

    assert settings.user_agent == DEFAULT_UA
    assert fake_client.instances[-1].config["user_agent"] == DEFAULT_UA


def test_direct_sdk_placeholder_is_replaced_and_fingerprint_logs_pinned_ua(
    monkeypatch, tmp_path, fake_client, caplog
):
    bridge = _bridge(monkeypatch, tmp_path, user_agent="(sdk default)")
    with caplog.at_level(logging.INFO, logger="pocket_bridge.bridge"):
        asyncio.run(bridge._import_client())

    assert fake_client.instances[-1].config["user_agent"] == DEFAULT_UA
    assert f"handshake_fingerprint user_agent={DEFAULT_UA}" in caplog.text
    assert "(sdk default)" not in caplog.text


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


def test_init_timeout_logs_exception_class_region_and_rotation(
    monkeypatch, tmp_path, fake_client, caplog
):
    """PART 44 [498] — an init-timeout failure must log the REGIONAL WS URL(s)
    actually attempted, the SDK EXCEPTION CLASS (not just the string), and the
    current endpoint rotation — for attempt 1 the unrotated SDK order is shown
    (rotate=0), and a rotated attempt surfaces the next regional host."""
    urls = [
        "wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket",
        "wss://api-asia.po.market/socket.io/?EIO=4&transport=websocket",
    ]
    bridge = _bridge(monkeypatch, tmp_path, reconnect_delay=0.0, urls=urls)
    with caplog.at_level(logging.ERROR, logger="pocket_bridge.bridge"):
        asyncio.run(bridge._ensure_connected())
    assert bridge.status == "connection_error"
    assert len(fake_client.instances) == TRANSIENT_CONNECT_ATTEMPTS
    records = "\n".join(rec.message for rec in caplog.records)
    assert "class=RuntimeError" in records
    assert "Connection initialization timed out" in records
    assert "api-eu.po.market" in records
    assert "rotate=0" in records
    assert "urls=['wss://api-eu.po.market" in records
    # One rotation per failed attempt is proven by the log field itself (0 → 3).
    for n in range(TRANSIENT_CONNECT_ATTEMPTS):
        assert f"rotate={n}" in records


def test_rotated_attempt_surfaces_next_regional_host(
    monkeypatch, tmp_path, fake_client, caplog
):
    """A pre-rotated bridge (blocked EU host) logs the ASIA host + rotation on
    attempt 1 — the diagnostic points at the region actually being tried."""
    urls = [
        "wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket",
        "wss://api-asia.po.market/socket.io/?EIO=4&transport=websocket",
    ]
    bridge = _bridge(monkeypatch, tmp_path, reconnect_delay=0.0, urls=urls)
    bridge._endpoint_rotation = 1
    with caplog.at_level(logging.ERROR, logger="pocket_bridge.bridge"):
        asyncio.run(bridge._ensure_connected())
    records = "\n".join(rec.message for rec in caplog.records)
    assert "api-asia.po.market" in records
    assert "rotate=1" in records


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
