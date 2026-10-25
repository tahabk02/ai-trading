"""Per-market regime adaptation for the predictive layer.

The existing execution gates already know WHICH market a symbol belongs to
(``asset_class.py`` + ``market_strategies``). This module adds the missing
predictive context: HOW that market is currently behaving, and which evidence
should be trusted more or suppressed.

Three structural adapters are implemented, one per real execution class:

  OTC    - synthetic/retail tape: first-order Markov direction persistence,
           consecutive-return correlation and recent tick-velocity dynamics.
  REAL   - institutional FX: UTC session liquidity, spread-to-ATR elasticity.
  CRYPTO - 24/7 majors: Bollinger bandwidth percentile (squeeze state),
           breakout side and resting depth-imbalance spikes.

Cross-market overlays:

  * high-impact event blackout (only when the caller supplies real event
    timestamps - nothing is invented from a calendar we do not have);
  * low-volatility / flat-zone / chop suppression evidence.

The module never lowers the 98% thermal gate and never produces a direction.
Its output is a diagnostic profile consumed by ``bayesian_ensemble`` and the
terminal.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

from app.services.asset_class import (
    ASSET_CLASS_CRYPTO,
    ASSET_CLASS_OTC,
    ASSET_CLASS_REAL,
    resolve_asset_class,
)
from app.services.microstructure import (
    _wilder_atr,
    analyze_tick_stream,
    compute_tick_velocity_series,
)

EPS = 1e-12

REGIME_TREND = "trend"
REGIME_RANGE = "range"
REGIME_REVERSAL = "reversal"
REGIME_EXPANSION = "expansion"
REGIME_COMPRESSION = "compression"

SESSION_ASIA = "asia"
SESSION_LONDON = "london"
SESSION_OVERLAP = "london_newyork_overlap"
SESSION_NEW_YORK = "new_york"
SESSION_LATE = "late"

# Liquidity multipliers are relative units, not probabilities. They scale the
# weight of microstructure evidence, not the direction itself.
SESSION_LIQUIDITY: Dict[str, float] = {
    SESSION_ASIA: 0.70,
    SESSION_LONDON: 1.00,
    SESSION_OVERLAP: 1.30,
    SESSION_NEW_YORK: 1.10,
    SESSION_LATE: 0.55,
}


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    if not np.isfinite(value):
        return 0.0
    return float(np.clip(value, low, high))


def _round(value: Optional[float], digits: int = 6) -> Optional[float]:
    if value is None:
        return None
    fvalue = float(value)
    if not np.isfinite(fvalue):
        return None
    return round(fvalue, digits)


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _ensure_utc(moment: Optional[datetime]) -> datetime:
    if moment is None:
        return _utc_now()
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def _parse_event_time(value: Any) -> Optional[datetime]:
    """Accept ISO-8601 strings, epoch seconds or epoch milliseconds."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return _ensure_utc(value)
    if isinstance(value, (int, float, np.integer, np.floating)):
        try:
            raw = float(value)
        except (OverflowError, TypeError, ValueError):
            return None
        if not np.isfinite(raw):
            return None
        seconds = raw / 1000.0 if raw > 1e11 else raw
        try:
            return datetime.fromtimestamp(seconds, tz=UTC)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
        return _ensure_utc(parsed)
    return None


