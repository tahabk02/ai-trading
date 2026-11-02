from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

EPS = 1e-12
DEFAULT_ATR_PERIOD = 20
DEFAULT_WICK_THRESHOLD = 0.55
BOLLINGER_PERIOD = 20
BOLLINGER_MULTIPLIER = 2.0
MIN_BOLLINGER_SAMPLES = 5
TAPE_RETENTION_MS = 20_000


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _finite_positive(value: Any) -> bool:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return number > 0 and number == number and number not in (float("inf"), float("-inf"))


def compute_wick_metrics(candle: Dict[str, Any]) -> Dict[str, Any]:
    open_ = float(candle.get("open", candle.get("close", 0.0)))
    high = float(candle.get("high", open_))
    low = float(candle.get("low", open_))
    close = float(candle.get("close", open_))
    span = high - low
    if not span > EPS:
        return {
            "upperWickRatio": 0.0,
            "lowerWickRatio": 0.0,
            "bodyRatio": 0.0,
            "range": 0.0,
            "direction": "flat",
        }
    body_top = max(open_, close)
    body_bottom = min(open_, close)
    upper = max(0.0, high - body_top)
    lower = max(0.0, body_bottom - low)
    direction = "up" if close > open_ else ("down" if close < open_ else "flat")
    return {
        "upperWickRatio": _clamp(upper / span, 0.0, 1.0),
        "lowerWickRatio": _clamp(lower / span, 0.0, 1.0),
        "bodyRatio": _clamp(abs(close - open_) / span, 0.0, 1.0),
        "range": span,
        "direction": direction,
    }


def _true_range(candle: Dict[str, Any], previous_close: Optional[float]) -> float:
    high = float(candle.get("high", 0.0))
    low = float(candle.get("low", 0.0))
    if previous_close is None:
        return high - low
    return max(high - low, abs(high - previous_close), abs(low - previous_close))


def compute_atr(candles: Sequence[Dict[str, Any]], period: int = DEFAULT_ATR_PERIOD) -> float:
    usable = [
        candle
        for candle in candles
        if _finite_positive(candle.get("high"))
        and _finite_positive(candle.get("low"))
        and _finite_positive(candle.get("close"))
        and float(candle.get("high")) >= float(candle.get("low"))
    ]
    if not usable:
        return 0.0
    take = max(1, min(period, len(usable)))
    start = len(usable) - take
    total = 0.0
    for index in range(start, len(usable)):
        previous = float(usable[index - 1]["close"]) if index > 0 else None
        total += _true_range(usable[index], previous)
    atr = total / take
    return atr if atr > EPS else 0.0


def compute_bollinger(
    closes: Sequence[float],
    period: int = BOLLINGER_PERIOD,
    multiplier: float = BOLLINGER_MULTIPLIER,
) -> Optional[Dict[str, float]]:
    usable = [float(value) for value in closes if _finite_positive(value)]
    if len(usable) < MIN_BOLLINGER_SAMPLES:
        return None
    take = min(period, len(usable))
    tail = usable[-take:]
    middle = sum(tail) / take
    variance = sum((value - middle) ** 2 for value in tail) / take
    std = variance ** 0.5
    upper = middle + std * multiplier
    lower = middle - std * multiplier
    width = upper - lower
    last = tail[-1]
    return {
        "middle": middle,
        "upper": upper,
        "lower": lower,
        "percentB": _clamp((last - lower) / width, 0.0, 1.0) if width > EPS else 0.5,
        "bandwidthPct": (width / middle) * 100.0 if middle > EPS else 0.0,
        "sampleCount": float(take),
    }


