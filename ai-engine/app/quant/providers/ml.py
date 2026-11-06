"""Qlib-compatible ML inference adapter with explicit model provenance."""

from __future__ import annotations

from pydantic import ValidationError

from app.core.config import settings
from app.quant.contracts import (
    ConfluenceRequest,
    Direction,
    MLProviderResponse,
    ProviderResult,
    ProviderStatus,
    SCHEMA_VERSION,
)
from app.quant.providers.base import ConfluenceProvider, feature_freshness_error
from app.quant.providers.http_client import (
    AsyncJSONProviderClient,
    ProviderTransportError,
)
from app.quant.providers.technical import (
    candle_series_error,
    latest_candle_timestamp,
)


class MLProvider(ConfluenceProvider):
    """Query an optional Qlib model service, or validate an injected verdict.

    An unconfigured or unavailable model is reported unavailable/error; no
    probability, direction, or cached inference is synthesized locally.
    """

    name = "ml"
    weight = 0.30
    description = "Fresh, versioned Qlib model inference"

    def __init__(
        self,
        endpoint: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float | None = None,
        client: AsyncJSONProviderClient | None = None,
    ) -> None:
        self._endpoint = endpoint if endpoint is not None else settings.QLIB_ML_URL
        self._endpoint = self._endpoint.strip() if self._endpoint else None
        self._client = client
        if self._endpoint and self._client is None:
            self._client = AsyncJSONProviderClient(
                self._endpoint,
                api_key=api_key if api_key is not None else settings.QLIB_API_KEY,
                timeout_seconds=(
                    timeout_seconds
                    if timeout_seconds is not None
                    else settings.QUANT_PROVIDER_TIMEOUT_SECONDS
                ),
            )

    async def evaluate(self, request: ConfluenceRequest) -> ProviderResult:
        if not self._endpoint:
            return self.unavailable("Qlib endpoint is not configured")
        if self._client is None:
            return self.error("Qlib client is not initialized")
        if not request.candles:
            return self.unavailable("Qlib inference requires observed candles")
        freshness_error = candle_series_error(request.candles, request.timeframe)
        if freshness_error is not None:
            return self.unavailable(f"Qlib input bars rejected: {freshness_error}")

        input_as_of = latest_candle_timestamp(request.candles)
        if input_as_of is None:
            return self.unavailable("Qlib input bars have no valid latest timestamp")
        try:
            raw = await self._client.post_json(
                {
                    "schema_version": SCHEMA_VERSION,
                    "symbol": request.symbol,
                    "timeframe": request.timeframe,
                    "input_as_of": input_as_of.isoformat(),
                    "candles": [
                        candle.model_dump(mode="json")
                        for candle in request.candles
                    ],
                }
            )
            response = MLProviderResponse.model_validate(raw)
        except ProviderTransportError as exc:
            return self.error(str(exc))
        except ValidationError as exc:
            return self.error(
                f"invalid Qlib response contract ({len(exc.errors())} validation errors)"
            )

        if response.timeframe != request.timeframe:
            return self.error("Qlib response timeframe does not match the request")
        if abs((response.input_as_of - input_as_of).total_seconds()) > 0.001:
            return self.error("Qlib response does not attest to the supplied latest bar")

        freshness_error = feature_freshness_error(response.as_of)
        if freshness_error is not None:
            return ProviderResult(
                name=self.name,
                status=ProviderStatus.DEGRADED,
                weight=self.weight,
                reason=f"stale or invalid ML evidence: {freshness_error}",
                evidence={
                    "model": response.model,
                    "version": response.version,
                    "as_of": response.as_of.isoformat(),
                },
            )

        probability = response.probability
        score = (
            (probability - 0.5) * 2.0
            if response.direction == Direction.BUY
            else -(probability - 0.5) * 2.0
            if response.direction == Direction.SELL
            else 0.0
        )
        return ProviderResult(
            name=self.name,
            status=ProviderStatus.OK,
            weight=self.weight,
            direction=response.direction,
            score=max(-1.0, min(1.0, score)),
            confidence=probability * 100.0,
            evidence={
                "model": response.model,
                "version": response.version,
                "as_of": response.as_of.isoformat(),
                "input_as_of": response.input_as_of.isoformat(),
                "timeframe": response.timeframe,
                "probability": probability,
                "probability_unit": response.probability_unit,
            },
        )

    def is_requested(self, request: ConfluenceRequest) -> bool:
        return True

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
