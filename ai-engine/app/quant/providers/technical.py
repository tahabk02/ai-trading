"""Technical confluence provider.

Every value is derived from the candles supplied in the request. Insufficient
history is reported as UNAVAILABLE/DEGRADED; the provider never fills a gap with
a synthetic bar or a default indicator value.
"""

from __future__ import annotations

import asyncio
import math
import re
from datetime import datetime, timezone

import numpy as np

from app.quant.contracts import (
    Candle,
    ConfluenceRequest,
    Direction,
    ProviderResult,
    ProviderStatus,
)
from app.quant.providers.base import ConfluenceProvider


def _timestamp_seconds(value: str | float | int | None) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        epoch = float(value)
    elif isinstance(value, str):
        candidate = value.strip()
        try:
            epoch = float(candidate)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                return None
            epoch = parsed.timestamp()
    else:
        return None
    if not math.isfinite(epoch) or epoch <= 0:
        return None
    if epoch > 1e11:
        epoch /= 1000.0
    return epoch


def _timeframe_seconds(timeframe: str) -> int | None:
    match = re.fullmatch(r"([1-9]\d*)(s|m|h|d)", timeframe.strip().lower())
    if match is None:
        return None
    amount = int(match.group(1))
    unit_seconds = {"s": 1, "m": 60, "h": 3_600, "d": 86_400}
    return amount * unit_seconds[match.group(2)]


def candle_series_error(candles: list[Candle], timeframe: str) -> str | None:
    if len(candles) < 5:
        return f"insufficient candles: {len(candles)} supplied, 5 required"
    interval_seconds = _timeframe_seconds(timeframe)
    if interval_seconds is None:
        return f"cannot establish candle freshness for timeframe {timeframe!r}"

    timestamps: list[float] = []
    for index, candle in enumerate(candles):
        timestamp = _timestamp_seconds(candle.timestamp)
        if timestamp is None:
            return f"candle {index} is missing a valid timezone-aware timestamp"
        if timestamps and timestamp <= timestamps[-1]:
            return "candle timestamps are not strictly increasing"
        timestamps.append(timestamp)

    age_seconds = datetime.now(timezone.utc).timestamp() - timestamps[-1]
    if age_seconds < -60:
        return "latest candle timestamp is too far in the future"
    if age_seconds > 2 * interval_seconds:
        return (
            f"stale candles: latest bar is {age_seconds:.0f}s old; "
            f"maximum is {2 * interval_seconds}s"
        )
    return None


def latest_candle_timestamp(candles: list[Candle]) -> datetime | None:
    if not candles:
        return None
    timestamp = _timestamp_seconds(candles[-1].timestamp)
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, timezone.utc)


def _ema(values: np.ndarray, span: int) -> np.ndarray:
    span = max(1, int(span))
    alpha = 2.0 / (span + 1.0)
    out = np.empty_like(values, dtype=np.float64)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = alpha * values[i] + (1.0 - alpha) * out[i - 1]
    return out


def _rsi(values: np.ndarray, period: int) -> float | None:
    if len(values) < period + 1:
        return None
    deltas = np.diff(values[-(period + 1):])
    gains = np.clip(deltas, 0.0, None)
    losses = np.clip(-deltas, 0.0, None)
    avg_gain = float(gains.mean())
    avg_loss = float(losses.mean())
    if avg_loss <= 0.0:
        return 100.0 if avg_gain > 0.0 else 50.0
    rs = avg_gain / avg_loss
    return float(100.0 - (100.0 / (1.0 + rs)))


def _atr(candles: list, period: int) -> float:
    highs = np.array([c.high for c in candles], dtype=np.float64)
    lows = np.array([c.low for c in candles], dtype=np.float64)
    closes = np.array([c.close for c in candles], dtype=np.float64)
    prev_close = closes[:-1]
    # Preserve bar order: true range per bar, not a shuffled 3N vector.
    tr = np.maximum.reduce(
        [
            highs[1:] - lows[1:],
            np.abs(highs[1:] - prev_close),
            np.abs(lows[1:] - prev_close),
        ]
    )
    if tr.size == 0:
        return 0.0
    span = min(max(1, int(period)), tr.size)
    return float(tr[-span:].mean())


class TechnicalProvider(ConfluenceProvider):
    name = "technical"
    weight = 0.40
    description = "Observed trend, momentum and realized ATR from supplied candles"

    def is_requested(self, request: ConfluenceRequest) -> bool:
        return bool(request.candles)

    async def evaluate(self, request: ConfluenceRequest) -> ProviderResult:
        if not request.candles:
            return self.unavailable("no candles supplied")

        freshness_error = candle_series_error(request.candles, request.timeframe)
        if freshness_error is not None:
            return self.unavailable(freshness_error)

        return await asyncio.to_thread(self._compute, request)

    def _compute(self, request: ConfluenceRequest) -> ProviderResult:
        candles = request.candles
        closes = np.array([c.close for c in candles], dtype=np.float64)

        if not np.all(np.isfinite(closes)) or np.any(closes <= 0.0):
            return self.unavailable("candles contain non-finite or non-positive closes")

        atr = _atr(candles, 14)
        if not math.isfinite(atr) or atr <= 0.0:
            return self.unavailable("realized ATR is zero; no volatility evidence")

        fast_span = min(9, len(closes) - 1)
        slow_span = min(21, len(closes) - 1)
        fast = _ema(closes, fast_span)[-1]
        slow = _ema(closes, slow_span)[-1]
        trend_component = math.tanh((fast - slow) / atr * 0.5)

        lookback = min(5, len(closes) - 1)
        momentum = (closes[-1] - closes[-lookback - 1]) / atr
        momentum_component = math.tanh(momentum * 0.5)

        rsi = _rsi(closes, min(14, len(closes) - 1))
        rsi_component = ((rsi - 50.0) / 50.0) if rsi is not None else 0.0

        score = float(
            np.clip(
                0.55 * trend_component
                + 0.30 * momentum_component
                + 0.15 * rsi_component,
                -1.0,
                1.0,
            )
        )

        if score > 0.05:
            direction = Direction.BUY
        elif score < -0.05:
            direction = Direction.SELL
        else:
            direction = Direction.NEUTRAL

        components = [trend_component, momentum_component, rsi_component]
        if direction == Direction.NEUTRAL:
            agreement = 0.5
        else:
            sign = 1.0 if direction == Direction.BUY else -1.0
            votes = [math.copysign(1.0, c) == sign for c in components if abs(c) > 1e-12]
            agreement = (sum(votes) / len(votes)) if votes else 0.5

        confidence = float(
            np.clip(100.0 * (0.60 * abs(score) + 0.40 * agreement), 0.0, 100.0)
        )

        status = ProviderStatus.OK if len(closes) >= 21 else ProviderStatus.DEGRADED
        reason = None
        if status == ProviderStatus.DEGRADED:
            reason = f"short history: {len(closes)} candles, 21 preferred"

        return ProviderResult(
            name=self.name,
            status=status,
            weight=self.weight,
            direction=direction,
            score=score,
            confidence=confidence,
            reason=reason,
            evidence={
                "bars": len(closes),
                "atr": atr,
                "ema_fast": float(fast),
                "ema_slow": float(slow),
                "rsi": rsi,
                "last_close": float(closes[-1]),
                "trend_component": trend_component,
                "momentum_component": momentum_component,
                "rsi_component": rsi_component,
                "agreement": agreement,
            },
        )
