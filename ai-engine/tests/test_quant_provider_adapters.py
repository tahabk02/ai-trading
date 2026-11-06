from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from app.quant.contracts import (
    SCHEMA_VERSION,
    Candle,
    ConfluenceRequest,
    Direction,
    MacroProviderResponse,
    ProviderStatus,
    SentimentProviderResponse,
)
from app.quant.providers.http_client import (
    AsyncJSONProviderClient,
    ProviderTransportError,
)
from app.quant.providers.macro import MacroProvider
from app.quant.providers.ml import MLProvider
from app.quant.providers.sentiment import SentimentProvider
from app.quant.pipeline import ConfluencePipeline
from app.quant.providers.registry import ProviderRegistry
from app.quant.providers.technical import TechnicalProvider


def _request(
    *,
    timeframe: str = "1h",
    bars: list[Candle] | None = None,
) -> ConfluenceRequest:
    return ConfluenceRequest(
        schema_version=SCHEMA_VERSION,
        symbol="EUR/USD",
        timeframe=timeframe,
        candles=bars or [],
    )


def _candles(
    *,
    timeframe_seconds: int = 3_600,
    count: int = 30,
    age_seconds: int = 30,
) -> list[Candle]:
    latest = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
    return [
        Candle(
            timestamp=(latest - timedelta(seconds=(count - index - 1) * timeframe_seconds)).isoformat(),
            open=1.1 + index * 0.0001,
            high=1.101 + index * 0.0001,
            low=1.099 + index * 0.0001,
            close=1.1005 + index * 0.0001,
        )
        for index in range(count)
    ]


def _run_provider(
    provider: Any,
    http_client: httpx.AsyncClient,
    request: ConfluenceRequest | None = None,
):
    async def run():
        try:
            return await provider.evaluate(request or _request())
        finally:
            await http_client.aclose()

    return asyncio.run(run())


def _provider_client(
    handler, *, api_key: str | None = None
) -> tuple[AsyncJSONProviderClient, httpx.AsyncClient]:
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncJSONProviderClient(
        "https://provider.test/v1",
        api_key=api_key,
        client=http_client,
    )
    return client, http_client


def _sentiment_payload(
    *,
    evidence_as_of: datetime | None = None,
    envelope_as_of: datetime | None = None,
) -> dict[str, Any]:
    current = datetime.now(timezone.utc)
    evidence_time = evidence_as_of or current
    return {
        "schema_version": SCHEMA_VERSION,
        "source": "news-social-adapter",
        "model": "fingpt-test",
        "as_of": (envelope_as_of or current).isoformat(),
        "evidence": [
            {
                "schema_version": SCHEMA_VERSION,
                "kind": "news" if index % 2 == 0 else "social",
                "source": "source-a",
                "reference_id": f"item-{index}",
                "polarity": polarity,
                "as_of": evidence_time.isoformat(),
            }
            for index, polarity in enumerate((0.7, 0.6, 0.8, 0.7))
        ],
    }


def test_fingpt_aggregates_strict_raw_evidence_and_sends_bearer_auth() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers.get("Authorization", "")
        payload = request.read()
        assert json.loads(payload)["schema_version"] == SCHEMA_VERSION
        return httpx.Response(200, json=_sentiment_payload())

    client, http_client = _provider_client(handler, api_key="unit-test-token")
    provider = SentimentProvider(endpoint="https://provider.test/v1", client=client)
    result = _run_provider(provider, http_client)

    assert result.status == ProviderStatus.OK
    assert result.direction == Direction.BUY
    assert result.score == pytest.approx(0.7)
    assert result.confidence == 100.0
    assert result.confidence_unit == "percent"
    assert result.evidence["confidence_method"] == "directional_evidence_agreement_percent"
    assert seen["authorization"] == "Bearer unit-test-token"


def test_fingpt_stale_item_or_envelope_is_degraded_without_score() -> None:
    stale = datetime.now(timezone.utc) - timedelta(minutes=16)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_sentiment_payload(evidence_as_of=stale))

    client, http_client = _provider_client(handler)
    result = _run_provider(
        SentimentProvider(endpoint="https://provider.test/v1", client=client),
        http_client,
    )
    assert result.status == ProviderStatus.DEGRADED
    assert result.score is None
    assert "stale evidence" in (result.reason or "")


def test_fingpt_rejects_missing_timezone_and_missing_evidence_contracts() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        payload = _sentiment_payload()
        payload["evidence"][0]["as_of"] = "2026-11-06T16:00:00"
        return httpx.Response(200, json=payload)

    client, http_client = _provider_client(handler)
    result = _run_provider(
        SentimentProvider(endpoint="https://provider.test/v1", client=client),
        http_client,
    )
    assert result.status == ProviderStatus.ERROR
    assert result.score is None
    assert "invalid sentiment response contract" in (result.reason or "")

    with pytest.raises(ValidationError, match="as_of"):
        SentimentProviderResponse.model_validate(
            {
                "schema_version": SCHEMA_VERSION,
                "source": "feed",
                "model": "model",
                "evidence": [
                    {
                        "schema_version": SCHEMA_VERSION,
                        "kind": "news",
                        "source": "source",
                        "reference_id": "id",
                        "polarity": 0.5,
                    }
                ],
            }
        )


