"""Tests for PO asset resolution + per-symbol subscription skipping.

Checks that unsupported/invalid OTC pairs (e.g. ``Invalid asset:
AUDCHF_otc``) are resolved against the broker's authoritative asset list and
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
    AssetsNotReadyError,
    PocketOptionBridge,
)
from pocket_bridge.config import (  # noqa: E402
    BridgeSettings,
    asset_candidates,
    asset_for_symbol,
    broker_symbol_is_otc,
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
    assert asset_candidates("AUD/CHF") == ["AUDCHF_otc", "AUDCHF"]
    assert asset_candidates("NZ d/Cad".replace(" ", "")) == ["NZDCAD_otc", "NZDCAD"]
    assert asset_candidates("EUR/AUD") == ["EURAUD_otc", "EURAUD"]
    assert asset_candidates("EUR/CAD") == ["EURCAD_otc", "EURCAD"]


def test_candidates_reject_retired_crypto():
    assert asset_candidates("BTC/USD") == []
    assert asset_candidates("ETH/USDT") == []


def test_dynamic_pair_gets_both_spellings_as_fallbacks():
    """A pair outside the hard-coded OTC set must still be able to resolve the
    broker's ``_otc`` listing instead of being dropped."""
    assert asset_candidates("USD/IDR") == ["USDIDR", "USDIDR_otc"]
    assert asset_candidates("EUR/SEK") == ["EURSEK"]  # REAL_FOREX stays bare
    assert broker_symbol_is_otc("USDIDR_otc") is True
    assert broker_symbol_is_otc("USDIDR") is False


def test_asset_for_symbol_backward_compat():
    # asset_for_symbol keeps returning the preferred OTC form (unchanged).
    assert asset_for_symbol("AUD/CHF") == "AUDCHF_otc"
    assert asset_for_symbol("EUR/USD") == "EURUSD_otc"


# --- resolution against the broker asset list -------------------------------

def test_resolve_prefers_active_otc():
    bridge = _bridge(["AUD/CHF"])
    client = FakeActiveAssetsClient([
        {"symbol": "AUDCHF", "is_active": True},
        {"symbol": "AUDCHF_otc", "is_active": True},
    ])
    resolved = asyncio.run(bridge._resolve_asset(client, "AUD/CHF"))
    assert resolved == "AUDCHF_otc"


def test_resolve_falls_back_to_bare_pair():
    bridge = _bridge(["AUD/CHF"])
    client = FakeActiveAssetsClient([
        {"symbol": "AUDCHF", "is_active": True},
    ])
    resolved = asyncio.run(bridge._resolve_asset(client, "AUD/CHF"))
    assert resolved == "AUDCHF"


def test_resolve_none_when_broker_lacks_every_candidate():
    bridge = _bridge(["AUD/CHF"])
    client = FakeActiveAssetsClient([
        {"symbol": "EURUSD_otc", "is_active": True},
    ])
    resolved = asyncio.run(bridge._resolve_asset(client, "AUD/CHF"))
    assert resolved is None
    assert "AUD/CHF" not in bridge._skipped  # skipped only at subscribe time


def test_resolve_unavailable_list_falls_back_to_first_candidate():
    bridge = _bridge(["AUD/CHF"])
    client = FakeActiveAssetsClient([])
    client.active_assets = _explode  # list fetch fails at runtime
    resolved = asyncio.run(bridge._resolve_asset(client, "AUD/CHF"))
    assert resolved == "AUDCHF_otc"


def test_resolve_uses_broker_spelling_for_dynamic_otc_pair():
    """The exact broker symbol (case/suffix) is returned, not a reconstruction."""
    bridge = _bridge(["USD/IDR"])
    client = FakeActiveAssetsClient([
        {"symbol": "usdidr_otc", "is_active": True},
    ])
    resolved = asyncio.run(bridge._resolve_asset(client, "USD/IDR"))
    assert resolved == "usdidr_otc"
    assert bridge._asset_type("USD/IDR", resolved) == "otc"


def test_resolve_prefers_otc_when_both_variants_are_listed():
    bridge = _bridge(["EUR/USD"])
    client = FakeActiveAssetsClient([
        {"symbol": "EURUSD", "is_active": True},
        {"symbol": "EURUSD_otc", "is_active": True},
    ])
    assert asyncio.run(bridge._resolve_asset(client, "EUR/USD")) == "EURUSD_otc"


