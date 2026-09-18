"""tests/test_asset_history_upsert.py — Alpha.5 Pro, Part 6.3.

The ai-engine's 60s AssetHistory upsert job must:
  1. map the current wall-clock time onto an exact 1-minute bucket boundary;
  2. emit ONE real bar (open=high=low=close=observed rate, tick_count=1) per
     whitelisted symbol to the core-backend /history/ingest endpoint (Http
     POST, correct path);
  3. log the mission line `AssetHistory upserted` with symbol / bars /
     window=30m;
  4. NEVER fabricate — a symbol with no real rate (and a failed upsert)
     produces no row.
"""

import asyncio
import json

import httpx
import pytest

from app.data.collector import (
    AssetHistoryUpsertJob,
    MarketDataCollector,
    ASSET_HISTORY_TIMEFRAME,
    ASSET_HISTORY_WINDOW_LABEL,
    OTC_SET,
)


class _FakeCollector:
    """Deterministic stand-in for MarketDataCollector — no network."""

    def __init__(self, prices):
        self.prices = dict(prices)
        self.calls = []

    async def fetch_live_spot(self, symbol):
        self.calls.append(symbol)
        return self.prices.get(symbol)


class _FakePost:
    """Stands in for the network POST, recording every payload."""

    def __init__(self, ingest_count=1):
        self.ingest_count = ingest_count
        self.payloads = []

    async def __call__(self, payload):
        self.payloads.append(payload)
        return {"ingested": self.ingest_count}


def test_minute_bucket_ms_aligns_to_exact_grid():
    job = AssetHistoryUpsertJob(MarketDataCollector())
    assert job.minute_bucket_ms(1_700_000_000_123.0) == 1_699_999_980_000
    assert job.minute_bucket_ms(1_700_000_040_000.0) == 1_700_000_040_000
    assert job.minute_bucket_ms(1_700_000_059_999.0) == 1_700_000_040_000


def test_run_once_pushes_one_real_bar_per_symbol():
    collector = _FakeCollector(prices={"EUR/USD": 1.085123, "USD/JPY": 149.123456})
    job = AssetHistoryUpsertJob(collector)  # type: ignore[arg-type]
    job._post_bars = _FakePost()
    n = asyncio.run(job.run_once())
    assert n == 2
    by_symbol = {p["symbol"]: p for p in job._post_bars.payloads}
    assert set(by_symbol.keys()) == {"EUR/USD", "USD/JPY"}
    for p in by_symbol.values():
        assert p["timeframe"] == ASSET_HISTORY_TIMEFRAME
        assert len(p["bars"]) == 1
        bar = p["bars"][0]
        assert bar["open"] == bar["high"] == bar["low"] == bar["close"]
        assert bar["close"] > 0
        assert bar["tickCount"] == 1
        assert bar["bucketStartMs"] % 60_000 == 0


def test_run_once_skips_symbols_without_a_real_rate():
    collector = _FakeCollector(prices={"EUR/USD": 1.085123})
    job = AssetHistoryUpsertJob(collector)  # type: ignore[arg-type]
    job._post_bars = _FakePost()
    n = asyncio.run(job.run_once())
    assert n == 1
    assert [p["symbol"] for p in job._post_bars.payloads] == ["EUR/USD"]


def test_run_once_covers_every_whitelisted_symbol():
    collector = _FakeCollector(prices={s: 1.0 for s in OTC_SET})
    job = AssetHistoryUpsertJob(collector)  # type: ignore[arg-type]
    job._post_bars = _FakePost()
    n = asyncio.run(job.run_once())
    assert n == len(OTC_SET)
    assert sorted(collector.calls) == sorted(OTC_SET)


def test_posts_via_httpx_to_core_ingest_route(monkeypatch):
    from app.core.config import settings

    observed = {}

    def handler(request: httpx.Request) -> httpx.Response:
        observed["method"] = request.method
        observed["path"] = request.url.path
        observed["payload"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "ingested": 1,
                "symbol": "GBP/USD",
                "timeframe": "1m",
                "window": "30m",
            },
            request=request,
        )

    class IngestTransportClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):
            kwargs.setdefault("base_url", settings.BACKEND_API_URL.rstrip("/"))
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", IngestTransportClient)

    job = AssetHistoryUpsertJob(_FakeCollector(prices={"GBP/USD": 1.265}))  # type: ignore[arg-type]
    n = asyncio.run(job.run_once())
    assert n == 1
    assert observed["method"] == "POST"
    assert observed["path"] == "/api/v1/history/ingest"
    payload = observed["payload"]
    assert payload["symbol"] == "GBP/USD"
    assert payload["bars"][0]["close"] == 1.265


def test_failed_upsert_contributes_no_rows():
    collector = _FakeCollector(prices={"EUR/USD": 1.085123})

    async def boom(_payload):
        raise httpx.HTTPStatusError(
            "400",
            request=httpx.Request("POST", "http://core-backend:4000/history/ingest"),
            response=httpx.Response(400),
        )

    job = AssetHistoryUpsertJob(collector)  # type: ignore[arg-type]
    job._post_bars = boom
    n = asyncio.run(job.run_once())
    assert n == 0  # a failed upsert contributes nothing — no fake rows


def test_mission_log_line_emitted(monkeypatch):
    from app.data import collector as collector_module

    lines = []

    class _Capture:
        def info(self, event, **kw):
            lines.append({"event": event, **kw})

        def warning(self, event, **kw):
            lines.append({"event": event, **kw})

    monkeypatch.setattr(collector_module, "logger", _Capture())  # type: ignore[attr-defined]

    collector = _FakeCollector(prices={"EUR/USD": 1.085123})
    job = AssetHistoryUpsertJob(collector)  # type: ignore[arg-type]
    job._post_bars = _FakePost(ingest_count=1)
    asyncio.run(job.run_once())

    matches = [
        l
        for l in lines
        if l.get("event") == "AssetHistory upserted"
        and l.get("symbol") == "EUR/USD"
        and l.get("bars") == 1
        and l.get("window") == ASSET_HISTORY_WINDOW_LABEL
    ]
    assert matches, f"mission log line missing; captured={lines!r}"