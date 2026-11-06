"""OpenBB macro-context adapter with per-observation freshness validation."""

from __future__ import annotations

from pydantic import ValidationError

from app.core.config import settings
from app.quant.contracts import (
    ConfluenceRequest,
    MacroProviderResponse,
    ProviderResult,
    ProviderStatus,
    SCHEMA_VERSION,
)
from app.quant.providers.base import ConfluenceProvider, feature_freshness_error
from app.quant.providers.http_client import (
    AsyncJSONProviderClient,
    ProviderTransportError,
)
from app.quant.providers.sentiment import direction_from_score


class MacroProvider(ConfluenceProvider):
    """Fetch real OpenBB-derived FX/macro observations through an adapter API.

    The adapter returns a strict directional macro assessment plus every raw
    observation used (for example policy rates, FX indices, commodities and
    correlations). The service validates provenance and freshness for each
    point and never turns raw values into a directional score itself.
    """

    name = "macro"
    weight = 0.15
    description = "Fresh OpenBB macro, rates, commodity and correlation context"

    def __init__(
        self,
        endpoint: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float | None = None,
        client: AsyncJSONProviderClient | None = None,
    ) -> None:
        self._endpoint = (
            endpoint if endpoint is not None else settings.OPENBB_MACRO_URL
        )
        self._endpoint = self._endpoint.strip() if self._endpoint else None
        self._client = client
        if self._endpoint and self._client is None:
            self._client = AsyncJSONProviderClient(
                self._endpoint,
                api_key=api_key if api_key is not None else settings.OPENBB_API_KEY,
                timeout_seconds=(
                    timeout_seconds
                    if timeout_seconds is not None
                    else settings.QUANT_PROVIDER_TIMEOUT_SECONDS
                ),
            )

    async def evaluate(self, request: ConfluenceRequest) -> ProviderResult:
        if self._endpoint:
            if self._client is None:
                return self.error("macro client is not initialized")
            try:
                raw = await self._client.post_json(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "symbol": request.symbol,
                        "timeframe": request.timeframe,
                        "assets": self._asset_legs(request.symbol),
                        "context": [
                            "interest_rates",
                            "fx_indices",
                            "commodities",
                            "global_correlations",
                        ],
                        "max_age_minutes": 15,
                    }
                )
                response = MacroProviderResponse.model_validate(raw)
            except ProviderTransportError as exc:
                return self.error(str(exc))
            except ValidationError as exc:
                return self.error(
                    f"invalid OpenBB response contract ({len(exc.errors())} validation errors)"
                )
            freshness_error = feature_freshness_error(response.as_of)
            if freshness_error is None:
                for point in response.data_points:
                    freshness_error = feature_freshness_error(point.as_of)
                    if freshness_error is not None:
                        break
            if freshness_error is not None:
                return ProviderResult(
                    name=self.name,
                    status=ProviderStatus.DEGRADED,
                    weight=self.weight,
                    reason=f"stale or invalid macro evidence: {freshness_error}",
                    evidence={"source": response.source, "regime": response.regime},
                )
            return ProviderResult(
                name=self.name,
                status=ProviderStatus.OK,
                weight=self.weight,
                direction=direction_from_score(response.score),
                score=response.score,
                confidence=response.confidence,
                evidence={
                    "source": response.source,
                    "methodology": response.methodology,
                    "regime": response.regime,
                    "as_of": response.as_of.isoformat(),
                    "data_points": [
                        {
                            "category": point.category,
                            "name": point.name,
                            "value": point.value,
                            "unit": point.unit,
                            "source": point.source,
                            "as_of": point.as_of.isoformat(),
                        }
                        for point in response.data_points
                    ],
                },
            )
        return self.unavailable("OpenBB endpoint is not configured")

    def is_requested(self, request: ConfluenceRequest) -> bool:
        return True

    @staticmethod
    def _asset_legs(symbol: str) -> list[str]:
        legs = [part.strip().upper() for part in symbol.split("/")]
        return legs if len(legs) == 2 and all(legs) else [symbol]

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
