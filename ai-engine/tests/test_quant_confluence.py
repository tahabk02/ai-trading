from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.quant.contracts import (
    SCHEMA_VERSION,
    ConfluenceRequest,
    ConfluenceStatus,
    ProviderStatus,
)
from app.quant.pipeline import ConfluencePipeline, _canonical_horizon_minutes
from app.quant.providers import default_registry
from app.quant.providers.technical import TechnicalProvider


def candles(
    count: int = 30,
    start: float = 1.1000,
    step: float = 0.0001,
    timeframe_seconds: int = 3_600,
) -> list[dict[str, float | int]]:
    bars: list[dict[str, float | int]] = []
    now_seconds = datetime.now(timezone.utc).timestamp()
    for index in range(count):
        close = start + index * step
        bars.append(
            {
                "timestamp": now_seconds
                - (count - index) * timeframe_seconds,
                "open": close - step * 0.5,
                "high": close + step,
                "low": close - step,
                "close": close,
                "volume": 100 + index,
            }
        )
    return bars


def request(**values) -> ConfluenceRequest:
    return ConfluenceRequest(schema_version=SCHEMA_VERSION, **values)


def run(confluence_request: ConfluenceRequest):
    pipeline = ConfluencePipeline(default_registry())
    return asyncio.run(pipeline.evaluate(confluence_request))


def test_request_requires_explicit_supported_schema_version() -> None:
    with pytest.raises(ValidationError, match="schema_version"):
        ConfluenceRequest(symbol="EUR/USD")

    with pytest.raises(ValidationError, match="schema_version"):
        ConfluenceRequest(schema_version="2.0.0", symbol="EUR/USD")


def test_unconfigured_external_providers_block_actionable_technical_only_signal() -> None:
    response = run(
        request(
            symbol="EUR/USD",
            timeframe="1h",
            candles=candles(),
        )
    )

    assert response.schema_version == SCHEMA_VERSION
    assert response.status == ConfluenceStatus.DEGRADED
    assert response.direction is None
    assert response.score is None
    assert response.confidence is None
    assert response.actionable is False
    assert response.target_price is None
    assert response.providers[0].status == ProviderStatus.OK
    assert all(
        provider.status == ProviderStatus.UNAVAILABLE
        for provider in response.providers[1:]
    )
    assert response.horizon_minutes == 60


def test_missing_technical_input_returns_awaiting_data_without_aggregate() -> None:
    response = run(request(symbol="EUR/USD", timeframe="1h"))

    assert response.status == ConfluenceStatus.AWAITING_DATA
    assert response.direction is None
    assert response.score is None
    assert response.confidence is None
    assert response.actionable is False
    assert response.target_price is None
    assert response.providers[0].status == ProviderStatus.UNAVAILABLE


def test_stale_primary_bars_cannot_produce_any_aggregate() -> None:
    old_bars = candles()
    stale_by = 10 * 3_600
    for bar in old_bars:
        bar["timestamp"] -= stale_by
    response = run(
        request(symbol="EUR/USD", timeframe="1h", candles=old_bars)
    )

    assert response.status == ConfluenceStatus.AWAITING_DATA
    assert response.direction is None
    assert response.score is None
    assert response.actionable is False
    assert response.target_price is None
    assert response.providers[0].status == ProviderStatus.UNAVAILABLE
    assert "stale candles" in (response.providers[0].reason or "")


def test_technical_provider_uses_only_real_positive_atr() -> None:
    provider = TechnicalProvider()
    result = asyncio.run(
        provider.evaluate(
            request(
                symbol="EUR/USD",
                timeframe="1h",
                candles=candles(),
            )
        )
    )

    assert result.status == ProviderStatus.OK
    assert result.score is not None
    assert result.confidence is not None
    assert result.confidence_unit == "percent"
    assert result.evidence["atr"] > 0


def test_horizon_is_canonical_and_derived_from_timeframe() -> None:
    assert _canonical_horizon_minutes("5m") == 5
    assert _canonical_horizon_minutes("1h") == 60
    assert _canonical_horizon_minutes("30s") == 1
    assert _canonical_horizon_minutes("1d") == 1_440
    assert _canonical_horizon_minutes("2d") is None
    assert _canonical_horizon_minutes("unknown") is None

    with pytest.raises(ValidationError, match="horizon_minutes"):
        request(
            symbol="EUR/USD",
            timeframe="5m",
            horizon_minutes=120,
        )


def test_live_price_timestamp_requires_timezone_aware_iso8601() -> None:
    with pytest.raises(ValidationError, match="live_price_as_of"):
        request(
            symbol="EUR/USD",
            live_price=1.1,
            live_price_as_of="2026-11-06T16:00:00",
        )

    with pytest.raises(ValidationError, match="live_price_as_of"):
        request(
            symbol="EUR/USD",
            live_price=1.1,
            live_price_as_of=1_794_000_000,
        )


def test_freshness_error_at_two_bar_boundary_is_not_stale() -> None:
    # One timeframe interval of age is within the allowed two-bar boundary.
    recent = candles(count=5, timeframe_seconds=3_600)
    result = asyncio.run(
        TechnicalProvider().evaluate(
            request(symbol="EUR/USD", timeframe="1h", candles=recent)
        )
    )
    assert result.status in (ProviderStatus.OK, ProviderStatus.DEGRADED)

    old = candles(count=5, timeframe_seconds=3_600)
    for bar in old:
        bar["timestamp"] -= 7_201
    result = asyncio.run(
        TechnicalProvider().evaluate(
            request(symbol="EUR/USD", timeframe="1h", candles=old)
        )
    )
    assert result.status == ProviderStatus.UNAVAILABLE
    assert "stale candles" in (result.reason or "")
