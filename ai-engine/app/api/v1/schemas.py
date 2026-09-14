"""
Pydantic models for request/response validation of the prediction API.

Strict validation ensures that:
- All required fields are present with correct types
- Missing or malformed fields return clean 422/400 errors
- No unhandled crashes due to unexpected payload shapes
"""

from pydantic import BaseModel, Field, field_validator
from typing import List, Dict, Any, Optional, Union
from datetime import datetime
import numpy as np


class CandleModel(BaseModel):
    """A single OHLCV candle from market data.

    ``timestamp`` accepts EITHER an ISO-8601 string (Node.js
    mapCandlesToAiFormat contract) OR epoch milliseconds (client
    aggregator / internal tick format). Both are real timestamps —
    rejecting either format breaks legitimate callers.
    """
    open: float = Field(..., description="Open price")
    high: float = Field(..., description="High price")
    low: float = Field(..., description="Low price")
    close: float = Field(..., description="Close price")
    volume: float = Field(..., description="Volume")
    timestamp: Optional[Union[str, float]] = Field(
        None,
        description="ISO-8601 string or epoch milliseconds",
    )

    @field_validator("open", "high", "low", "close", "volume")
    @classmethod
    def validate_finite_positive(cls, v: float, info: Any) -> float:
        field_name = info.field_name if hasattr(info, 'field_name') else str(info)
        if not np.isfinite(v):
            raise ValueError(f"{field_name} must be finite, got {v}")
        if v <= 0 and field_name in ("open", "high", "low", "close"):
            raise ValueError(f"{field_name} must be positive, got {v}")
        return float(v)

    @field_validator("volume")
    @classmethod
    def validate_volume(cls, v: float) -> float:
        if not np.isfinite(v):
            raise ValueError(f"volume must be finite, got {v}")
        if v < 0:
            raise ValueError(f"volume must be non-negative, got {v}")
        return float(v)

    @field_validator("timestamp")
    @classmethod
    def validate_timestamp(cls, v: Optional[Union[str, float]]) -> Optional[Union[str, float]]:
        """Accept ISO strings and epoch-ms numbers; reject anything else."""
        if v is None:
            return None
        if isinstance(v, str):
            if not v.strip():
                return None
            return v.strip()
        if isinstance(v, (int, float)):
            fv = float(v)
            # Epoch 0 (1970-01-01) is a legitimate relative-series origin.
            if not np.isfinite(fv) or fv < 0:
                raise ValueError(
                    f"epoch timestamp must be finite and non-negative, got {v}"
                )
            return fv
        raise ValueError(
            f"timestamp must be an ISO-8601 string or epoch milliseconds, "
            f"got {type(v).__name__}"
        )


class FutureCandleModel(BaseModel):
    """A model-produced future candle, never a realized market observation."""
    timestamp: float = Field(..., gt=0)
    open: float = Field(..., gt=0)
    high: float = Field(..., gt=0)
    low: float = Field(..., gt=0)
    close: float = Field(..., gt=0)
    volume: float = Field(default=0, ge=0)
    projected: bool = True


from app.services.ml_predictor import pad_candles_if_needed

# ═══════════════════════════════════════════════════════════════════
# STRICT OTC WHITELIST — 100% REAL, 0 DEMO — FULL 34-PAIR UNIVERSE
# Mirrors core-backend symbolRegistry.service.ts EXACTLY. Includes the
# two CRYPTO MAJORS (BTC/USD, ETH/USD) whose absence previously caused
# every crypto prediction to be rejected at Pydantic validation (HTTP
# 422) — the root cause of BTC/ETH signals being permanently stuck.
# ═══════════════════════════════════════════════════════════════════
STRICT_OTC_WHITELIST = frozenset({
    # Forex Majors (7)
    "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "USD/CAD", "AUD/USD", "NZD/USD",
    # Crypto Majors (2)
    "BTC/USD", "ETH/USD",
    # Euro Crosses (7)
    "EUR/GBP", "EUR/JPY", "EUR/CHF", "EUR/AUD", "EUR/CAD", "EUR/NZD", "EUR/TRY",
    # Pound Crosses (4)
    "GBP/JPY", "GBP/CHF", "GBP/AUD", "GBP/CAD",
    # Yen Crosses (3)
    "AUD/JPY", "CAD/JPY", "CHF/JPY",
    # Other Minors (5)
    "AUD/CAD", "AUD/NZD", "NZD/JPY", "CAD/CHF", "EUR/RUB",
    # Emerging / OTC Variants (6)
    "USD/TRY", "USD/ZAR", "USD/MXN", "USD/SGD", "MAD/USD", "KES/USD",
})

# Asset-class precision map:
#   - Crypto majors (BTC/USD, ETH/USD) → 2 decimals (prices ~60k / ~3k)
#   - JPY-cross pairs                  → 3 decimals
#   - All other OTC Forex pairs        → 5 decimals
CRYPTO_SYMBOLS = frozenset({"BTC/USD", "ETH/USD"})
JPY_QUOTES = frozenset({"JPY"})


def otc_price_precision(symbol: str) -> int:
    """Decimal precision per asset class: crypto → 2, JPY → 3, else 5."""
    sym = (symbol or "").strip().upper()
    if sym in CRYPTO_SYMBOLS:
        return 2
    try:
        quote = sym.split("/")[1]
        return 3 if quote in JPY_QUOTES else 5
    except (IndexError, AttributeError):
        return 5