def evaluate_event_blackout(
    now: Optional[datetime],
    event_times: Optional[Sequence[Any]],
    *,
    before_minutes: int = 15,
    after_minutes: int = 15,
) -> Dict[str, Any]:
    """Suppress predictions around real high-impact events supplied by callers.

    ``event_times`` must contain genuine event timestamps. When it is absent
    the result is explicitly ``available: False`` - the engine does not
    fabricate a news calendar.
    """
    if event_times is None:
        return {
            "available": False,
            "active": False,
            "reason": "no_event_calendar_supplied",
            "minutes_to_event": None,
        }
    try:
        event_items = list(event_times)[:200]
    except TypeError:
        event_items = []
    if not event_items:
        return {
            "available": False,
            "active": False,
            "reason": "no_event_calendar_supplied",
            "minutes_to_event": None,
        }
    current = _ensure_utc(now)
    before = max(0, int(before_minutes))
    after = max(0, int(after_minutes))
    nearest: Optional[Tuple[float, datetime]] = None
    for raw in event_items:
        event = _parse_event_time(raw)
        if event is None:
            continue
        delta_min = (event - current).total_seconds() / 60.0
        if nearest is None or abs(delta_min) < abs(nearest[0]):
            nearest = (delta_min, event)
        if -after <= delta_min <= before:
            return {
                "available": True,
                "active": True,
                "reason": "high_impact_event_window",
                "minutes_to_event": _round(delta_min, 1),
                "event_time": event.isoformat(),
            }
    if nearest is None:
        return {
            "available": False,
            "active": False,
            "reason": "no_parseable_event_times",
            "minutes_to_event": None,
        }
    return {
        "available": True,
        "active": False,
        "reason": "outside_event_window",
        "minutes_to_event": _round(nearest[0], 1),
        "event_time": nearest[1].isoformat(),
    }


# ---------------------------------------------------------------------------
# Shared feature helpers
# ---------------------------------------------------------------------------
def _efficiency_ratio(closes: np.ndarray, window: int = 30) -> float:
    tail = closes[-min(len(closes), window) :]
    if len(tail) < 2:
        return 0.0
    path = float(np.sum(np.abs(np.diff(tail))))
    return abs(float(tail[-1] - tail[0])) / max(path, EPS)


def _atr_percentile(atr_pct: np.ndarray, window: int = 120) -> float:
    hist = atr_pct[-min(len(atr_pct), window) :]
    if len(hist) == 0:
        return 0.5
    if float(np.ptp(hist)) <= EPS:
        # A constant volatility history has no rank; 0.5 is neutral instead of
        # falsely reporting the 100th percentile (which used to read as
        # "expansion" on a flat tape).
        return 0.5
    return float(np.mean(hist <= hist[-1]))


def _directional_bias(closes: np.ndarray, atr: float) -> float:
    tail = closes[-min(len(closes), 20) :]
    if len(tail) < 3:
        return 0.0
    x = np.arange(len(tail), dtype=np.float64)
    slope = float(np.polyfit(x, tail, 1)[0])
    scale = max(atr, float(np.mean(tail)) * 1e-5, EPS)
    return _clamp(slope / scale * 3.0)


def _classify_regime(
    efficiency: float,
    atr_percentile: float,
    reversal_ratio: float,
    compression: bool,
) -> str:
    if compression and atr_percentile <= 0.30:
        return REGIME_COMPRESSION
    if atr_percentile >= 0.80 and efficiency >= 0.30:
        return REGIME_EXPANSION
    if reversal_ratio >= 0.60 and efficiency < 0.35:
        return REGIME_REVERSAL
    if efficiency >= 0.32:
        return REGIME_TREND
    return REGIME_RANGE


def _bollinger_state(closes: np.ndarray, window: int = 20) -> Dict[str, Any]:
    if len(closes) < window + 2:
        return {
            "available": False,
            "reason": "insufficient_history",
        }
    w = min(window, len(closes))
    windows = np.lib.stride_tricks.sliding_window_view(closes, w)
    means = windows.mean(axis=1)
    stds = windows.std(axis=1)
    bandwidth = 2.0 * stds / np.maximum(means, EPS)
    if len(bandwidth) and float(bandwidth[-1]) <= EPS:
        percentile = 0.0
    else:
        percentile = float(np.mean(bandwidth <= bandwidth[-1])) if len(bandwidth) else 0.5
    mean_last = float(means[-1])
    std_last = float(stds[-1])
    upper = mean_last + 2.0 * std_last
    lower = mean_last - 2.0 * std_last
    close = float(closes[-1])
    position = (close - lower) / max(upper - lower, EPS)
    return {
        "available": True,
        "window": w,
        "bandwidth": _round(float(bandwidth[-1]), 6) or 0.0,
        "bandwidth_percentile": _round(percentile, 3) or 0.0,
        "squeeze": bool(std_last <= EPS or percentile <= 0.20),
        "percent_b": _round(_clamp(position, 0.0, 1.0), 4) or 0.0,
        "breakout": "up" if close > upper else ("down" if close < lower else "none"),
    }


