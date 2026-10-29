"""Proxy routing, close-code diagnostics, jittered backoff and stall recovery.

These cover the reliability-only hardening for a cloud VPS deployment:

  * ``PROXY_URL`` is validated at boot and forwarded to the SDK transport
    without touching any TLS/fingerprint option;
  * invalid proxy auth / UID / SSID shapes fail fast with a clear ValueError;
  * reconnect delays grow exponentially with bounded randomized jitter;
  * WebSocket close codes are surfaced explicitly (1000/1006/1008);
  * a subscribed-but-silent symbol is flagged STALLED and drives a clean
    disconnect -> re-auth -> resubscribe cycle.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from pocket_bridge.bridge import (
    WS_CLOSE_ABNORMAL,
    WS_CLOSE_NORMAL,
    WS_CLOSE_POLICY_VIOLATION,
    PocketOptionBridge,
)
from pocket_bridge.config import (
    BridgeSettings,
    mask_proxy_url,
    normalize_proxy_url,
)
from pocket_bridge.m20_engine import M20Engine

SSID = '42["auth",{"session":"abc123def456session","uid":1,"isDemo":0}]'


def _settings(**overrides) -> BridgeSettings:
    values = {
        "ssid": SSID,
        "symbols": [],
        "session_path": "",
        "refresh_at_startup": False,
    }
    values.update(overrides)
    return BridgeSettings(**values)


def _bridge(**overrides) -> PocketOptionBridge:
    return PocketOptionBridge(_settings(**overrides), M20Engine([], max_history=10))


class _ConnectedClient:
    def __init__(self) -> None:
        self.disconnected = False

    def is_connected(self) -> bool:
        return True

    async def send_raw_message(self, message: str) -> None:
        return None

    async def disconnect(self) -> None:
        self.disconnected = True


# ── PROXY_URL ────────────────────────────────────────────────────────────────


def test_proxy_url_is_read_and_canonicalized(monkeypatch):
    monkeypatch.setenv("PROXY_URL", "SOCKS5://user:pass@Proxy.Example.com:1080")
    settings = BridgeSettings(ssid=SSID, symbols=[])
    assert settings.proxy_url == "socks5://user:pass@Proxy.Example.com:1080"
    assert settings.has_proxy is True


def test_proxy_url_defaults_port_per_scheme(monkeypatch):
    assert normalize_proxy_url("socks5://proxy.local") == (
        "socks5://proxy.local:1080"
    )
    assert normalize_proxy_url("http://proxy.local") == "http://proxy.local:8080"
    assert normalize_proxy_url("") == ""


def test_invalid_proxy_scheme_fails_fast(monkeypatch):
    monkeypatch.setenv("PROXY_URL", "ftp://proxy.local:21")
    with pytest.raises(ValueError, match="PROXY_URL scheme"):
        BridgeSettings(ssid=SSID, symbols=[])


def test_proxy_credentials_require_a_password(monkeypatch):
    monkeypatch.setenv("PROXY_URL", "socks5://user@proxy.local:1080")
    with pytest.raises(ValueError, match="user:password@host:port"):
        BridgeSettings(ssid=SSID, symbols=[])


def test_proxy_url_is_redacted_in_health_and_logs():
    assert mask_proxy_url("socks5://user:pass@proxy.local:1080") == (
        "socks5://***:***@proxy.local:1080"
    )
    assert mask_proxy_url("") == "(none)"


def test_invalid_uid_fails_fast(monkeypatch):
    monkeypatch.setenv("POCKET_OPTION_UID", "-5")
    # A raw token takes uid from the environment (an explicit frame would pin it).
    with pytest.raises(ValueError, match="POCKET_OPTION_UID"):
        BridgeSettings(ssid="abc123def456session", symbols=[])


def test_proxy_is_forwarded_to_the_sdk_transport(monkeypatch, tmp_path):
    from BinaryOptionsToolsV2 import pocketoption as po

    class _FakeClient:
        instances: list = []

        def __init__(self, payload, config=None, **kwargs):
            self.config = config
            type(self).instances.append(self)

    monkeypatch.setattr(po, "PocketOptionAsync", _FakeClient)
    monkeypatch.setenv("PROXY_URL", "socks5://user:pass@127.0.0.1:1080")
    bridge = _bridge(session_path=str(tmp_path / "missing.json"))

    asyncio.run(bridge._import_client())

    config = _FakeClient.instances[-1].config
    assert config["proxy"] == "socks5://user:pass@127.0.0.1:1080"
    # Reliability-only: no fingerprint/TLS knobs are injected by the proxy path.
    assert "tls_cipher_suites" not in config
    assert "tls_alpn" not in config


def test_empty_proxy_allows_direct_egress(monkeypatch, tmp_path):
    from BinaryOptionsToolsV2 import pocketoption as po

    class _FakeClient:
        instances: list = []

        def __init__(self, payload, config=None, **kwargs):
            self.config = config
            type(self).instances.append(self)

    monkeypatch.setattr(po, "PocketOptionAsync", _FakeClient)
    monkeypatch.delenv("PROXY_URL", raising=False)
    monkeypatch.delenv("POCKET_OPTION_PROXY", raising=False)
    bridge = _bridge(session_path=str(tmp_path / "missing.json"))

    assert bridge.settings.proxy_url == ""
    assert bridge.settings.has_proxy is False

    asyncio.run(bridge._import_client())

    config = _FakeClient.instances[-1].config
    assert "proxy" not in config
    assert bridge.health_payload()["proxy_enabled"] is False


# ── Backoff / close codes ────────────────────────────────────────────────────


def test_backoff_is_exponential_without_jitter():
    bridge = _bridge(reconnect_base_delay=1.0, reconnect_max_delay=60.0,
                     reconnect_jitter=0.0)
    assert [bridge._backoff_delay(i) for i in range(7)] == [
        1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0,
    ]


def test_backoff_jitter_stays_within_bounds():
    bridge = _bridge(reconnect_base_delay=1.0, reconnect_max_delay=60.0,
                     reconnect_jitter=0.25)
    for index in range(7):
        raw = min(60.0, 2.0 ** index)
        delay = bridge._backoff_delay(index)
        assert raw <= delay <= raw * 1.25 + 1e-9


def test_close_codes_are_classified_explicitly():
    bridge = _bridge()
    assert bridge._classify_close(None, clean=True) == WS_CLOSE_NORMAL
    assert bridge._classify_close(RuntimeError("policy violation")) == (
        WS_CLOSE_POLICY_VIOLATION
    )
    assert bridge._classify_close(RuntimeError("connection reset by peer")) == (
        WS_CLOSE_ABNORMAL
    )

    class _CloseError(Exception):
        code = 1008

    assert bridge._classify_close(_CloseError("closed")) == 1008
    assert bridge._extract_close_code(RuntimeError("ws closed 1006")) == 1006


# ── Stall watchdog / clean recovery ──────────────────────────────────────────


def test_stale_subscription_is_flagged_and_recovery_is_scheduled(monkeypatch):
    bridge = _bridge()
    client = _ConnectedClient()
    bridge.client = client
    bridge.status = "connected"
    bridge._subs = {"EUR/USD": object()}
    bridge._last_tick_ts = {"EUR/USD": time.time() - 51.0}
    scheduled: list = []
    monkeypatch.setattr(
        bridge, "_schedule_stall_recovery",
        lambda symbols: scheduled.append(list(symbols)),
    )

    asyncio.run(bridge._heartbeat_tick(send_keepalive=False, emit=False))

    assert client.disconnected is True
    assert bridge.client is None
    assert bridge.status == "stalled"
    assert scheduled == [["EUR/USD"]]


def test_fresh_subscription_gets_a_full_window_before_being_recycled():
    bridge = _bridge()
    client = _ConnectedClient()
    bridge.client = client
    bridge.status = "connected"
    bridge._subs = {"EUR/USD": object()}
    bridge._subscribed_at = {"EUR/USD": time.time()}

    asyncio.run(bridge._heartbeat_tick(send_keepalive=False, emit=False))

    assert client.disconnected is False
    assert bridge.status == "connected"


def test_stall_recovery_runs_clean_disconnect_auth_and_resubscribe(monkeypatch):
    bridge = _bridge()
    bridge.client = _ConnectedClient()
    calls: list = []

    async def teardown() -> None:
        calls.append("teardown")

    async def connect() -> None:
        calls.append("connect")

    def start_static() -> None:
        calls.append("static")

    def rearm_dynamic() -> None:
        calls.append("dynamic")

    monkeypatch.setattr(bridge, "_teardown_client", teardown)
    monkeypatch.setattr(bridge, "_ensure_connected", connect)
    monkeypatch.setattr(bridge, "_start_static_readers", start_static)
    monkeypatch.setattr(bridge, "_rearm_dynamic_readers", rearm_dynamic)

    asyncio.run(bridge._recover_after_stall(["EUR/USD"]))

    assert calls == ["teardown", "connect", "static", "dynamic"]


# ── SERVER_PUBLIC_IP ─────────────────────────────────────────────────────────


def test_server_public_ip_is_read_and_reported(monkeypatch):
    monkeypatch.setenv("SERVER_PUBLIC_IP", "91.99.71.111")
    settings = BridgeSettings(ssid=SSID, symbols=[])
    assert settings.server_public_ip == "91.99.71.111"

    bridge = PocketOptionBridge(settings, M20Engine([], max_history=10))
    assert bridge.health_payload()["server_public_ip"] == "91.99.71.111"


def test_invalid_server_public_ip_fails_fast(monkeypatch):
    monkeypatch.setenv("SERVER_PUBLIC_IP", "vps.example.com")
    with pytest.raises(ValueError, match="SERVER_PUBLIC_IP"):
        BridgeSettings(ssid=SSID, symbols=[])


def test_server_public_ip_is_never_injected_into_auth(monkeypatch):
    monkeypatch.setenv("SERVER_PUBLIC_IP", "91.99.71.111")
    settings = BridgeSettings(ssid=SSID, symbols=[])
    assert "server_public_ip" not in settings.auth
    assert "91.99.71.111" not in repr(settings.auth)
