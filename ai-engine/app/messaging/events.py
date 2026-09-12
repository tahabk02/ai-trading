

"""
events.py

Domain event definitions used across the AI Engine messaging layer.
Events are plain dataclasses serialised to JSON for Redis Pub/Sub.
"""

from dataclasses import dataclass, field, asdict
from typing import Dict, Any, Optional
from datetime import datetime


@dataclass
class SignalGeneratedEvent:
    """Emitted whenever the SignalGenerator produces an ACTIVE signal."""

    symbol: str
    signal_type: str  # "BUY" | "SELL"
    price: float
    confidence: float
    stop_loss: float
    take_profit: float
    indicators: Dict[str, float]
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    status: str = "ACTIVE"
    reason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class NoTradeEvent:
    """Emitted when the generator decides not to emit a signal."""

    symbol: str
    status: str  # "NO_DATA" | "INVALID_CANDLES" | "INVALID_INDICATORS" | "SIDEWAYS_CHOP" | "NEWS_FREEZE" | "LOW_CONFIDENCE" | "INTERNAL_ERROR"
    reason: Optional[str] = None
    confidence: float = 0.0
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ModelTrainedEvent:
    """Emitted after a successful model training run."""

    symbol: str
    model_name: str  # "xgboost_classifier" | "lstm_model"
    version: str
    accuracy: float
    features: list[str]
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class EngineStatusEvent:
    """Emitted when the AI engine status changes."""

    status: str  # "OPERATIONAL" | "DEGRADED" | "OFFLINE"
    message: Optional[str] = None
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

