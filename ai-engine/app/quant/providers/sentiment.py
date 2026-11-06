"""FinGPT-compatible sentiment adapter with strict provenance and freshness."""

from __future__ import annotations

from pydantic import ValidationError

from app.core.config import settings
from app.quant.contracts import (
    ConfluenceRequest,
    Direction,
    ProviderResult,
    ProviderStatus,
    SCHEMA_VERSION,
    SentimentProviderResponse,
)
from app.quant.providers.base import ConfluenceProvider, feature_freshness_error
from app.quant.providers.http_client import (
    AsyncJSONProviderClient,
    ProviderTransportError,
)


def direction_from_score(score: float, threshold: float = 0.05) -> Direction:
    if score > threshold:
        return Direction.BUY
    if score < -threshold:
        return Direction.SELL
    return Direction.NEUTRAL


class SentimentProvider(ConfluenceProvider):
    """Fetch or validate real FinGPT/news sentiment evidence.

    ``FINGPT_SENTIMENT_URL`` must point to a service implementing the strict
    ``SentimentProviderResponse`` raw-evidence contract. An unconfigured or
    unavailable endpoint is explicitly unavailable; no caller-supplied feature,
    local model, cached score, neutral default, or fallback verdict is used.
    """

    name = "sentiment"
    weight = 0.15
    description = "Fresh, provenance-bearing FinGPT/news/social sentiment"

    def __init__(
        self,
        endpoint: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float | None = None,
        client: AsyncJSONProviderClient | None = None,
    ) -> None:
        self._endpoint = (
            endpoint if endpoint is not None else settings.FINGPT_SENTIMENT_URL
        )
        self._endpoint = self._endpoint.strip() if self._endpoint else None
        self._client = client
        if self._endpoint and self._client is None:
            self._client = AsyncJSONProviderClient(
                self._endpoint,
                api_key=api_key if api_key is not None else settings.FINGPT_API_KEY,
                timeout_seconds=(
                    timeout_seconds
                    if timeout_seconds is not None
                    else settings.QUANT_PROVIDER_TIMEOUT_SECONDS
                ),
            )

    async def evaluate(self, request: ConfluenceRequest) -> ProviderResult:
        if self._endpoint:
            if self._client is None:
                return self.error("sentiment client is not initialized")
            try:
                raw = await self._client.post_json(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "symbol": request.symbol,
                        "timeframe": request.timeframe,
                        "lookback_minutes": 15,
                        "include": ["news", "social", "market_mood"],
                    }
                )
                response = SentimentProviderResponse.model_validate(raw)
            except ProviderTransportError as exc:
                return self.error(str(exc))
            except ValidationError as exc:
                return self.error(
                    f"invalid sentiment response contract ({len(exc.errors())} validation errors)"
                )
            timestamps = [response.as_of, *(item.as_of for item in response.evidence)]
            freshness_error = next(
                (
                    error
                    for timestamp in timestamps
                    if (error := feature_freshness_error(timestamp)) is not None
                ),
                None,
            )
            if freshness_error is not None:
                return ProviderResult(
                    name=self.name,
                    status=ProviderStatus.DEGRADED,
                    weight=self.weight,
                    reason=f"stale or invalid sentiment evidence: {freshness_error}",
                    evidence={"source": response.source, "model": response.model},
                )

            polarities = [item.polarity for item in response.evidence]
            score = sum(polarities) / len(polarities)
            direction = direction_from_score(score)
            votes = [direction_from_score(polarity) for polarity in polarities]
            confidence = 100.0 * sum(vote == direction for vote in votes) / len(votes)
            return ProviderResult(
                name=self.name,
                status=ProviderStatus.OK,
                weight=self.weight,
                direction=direction,
                score=score,
                confidence=confidence,
                evidence={
                    "source": response.source,
                    "model": response.model,
                    "evidence_count": len(response.evidence),
                    "as_of": response.as_of.isoformat(),
                    "confidence_method": "directional_evidence_agreement_percent",
                    "items": [
                        {
                            "kind": item.kind,
                            "source": item.source,
                            "reference_id": item.reference_id,
                            "polarity": item.polarity,
                            "as_of": item.as_of.isoformat(),
                        }
                        for item in response.evidence
                    ],
                },
            )
        return self.unavailable("FinGPT endpoint is not configured")

    def is_requested(self, request: ConfluenceRequest) -> bool:
        return True

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
