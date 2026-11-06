"""Typed contracts for the multi-provider confluence pipeline.

The pipeline is a pure data-to-data transformation: every provider consumes
observed inputs and reports what it actually saw. No provider may synthesize a
tick, candle, probability, or target. Missing data is reported as an explicit
status, never as a neutral score.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)


SCHEMA_VERSION = "1.0.0"
EvidenceKind = Literal["news", "social", "market_mood"]
MacroCategory = Literal[
    "fx_index",
    "interest_rate_differential",
    "commodity",
    "global_correlation",
]


def _parse_aware_iso8601(value: object, field_name: str) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError(f"{field_name} must include a timezone")
        return value
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be an ISO-8601 string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field_name} must be a valid ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field_name} must include a timezone")
    return parsed


class Direction(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    NEUTRAL = "NEUTRAL"


class ProviderStatus(str, Enum):
    OK = "OK"
    DEGRADED = "DEGRADED"
    UNAVAILABLE = "UNAVAILABLE"
    ERROR = "ERROR"


class ConfluenceStatus(str, Enum):
    OK = "OK"
    DEGRADED = "DEGRADED"
    AWAITING_DATA = "AWAITING_DATA"


class Candle(BaseModel):
    """One observed OHLC bar.

    ``timestamp`` accepts an ISO-8601 string or a Unix epoch (seconds or
    milliseconds). It is kept as received so callers can audit provenance.
    """

    model_config = ConfigDict(extra="allow")

    timestamp: str | float | int | None = None
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None

    @field_validator("open", "high", "low", "close")
    @classmethod
    def finite_positive_price(cls, value: float) -> float:
        if not math.isfinite(value) or value <= 0:
            raise ValueError("OHLC prices must be finite and positive")
        return float(value)

    @field_validator("volume")
    @classmethod
    def finite_non_negative_volume(cls, value: float | None) -> float | None:
        if value is None:
            return None
        if not math.isfinite(value) or value < 0:
            raise ValueError("volume must be finite and non-negative")
        return float(value)

    @model_validator(mode="after")
    def ohlc_consistent(self) -> "Candle":
        if self.high < max(self.open, self.close, self.low):
            raise ValueError("high must be >= open, close and low")
        if self.low > min(self.open, self.close, self.high):
            raise ValueError("low must be <= open, close and high")
        return self


class SentimentEvidence(BaseModel):
    """One timestamped, source-attributed news/social sentiment observation."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[SCHEMA_VERSION]
    kind: EvidenceKind
    source: str = Field(min_length=1, max_length=128)
    reference_id: str = Field(min_length=1, max_length=256)
    polarity: float = Field(ge=-1.0, le=1.0)
    as_of: datetime

    @field_validator("polarity")
    @classmethod
    def finite_polarity(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("sentiment polarity must be finite")
        return float(value)

    @field_validator("as_of", mode="before")
    @classmethod
    def parse_as_of(cls, value: object) -> datetime:
        return _parse_aware_iso8601(value, "as_of")


class SentimentProviderResponse(BaseModel):
    """Strict raw-evidence response from the FinGPT adapter.

    The engine computes the aggregate polarity and agreement confidence from
    evidence items; it does not trust a provider-supplied aggregate score.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[SCHEMA_VERSION]
    source: str = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=128)
    evidence: list[SentimentEvidence] = Field(min_length=1, max_length=500)
    as_of: datetime

    @field_validator("as_of", mode="before")
    @classmethod
    def parse_as_of(cls, value: object) -> datetime:
        return _parse_aware_iso8601(value, "as_of")


class MacroDataPoint(BaseModel):
    """One observed OpenBB data point with its source timestamp and units."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[SCHEMA_VERSION]
    category: MacroCategory
    name: str = Field(min_length=1, max_length=128)
    value: float
    unit: str = Field(min_length=1, max_length=64)
    source: str = Field(min_length=1, max_length=128)
    as_of: datetime

    @field_validator("value")
    @classmethod
    def finite_value(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("macro data values must be finite")
        return float(value)

    @field_validator("as_of", mode="before")
    @classmethod
    def parse_as_of(cls, value: object) -> datetime:
        return _parse_aware_iso8601(value, "as_of")


class MacroProviderResponse(BaseModel):
    """Strict output of the configured OpenBB context adapter.

    The adapter returns its directional assessment alongside the raw
    observations it used. The confluence service validates every source point
    and does not infer a direction from bare interest-rate or commodity levels.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[SCHEMA_VERSION]
    score: float = Field(ge=-1.0, le=1.0)
    confidence: float = Field(ge=0.0, le=100.0)
    confidence_unit: Literal["percent"]
    source: str = Field(min_length=1, max_length=128)
    methodology: str = Field(min_length=1, max_length=128)
    regime: str | None = Field(default=None, max_length=64)
    data_points: list[MacroDataPoint] = Field(min_length=1, max_length=128)
    as_of: datetime

    @field_validator("score", "confidence")
    @classmethod
    def finite_values(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("macro assessment values must be finite")
        return float(value)

    @field_validator("as_of", mode="before")
    @classmethod
    def parse_as_of(cls, value: object) -> datetime:
        return _parse_aware_iso8601(value, "as_of")


class MLProviderResponse(BaseModel):
    """Strict Qlib model inference tied to the requested timeframe and bars."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[SCHEMA_VERSION]
    direction: Direction
    probability: float = Field(ge=0.5, le=1.0)
    probability_unit: Literal["fraction"]
    timeframe: str = Field(min_length=1, max_length=16)
    input_as_of: datetime
    model: str = Field(min_length=1, max_length=128)
    version: str = Field(min_length=1, max_length=64)
    as_of: datetime

    @field_validator("probability")
    @classmethod
    def finite_probability(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("ML probability must be finite")
        return float(value)

    @field_validator("input_as_of", "as_of", mode="before")
    @classmethod
    def parse_timestamps(cls, value: object, info: ValidationInfo) -> datetime:
        return _parse_aware_iso8601(value, info.field_name)

    @model_validator(mode="after")
    def direction_matches_probability(self) -> "MLProviderResponse":
        if self.direction == Direction.NEUTRAL and self.probability != 0.5:
            raise ValueError("NEUTRAL inference must have probability 0.5")
        return self


class ConfluenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[SCHEMA_VERSION]
    symbol: str = Field(min_length=1, max_length=32)
    timeframe: str = Field(default="1h", min_length=1, max_length=16)
    live_price: float | None = Field(default=None, gt=0)
    live_price_as_of: datetime | None = None
    candles: list[Candle] = Field(default_factory=list, max_length=5000)
    required_providers: int = Field(default=1, ge=1, le=4)
    request_id: str | None = Field(default=None, min_length=1, max_length=128)

    @field_validator("symbol")
    @classmethod
    def normalize_symbol(cls, value: str) -> str:
        symbol = value.strip().upper()
        if not symbol:
            raise ValueError("symbol must not be blank")
        return symbol

    @field_validator("timeframe")
    @classmethod
    def normalize_timeframe(cls, value: str) -> str:
        timeframe = value.strip().lower()
        if not timeframe:
            raise ValueError("timeframe must not be blank")
        return timeframe

    @field_validator("live_price")
    @classmethod
    def finite_live_price(cls, value: float | None) -> float | None:
        if value is None:
            return None
        if not math.isfinite(value) or value <= 0:
            raise ValueError("live_price must be finite and positive")
        return float(value)

    @field_validator("live_price_as_of", mode="before")
    @classmethod
    def timezone_aware_live_price_timestamp(
        cls, value: object
    ) -> datetime | None:
        if value is None:
            return None
        return _parse_aware_iso8601(value, "live_price_as_of")


class ProviderResult(BaseModel):
    """The complete, auditable output of one provider."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    name: str
    status: ProviderStatus
    weight: float = Field(gt=0.0)
    confidence_unit: Literal["percent"] = "percent"
    direction: Direction | None = None
    score: float | None = Field(default=None, ge=-1.0, le=1.0)
    confidence: float | None = Field(default=None, ge=0.0, le=100.0)
    reason: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def usable_status_has_values(self) -> "ProviderResult":
        if self.status == ProviderStatus.OK:
            if self.direction is None or self.score is None or self.confidence is None:
                raise ValueError("OK provider results require direction, score and confidence")
        return self

    @field_validator("score", "confidence")
    @classmethod
    def finite_optional_signal_value(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("provider signal values must be finite")
        return value


class ConfluenceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    confluence_id: str
    request_id: str | None = None
    symbol: str
    timeframe: str
    status: ConfluenceStatus
    confidence_unit: Literal["percent"] = "percent"
    direction: Direction | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=100.0)
    score: float | None = Field(default=None, ge=-1.0, le=1.0)
    actionable: bool = False
    target_price: float | None = Field(default=None, gt=0.0)
    current_price: float | None = Field(default=None, gt=0.0)
    atr: float | None = Field(default=None, gt=0.0)
    horizon_minutes: int | None = Field(default=None, ge=1, le=1440)
    required_providers: int
    available_providers: int
    provider_coverage: float = Field(ge=0.0, le=1.0)
    providers: list[ProviderResult]
    degraded_reasons: list[str] = Field(default_factory=list)
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @field_validator("confidence", "score", "target_price", "current_price", "atr")
    @classmethod
    def finite_response_values(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("confluence response values must be finite")
        return value

    @field_validator("generated_at", mode="before")
    @classmethod
    def parse_generated_at(cls, value: object) -> datetime:
        return _parse_aware_iso8601(value, "generated_at")

    @model_validator(mode="after")
    def actionable_signal_is_complete(self) -> "ConfluenceResponse":
        if self.confidence is not None and not math.isfinite(self.confidence):
            raise ValueError("confidence must be finite")
        if self.actionable and (
            self.status != ConfluenceStatus.OK
            or self.direction == Direction.NEUTRAL
            or self.direction is None
            or self.confidence is None
            or self.target_price is None
            or self.current_price is None
            or self.horizon_minutes is None
        ):
            raise ValueError(
                "actionable response requires OK status, direction, confidence, "
                "AI target, current price and horizon"
            )
        if self.target_price is not None and self.current_price is not None:
            if self.direction == Direction.BUY and self.target_price <= self.current_price:
                raise ValueError("BUY target must be above current_price")
            if self.direction == Direction.SELL and self.target_price >= self.current_price:
                raise ValueError("SELL target must be below current_price")
        return self


class ProviderDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[SCHEMA_VERSION] = SCHEMA_VERSION
    name: str
    weight: float
    description: str
