"""Tests for PO asset resolution + per-symbol subscription skipping.

Checks that unsupported/invalid OTC pairs (e.g. ``Invalid asset:
GBPCHF_otc``) are resolved against the broker's authoritative asset list and
skipped WITHOUT flipping the bridge into a global ``connection_error`` that
would take down the pairs that do work (EUR/USD, USD/CHF).

Runs offline using fake clients â€” no network, no SSID.
Run:  .venv-1\\Scripts\\python -m pytest pocket-bridge/tests -q
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from pocket_bridge.bridge import (  # noqa: E402
    AssetSkippedError,
    PocketOptionBridge,
)
from pocket_bridge.config import (  # noqa: E402
    BridgeSettings,
    asset_candidates,
    asset_for_symbol,
)
from pocket_bridge.m20_engine import M20Engine  # noqa: E402


class FakeActiveAssetsClient:
    """Minimal stand-in exposing ``active_assets()`` / ``is_connected()``."""

    def __init__(self, assets):
        self.assets = assets
        self.calls = []
        self.is_active = True

    def is_connected(self) -> bool:
        return self.is_active

    async def active_assets(self):
        self.calls.append("active_assets")
        return list(self.assets)


def _bridge(symbols, ssid="fake-ssid") -> PocketOptionBridge:
    return PocketOptionBridge(
        BridgeSettings(ssid=ssid, symbols=symbols),
M20Engine(symbols),
    )


# --- asset_candidates -------------------------------------------------------

def test_candidates_prefer_otc_then_bare():
    assert asset_candidates("GBP/CHF") == ["GBPCHF_otc", "GBPCHF"]
    assert asset_candidates("NZ d/Cad".replace(" ", "")) == ["NZDCAD_otc", "NZDCAD"]
    assert asset_candidates("EUR/AUD") == ["EURAUD_otc", "EURAUD"]
    assert asset_candidates("EUR/CAD") == ["EURCAD_otc", "EURCAD"]


def test_candidates_crypto_no_otc():
    assert asset_candidates("BTC/USD") == ["BTCUSD"]
    assert asset_candidates("ETH/USDT") == ["ETHUSDT"]


def test_asset_for_symbol_backward_compat():
    # asset_for_symbol keeps returning the preferred OTC form (unchanged).
    assert asset_for_symbol("GBP/CHF") == "GBPCHF_otc"
    assert asset_for_symbol("EUR/USD") == "EURUSD_otc"


# --- resolution against the broker asset list -------------------------------

def test_resolve_prefers_active_otc():
    bridge = _bridge(["GBP/CHF"])
    client = FakeActiveAssetsClient([
        {"symbol": "GBPCHF", "is_active": True},
        {"symbol": "GBPCHF_otc", "is_active": True},
    ])
    resolved = asyncio.run(bridge._resolve_asset(client, "GBP/CHF"))
    assert resolved == "GBPCHF_otc"


def test_resolve_falls_back_to_bare_pair():
    bridge = _bridge(["GBP/CHF"])
    client = FakeActiveAssetsClient([
        {"symbol": "GBPCHF", "is_active": True},
    ])
    resolved = asyncio.run(bridge._resolve_asset(client, "GBP/CHF"))
    assert resolved == "GBPCHF"


def test_resolve_none_when_broker_lacks_every_candidate():
    bridge = _bridge(["GBP/CHF"])
    client = FakeActiveAssetsClient([
        {"symbol": "EURUSD_otc", "is_active": True},
    ])
    resolved = asyncio.run(bridge._resolve_asset(client, "GBP/CHF"))
    assert resolved is None
    assert "GBP/CHF" not in bridge._skipped  # skipped only at subscribe time


def test_resolve_unavailable_list_falls_back_to_first_candidate():
    bridge = _bridge(["GBP/CHF"])
    client = FakeActiveAssetsClient([])
    client.active_assets = _explode  # list fetch fails at runtime
    resolved = asyncio.run(bridge._resolve_asset(client, "GBP/CHF"))
    assert resolved == "GBPCHF_otc"


# --- subscribe-time invalid-asset skip --------------------------------------

class FakeSubscribeErrorClient(FakeActiveAssetsClient):
    def __init__(self):
        super().__init__([])
        self.active_assets_calls = 0

    async def active_assets(self):
        self.active_assets_calls += 1
        raise RuntimeError("boom")

    async def subscribe_symbol(self, asset: str):
        raise RuntimeError(f"PocketOptionError, Invalid asset: {asset}")


def test_invalid_asset_error_detection():
    bridge = _bridge(["EUR/USD"])
    assert asyncio.run(bridge._is_invalid_asset_error(RuntimeError("Invalid asset: GBPCHF_otc"))
    )
    assert not asyncio.run(bridge._is_invalid_asset_error(RuntimeError("connection reset by peer"))
    )


def test_subscribe_invalid_asset_skips_without_connection_error():
    bridge = _bridge(["EUR/USD", "GBP/CHF"])
    bridge.status = "connected"  # other pairs are already live
    client = FakeSubscribeErrorClient()
    bridge.client = client
    with pytest.raises(AssetSkippedError):
        asyncio.run(bridge.run_reader("GBP/CHF", "GBPCHF_otc"))
    # Per-symbol skip: no global connection_error, bridge stays ONLINE.
    assert bridge.status == "connected"
    assert bridge.last_error is None
    assert bridge._skipped == {"GBP/CHF": "GBPCHF_otc"}


def test_subscribe_generic_failure_still_reports_connection_error():
    bridge = _bridge(["EUR/USD"])
    client = FakeSubscribeErrorClient()
    client.subscribe_symbol = _explode_generic  # not an invalid-asset error
    bridge.client = client
    asyncio.run(bridge.run_reader("EUR/USD", "EURUSD_otc"))
    assert bridge.status == "connection_error"
    assert "EUR/USD" not in bridge._skipped


# --- helpers ----------------------------------------------------------------

async def _explode(*_args, **_kwargs):
    raise RuntimeError("network down")


async def _explode_generic(*_args, **_kwargs):
    raise RuntimeError("connection reset by peer")