def test_real_forex_never_resolves_to_an_otc_listing():
    """The 5 ECB-sourced pairs must never be priced from the OTC venue."""
    bridge = _bridge(["EUR/HUF"])
    client = FakeActiveAssetsClient([
        {"symbol": "EURHUF_otc", "is_active": True},
    ])
    assert asyncio.run(bridge._resolve_asset(client, "EUR/HUF")) is None


def test_resolve_falls_back_to_inactive_listing():
    bridge = _bridge(["AUD/CHF"])
    client = FakeActiveAssetsClient([
        {"symbol": "AUDCHF_otc", "is_active": False},
    ])
    resolved = asyncio.run(bridge._resolve_asset(client, "AUD/CHF"))
    assert resolved == "AUDCHF_otc"


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
    assert asyncio.run(bridge._is_invalid_asset_error(RuntimeError("Invalid asset: AUDCHF_otc"))
    )
    assert not asyncio.run(bridge._is_invalid_asset_error(RuntimeError("connection reset by peer"))
    )


def test_subscribe_invalid_asset_skips_without_connection_error():
    bridge = _bridge(["EUR/USD", "AUD/CHF"])
    bridge.status = "connected"  # other pairs are already live
    bridge._assets_ready = True
    client = FakeSubscribeErrorClient()
    bridge.client = client
    with pytest.raises(AssetSkippedError):
        asyncio.run(bridge.run_reader("AUD/CHF", "AUDCHF_otc"))
    # Per-symbol skip: no global connection_error, bridge stays ONLINE.
    assert bridge.status == "connected"
    assert bridge.last_error is None
    assert bridge._skipped == {"AUD/CHF": "AUDCHF_otc"}


def test_subscribe_generic_failure_still_reports_connection_error():
    bridge = _bridge(["EUR/USD"])
    bridge.status = "connected"
    bridge._assets_ready = True
    client = FakeSubscribeErrorClient()
    client.subscribe_symbol = _explode_generic  # not an invalid-asset error
    bridge.client = client
    asyncio.run(bridge.run_reader("EUR/USD", "EURUSD_otc"))
    assert bridge.status == "connection_error"
    assert "EUR/USD" not in bridge._skipped


class FakeWarmingAssetsClient(FakeActiveAssetsClient):
    """Socket is up but the SDK's asset registry is still empty."""

    def __init__(self):
        super().__init__([])
        self.subscribe_calls = 0

    async def active_assets(self):
        raise RuntimeError("Uninitialized, Assets not initialized yet.")

    async def subscribe_symbol(self, asset: str):
        self.subscribe_calls += 1
        raise RuntimeError(
            f'PocketOptionError, General error: BinaryOptionsError: '
            f'General("Assets not found")'
        )


def test_assets_not_found_on_warming_registry_is_transient_not_skipped():
    """The exact production error must NEVER permanently skip the pair nor
    flip the bridge into a global connection_error."""
    bridge = _bridge(["EUR/USD"])
    bridge.status = "connected"
    bridge._assets_ready = True  # legacy/racy state: ready flag, no registry
    client = FakeWarmingAssetsClient()
    bridge.client = client

    with pytest.raises(AssetsNotReadyError):
        asyncio.run(bridge.run_reader("EUR/USD", "EURUSD_otc"))

    assert bridge.status == "connected"
    assert bridge._skipped == {}
    # The error is classified transient — the symbol is NOT retired/skipped.
    assert client.subscribe_calls == 1


def test_unready_bridge_defers_before_any_subscribe_attempt():
    bridge = _bridge(["EUR/USD"])
    client = FakeWarmingAssetsClient()
    bridge.client = client
    bridge._assets_ready = False

    async def _already_connected() -> None:
        return None

    bridge._ensure_connected = _already_connected  # type: ignore[method-assign]

    with pytest.raises(AssetsNotReadyError):
        asyncio.run(bridge.run_reader("EUR/USD", "EURUSD_otc"))

    assert client.subscribe_calls == 0
    assert bridge._skipped == {}


def test_ready_is_deferred_until_the_registry_is_populated():
    bridge = _bridge(["EUR/USD"])
    calls = []

    async def on_ready():
        calls.append(True)

    bridge.on_ready = on_ready
    asyncio.run(bridge._mark_ready())
    assert bridge._assets_ready is False
    assert calls == []

    bridge._available_assets = {"EURUSD_otc"}
    asyncio.run(bridge._mark_ready())
    assert bridge._assets_ready is True
    assert calls == [True]


# --- helpers ----------------------------------------------------------------

async def _explode(*_args, **_kwargs):
    raise RuntimeError("network down")


async def _explode_generic(*_args, **_kwargs):
    raise RuntimeError("connection reset by peer")