def _markov_direction(closes: np.ndarray) -> Dict[str, Any]:
    """First-order Markov chain over down/flat/up bar directions."""
    if len(closes) < 6:
        return {"available": False, "reason": "insufficient_history"}
    deltas = np.diff(closes)
    tol = max(float(np.mean(np.abs(deltas))), EPS) * 0.05
    states = np.where(deltas > tol, 2, np.where(deltas < -tol, 0, 1))
    counts = np.ones((3, 3), dtype=np.float64)  # Laplace smoothing
    if len(states) > 1:
        transition_idx = states[:-1] * 3 + states[1:]
        counts += np.bincount(transition_idx, minlength=9).reshape(3, 3)
    probs = counts / counts.sum(axis=1, keepdims=True)
    last_state = int(states[-1])
    persistence = float(np.trace(probs) / 3.0)
    reversal = float((probs[last_state, 2] if last_state == 0 else 0.0) + (probs[last_state, 0] if last_state == 2 else 0.0))
    return {
        "available": True,
        "last_state": ["down", "flat", "up"][last_state],
        "next_state_probabilities": {
            "down": _round(float(probs[last_state, 0]), 4),
            "flat": _round(float(probs[last_state, 1]), 4),
            "up": _round(float(probs[last_state, 2]), 4),
        },
        "persistence": _round(persistence, 4),
        "reversal_probability": _round(reversal, 4),
        "transition_matrix": [[_round(float(v), 4) for v in row] for row in probs],
    }


def _micro_correlation(closes: np.ndarray) -> Optional[float]:
    if len(closes) < 5:
        return None
    rets = np.diff(closes) / np.maximum(closes[:-1], EPS)
    if len(rets) < 3 or float(np.std(rets)) <= EPS:
        return None
    corr = float(np.corrcoef(rets[:-1], rets[1:])[0, 1])
    if not np.isfinite(corr):
        return None
    return _round(corr, 4)


def _velocity_dynamics(
    tick_prices: Optional[Sequence[float]],
    tick_timestamps: Optional[Sequence[float]],
    now: Optional[datetime],
) -> Dict[str, Any]:
    if tick_prices is None or tick_timestamps is None:
        return {
            "available": False,
            "reason": "tick_timestamps_not_supplied",
        }
    try:
        prices = np.asarray(tick_prices, dtype=np.float64)
        times = np.asarray(tick_timestamps, dtype=np.float64)
    except (TypeError, ValueError):
        return {
            "available": False,
            "reason": "tick_timestamps_not_numeric",
        }
    if (
        len(prices) < 4
        or len(times) != len(prices)
        or not np.all(np.isfinite(prices))
        or not np.all(np.isfinite(times))
    ):
        return {
            "available": False,
            "reason": "insufficient_three_second_windows",
        }
    if not np.all(np.diff(times) > 0):
        return {
            "available": False,
            "reason": "tick_timestamps_not_monotonic",
        }
    current = float(times[-1])
    recent_mask = times >= current - 3.0
    older_mask = (times >= current - 6.0) & (times < current - 3.0)
    if int(np.count_nonzero(recent_mask)) < 2 or int(np.count_nonzero(older_mask)) < 2:
        return {
            "available": False,
            "reason": "insufficient_three_second_windows",
        }
    recent_prices = prices[recent_mask]
    older_prices = prices[older_mask]
    recent_v = (recent_prices[-1] - recent_prices[0]) / max(times[recent_mask][-1] - times[recent_mask][0], EPS)
    older_v = (older_prices[-1] - older_prices[0]) / max(times[older_mask][-1] - times[older_mask][0], EPS)
    accel = (recent_v - older_v) / max(abs(older_v), EPS)
    return {
        "available": True,
        "recent_velocity": _round(float(recent_v)),
        "prior_velocity": _round(float(older_v)),
        "acceleration": _round(_clamp(accel / 3.0)),
        "window_seconds": 3.0,
        "evaluated_at": _ensure_utc(now).isoformat() if now is not None else None,
    }