def _to_ms(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number <= 0:
        return None
    return number if number > 1e11 else number * 1000.0


def _normalise_tape(
    tick_prices: Optional[Sequence[Any]],
    tick_timestamps: Optional[Sequence[Any]],
) -> List[Dict[str, float]]:
    if not tick_prices or not tick_timestamps:
        return []
    count = min(len(tick_prices), len(tick_timestamps))
    tape: List[Dict[str, float]] = []
    for index in range(count):
        price = tick_prices[index]
        ts_ms = _to_ms(tick_timestamps[index])
        if ts_ms is None or not _finite_positive(price):
            continue
        tape.append({"tsMs": ts_ms, "price": float(price)})
    tape.sort(key=lambda item: item["tsMs"])
    return tape


def _price_at_or_before(tape: Sequence[Dict[str, float]], target_ms: float) -> Optional[Dict[str, float]]:
    for item in reversed(tape):
        if item["tsMs"] <= target_ms:
            return item
    return None


def compute_velocity(tape: Sequence[Dict[str, float]], atr: float, as_of_ms: float) -> Dict[str, Any]:
    usable = [item for item in tape if item["tsMs"] <= as_of_ms]
    empty = {
        "available": False,
        "delta5": 0.0,
        "delta15": 0.0,
        "velocity5": 0.0,
        "velocity15": 0.0,
        "prior5Velocity": 0.0,
        "acceleration": 0.0,
        "atrNormalizedMove": 0.0,
        "spike": False,
        "decelerating": False,
        "direction": "flat",
        "sampleCount": len(usable),
        "window5s": 0.0,
        "window15s": 0.0,
    }
    if len(usable) < 3:
        return empty
    last = usable[-1]
    window = [item for item in usable if item["tsMs"] >= last["tsMs"] - TAPE_RETENTION_MS]
    if len(window) < 3:
        return {**empty, "sampleCount": len(window)}
    p15 = _price_at_or_before(window, last["tsMs"] - 15_000)
    p5 = _price_at_or_before(window, last["tsMs"] - 5_000)
    p_prior_start = _price_at_or_before(window, last["tsMs"] - 10_000)
    p_prior_end = _price_at_or_before(window, last["tsMs"] - 5_000)
    if p15 is None or p5 is None or p_prior_start is None or p_prior_end is None:
        return {**empty, "sampleCount": len(window)}
    span5 = (last["tsMs"] - p5["tsMs"]) / 1000.0
    span15 = (last["tsMs"] - p15["tsMs"]) / 1000.0
    if span5 < 1.0 or span15 < 1.0:
        return {**empty, "sampleCount": len(window)}
    delta5 = last["price"] - p5["price"]
    delta15 = last["price"] - p15["price"]
    velocity5 = delta5 / span5
    velocity15 = delta15 / span15
    prior_span = (p_prior_end["tsMs"] - p_prior_start["tsMs"]) / 1000.0
    prior_velocity = (
        (p_prior_end["price"] - p_prior_start["price"]) / prior_span
        if prior_span > EPS
        else 0.0
    )
    acceleration = (velocity5 - prior_velocity) / span5
    atr_normalised = abs(delta5) / atr if atr > EPS else 0.0
    spike = atr > EPS and abs(delta5) >= atr * 1.5
    decelerating = (
        abs(prior_velocity) > EPS and abs(velocity5) <= abs(prior_velocity) * 0.6
    ) or (
        abs(velocity5) > EPS
        and acceleration != 0
        and (acceleration > 0) != (velocity5 > 0)
    )
    direction = "up" if delta15 > EPS else ("down" if delta15 < -EPS else "flat")
    return {
        "available": True,
        "delta5": delta5,
        "delta15": delta15,
        "velocity5": velocity5,
        "velocity15": velocity15,
        "prior5Velocity": prior_velocity,
        "acceleration": acceleration,
        "atrNormalizedMove": atr_normalised,
        "spike": spike,
        "decelerating": decelerating,
        "direction": direction,
        "sampleCount": len(window),
        "window5s": span5,
        "window15s": span15,
    }


def _tape_reversal(tape: Sequence[Dict[str, float]], side: str) -> bool:
    if len(tape) < 6:
        return False
    tail = tape[-6:]
    prior_move = tail[2]["price"] - tail[0]["price"]
    recent_move = tail[5]["price"] - tail[3]["price"]
    if side == "upper":
        return prior_move > EPS and recent_move < -EPS
    return prior_move < -EPS and recent_move > EPS


def _boundary_pick(
    side: str,
    resistance: Optional[float],
    support: Optional[float],
    bollinger: Optional[Dict[str, float]],
    candle: Dict[str, Any],
) -> Dict[str, Any]:
    candidates: List[Tuple[str, float]] = []
    if side == "upper":
        if resistance is not None:
            candidates.append(("resistance", resistance))
        if bollinger is not None:
            candidates.append(("bollinger_upper", bollinger["upper"]))
    else:
        if support is not None:
            candidates.append(("support", support))
        if bollinger is not None:
            candidates.append(("bollinger_lower", bollinger["lower"]))
    chosen: Tuple[Optional[str], Optional[float]] = (None, None)
    for kind, level in candidates:
        distance = abs(level - float(candle.get("high" if side == "upper" else "low")))
        if chosen[1] is None or distance < chosen[1]:
            chosen = (kind, distance)
    return {"kind": chosen[0], "distance": chosen[1]}


def _candles_from_tape(tape: Sequence[Dict[str, float]]) -> Tuple[Optional[Dict[str, float]], List[Dict[str, float]]]:
    if len(tape) < 2:
        return None, []
    buckets: Dict[int, List[Dict[str, float]]] = {}
    for item in tape:
        bucket = int(item["tsMs"] // 5000) * 5000
        buckets.setdefault(bucket, []).append(item)
    bars: List[Dict[str, float]] = []
    for bucket in sorted(buckets):
        items = buckets[bucket]
        prices = [item["price"] for item in items]
        bars.append(
            {
                "open": prices[0],
                "high": max(prices),
                "low": min(prices),
                "close": prices[-1],
                "volume": float(len(prices)),
            }
        )
    if not bars:
        return None, []
    return bars[-1], bars[-21:-1]


def detect_intra_candle_pullback(
    forming: Dict[str, Any],
    closed: Sequence[Dict[str, Any]],
    *,
    symbol: str,
    timeframe: str,
    now_ms: float,
    micro_forming: Optional[Dict[str, Any]] = None,
    micro_closed: Optional[Sequence[Dict[str, Any]]] = None,
    tape: Optional[Sequence[Dict[str, float]]] = None,
    wick_threshold: float = DEFAULT_WICK_THRESHOLD,
    atr_period: int = DEFAULT_ATR_PERIOD,
) -> Dict[str, Any]:
    tape = list(tape or [])
    micro_closed = list(micro_closed or [])
    wick = compute_wick_metrics(forming)
    micro_bars = ([*micro_closed, micro_forming] if micro_forming else [])
    atr_bars = micro_bars if len(micro_bars) >= 2 else [*closed, forming]
    atr = compute_atr(atr_bars, atr_period)
    atr_source = "unavailable" if atr <= EPS else ("micro" if len(micro_bars) >= 2 else "forming")
    bollinger_closes = (
        [float(candle.get("close", 0.0)) for candle in closed]
        if closed
        else [float(candle.get("close", 0.0)) for candle in micro_closed]
    ) + [float(forming.get("close", 0.0))]
    bollinger = compute_bollinger(bollinger_closes)
    level_window = list(closed)[-20:] if closed else list(micro_closed)[-20:]
    resistance = max(float(candle["high"]) for candle in level_window) if level_window else None
    support = min(float(candle["low"]) for candle in level_window) if level_window else None
    if resistance is None and support is None and tape:
        last_ts = tape[-1]["tsMs"]
        prior_tape = [item for item in tape if item["tsMs"] <= last_ts - 5_000]
        level_tape = prior_tape if prior_tape else tape[:-1]
        if level_tape:
            resistance = max(item["price"] for item in level_tape)
            support = min(item["price"] for item in level_tape)
    close = float(forming.get("close", 0.0))
    high = float(forming.get("high", close))
    low = float(forming.get("low", close))
    tolerance = max(atr * 0.25, close * 1e-5)
    at_upper = (
        resistance is not None and high >= resistance - tolerance
    ) or (
        bollinger is not None and high >= bollinger["upper"] - tolerance
    )
    at_lower = (
        support is not None and low <= support + tolerance
    ) or (
        bollinger is not None and low <= bollinger["lower"] + tolerance
    )
    upper_alert = at_upper and float(wick["upperWickRatio"]) > wick_threshold
    lower_alert = at_lower and float(wick["lowerWickRatio"]) > wick_threshold
    if upper_alert and (not lower_alert or float(wick["upperWickRatio"]) >= float(wick["lowerWickRatio"])):
        side: Optional[str] = "upper"
    elif lower_alert:
        side = "lower"
    else:
        side = None
    picked = (
        _boundary_pick(side, resistance, support, bollinger, forming)
        if side is not None
        else {"kind": None, "distance": None}
    )
    velocity = compute_velocity(tape, atr, now_ms)
    micro_wick = compute_wick_metrics(micro_forming) if micro_forming else None
    micro_near_upper = bool(
        micro_forming
        and (
            (resistance is not None and float(micro_forming.get("high", 0.0)) >= resistance - tolerance)
            or (bollinger is not None and float(micro_forming.get("high", 0.0)) >= bollinger["upper"] - tolerance)
        )
    )
    micro_near_lower = bool(
        micro_forming
        and (
            (support is not None and float(micro_forming.get("low", 0.0)) <= support + tolerance)
            or (bollinger is not None and float(micro_forming.get("low", 0.0)) <= bollinger["lower"] + tolerance)
        )
    )
    if side == "upper":
        micro_rejection = micro_near_upper and (
            float((micro_wick or {}).get("upperWickRatio", 0.0)) >= 0.4
            or float(micro_forming.get("close", 0.0)) < float(micro_forming.get("open", 0.0))
        )
    elif side == "lower":
        micro_rejection = micro_near_lower and (
            float((micro_wick or {}).get("lowerWickRatio", 0.0)) >= 0.4
            or float(micro_forming.get("close", 0.0)) > float(micro_forming.get("open", 0.0))
        )
    else:
        micro_rejection = False
    reversal = _tape_reversal(tape, side) if side else False
    micro_validated = bool(micro_rejection or reversal)
    rejection_direction = "upper" if velocity["direction"] == "up" else ("lower" if velocity["direction"] == "down" else None)
    directional_exhaustion = side is not None and rejection_direction == side
    alert = side is not None
    triggered = bool(alert and directional_exhaustion and velocity["spike"] and velocity["decelerating"])
    signal = (
        ("PUT" if side == "upper" else "CALL")
        if triggered and micro_validated
        else None
    )
    ratio = float(wick["upperWickRatio"] if side == "upper" else wick["lowerWickRatio"])
    ratio_norm = _clamp((ratio - wick_threshold) / max(1.0 - wick_threshold, EPS), 0.0, 1.0) if side else 0.0
    spike_norm = _clamp(float(velocity["atrNormalizedMove"]) / 3.0, 0.0, 1.0)
    score = _clamp(
        0.35 * ratio_norm
        + 0.25 * (1.0 if velocity["spike"] else 0.0)
        + 0.20 * (1.0 if velocity["decelerating"] else 0.0)
        + 0.20 * (1.0 if micro_validated else 0.0),
        0.0,
        1.0,
    )
    confidence = (
        0.0
        if signal is None
        else round(
            _clamp(
                55.0 + 30.0 * ratio_norm + 10.0 * spike_norm + 5.0 * (1.0 if micro_validated else 0.0),
                0.0,
                96.5,
            ),
            2,
        )
    )
    tier_eligible = bool(signal is not None and score >= 0.7 and confidence >= 70.0)
    entry_timing = "now" if signal else ("wait" if alert and velocity["spike"] else "none")
    entry_price = high if side == "upper" else (low if side == "lower" else None)
    if alert and not directional_exhaustion:
        reason = "wick_rejection_without_exhaustion"
    elif alert and not velocity["spike"]:
        reason = "wick_rejection_without_velocity_spike"
    elif alert and not velocity["decelerating"]:
        reason = "velocity_not_decelerating"
    elif alert and not micro_validated:
        reason = "micro_timeframe_not_validated"
    elif signal:
        reason = "wick_rejection_exhaustion_pullback"
    elif alert:
        reason = "pullback_setup_not_confirmed"
    else:
        reason = "no_boundary_wick_rejection"
    return {
        "available": True,
        "symbol": symbol,
        "timeframe": timeframe,
        "generatedAtMs": now_ms,
        "forming": {
            "open": float(forming.get("open", close)),
            "high": high,
            "low": low,
            "close": close,
            "range": high - low,
            "direction": wick["direction"],
        },
        "wick": wick,
        "atr": atr,
        "atrTimeframe": "S5" if atr_source == "micro" else timeframe,
        "atrSource": atr_source,
        "boundaries": {
            "support": support,
            "resistance": resistance,
            "bollingerUpper": bollinger["upper"] if bollinger else None,
            "bollingerMiddle": bollinger["middle"] if bollinger else None,
            "bollingerLower": bollinger["lower"] if bollinger else None,
            "tolerance": tolerance,
            "boundaryKind": picked["kind"],
            "distanceToBoundary": picked["distance"],
        },
        "velocity": velocity,
        "exhaustion": {
            "detected": bool(directional_exhaustion and velocity["spike"] and velocity["decelerating"]),
            "side": side,
            "direction": velocity["direction"],
            "spike": bool(velocity["spike"]),
            "decelerating": bool(velocity["decelerating"]),
            "atrNormalizedMove": float(velocity["atrNormalizedMove"]),
        },
        "wickRejection": {
            "alert": alert,
            "side": side,
            "wickRatio": ratio,
            "threshold": wick_threshold,
            "nearBoundary": alert,
            "boundaryKind": picked["kind"],
        },
        "pullback": {
            "signal": signal,
            "side": side,
            "confidence": confidence,
            "score": round(score, 4),
            "entryTiming": entry_timing,
            "entryPrice": entry_price,
            "tierEligible": tier_eligible,
            "m1Pullback": bool(side is not None and timeframe.upper() == "M1"),
            "reason": reason,
        },
        "confluence": {
            "microValidated": micro_validated,
            "microRejection": bool(micro_rejection),
            "tapeReversal": bool(reversal),
            "microTimeframe": "S5",
            "timeframe": timeframe,
            "score": round(score, 4),
            "tierEligible": tier_eligible,
        },
    }


def build_intra_candle_features(
    candles: Optional[Sequence[Dict[str, Any]]] = None,
    *,
    symbol: str = "",
    timeframe: str = "M1",
    core_features: Optional[Dict[str, Any]] = None,
    tick_prices: Optional[Sequence[Any]] = None,
    tick_timestamps: Optional[Sequence[Any]] = None,
    live_price: Optional[float] = None,
) -> Dict[str, Any]:
    if isinstance(core_features, dict):
        if core_features.get("available") and isinstance(core_features.get("pullback"), dict):
            return core_features
    prices = [float(value) for value in (tick_prices or []) if _finite_positive(value)]
    tape = _normalise_tape(tick_prices, tick_timestamps)
    micro_forming: Optional[Dict[str, Any]] = None
    micro_closed: List[Dict[str, Any]] = []
    if tape:
        micro_forming, micro_closed = _candles_from_tape(tape)
    bars = [
        {
            "open": float(candle.get("open", candle.get("close", 0.0))),
            "high": float(candle.get("high", candle.get("close", 0.0))),
            "low": float(candle.get("low", candle.get("close", 0.0))),
            "close": float(candle.get("close", 0.0)),
            "volume": float(candle.get("volume", 0.0) or 0.0),
        }
        for candle in (candles or [])
        if _finite_positive(candle.get("close"))
    ]
    if bars:
        forming = bars[-1]
        closed = bars[:-1]
    elif prices:
        forming = {
            "open": prices[0],
            "high": max(prices),
            "low": min(prices),
            "close": live_price if _finite_positive(live_price) else prices[-1],
            "volume": float(len(prices)),
        }
        closed = []
    else:
        return {
            "available": False,
            "reason": "no_real_intra_candle_input",
            "symbol": symbol,
            "timeframe": timeframe,
        }
    now_ms = tape[-1]["tsMs"] if tape else 0.0
    return detect_intra_candle_pullback(
        forming,
        closed,
        symbol=symbol,
        timeframe=timeframe,
        now_ms=now_ms,
        micro_forming=micro_forming,
        micro_closed=micro_closed,
        tape=tape,
    )


def apply_pullback_confidence(
    score: float,
    intra: Optional[Dict[str, Any]],
    direction: str,
) -> Tuple[float, float]:
    if not isinstance(intra, dict) or not intra.get("available"):
        return score, 0.0
    pullback = intra.get("pullback")
    if not isinstance(pullback, dict):
        return score, 0.0
    signal = pullback.get("signal")
    if signal not in ("CALL", "PUT") or not pullback.get("tierEligible"):
        return score, 0.0
    expected = "BUY" if signal == "CALL" else "SELL"
    if direction != expected:
        return score, 0.0
    confidence = float(pullback.get("confidence", 0.0) or 0.0)
    boosted = min(96.5, max(float(score), confidence))
    return boosted, boosted - float(score)


def apply_pullback_projection(
    intra: Optional[Dict[str, Any]],
    direction: str,
    current_price: float,
    atr: float,
    digits: int,
    default_target: float,
    default_distance: float,
) -> Tuple[float, float, Optional[float], Optional[str]]:
    if not isinstance(intra, dict) or not intra.get("available"):
        return default_target, default_distance, None, None
    pullback = intra.get("pullback")
    if not isinstance(pullback, dict):
        return default_target, default_distance, None, None
    signal = pullback.get("signal")
    if signal not in ("CALL", "PUT") or pullback.get("entryTiming") != "now":
        return default_target, default_distance, None, pullback.get("entryTiming")
    expected = "BUY" if signal == "CALL" else "SELL"
    if direction != expected or not pullback.get("tierEligible"):
        return default_target, default_distance, None, pullback.get("entryTiming")
    entry = float(pullback.get("entryPrice") or current_price)
    distance = max(float(atr) * 0.35, current_price * 0.0002)
    target = current_price + distance if direction == "BUY" else current_price - distance
    return round(target, digits), round(distance, digits), round(entry, digits), "now"
