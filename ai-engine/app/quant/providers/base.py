from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone

from app.quant.contracts import (
    ConfluenceRequest,
    ProviderDescriptor,
    ProviderResult,
    ProviderStatus,
)

MAX_EXTERNAL_FEATURE_AGE_SECONDS = 15 * 60
MAX_FUTURE_CLOCK_SKEW_SECONDS = 60


def feature_freshness_error(as_of: datetime | None) -> str | None:
    if as_of is None:
        return "missing as_of timestamp"
    if as_of.tzinfo is None or as_of.utcoffset() is None:
        return "as_of timestamp must include a timezone"

    age_seconds = (
        datetime.now(timezone.utc) - as_of.astimezone(timezone.utc)
    ).total_seconds()
    if age_seconds < -MAX_FUTURE_CLOCK_SKEW_SECONDS:
        return "as_of timestamp is too far in the future"
    if age_seconds > MAX_EXTERNAL_FEATURE_AGE_SECONDS:
        return (
            f"stale evidence: {age_seconds:.0f}s old; "
            f"maximum is {MAX_EXTERNAL_FEATURE_AGE_SECONDS}s"
        )
    return None


class ConfluenceProvider(ABC):
    """One independent, auditable input to the confluence aggregate."""

    name: str
    weight: float
    description: str

    @abstractmethod
    async def evaluate(self, request: ConfluenceRequest) -> ProviderResult:
        raise NotImplementedError

    def descriptor(self) -> ProviderDescriptor:
        return ProviderDescriptor(
            name=self.name,
            weight=self.weight,
            description=self.description,
        )

    def is_requested(self, request: ConfluenceRequest) -> bool:
        """Whether the caller or deployment configured this evidence source."""
        return False

    def unavailable(self, reason: str) -> ProviderResult:
        return ProviderResult(
            name=self.name,
            status=ProviderStatus.UNAVAILABLE,
            weight=self.weight,
            reason=reason,
        )

    def error(self, reason: str) -> ProviderResult:
        return ProviderResult(
            name=self.name,
            status=ProviderStatus.ERROR,
            weight=self.weight,
            reason=reason,
        )

    async def close(self) -> None:
        """Release optional provider resources during application shutdown."""
        return None