class PredictRequest(BaseModel):
    """Strict validation model for POST /api/v1/predict requests."""
    symbol: str = Field(
        ...,
        min_length=1,
        description="Trading symbol (STRICT: whitelisted OTC pair only)",
    )
    timeframe: str = Field(
        default="1d",
        description="Bar timeframe (e.g. '1d', '1h', '15m')",
    )
    candles: List[CandleModel] = Field(
        ...,
        min_length=1,
        description="List of OHLCV candles (auto-padded to 90 for robust ML)",
    )
    live_price: float = Field(
        ...,
        gt=0,
        description="Live snapshot price from Alpaca (required, must be > 0)",
    )
    bid: Optional[float] = Field(
        default=None,
        gt=0,
        description="Real live bid arm (drives bid_ask_pressure; optional)",
    )
    ask: Optional[float] = Field(
        default=None,
        gt=0,
        description="Real live ask arm (drives bid_ask_pressure; optional)",
    )
    dataSource: Optional[str] = Field(
        default="unknown",
        description="Source of the data (e.g. 'alpaca', 'alpaca_historical')",
    )
    force_retrain: Optional[bool] = Field(
        default=False,
        description="Force retrain the ML model",
    )

    @field_validator("symbol")
    @classmethod
    def validate_symbol(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("symbol must be a non-empty string")
        normalized = stripped.upper()
        # STRICT WHITELIST GATE — reject ALL non-whitelisted tickers.
        # Covers the FULL 34-pair universe including BTC/USD & ETH/USD.
        if normalized not in STRICT_OTC_WHITELIST:
            raise ValueError(
                f"Symbol '{normalized}' is NOT in the strict OTC whitelist. "
                "Allowed pairs (34): EUR/USD, GBP/USD, USD/JPY, USD/CHF, USD/CAD, "
                "AUD/USD, NZD/USD, BTC/USD, ETH/USD, EUR/GBP, EUR/JPY, EUR/CHF, "
                "EUR/AUD, EUR/CAD, EUR/NZD, EUR/TRY, GBP/JPY, GBP/CHF, GBP/AUD, "
                "GBP/CAD, AUD/JPY, CAD/JPY, CHF/JPY, AUD/CAD, AUD/NZD, NZD/JPY, "
                "CAD/CHF, EUR/RUB, USD/TRY, USD/ZAR, USD/MXN, USD/SGD, MAD/USD, KES/USD."
            )
        return normalized

    @field_validator("candles")
    @classmethod
    def validate_candle_count(cls, v: List[CandleModel]) -> List[CandleModel]:
        """Structural validation ONLY — count enforcement lives in the route.

        The previous implementation called ``pad_candles_if_needed`` here,
        which RAISES for short arrays inside the Pydantic validator. That
        surfaced as an opaque HTTP 422/500 instead of the route's clean,
        descriptive HTTP 400. Short-but-real arrays now pass through and the
        /predict handler enforces the 90-bar minimum explicitly.
        """
        if not v:
            raise ValueError("candles array cannot be empty")
        return v

    @field_validator("timeframe")
    @classmethod
    def validate_timeframe(cls, v: str) -> str:
        # FULL HORIZON RANGE (1 minute → 10 days):
        #  • All Pocket Option expirations: 1m … 35m+
        #  • Standard exchange intervals:   1h, 4h, 1d
        #  • Multi-day projections:         2d, 3d, 5d, 10d
        # The ATR × √horizon projection math scales targets to the exact
        # user-selected window on every request.
        valid = {
            "1m", "2m", "3m", "5m", "10m", "15m",
            "20m", "25m", "30m", "35m+",
            "1h", "4h", "1d", "2d", "3d", "5d", "10d",
        }
        if v.lower() not in valid:
            raise ValueError(
                f"Invalid timeframe '{v}'. Must be one of: {sorted(valid)}"
            )
        return v.lower()


class IndicatorModel(BaseModel):
    """Live 9-factor real-time micro-tape values (lagging RSI/SMA/MACD purged)."""
    tick_velocity: Optional[float] = None
    micro_momentum: Optional[float] = None
    bid_ask_pressure: Optional[float] = None
    price_action_delta: Optional[float] = None
    live_tick_move: Optional[float] = None
    instant_delta: Optional[float] = None
    tick_velocity_acceleration: Optional[float] = None
    order_flow_imbalance: Optional[float] = None


class PredictResponse(BaseModel):
    """Standardized prediction response."""
    symbol: str
    signal: Optional[str] = Field(None, pattern="^(BUY|SELL|HOLD)$")
    # Genuine full-range confidence percentage (0-100 scale from the engine).
    confidence: float = Field(..., ge=0.0, le=100.0)
    target_price: float = Field(..., ge=0)
    current_price: float = Field(..., gt=0)
    ml_probability: float = Field(..., ge=0.0, le=1.0)
    model_accuracy: float = Field(..., ge=0.0, le=1.0)
    timeframe: str
    proxyLatencyMs: Optional[float] = None
    indicators: IndicatorModel = Field(default_factory=IndicatorModel)
    timestamp: str
    delta_pct: Optional[float] = None
    dataSource: Optional[str] = None
    barCount: Optional[int] = None
    future_candles: List[FutureCandleModel] = Field(default_factory=list)


class ErrorResponse(BaseModel):
    """Standardized error response."""
    error: str
    detail: Optional[Dict[str, Any]] = None
    symbol: Optional[str] = None
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
