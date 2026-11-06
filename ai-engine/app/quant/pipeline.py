"""Deterministic aggregation of independent confluence providers.

The pipeline is intentionally boring: run providers, drop missing inputs, and
aggregate only the real values that came back. It never replaces an unavailable
feed with a neutral score, and it never derives a target without a real ATR and
a real current price.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from datetime import datetime, timezone

from app.quant.contracts import (
    ConfluenceRequest,
    ConfluenceResponse,
    ConfluenceStatus,
    Direction,
    ProviderResult,
    ProviderStatus,
    SCHEMA_VERSION,
)
from app.quant.providers.registry import ProviderRegistry
from app.quant.providers.base import feature_freshness_error
from app.services.quant_matrix import project_target, symbol_price_digits


DIRECTION_THRESHOLD = 0.05
DEFAULT_MIN_SCORE = 0.55
DEFAULT_MIN_CONFIDENCE = 60.0


def _deterministic_confluence_id(request: ConfluenceRequest) -> str:
    identity = request.model_dump(mode="json", exclude={"request_id"})
    payload = json.dumps(identity, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _direction_from_score(score: float) -> Direction:
    if score > DIRECTION_THRESHOLD:
        return Direction.BUY
    if score < -DIRECTION_THRESHOLD:
        return Direction.SELL
    return Direction.NEUTRAL


def _canonical_horizon_minutes(timeframe: str) -> int | None:
    match = re.fullmatch(r"([1-9]\d*)(s|m|h|d)", timeframe.strip().lower())
    if match is None:
        return None
    amount = int(match.group(1))
    seconds_per_unit = {"s": 1, "m": 60, "h": 3_600, "d": 86_400}
    duration_seconds = amount * seconds_per_unit[match.group(2)]
    horizon_minutes = max(1, math.ceil(duration_seconds / 60))
    return horizon_minutes if horizon_minutes <= 1_440 else None


class ConfluencePipeline:
    def __init__(
        self,
        registry: ProviderRegistry,
        *,
        provider_timeout_seconds: float = 3.0,
        min_score: float = DEFAULT_MIN_SCORE,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    ) -> None:
        if provider_timeout_seconds <= 0:
            raise ValueError("provider_timeout_seconds must be positive")
        self.registry = registry
        self.provider_timeout_seconds = float(provider_timeout_seconds)
        self.min_score = float(min_score)
        self.min_confidence = float(min_confidence)

    async def close(self) -> None:
        await self.registry.close()

    async def evaluate(self, request: ConfluenceRequest) -> ConfluenceResponse:
        results = await self._run_providers(request)
        horizon_minutes = _canonical_horizon_minutes(request.timeframe)
        usable = [
            result
            for result in results
            if result.status in (ProviderStatus.OK, ProviderStatus.DEGRADED)
            and result.direction is not None
            and result.score is not None
            and result.confidence is not None
        ]

        total_weight = self.registry.total_weight()
        usable_weight = sum(result.weight for result in usable)
        coverage = (usable_weight / total_weight) if total_weight > 0 else 0.0

        current_price = self._current_price(request, results)
        atr = self._atr(results)
        technical_ready = any(
            result.name == "technical" and result.status == ProviderStatus.OK
            for result in results
        )
        requested_provider_degraded = any(
            provider.is_requested(request)
            and result.status != ProviderStatus.OK
            for provider, result in zip(self.registry.providers, results, strict=True)
        )

        if (
            not usable
            or not technical_ready
            or requested_provider_degraded
            or len(usable) < request.required_providers
        ):
            if not usable or not technical_ready:
                status = ConfluenceStatus.AWAITING_DATA
            else:
                status = ConfluenceStatus.DEGRADED
            return ConfluenceResponse(
                schema_version=SCHEMA_VERSION,
                confluence_id=_deterministic_confluence_id(request),
                request_id=request.request_id,
                symbol=request.symbol,
                timeframe=request.timeframe,
                status=status,
                required_providers=request.required_providers,
                available_providers=len(usable),
                provider_coverage=max(0.0, min(1.0, coverage)),
                providers=results,
                degraded_reasons=self._degraded_reasons(results),
                current_price=current_price,
                atr=atr,
                horizon_minutes=horizon_minutes,
                generated_at=datetime.now(timezone.utc),
            )

        weighted_score = (
            sum(result.score * result.weight for result in usable) / usable_weight
        )
        weighted_confidence = (
            sum(result.confidence * result.weight for result in usable) / usable_weight
        )
        direction = _direction_from_score(weighted_score)

        aligned_weight = 0.0
        for result in usable:
            if result.direction is None:
                continue
            if result.direction == Direction.NEUTRAL:
                aligned_weight += result.weight * 0.5
            elif result.direction == direction:
                aligned_weight += result.weight
        agreement = (aligned_weight / usable_weight) if usable_weight > 0 else 0.0
        # Missing independent feeds reduce certainty even when the available
        # feed is strong; this is coverage, not a fabricated score.
        confidence = weighted_confidence * (0.5 + 0.5 * agreement) * (
            0.75 + 0.25 * coverage
        )
        confidence = max(0.0, min(100.0, confidence))

        status = ConfluenceStatus.OK

        target_price = self._target_price(
            request=request,
            direction=direction,
            current_price=current_price,
            atr=atr,
        )
        actionable = (
            status == ConfluenceStatus.OK
            and direction != Direction.NEUTRAL
            and abs(weighted_score) >= self.min_score
            and confidence >= self.min_confidence
            and target_price is not None
            and current_price is not None
            and horizon_minutes is not None
        )

        return ConfluenceResponse(
            schema_version=SCHEMA_VERSION,
            confluence_id=_deterministic_confluence_id(request),
            request_id=request.request_id,
            symbol=request.symbol,
            timeframe=request.timeframe,
            status=status,
            direction=direction,
            confidence=confidence,
            score=max(-1.0, min(1.0, weighted_score)),
            actionable=actionable,
            target_price=target_price,
            current_price=current_price,
            atr=atr,
            horizon_minutes=horizon_minutes,
            required_providers=request.required_providers,
            available_providers=len(usable),
            provider_coverage=max(0.0, min(1.0, coverage)),
            providers=results,
            degraded_reasons=self._degraded_reasons(
                results, required=request.required_providers
            ),
            generated_at=datetime.now(timezone.utc),
        )

    async def _run_providers(
        self, request: ConfluenceRequest
    ) -> list[ProviderResult]:
        async def run(provider) -> ProviderResult:  # type: ignore[no-untyped-def]
            try:
                return await asyncio.wait_for(
                    provider.evaluate(request),
                    timeout=self.provider_timeout_seconds,
                )
            except asyncio.TimeoutError:
                return provider.error(
                    f"provider timed out after {self.provider_timeout_seconds:.1f}s"
                )
            except Exception as exc:  # noqa: BLE001 - provider isolation boundary
                return provider.error(type(exc).__name__)

        return list(
            await asyncio.gather(
                *(run(provider) for provider in self.registry.providers)
            )
        )

    @staticmethod
    def _current_price(
        request: ConfluenceRequest, results: list[ProviderResult]
    ) -> float | None:
        if request.live_price is not None:
            if feature_freshness_error(request.live_price_as_of) is None:
                return float(request.live_price)
        for result in results:
            value = result.evidence.get("last_close")
            if isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
                return float(value)
        return None

    @staticmethod
    def _atr(results: list[ProviderResult]) -> float | None:
        for result in results:
            value = result.evidence.get("atr")
            if isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
                return float(value)
        return None

    @staticmethod
    def _target_price(
        *,
        request: ConfluenceRequest,
        direction: Direction,
        current_price: float | None,
        atr: float | None,
    ) -> float | None:
        if direction == Direction.NEUTRAL:
            return None
        if current_price is None or atr is None or atr <= 0.0:
            return None
        try:
            target, _distance = project_target(
                direction.value,
                current_price,
                atr,
                request.timeframe,
                symbol_price_digits(request.symbol),
            )
        except (ValueError, TypeError, OverflowError):
            return None
        if not math.isfinite(target) or target <= 0.0:
            return None
        if direction == Direction.BUY and target <= current_price:
            return None
        if direction == Direction.SELL and target >= current_price:
            return None
        return float(target)

    @staticmethod
    def _degraded_reasons(
        results: list[ProviderResult], *, required: int | None = None
    ) -> list[str]:
        reasons: list[str] = []
        for result in results:
            if result.status == ProviderStatus.OK:
                continue
            detail = f"{result.name}: {result.status.value}"
            if result.reason:
                detail = f"{detail} ({result.reason})"
            reasons.append(detail)

        usable = sum(
            1
            for result in results
            if result.status in (ProviderStatus.OK, ProviderStatus.DEGRADED)
        )
        if required is not None and usable < required:
            reasons.append(
                f"coverage: {usable}/{required} required providers available"
            )
        return reasons
