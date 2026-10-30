"""One streaming client per symbol (BinaryOptionsToolsV2 0.2.14 limitation).

A second concurrent ``subscribe_symbol`` on the same SDK client silences ALL
streams, so the bridge must give every non-primary pair its own
``PocketOptionAsync`` while the primary pair keeps using the control client.
"""

import asyncio
import json
import time

from pocket_bridge.bridge import PocketOptionBridge
from pocket_bridge.config import BridgeSettings
from pocket_bridge.m20_engine import M20Engine

SSID = (
    '42["auth",{"session":"0123456789abcdef0123456789abcdef",'
    '"isDemo":1,"uid":123456,"platform":9,'
    '"isFastHistory":true,"isOptimized":true}]'
)


class _FakeClient:
    instances: list = []

    def __init__(self, payload, config=None, **kwargs):
        self.payload = payload
        self.config = config
        self.disconnected = False
        type(self).instances.append(self)

    async def wait_for_assets(self, timeout=None):
        return None

    def is_connected(self):
        return not self.disconnected

    async def disconnect(self):
        self.disconnected = True


def _bridge(tmp_path) -> PocketOptionBridge:
    settings = BridgeSettings(
        symbols=["EUR/USD", "USD/JPY", "AUD/USD"],
        ssid=SSID,
        session_path=str(tmp_path / "po_session.json"),
        refresh_at_startup=False,
    )
    return PocketOptionBridge(settings, M20Engine([], max_history=10))


def test_primary_reuses_control_and_each_pair_gets_its_own_client(
    monkeypatch, tmp_path
):
    from BinaryOptionsToolsV2 import pocketoption as po

    _FakeClient.instances = []
    monkeypatch.setattr(po, "PocketOptionAsync", _FakeClient)
    bridge = _bridge(tmp_path)
    bridge._primary_symbol = "EUR/USD"
    control = _FakeClient("control")
    bridge.client = control
    _FakeClient.instances = []

    async def scenario():
        assert await bridge._ensure_reader_client("EUR/USD") is control
        eur = await bridge._ensure_reader_client("USD/JPY")
        aud = await bridge._ensure_reader_client("AUD/USD")
        again = await bridge._ensure_reader_client("USD/JPY")
        return eur, aud, again

    eur, aud, again = asyncio.run(scenario())

    assert eur is again
    assert eur is not control
    assert aud is not control
    assert aud is not eur
    assert len(_FakeClient.instances) == 2
    assert json.loads(eur.payload[2:])[1]["session"] == (
        "0123456789abcdef0123456789abcdef"
    )


class _TickStream:
    def __init__(self, price: float):
        self.price = price

    def __aiter__(self):
        return self

    async def __anext__(self):
        await asyncio.sleep(0.01)
        return {"price": self.price, "timestamp": int(time.time() * 1000)}


class _StreamingFake(_FakeClient):
    async def active_assets(self):
        return [
            {"symbol": "EURUSD_otc", "is_active": True},
            {"symbol": "USDJPY_otc", "is_active": True},
        ]

    async def subscribe_symbol(self, asset: str):
        self.asset_streams = getattr(self, "asset_streams", [])
        self.asset_streams.append(asset)
        return _TickStream(1.1 if "EUR" in asset else 150.0)


def test_two_pairs_stream_concurrently_on_separate_clients(monkeypatch, tmp_path):
    from BinaryOptionsToolsV2 import pocketoption as po

    _StreamingFake.instances = []
    monkeypatch.setattr(po, "PocketOptionAsync", _StreamingFake)
    bridge = _bridge(tmp_path)
    bridge._primary_symbol = "EUR/USD"

    async def scenario():
        tasks = [
            asyncio.create_task(bridge.run_reader("EUR/USD", "EURUSD_otc")),
            asyncio.create_task(bridge.run_reader("USD/JPY", "USDJPY_otc")),
        ]
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if bridge._tick_count.get("EUR/USD") and bridge._tick_count.get(
                "USD/JPY"
            ):
                break
            await asyncio.sleep(0.02)
        counts = dict(bridge._tick_count)
        subscribed = [c.asset_streams for c in bridge._reader_clients.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        return counts, subscribed

    counts, subscribed = asyncio.run(scenario())

    assert counts.get("EUR/USD", 0) > 0
    assert counts.get("USD/JPY", 0) > 0
    assert subscribed and subscribed[0] == ["USDJPY_otc"]
    assert len(_StreamingFake.instances) == 2


def test_releasing_one_reader_leaves_the_others_streaming(monkeypatch, tmp_path):
    from BinaryOptionsToolsV2 import pocketoption as po

    _FakeClient.instances = []
    monkeypatch.setattr(po, "PocketOptionAsync", _FakeClient)
    bridge = _bridge(tmp_path)
    bridge._primary_symbol = "EUR/USD"
    control = _FakeClient("control")
    bridge.client = control
    async def scenario():
        eur = await bridge._ensure_reader_client("USD/JPY")
        aud = await bridge._ensure_reader_client("AUD/USD")
        await bridge._release_reader_client("USD/JPY")
        return eur, aud

    eur, aud = asyncio.run(scenario())

    assert eur.disconnected
    assert not aud.disconnected
    assert bridge.client is control
    assert not control.disconnected
    assert "AUD/USD" in bridge._reader_clients
