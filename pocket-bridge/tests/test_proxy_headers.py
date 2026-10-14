"""Optional upstream proxy + browser-fingerprint headers for the PO bridge.

Covers the headless-feed hardening:

  * ``PO_BRIDGE_PROXY`` (single) / ``PO_BRIDGE_PROXY_LIST`` (rotating pool) are
    forwarded to the SDK's native ``config.proxy`` — and are ABSENT from the
    config when unset (never a bogus empty proxy).
  * the proxy rotates in step with the regional-endpoint rotation, even when
    ``POCKET_OPTION_WS_URLS`` is unset.
  * the handshake ``User-Agent`` falls back to the captured session's own
    ``userAgent`` (the fingerprint that minted the SSID) and can be overridden
    by env; ``origin`` defaults to the PO web origin.
  * proxy credentials are forwarded to the SDK but NEVER appear in the log line.
"""

import asyncio
import logging

import pytest

from pocket_bridge.bridge import (
    PocketOptionBridge,
    TRANSIENT_CONNECT_ATTEMPTS,
)
from pocket_bridge.config import (
    BridgeSettings,
    mask_proxy,
    proxy_warning,
)

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
        _settings(monkeypatch, tmp_path, **overrides), _M20([])
    )
    bridge.session.raw_ssid = "not-a-real-ssid"
    bridge.session.cookies.append(
        {"name": "ssid", "value": "not-a-real-ssid", "domain": ".pocketoption.com"}
    )
    return bridge


def _M20(symbols):
    from pocket_bridge.m20_engine import M20Engine

    return M20Engine(symbols, max_history=10)


class _FakeClient:
    """Stands in for PocketOptionAsync: records config, always fails to auth."""

    instances: list = []

    def __init__(self, payload, config=None, url=None, **kwargs):
        self.payload = payload
        self.config = config
        self.url = url
        type(self).instances.append(self)

    async def wait_for_assets(self, timeout=None):
        raise RuntimeError(TIMEOUT_ERROR)

    def is_connected(self):
        return False

    async def disconnect(self):
        pass


async def _no_refresh(self=None) -> bool:
    return False


@pytest.fixture
def fake_client(monkeypatch):
    from BinaryOptionsToolsV2 import pocketoption as po

    _FakeClient.instances = []
    monkeypatch.setattr(po, "PocketOptionAsync", _FakeClient)
    monkeypatch.setattr(PocketOptionBridge, "_run_refresh_once", _no_refresh)
    return _FakeClient


def _cfg(bridge, fake_client):
    asyncio.run(bridge._import_client())
    return fake_client.instances[-1].config


# ── proxy forwarding ────────────────────────────────────────────────────────

def test_proxy_forwarded_to_sdk_config(monkeypatch, tmp_path, fake_client):
    bridge = _bridge(monkeypatch, tmp_path, proxy="socks5://host:1080")
    assert _cfg(bridge, fake_client)["proxy"] == "socks5://host:1080"


def test_proxy_absent_when_unset(monkeypatch, tmp_path, fake_client):
    """No proxy configured must mean NO ``proxy`` key at all — an empty string
    would make the SDK try to tunnel through "" instead of dialing direct."""
    bridge = _bridge(monkeypatch, tmp_path)
    assert "proxy" not in _cfg(bridge, fake_client)


def test_proxy_credentials_forwarded_verbatim_to_sdk(
    monkeypatch, tmp_path, fake_client
):
    url = "http://user:pass@host:3128"
    bridge = _bridge(monkeypatch, tmp_path, proxy=url)
    assert _cfg(bridge, fake_client)["proxy"] == url


def test_proxy_pool_rotates_with_rotation_index(monkeypatch, tmp_path, fake_client):
    pool = ["http://a:1", "http://b:2"]
    bridge = _bridge(monkeypatch, tmp_path, proxy_list=pool)
    bridge._endpoint_rotation = 1
    assert _cfg(bridge, fake_client)["proxy"] == "http://b:2"


def test_proxy_list_takes_precedence_over_single(monkeypatch, tmp_path, fake_client):
    bridge = _bridge(
        monkeypatch, tmp_path, proxy="http://single:1", proxy_list=["http://pool:2"]
    )
    assert _cfg(bridge, fake_client)["proxy"] == "http://pool:2"