def test_openbb_requires_categorized_timestamped_macro_data_points() -> None:
    now = datetime.now(timezone.utc)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "schema_version": SCHEMA_VERSION,
                "score": 0.4,
                "confidence": 72.0,
                "confidence_unit": "percent",
                "source": "openbb-adapter",
                "methodology": "versioned-fx-macro-model",
                "regime": "risk-on",
                "data_points": [
                    {
                        "schema_version": SCHEMA_VERSION,
                        "category": "interest_rate_differential",
                        "name": "policy_rate_differential",
                        "value": 1.25,
                        "unit": "percentage_points",
                        "source": "central-bank-data",
                        "as_of": now.isoformat(),
                    },
                    {
                        "schema_version": SCHEMA_VERSION,
                        "category": "global_correlation",
                        "name": "eur-dollar-index-correlation",
                        "value": -0.3,
                        "unit": "correlation",
                        "source": "market-data",
                        "as_of": now.isoformat(),
                    },
                ],
                "as_of": now.isoformat(),
            },
        )

    client, http_client = _provider_client(handler)
    result = _run_provider(
        MacroProvider(endpoint="https://provider.test/v1", client=client),
        http_client,
    )
    assert result.status == ProviderStatus.OK
    assert result.score == 0.4
    assert result.evidence["methodology"] == "versioned-fx-macro-model"
    assert result.evidence["data_points"][0]["category"] == "interest_rate_differential"


def test_openbb_rejects_stale_datapoint_and_unzoned_timestamp() -> None:
    now = datetime.now(timezone.utc)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "schema_version": SCHEMA_VERSION,
                "score": 0.4,
                "confidence": 72.0,
                "confidence_unit": "percent",
                "source": "openbb-adapter",
                "methodology": "macro-model",
                "data_points": [
                    {
                        "schema_version": SCHEMA_VERSION,
                        "category": "fx_index",
                        "name": "dxy",
                        "value": 103.2,
                        "unit": "index_points",
                        "source": "market-data",
                        "as_of": (now - timedelta(minutes=16)).isoformat(),
                    }
                ],
                "as_of": now.isoformat(),
            },
        )

    client, http_client = _provider_client(handler)
    result = _run_provider(
        MacroProvider(endpoint="https://provider.test/v1", client=client),
        http_client,
    )
    assert result.status == ProviderStatus.DEGRADED
    assert result.score is None

    malformed = {
        "schema_version": SCHEMA_VERSION,
        "score": 0.4,
        "confidence": 72.0,
        "confidence_unit": "percent",
        "source": "openbb-adapter",
        "methodology": "macro-model",
        "data_points": [
            {
                "schema_version": SCHEMA_VERSION,
                "category": "fx_index",
                "name": "dxy",
                "value": 103.2,
                "unit": "index_points",
                "source": "market-data",
                "as_of": "2026-11-06T16:00:00",
            }
        ],
        "as_of": now.isoformat(),
    }
    with pytest.raises(ValidationError):
        MacroProviderResponse.model_validate(malformed)


def test_qlib_response_is_bound_to_fresh_requested_bars_and_timeframe() -> None:
    bars = _candles()
    request_payload_seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        request_payload_seen.update(json.loads(request.content))
        body = request_payload_seen
        return httpx.Response(
            200,
            json={
                "schema_version": SCHEMA_VERSION,
                "direction": "BUY",
                "probability": 0.8,
                "probability_unit": "fraction",
                "timeframe": body["timeframe"],
                "input_as_of": body["input_as_of"],
                "model": "qlib-test",
                "version": "test-version",
                "as_of": datetime.now(timezone.utc).isoformat(),
            },
        )

    client, http_client = _provider_client(handler)
    result = _run_provider(
        MLProvider(endpoint="https://provider.test/v1", client=client),
        http_client,
        _request(bars=bars),
    )
    assert result.status == ProviderStatus.OK
    assert result.direction == Direction.BUY
    assert result.confidence == 80.0
    assert result.confidence_unit == "percent"
    assert request_payload_seen["timeframe"] == "1h"


