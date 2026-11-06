from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SignalSide = Literal["BUY", "SELL"]


class SignalRejected(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


class OrderStatus(str, Enum):
    INTENT = "INTENT"
    SUBMITTED = "SUBMITTED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED = "FILLED"
    CANCELED = "CANCELED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    UNKNOWN = "UNKNOWN"
    MANUAL_REVIEW = "MANUAL_REVIEW"

    @property
    def terminal(self) -> bool:
        return self in {
            OrderStatus.FILLED,
            OrderStatus.CANCELED,
            OrderStatus.REJECTED,
            OrderStatus.EXPIRED,
            OrderStatus.MANUAL_REVIEW,
        }


class SignalEnvelope(BaseModel):
    model_config = ConfigDict(frozen=True)

    event_id: str
    signal_id: str | None = None
    symbol: str
    side: SignalSide
    confidence: float
    price: float
    target_price: float | None = None
    horizon_minutes: int | None = None
    timestamp: datetime
    executable: bool
    dispatchable: bool | None = None
    market_waiting: bool = False
    tier: str | None = None
    regime_gate: str | None = None
    quantity: float | None = None
    raw: dict[str, Any] = Field(default_factory=dict)

    @field_validator("symbol")
    @classmethod
    def _normalize_symbol(cls, value: str) -> str:
        symbol = value.strip().upper()
        if not symbol or "/" not in symbol:
            raise ValueError("symbol must be a venue-qualified pair such as EUR/USD")
        return symbol

    @field_validator("confidence")
    @classmethod
    def _validate_confidence(cls, value: float) -> float:
        if not math.isfinite(value) or value < 0.0 or value > 100.0:
            raise ValueError("confidence must be finite and within 0..100")
        return value

    @field_validator("price", "target_price")
    @classmethod
    def _validate_price(cls, value: float | None) -> float | None:
        if value is None:
            return None
        if not math.isfinite(value) or value <= 0.0:
            raise ValueError("price must be finite and strictly positive")
        return value

    @field_validator("horizon_minutes")
    @classmethod
    def _validate_horizon(cls, value: int | None) -> int | None:
        if value is None:
            return None
        if value <= 0 or value > 1_440:
            raise ValueError("horizon_minutes must be within 1..1440")
        return value

    @classmethod
    def from_stream_entry(cls, event_id: str, fields: dict[str, Any]) -> "SignalEnvelope":
        payload = _unwrap_payload(fields)
        raw = dict(payload)

        # Non-actionable riders are rejected before numeric validation so a
        # feed-gap placeholder (missing price) is skipped, not dead-lettered.
        if "executable" in payload:
            if payload.get("executable") is not True:
                raise SignalRejected(
                    "NOT_EXECUTABLE",
                    "signal is not stamped executable=true by the AI engine",
                )
        elif "market_waiting" in payload:
            raise SignalRejected(
                "MARKET_WAITING", "signal is in market-waiting state"
            )
        else:
            raise SignalRejected(
                "EXECUTABLE_MISSING",
                "signal contract requires an explicit executable flag",
            )
        dispatchable = payload.get("dispatchable")
        if dispatchable is not None and dispatchable is not True:
            raise SignalRejected(
                "NOT_DISPATCHABLE", "signal is not stamped dispatchable=true"
            )
        if payload.get("market_waiting") is True:
            raise SignalRejected(
                "MARKET_WAITING", "signal is in market-waiting state"
            )
        if payload.get("schema_version") != "1.0.0":
            raise SignalRejected(
                "SCHEMA_VERSION_UNSUPPORTED",
                "signal schema_version must be 1.0.0",
            )
        if payload.get("confidence_unit") != "percent":
            raise SignalRejected(
                "CONFIDENCE_UNIT_MISSING",
                "signal confidence_unit must explicitly be 'percent'",
            )

        symbol = _first(payload, "symbol", "instrument")
        side_raw = _first(payload, "signal_type", "signalType", "signal", "direction")
        price_raw = _first(payload, "price", "current_price", "currentPrice", "tick", "live_price")
        confidence_raw = _first(payload, "confidence", "confidence_score")
        target_raw = _first(payload, "target_price", "take_profit", "targetPrice")
        timestamp_raw = _first(payload, "timestamp", "ts_utc", "ts")

        if not isinstance(symbol, str) or not symbol.strip():
            raise SignalRejected("SYMBOL_MISSING", "signal carries no symbol")
        if not isinstance(side_raw, str) or side_raw.strip().upper() not in ("BUY", "SELL"):
            raise SignalRejected(
                "DIRECTION_MISSING", "signal carries no BUY/SELL direction"
            )
        if price_raw is None:
            raise SignalRejected("PRICE_MISSING", "signal carries no reference price")
        if confidence_raw is None:
            raise SignalRejected("CONFIDENCE_MISSING", "signal carries no confidence")
        if timestamp_raw is None:
            raise SignalRejected("TIMESTAMP_MISSING", "signal carries no timestamp")

        try:
            price = float(price_raw)
            confidence = float(confidence_raw)
            target_price = None if target_raw is None else float(target_raw)
        except (TypeError, ValueError) as exc:
            raise SignalRejected("NUMERIC_INVALID", str(exc)) from exc

        if not math.isfinite(confidence) or confidence < 0.0 or confidence > 100.0:
            raise SignalRejected(
                "CONFIDENCE_SCALE_INVALID",
                f"confidence must be within 0..100, got {confidence}",
            )
        if not math.isfinite(price) or price <= 0.0:
            raise SignalRejected("PRICE_INVALID", f"price must be positive, got {price}")

        side = side_raw.strip().upper()

        if target_price is not None:
            if not math.isfinite(target_price) or target_price <= 0.0:
                raise SignalRejected(
                    "TARGET_INVALID", f"target_price must be positive, got {target_price}"
                )
            if side == "BUY" and target_price <= price:
                raise SignalRejected(
                    "TARGET_CONTRADICTS_DIRECTION",
                    f"BUY target {target_price} is not above price {price}",
                )
            if side == "SELL" and target_price >= price:
                raise SignalRejected(
                    "TARGET_CONTRADICTS_DIRECTION",
                    f"SELL target {target_price} is not below price {price}",
                )

        horizon_raw = payload.get("horizon_minutes")
        horizon = None
        if horizon_raw is not None:
            try:
                horizon = int(horizon_raw)
            except (TypeError, ValueError) as exc:
                raise SignalRejected("HORIZON_INVALID", str(exc)) from exc
            if horizon <= 0 or horizon > 1_440:
                raise SignalRejected(
                    "HORIZON_INVALID", f"horizon_minutes out of range: {horizon}"
                )

        quantity_raw = _first(payload, "quantity", "amount", "qty")
        quantity = None
        if quantity_raw is not None:
            try:
                quantity = float(quantity_raw)
            except (TypeError, ValueError) as exc:
                raise SignalRejected("QUANTITY_INVALID", str(exc)) from exc
            if not math.isfinite(quantity) or quantity <= 0.0:
                raise SignalRejected(
                    "QUANTITY_INVALID", f"quantity must be positive, got {quantity}"
                )

        # The publisher's stable event id is the cross-process idempotency key.
        # A re-published entry gets a NEW Redis stream id but the same event id,
        # so using it here is what prevents a duplicate order after a retry.
        contract_event_id = _optional_str(payload.get("event_id"))
        if contract_event_id is None or len(contract_event_id) > 128:
            contract_event_id = event_id

        try:
            return cls(
                event_id=contract_event_id,
                signal_id=_optional_str(_first(payload, "signal_id", "id")),
                symbol=symbol,
                side=side,
                confidence=confidence,
                price=price,
                target_price=target_price,
                horizon_minutes=horizon,
                timestamp=_parse_timestamp(timestamp_raw),
                executable=True,
                dispatchable=dispatchable if isinstance(dispatchable, bool) else None,
                market_waiting=False,
                tier=_optional_str(payload.get("tier")),
                regime_gate=_optional_str(payload.get("regime_gate")),
                quantity=quantity,
                raw=raw,
            )
        except SignalRejected:
            raise
        except Exception as exc:
            raise SignalRejected("SIGNAL_INVALID", str(exc)) from exc

    def dedupe_key(self, window_seconds: int) -> str:
        bucket = int(self.timestamp.timestamp()) // window_seconds
        identity = "|".join(
            [self.symbol, self.side, str(self.horizon_minutes or "default"), str(bucket)]
        )
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()


class OrderIntent(BaseModel):
    model_config = ConfigDict(frozen=True)

    event_id: str
    client_order_id: str
    signal_id: str | None
    symbol: str
    side: SignalSide
    quantity: float
    notional: float
    reference_price: float
    confidence: float
    signal_timestamp: datetime
    dedupe_key: str
    raw_signal: dict[str, Any]

    @classmethod
    def build(
        cls,
        signal: SignalEnvelope,
        quantity: float,
        notional: float,
        dedupe_key: str,
    ) -> "OrderIntent":
        digest = hashlib.sha256(signal.event_id.encode("utf-8")).hexdigest()[:24]
        return cls(
            event_id=signal.event_id,
            client_order_id=f"ex-{digest}",
            signal_id=signal.signal_id,
            symbol=signal.symbol,
            side=signal.side,
            quantity=round(quantity, 8),
            notional=round(notional, 8),
            reference_price=signal.price,
            confidence=signal.confidence,
            signal_timestamp=signal.timestamp,
            dedupe_key=dedupe_key,
            raw_signal=signal.raw,
        )


class RiskDecision(BaseModel):
    model_config = ConfigDict(frozen=True)

    allowed: bool
    code: str
    detail: str
    quantity: float = 0.0
    notional: float = 0.0


class AccountSnapshot(BaseModel):
    model_config = ConfigDict(frozen=True)

    venue: str
    balance: float
    equity: float
    starting_equity: float
    open_notional: float
    open_positions: int
    daily_pnl: float | None
    supports_short: bool


class BrokerOrder(BaseModel):
    model_config = ConfigDict(frozen=True)

    client_order_id: str
    broker_order_id: str | None
    status: OrderStatus
    filled_quantity: float = 0.0
    average_price: float | None = None
    reason: str | None = None


class ProcessOutcome(BaseModel):
    model_config = ConfigDict(frozen=True)

    ack: bool
    status: str
    reason: str | None = None
    detail: str | None = None
    dead_letter: bool = False


def _unwrap_payload(fields: dict[str, Any]) -> dict[str, Any]:
    encoded = fields.get("payload") if isinstance(fields, dict) else None
    if isinstance(encoded, str) and encoded.strip().startswith("{"):
        try:
            parsed = json.loads(encoded)
        except json.JSONDecodeError as exc:
            raise SignalRejected("PAYLOAD_NOT_JSON", str(exc)) from exc
        if isinstance(parsed, dict):
            return parsed
    return dict(fields)


def _first(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)):
        seconds = float(value) / 1000.0 if float(value) > 1e11 else float(value)
        parsed = datetime.fromtimestamp(seconds, tz=timezone.utc)
    elif isinstance(value, str):
        text = value.strip()
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            try:
                numeric = float(text)
            except ValueError as exc:
                raise SignalRejected("TIMESTAMP_INVALID", text) from exc
            seconds = numeric / 1000.0 if numeric > 1e11 else numeric
            parsed = datetime.fromtimestamp(seconds, tz=timezone.utc)
    else:
        raise SignalRejected("TIMESTAMP_INVALID", repr(value))

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