def _session_profile(now: Optional[datetime]) -> Dict[str, Any]:
    current = _ensure_utc(now)
    hour = current.hour
    if 0 <= hour < 7:
        session = SESSION_ASIA
    elif 7 <= hour < 12:
        session = SESSION_LONDON
    elif 12 <= hour < 16:
        session = SESSION_OVERLAP
    elif 16 <= hour < 21:
        session = SESSION_NEW_YORK
    else:
        session = SESSION_LATE
    return {
        "session": session,
        "utc_hour": hour,
        "liquidity_multiplier": SESSION_LIQUIDITY[session],
    }


def _spread_elasticity(
    bid: Optional[float],
    ask: Optional[float],
    atr: float,
    price: float,
    symbol: str,
) -> Dict[str, Any]:
    if (
        bid is None
        or ask is None
        or not np.isfinite(bid)
        or not np.isfinite(ask)
        or ask <= bid
    ):
        return {
            "available": False,
            "reason": "no_quoted_spread",
        }
    quote = symbol.split("/")[-1].upper() if "/" in symbol else ""
    pip = 0.01 if quote == "JPY" else 0.0001
    spread = float(ask) - float(bid)
    spread_to_atr = spread / max(atr, EPS)
    elasticity = _clamp(spread_to_atr / 0.35, 0.0, 2.0)
    return {
        "available": True,
        "spread": _round(spread, 8),
        "spread_pips": _round(spread / pip, 3),
        "spread_to_atr": _round(spread_to_atr, 4),
        "elasticity": _round(elasticity, 3),
        "wide": bool(elasticity >= 1.0),
    }


def _regime_weight_multipliers(asset_class: str, regime: str) -> Dict[str, float]:
    base = {
        "momentum": 1.0,
        "microstructure": 1.0,
        "order_flow": 1.0,
        "volatility": 1.0,
        "regime": 1.0,
    }
    if asset_class == ASSET_CLASS_OTC:
        base.update({"microstructure": 1.25, "order_flow": 1.10, "volatility": 0.85})
    elif asset_class == ASSET_CLASS_REAL:
        base.update({"order_flow": 1.25, "microstructure": 1.10, "momentum": 0.95})
    elif asset_class == ASSET_CLASS_CRYPTO:
        base.update({"momentum": 1.20, "volatility": 1.15, "microstructure": 0.85})
    if regime == REGIME_TREND:
        base["momentum"] *= 1.15
        base["microstructure"] *= 0.95
    elif regime == REGIME_RANGE:
        base["microstructure"] *= 1.10
        base["momentum"] *= 0.90
    elif regime == REGIME_REVERSAL:
        base["microstructure"] *= 1.20
        base["momentum"] *= 0.85
    elif regime == REGIME_EXPANSION:
        base["volatility"] *= 1.20
        base["momentum"] *= 1.10
    elif regime == REGIME_COMPRESSION:
        base["volatility"] *= 0.75
        base["order_flow"] *= 1.10
    return base