def test_qlib_rejects_mismatched_timeframe_or_stale_input_bars() -> None:
    bars = _candles()

    def wrong_timeframe(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "schema_version": SCHEMA_VERSION,
                "direction": "BUY",
                "probability": 0.8,
                "probability_unit": "fraction",
                "timeframe": "5m",
                "input_as_of": bars[-1].timestamp,
                "model": "qlib-test",
                "version": "test-version",
                "as_of": datetime.now(timezone.utc).isoformat(),
            },
        )

    client, http_client = _provider_client(wrong_timeframe)
    result = _run_provider(
        MLProvider(endpoint="https://provider.test/v1", client=client),
        http_client,
        _request(bars=bars),
    )
    assert result.status == ProviderStatus.ERROR
    assert "timeframe does not match" in (result.reason or "")

    stale_bars = _candles(age_seconds=7_201)
    called = False

    def no_call(_request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    client, http_client = _provider_client(no_call)
    result = _run_provider(
        MLProvider(endpoint="https://provider.test/v1", client=client),
        http_client,
        _request(bars=stale_bars),
    )
    assert result.status == ProviderStatus.UNAVAILABLE
    assert "stale candles" in (result.reason or "")
    assert not called


def test_bounded_http_errors_retry_once_and_are_sanitized() -> None:
    attempts = 0

    def retry_once(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"ok": True})

    client, http_client = _provider_client(retry_once)
    result = asyncio.run(client.post_json({"test": True}))
    asyncio.run(http_client.aclose())
    assert result == {"ok": True}
    assert attempts == 2

    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("sensitive upstream message", request=request)

    client, http_client = _provider_client(timeout)

    async def execute_timeout():
        try:
            with pytest.raises(ProviderTransportError, match="timed out") as error:
                await client.post_json({})
            assert "sensitive upstream message" not in str(error.value)
        finally:
            await http_client.aclose()

    asyncio.run(execute_timeout())


def test_provider_keys_require_tls_and_blank_config_is_unavailable() -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        AsyncJSONProviderClient("http://provider.test/v1", api_key="test-key")

    for provider_class in (SentimentProvider, MacroProvider, MLProvider):
        provider = provider_class(endpoint="")
        result = asyncio.run(provider.evaluate(_request()))
        assert result.status == ProviderStatus.UNAVAILABLE
        assert result.score is None
        assert provider.is_requested(_request())


def _run_complete_pipeline(*, sentiment_age_minutes: int = 0):
    transport = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: _complete_provider_response(
                request, sentiment_age_minutes=sentiment_age_minutes
            )
        )
    )
    providers = [
        TechnicalProvider(),
        MLProvider(
            endpoint="https://provider.test/ml",
            client=AsyncJSONProviderClient(
                "https://provider.test/ml", client=transport
            ),
        ),
        SentimentProvider(
            endpoint="https://provider.test/sentiment",
            client=AsyncJSONProviderClient(
                "https://provider.test/sentiment", client=transport
            ),
        ),
        MacroProvider(
            endpoint="https://provider.test/macro",
            client=AsyncJSONProviderClient(
                "https://provider.test/macro", client=transport
            ),
        ),
    ]
    pipeline = ConfluencePipeline(
        ProviderRegistry(providers),
        provider_timeout_seconds=1.0,
        min_score=0.0,
        min_confidence=0.0,
    )

    async def evaluate():
        try:
            return await pipeline.evaluate(_request(bars=_candles()))
        finally:
            await transport.aclose()

    return asyncio.run(evaluate())


def _complete_provider_response(
    request: httpx.Request, *, sentiment_age_minutes: int
) -> httpx.Response:
    now = datetime.now(timezone.utc)
    if request.url.path.endswith("/sentiment"):
        return httpx.Response(
            200,
            json=_sentiment_payload(
                evidence_as_of=now - timedelta(minutes=sentiment_age_minutes)
            ),
        )
    if request.url.path.endswith("/macro"):
        return httpx.Response(
            200,
            json={
                "schema_version": SCHEMA_VERSION,
                "score": 0.6,
                "confidence": 80.0,
                "confidence_unit": "percent",
                "source": "openbb-adapter",
                "methodology": "macro-model-v1",
                "data_points": [
                    {
                        "schema_version": SCHEMA_VERSION,
                        "category": "interest_rate_differential",
                        "name": "policy-rate-spread",
                        "value": 1.0,
                        "unit": "percentage_points",
                        "source": "central-bank-data",
                        "as_of": now.isoformat(),
                    }
                ],
                "as_of": now.isoformat(),
            },
        )
    if request.url.path.endswith("/ml"):
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "schema_version": SCHEMA_VERSION,
                "direction": "BUY",
                "probability": 0.8,
                "probability_unit": "fraction",
                "timeframe": body["timeframe"],
                "input_as_of": body["input_as_of"],
                "model": "qlib-model",
                "version": "model-v1",
                "as_of": now.isoformat(),
            },
        )
    return httpx.Response(404)


def test_end_to_end_confluence_requires_all_fresh_configured_providers() -> None:
    response = _run_complete_pipeline()
    assert response.status.value == "OK"
    assert response.schema_version == SCHEMA_VERSION
    assert response.confidence_unit == "percent"
    assert response.direction == Direction.BUY
    assert response.actionable is True
    assert response.target_price is not None
    assert response.horizon_minutes == 60
    assert all(result.status == ProviderStatus.OK for result in response.providers)

    stale_response = _run_complete_pipeline(sentiment_age_minutes=16)
    assert stale_response.status.value == "DEGRADED"
    assert stale_response.direction is None
    assert stale_response.score is None
    assert stale_response.confidence is None
    assert stale_response.actionable is False
    assert stale_response.target_price is None