# ── browser-fingerprint headers ─────────────────────────────────────────────

def test_user_agent_falls_back_to_captured_session(monkeypatch, tmp_path, fake_client):
    bridge = _bridge(monkeypatch, tmp_path)
    bridge.session.user_agent = "Mozilla/5.0 (captured browser)"
    assert _cfg(bridge, fake_client)["user_agent"] == "Mozilla/5.0 (captured browser)"


def test_env_user_agent_overrides_session(monkeypatch, tmp_path, fake_client):
    bridge = _bridge(monkeypatch, tmp_path, user_agent="CustomUA/1.0")
    bridge.session.user_agent = "Mozilla/5.0 (captured browser)"
    assert _cfg(bridge, fake_client)["user_agent"] == "CustomUA/1.0"


def test_user_agent_absent_when_no_source(monkeypatch, tmp_path, fake_client):
    bridge = _bridge(monkeypatch, tmp_path)
    assert "user_agent" not in _cfg(bridge, fake_client)


def test_origin_defaults_to_po_web_origin(monkeypatch, tmp_path, fake_client):
    bridge = _bridge(monkeypatch, tmp_path)
    assert _cfg(bridge, fake_client)["origin"] == "https://pocketoption.com"


def test_optional_headers_absent_by_default(monkeypatch, tmp_path, fake_client):
    cfg = _cfg(_bridge(monkeypatch, tmp_path), fake_client)
    assert "sec_websocket_extensions" not in cfg
    assert "tls_cipher_suites" not in cfg
    assert "tls_alpn" not in cfg


def test_optional_headers_forwarded_when_configured(
    monkeypatch, tmp_path, fake_client
):
    bridge = _bridge(
        monkeypatch,
        tmp_path,
        sec_websocket_extensions="permessage-deflate",
        tls_cipher_suites=["TLS_AES_128_GCM_SHA256"],
        tls_alpn=["http/1.1"],
    )
    cfg = _cfg(bridge, fake_client)
    assert cfg["sec_websocket_extensions"] == "permessage-deflate"
    assert cfg["tls_cipher_suites"] == ["TLS_AES_128_GCM_SHA256"]
    assert cfg["tls_alpn"] == ["http/1.1"]


# ── rotation + logging ──────────────────────────────────────────────────────

def test_proxy_pool_rotates_across_connect_attempts(
    monkeypatch, tmp_path, fake_client
):
    """A blocked proxy must be bypassed on the NEXT attempt even without
    POCKET_OPTION_WS_URLS — the rotation counter advances on the proxy pool."""
    pool = ["http://a:1", "http://b:2"]
    bridge = _bridge(monkeypatch, tmp_path, reconnect_delay=0.0, proxy_list=pool)
    asyncio.run(bridge._ensure_connected())
    assert bridge._endpoint_rotation == TRANSIENT_CONNECT_ATTEMPTS
    sent = [inst.config.get("proxy") for inst in fake_client.instances]
    assert sent == [pool[0], pool[1], pool[0]]


def test_fingerprint_log_masks_proxy_credentials(
    monkeypatch, tmp_path, fake_client, caplog
):
    bridge = _bridge(
        monkeypatch, tmp_path, proxy="http://user:secret@host:3128"
    )
    with caplog.at_level(logging.INFO, logger="pocket_bridge.bridge"):
        asyncio.run(bridge._import_client())
    records = "\n".join(rec.message for rec in caplog.records)
    assert "handshake_fingerprint" in records
    assert "http://***@host:3128" in records
    assert "secret" not in records


# ── pure helpers ────────────────────────────────────────────────────────────

def test_mask_proxy_strips_userinfo():
    assert mask_proxy("http://user:pass@host:3128") == "http://***@host:3128"
    assert mask_proxy("socks5://host:1080") == "socks5://host:1080"
    assert mask_proxy("") == ""
    assert mask_proxy("user:pass@host:3128") == "***@host:3128"


def test_proxy_warning_reports_bad_scheme_and_missing_scheme():
    assert proxy_warning("http://host:3128") is None
    assert proxy_warning("socks5://host:1080") is None
    assert proxy_warning(None) is None
    assert "missing a scheme" in (proxy_warning("host:3128") or "")
    assert "not one of" in (proxy_warning("ftp://host:21") or "")