# ---------------------------------------------------------------------------
# Public profiler
# ---------------------------------------------------------------------------
def profile_market_regime(
    *,
    symbol: str,
    candles: Sequence[Dict[str, Any]],
    tick_prices: Optional[Sequence[float]] = None,
    tick_timestamps: Optional[Sequence[float]] = None,
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    bid_depth: Optional[float] = None,
    ask_depth: Optional[float] = None,
    event_times: Optional[Sequence[Any]] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Profile the current market regime and its evidence adjustments."""
    if not candles or len(candles) < 2:
        raise ValueError("profile_market_regime requires >= 2 candles")

    closes = np.asarray([float(c["close"]) for c in candles], dtype=np.float64)
    highs = np.asarray([float(c.get("high", c["close"])) for c in candles], dtype=np.float64)
    lows = np.asarray([float(c.get("low", c["close"])) for c in candles], dtype=np.float64)
    opens = np.asarray([float(c.get("open", c["close"])) for c in candles], dtype=np.float64)
    if not np.all(np.isfinite(closes)) or np.any(closes <= 0):
        raise ValueError("candle closes must be finite and positive")
    if (
        not np.all(np.isfinite(highs))
        or not np.all(np.isfinite(lows))
        or not np.all(np.isfinite(opens))
    ):
        raise ValueError("candle OHLC values must be finite")
    if np.any(highs < lows):
        raise ValueError("candle high must be >= low")

    atr = _wilder_atr(highs, lows, closes)
    atr_last = float(atr[-1]) if len(atr) else 0.0
    atr_pct = atr / np.maximum(closes, EPS)
    atr_percentile = _atr_percentile(atr_pct)
    efficiency = _efficiency_ratio(closes)
    ranges = np.maximum(highs - lows, EPS)
    range_ratio = float(ranges[-1]) / max(float(np.mean(ranges[-min(len(ranges), 20) :])), EPS)
    compression = bool(range_ratio <= 0.55)
    directional_bias = _directional_bias(closes, atr_last)

    comparison_bars = min(len(closes) - 1, 10)
    body_sign = np.sign(closes[-comparison_bars:] - opens[-comparison_bars:])
    trend_sign = np.sign(np.diff(closes)[-comparison_bars:])
    reversal_ratio = float(np.mean(body_sign != trend_sign))
    regime = _classify_regime(efficiency, atr_percentile, reversal_ratio, compression)

    asset_class = resolve_asset_class(symbol)
    session = _session_profile(now)
    news = evaluate_event_blackout(now, event_times)

    features: Dict[str, Any] = {
        "efficiency_ratio": _round(efficiency, 3),
        "atr": _round(atr_last, 8),
        "atr_percentile": _round(atr_percentile, 3),
        "range_ratio": _round(range_ratio, 3),
        "compression": compression,
        "directional_bias": _round(directional_bias, 4),
    }
    adapter: Dict[str, Any] = {}
    if asset_class == ASSET_CLASS_OTC:
        adapter = {
            "markov": _markov_direction(closes),
            "micro_correlation": _micro_correlation(closes),
            "velocity_dynamics": _velocity_dynamics(tick_prices, tick_timestamps, now),
        }
    elif asset_class == ASSET_CLASS_REAL:
        adapter = {
            "session": session,
            "spread": _spread_elasticity(bid, ask, atr_last, float(closes[-1]), symbol),
        }
    elif asset_class == ASSET_CLASS_CRYPTO:
        adapter = {
            "bollinger": _bollinger_state(closes),
            "depth": _depth_state(bid_depth, ask_depth),
        }

    suppression_reasons: List[str] = []
    if atr_last <= EPS or (atr_percentile <= 0.15 and efficiency < 0.10):
        suppression_reasons.append("low_volatility_flat_zone")
    if efficiency < 0.08:
        suppression_reasons.append("chop")
    if news["active"]:
        suppression_reasons.append("event_blackout")
    if asset_class == ASSET_CLASS_REAL and session["liquidity_multiplier"] <= 0.55:
        suppression_reasons.append("illiquid_session")
    spread = adapter.get("spread") if isinstance(adapter, dict) else None
    if isinstance(spread, dict) and spread.get("wide"):
        suppression_reasons.append("wide_spread")

    suppression = {
        "active": bool(suppression_reasons),
        "reasons": suppression_reasons,
    }
    multipliers = _regime_weight_multipliers(asset_class, regime)
    liquidity = session["liquidity_multiplier"] if asset_class == ASSET_CLASS_REAL else 1.0
    return {
        "available": True,
        "symbol": symbol,
        "asset_class": asset_class,
        "regime": regime,
        "directional_bias": _round(directional_bias, 4) or 0.0,
        "features": features,
        "adapter": adapter,
        "session": session,
        "news": news,
        "suppression": suppression,
        "adaptation": {
            "weight_multipliers": {k: _round(v, 3) for k, v in multipliers.items()},
            "liquidity_multiplier": _round(liquidity, 3),
            "suppression_multiplier": 0.0 if suppression["active"] else 1.0,
        },
        "reasoning": _reasoning_text(regime, asset_class, suppression_reasons),
    }


def _depth_state(
    bid_depth: Optional[float],
    ask_depth: Optional[float],
) -> Dict[str, Any]:
    if (
        bid_depth is None
        or ask_depth is None
        or not np.isfinite(bid_depth)
        or not np.isfinite(ask_depth)
        or (bid_depth + ask_depth) <= EPS
    ):
        return {"available": False, "reason": "no_depth_supplied"}
    imbalance = (float(bid_depth) - float(ask_depth)) / (
        float(bid_depth) + float(ask_depth)
    )
    return {
        "available": True,
        "imbalance": _round(_clamp(imbalance), 4),
        "spike": bool(abs(imbalance) >= 0.35),
        "side": "bid" if imbalance > 0 else ("ask" if imbalance < 0 else "flat"),
    }


def _reasoning_text(regime: str, asset_class: str, suppression: List[str]) -> str:
    text = f"{asset_class} tape classified {regime}"
    if suppression:
        text += "; evidence suppressed: " + ", ".join(suppression)
    return text


def profile_price_regime(
    *,
    symbol: str,
    prices: Sequence[float],
    highs: Optional[Sequence[float]] = None,
    lows: Optional[Sequence[float]] = None,
    tick_prices: Optional[Sequence[float]] = None,
    tick_timestamps: Optional[Sequence[float]] = None,
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    bid_depth: Optional[float] = None,
    ask_depth: Optional[float] = None,
    event_times: Optional[Sequence[Any]] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Build a regime profile from a flat live-price stream.

    The OHLC wrapper is derived from REAL closes/highs/lows only - no synthetic
    price is inserted. When highs/lows are unavailable the close is used for
    both, which only widens uncertainty (it can never fabricate a wick).
    """
    p = np.asarray(prices, dtype=np.float64)
    if len(p) < 2:
        raise ValueError("profile_price_regime requires >= 2 prices")
    h = np.asarray(highs, dtype=np.float64) if highs is not None and len(highs) == len(p) else p
    l = np.asarray(lows, dtype=np.float64) if lows is not None and len(lows) == len(p) else p
    opens = np.concatenate(([float(p[0])], p[:-1]))
    candles = [
        {
            "open": float(opens[i]),
            "high": float(h[i]),
            "low": float(l[i]),
            "close": float(p[i]),
            "volume": 0.0,
        }
        for i in range(len(p))
    ]
    profile = profile_market_regime(
        symbol=symbol,
        candles=candles,
        # The flat prices are themselves the tick tape when no separate tick
        # series was supplied, so 3-second OTC velocity dynamics stay available
        # to the streaming path instead of reporting a false "not supplied".
        tick_prices=tick_prices if tick_prices is not None else p,
        tick_timestamps=tick_timestamps,
        bid=bid,
        ask=ask,
        bid_depth=bid_depth,
        ask_depth=ask_depth,
        event_times=event_times,
        now=now,
    )
    profile["source"] = "tick_aggregation"
    profile["microstructure"] = analyze_tick_stream(
        p,
        highs=highs,
        lows=lows,
        bid_depth=bid_depth,
        ask_depth=ask_depth,
    )
    return profile
