"""AssetHistory REST fallback boundedness regressions.

The production stall: `run_once` fetched all 34 OTC symbols STRICTLY SERIALLY
with up-to-12s httpx timeouts against three public REST endpoints, then POSTed
to the backend. Worst case ~408s per pass against a 60s interval, with failed
fetches not negatively cached so the storm repeated every minute forever.

External REST is best-effort by design — the local WebSocket tick pipeline is
authoritative. These tests pin the bounds, not the vendor.
"""
import asyncio
import time

import pytest

from app.data import collector as collector_mod
from app.data.collector import AssetHistoryUpsertJob


def _job(fetch, post=None, symbols=None):
    """Build a job without touching __init__'s real httpx client."""
    job = AssetHistoryUpsertJob.__new__(AssetHistoryUpsertJob)

    class _C:
        async def fetch_live_spot(self, symbol):
            return await fetch(symbol)

    job.collector = _C()

    async def _aclose():
        return None

    # stop() closes the real httpx client; __new__ bypasses __init__ so give it
    # a stub, otherwise the test fails on plumbing rather than on cancellation.
    job.client = type("_Client", (), {"aclose": staticmethod(_aclose)})()

    async def _post(payload):
        return await post(payload) if post else {"ingested": 1}

    job._post_bars = _post
    return job


@pytest.fixture(autouse=True)
def _patch_symbol_set(monkeypatch):
    """Shrink OTC_SET so tests are fast but keep a realistic fan-out shape."""
    syms = sorted(collector_mod.OTC_SET)[:16]
    monkeypatch.setattr(collector_mod, "OTC_SET", frozenset(syms))
    return syms


def test_concurrency_and_deadline_bounds_are_configured():
    assert collector_mod.ASSET_HISTORY_FETCH_CONCURRENCY >= 2
    assert collector_mod.ASSET_HISTORY_PASS_DEADLINE_SECONDS > 0
    # The deadline must be shorter than the schedule interval, otherwise a slow
    # pass can still overlap the next one.
    assert (
        collector_mod.ASSET_HISTORY_PASS_DEADLINE_SECONDS
        < collector_mod.ASSET_HISTORY_UPSERT_INTERVAL_SECONDS
    )


def test_fanout_is_bounded_by_concurrency_not_symbol_count(_patch_symbol_set):
    """Peak in-flight fetches must respect the semaphore."""
    limit = collector_mod.ASSET_HISTORY_FETCH_CONCURRENCY
    inflight = 0
    peak = 0

    async def fetch(_symbol):
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        try:
            await asyncio.sleep(0.05)
            return 1.5
        finally:
            inflight -= 1

    job = _job(fetch)
    assert asyncio.run(job.run_once()) == len(_patch_symbol_set)
    assert peak <= limit, f"peak concurrency {peak} exceeded limit {limit}"


def test_serial_equivalent_would_be_slower_than_bounded_fanout(_patch_symbol_set):
    """Non-vacuity: the bounded pass must beat the old serial loop."""
    per_symbol = 0.08

    async def fetch(_symbol):
        await asyncio.sleep(per_symbol)
        return 1.5

    started = time.time()
    total = asyncio.run(_job(fetch).run_once())
    elapsed = time.time() - started

    serial = per_symbol * len(_patch_symbol_set)
    assert total == len(_patch_symbol_set)
    assert elapsed < serial, (
        f"bounded pass took {elapsed:.2f}s, not faster than serial {serial:.2f}s"
    )


def test_pass_deadline_abandons_rather_than_overlapping(_patch_symbol_set, monkeypatch):
    """A hanging vendor must not consume the whole pass budget."""
    monkeypatch.setattr(
        collector_mod, "ASSET_HISTORY_PASS_DEADLINE_SECONDS", 0.25,
    )

    async def fetch(_symbol):
        await asyncio.sleep(30)  # never resolves in time
        return 1.5

    started = time.time()
    total = asyncio.run(_job(fetch).run_once())
    elapsed = time.time() - started

    assert total == 0
    assert elapsed < 5.0, f"pass overran deadline ({elapsed:.2f}s)"


def test_never_fabricates_a_bar_without_a_real_rate(_patch_symbol_set):
    """Zero/invalid/non-finite rates must produce no upsert at all."""
    posted = []

    async def post(payload):
        posted.append(payload)
        return {"ingested": 1}

    rates = {s: 0.0 for s in _patch_symbol_set}
    # Poison with invalid values the guard must reject.
    rates[_patch_symbol_set[0]] = -1.0
    rates[_patch_symbol_set[1]] = float("nan")
    rates[_patch_symbol_set[2]] = float("inf")
    rates[_patch_symbol_set[3]] = None

    async def fetch(symbol):
        return rates[symbol]

    asyncio.run(_job(fetch, post=post).run_once())
    assert posted == [], "a bar was fabricated from a non-price"


def test_failed_fetch_does_not_abort_the_remaining_symbols(_patch_symbol_set):
    """One vendor error must not cost the whole pass."""
    ok = _patch_symbol_set[-1]

    async def fetch(symbol):
        if symbol != ok:
            raise RuntimeError("upstream 502")
        return 2.5

    assert asyncio.run(_job(fetch).run_once()) == 1


def test_failed_upsert_does_not_abort_the_remaining_symbols(_patch_symbol_set):
    async def fetch(_symbol):
        return 3.5

    async def post(payload):
        if payload["symbol"] == _patch_symbol_set[0]:
            raise RuntimeError("backend down")
        return {"ingested": 1}

    total = asyncio.run(_job(fetch, post=post).run_once())
    assert total == len(_patch_symbol_set) - 1


def test_partial_vendor_failure_still_yields_its_share(_patch_symbol_set):
    ok = set(_patch_symbol_set[:3])

    async def fetch(symbol):
        if symbol not in ok:
            raise RuntimeError("timeout")
        return 4.5

    assert asyncio.run(_job(fetch).run_once()) == len(ok)


def test_minute_bucket_is_idempotent_for_repeat_passes():
    """Repeated passes in the same minute must target the same bucket key, so
    the backend upsert cannot duplicate bars."""
    now_ms = 1_700_000_123_456.0
    assert AssetHistoryUpsertJob.minute_bucket_ms(now_ms) == (
        AssetHistoryUpsertJob.minute_bucket_ms(now_ms + 5_000)
    )


def test_stop_cancels_an_in_flight_pass_promptly():
    """stop() must cancel mid-pass immediately, not wait out vendor timeouts."""
    async def fetch(_symbol):
        await asyncio.sleep(30)
        return 1.0

    async def scenario():
        job = _job(fetch)
        job._running = True
        job._task = None
        job.start()
        await asyncio.sleep(0.2)  # let the pass reach the vendor await
        started = time.time()
        await job.stop()
        return time.time() - started

    elapsed = asyncio.run(scenario())
    assert elapsed < 5.0, f"stop() took {elapsed:.2f}s to cancel an in-flight pass"