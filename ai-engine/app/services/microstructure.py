"""Vectorised candle and tick microstructure analytics.

This module is deliberately pure: every function takes REAL observed OHLCV or
tick arrays and returns a JSON-serialisable dictionary. Nothing here invents a
price, a volume or a probability. When an input is unavailable (no quoted book,
no timestamps, no volume) the corresponding field is reported as ``None`` or
marked with an explicit ``*_available: False`` flag instead of being guessed.

The layer is additive to the authoritative confluence gate in
``quant_matrix``. It never changes the direction or the confidence of a
verdict; it supplies auditable diagnostics that the terminal can render:

  * body-range ratio (BRR) and upper/lower wick-range ratio (WRR)
  * strength-reversal index (SRI) on the freshest closed candles
  * rolling liquidity pools and stop-run ("sweep") detection
  * tick velocity, velocity acceleration and momentum divergence
  * order-flow imbalance, aggression and absorption
  * low-volatility / flat-zone / chop suppression evidence

All rolling calculations use NumPy's sliding-window views, so a 30k-candle
series is processed with no Python loop over the tape.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

EPS = 1e-12
DEFAULT_LOOKBACK = 20
DEFAULT_VELOCITY_WINDOW = 30


# ---------------------------------------------------------------------------
# Small numeric helpers
# ---------------------------------------------------------------------------
def _as_array(values: Iterable[float], *, positive: bool = False) -> np.ndarray:
    arr = np.asarray(list(values), dtype=np.float64)
    if arr.size == 0:
        return arr
    if not np.all(np.isfinite(arr)):
        raise ValueError("microstructure inputs must be finite")
    if positive and np.any(arr <= 0):
        raise ValueError("microstructure prices must be positive")
    return arr


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    if not np.isfinite(value):
        return 0.0
    return float(np.clip(value, low, high))


def _round(value: Optional[float], digits: int = 6) -> Optional[float]:
    if value is None:
        return None
    try:
        fvalue = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(fvalue):
        return None
    return round(fvalue, digits)


def _safe_div(numerator: np.ndarray | float, denominator: np.ndarray | float) -> np.ndarray:
    return np.divide(
        numerator,
        denominator,
        out=np.zeros_like(np.asarray(numerator, dtype=np.float64)),
        where=np.asarray(denominator, dtype=np.float64) > EPS,
    )


def _wilder_atr(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    period: int = 14,
) -> np.ndarray:
    """Simple rolling ATR used only as a normaliser for microstructure fields.

    The authoritative Wilder ATR for the trading verdict still comes from
    ``quant_matrix.compute_atr_series``. This local helper keeps the
    microstructure module import-cycle free and is vectorised via cumulative
    sums.
    """
    n = len(closes)
    if n == 0:
        return np.zeros(0, dtype=np.float64)
    p = max(1, min(int(period), n))
    prev_close = np.empty(n, dtype=np.float64)
    prev_close[0] = closes[0]
    prev_close[1:] = closes[:-1]
    true_range = np.maximum(
        highs - lows,
        np.maximum(np.abs(highs - prev_close), np.abs(lows - prev_close)),
    )
    if n < p:
        return np.full(n, float(np.mean(true_range)), dtype=np.float64)
    csum = np.concatenate(([0.0], np.cumsum(true_range)))
    rolling = (csum[p:] - csum[:-p]) / float(p)
    atr = np.empty(n, dtype=np.float64)
    atr[: p - 1] = rolling[0]
    atr[p - 1 :] = rolling
    return atr


# ---------------------------------------------------------------------------
# Candle geometry
# ---------------------------------------------------------------------------
def compute_body_metrics(
    opens: Sequence[float],
    closes: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
) -> Dict[str, np.ndarray]:
    """Return per-candle BRR/WRR/close-position arrays in [0, 1]."""
    o = _as_array(opens)
    c = _as_array(closes)
    h = _as_array(highs)
    l = _as_array(lows)
    n = min(len(o), len(c), len(h), len(l))
    if n == 0:
        return {
            "brr": np.zeros(0),
            "wrr_upper": np.zeros(0),
            "wrr_lower": np.zeros(0),
            "close_position": np.zeros(0),
        }
    o, c, h, l = o[-n:], c[-n:], h[-n:], l[-n:]
    span = h - l
    body = np.abs(c - o)
    upper = h - np.maximum(o, c)
    lower = np.minimum(o, c) - l
    close_pos = _safe_div(c - l, span)
    return {
        "brr": _safe_div(body, span),
        "wrr_upper": _safe_div(upper, span),
        "wrr_lower": _safe_div(lower, span),
        "close_position": close_pos,
    }


def compute_brr_wrr(
    opens: Sequence[float],
    closes: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
) -> Dict[str, float]:
    """Last-candle body-range and wick-range ratios (BRR / upper / lower WRR)."""
    metrics = compute_body_metrics(opens, closes, highs, lows)
    if len(metrics["brr"]) == 0:
        return {"brr": 0.0, "wrr_upper": 0.0, "wrr_lower": 0.0}
    return {
        "brr": _round(metrics["brr"][-1]) or 0.0,
        "wrr_upper": _round(metrics["wrr_upper"][-1]) or 0.0,
        "wrr_lower": _round(metrics["wrr_lower"][-1]) or 0.0,
    }


def compute_strength_reversal_index(
    opens: Sequence[float],
    closes: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
    window: int = 3,
) -> float:
    """Signed reversal pressure from wick rejection and close location.

    Positive values indicate lower-wick rejection (a bullish reversal cue),
    negative values indicate upper-wick rejection. The index is bounded to
    [-1, +1] and averaged over the freshest ``window`` candles.
    """
    metrics = compute_body_metrics(opens, closes, highs, lows)
    if len(metrics["brr"]) == 0:
        return 0.0
    w = max(1, min(int(window), len(metrics["brr"])))
    wick_bias = metrics["wrr_lower"][-w:] - metrics["wrr_upper"][-w:]
    close_bias = (metrics["close_position"][-w:] - 0.5) * 2.0
    score = float(np.mean(wick_bias * 1.25 + close_bias * 0.75))
    return _round(_clamp(score)) or 0.0


# ---------------------------------------------------------------------------
# Liquidity pools and sweeps
# ---------------------------------------------------------------------------
def _rolling_prior_extrema(
    highs: np.ndarray,
    lows: np.ndarray,
    lookback: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """Rolling max high / min low over the PRIOR ``lookback`` bars.

    Element ``i`` uses bars ``[i - lookback, i)`` so the current bar can never
    define its own pool. Early bars are left as NaN and treated as "no pool".
    """
    n = len(highs)
    prior_max = np.full(n, np.nan, dtype=np.float64)
    prior_min = np.full(n, np.nan, dtype=np.float64)
    if n <= lookback:
        return prior_max, prior_min
    hi_win = np.lib.stride_tricks.sliding_window_view(highs, lookback)
    lo_win = np.lib.stride_tricks.sliding_window_view(lows, lookback)
    prior_max[lookback:] = hi_win[: n - lookback].max(axis=1)
    prior_min[lookback:] = lo_win[: n - lookback].min(axis=1)
    return prior_max, prior_min


def detect_liquidity_sweeps(
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    lookback: int = DEFAULT_LOOKBACK,
) -> Dict[str, Any]:
    """Detect stop-runs above prior highs / below prior lows that close back.

    A sweep is a genuine wick beyond a resting pool followed by a close back
    inside it. The flags are vectorised; only the compact pool list uses a
    bounded Python loop over at most ``pool_scan`` bars.
    """
    h = _as_array(highs)
    l = _as_array(lows)
    c = _as_array(closes)
    n = min(len(h), len(l), len(c))
    if n < 2:
        return {
            "available": False,
            "reason": "insufficient_history",
            "sweep_high": False,
            "sweep_low": False,
            "pools": [],
        }
    h, l, c = h[-n:], l[-n:], c[-n:]
    lb = max(2, min(int(lookback), n - 1))
    prior_max, prior_min = _rolling_prior_extrema(h, l, lb)
    valid = ~np.isnan(prior_max)

    sweep_high_mask = valid & (h > prior_max) & (c < prior_max)
    sweep_low_mask = valid & (l < prior_min) & (c > prior_min)

    span = np.maximum(h - l, EPS)
    high_strength = np.where(
        sweep_high_mask,
        (h - np.maximum(c, np.nan_to_num(prior_max))) / span,
        0.0,
    )
    low_strength = np.where(
        sweep_low_mask,
        (np.minimum(c, np.nan_to_num(prior_min)) - l) / span,
        0.0,
    )

    last_sweep = "none"
    strength = 0.0
    if bool(sweep_high_mask[-1]):
        last_sweep = "high"
        strength = float(high_strength[-1])
    elif bool(sweep_low_mask[-1]):
        last_sweep = "low"
        strength = float(low_strength[-1])

    if n > lb:
        recent_hi = int(np.count_nonzero(sweep_high_mask[-min(n, 20) :]))
        recent_lo = int(np.count_nonzero(sweep_low_mask[-min(n, 20) :]))
    else:
        recent_hi = recent_lo = 0

    atr = _wilder_atr(h, l, c)
    atr_last = float(atr[-1]) if len(atr) else 0.0
    pools = _extract_pools(h, l, c, atr_last, scan=min(n, 120), limit=10)

    return {
        "available": True,
        "lookback": lb,
        "sweep_high": bool(sweep_high_mask[-1]),
        "sweep_low": bool(sweep_low_mask[-1]),
        "last_sweep": last_sweep,
        "sweep_strength": _round(_clamp(strength, 0.0, 1.0)) or 0.0,
        "sweeps_high_recent": recent_hi,
        "sweeps_low_recent": recent_lo,
        "pool_high": _round(prior_max[-1]) if valid[-1] else None,
        "pool_low": _round(prior_min[-1]) if valid[-1] else None,
        "pools": pools,
    }


def _extract_pools(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    atr: float,
    *,
    scan: int,
    limit: int,
) -> List[Dict[str, Any]]:
    """Locate the nearest unswept swing highs/lows for a heatmap surface."""
    n = len(highs)
    start = max(1, n - int(scan))
    end = n - 1
    found: List[Tuple[float, str, int]] = []
    for i in range(start, end):
        if highs[i] > highs[i - 1] and highs[i] >= highs[i + 1]:
            found.append((float(highs[i]), "high", i))
        if lows[i] < lows[i - 1] and lows[i] <= lows[i + 1]:
            found.append((float(lows[i]), "low", i))
    if not found:
        return []
    last_close = float(closes[-1])
    tolerance = max(atr * 0.25, last_close * 1e-6)
    selected = sorted(found, key=lambda item: abs(item[0] - last_close))[:limit]
    pools: List[Dict[str, Any]] = []
    for level, side, idx in selected:
        if side == "high":
            swept = bool(np.any(highs[idx + 1 :] > level))
        else:
            swept = bool(np.any(lows[idx + 1 :] < level))
        touches = int(np.sum(np.abs((highs if side == "high" else lows)[idx + 1 :] - level) <= tolerance))
        pools.append(
            {
                "price": _round(level),
                "side": side,
                "distance_atr": _round(abs(level - last_close) / max(atr, EPS), 3),
                "touches": touches,
                "swept": swept,
            }
        )
    pools.sort(key=lambda p: (p["side"], abs((p["price"] or 0.0) - last_close)))
    return pools


# ---------------------------------------------------------------------------
# Tick velocity / momentum
# ---------------------------------------------------------------------------
def compute_tick_velocity_series(
    prices: Sequence[float],
    timestamps: Optional[Sequence[float]] = None,
) -> Tuple[np.ndarray, str]:
    """Price velocity per second (real clock) or per tick (no clock supplied)."""
    p = _as_array(prices, positive=True)
    if len(p) < 2:
        return np.zeros(0, dtype=np.float64), "insufficient_history"
    dp = np.diff(p)
    units = "per_tick"
    if timestamps is not None and len(timestamps) == len(p):
        t = _as_array(timestamps)
        dt = np.diff(t)
        if np.all(dt > 0):
            dp = dp / dt
            units = "per_second"
    return dp, units


def compute_velocity_metrics(
    prices: Sequence[float],
    timestamps: Optional[Sequence[float]] = None,
    tick: Optional[float] = None,
) -> Dict[str, Any]:
    """Velocity, acceleration and decay over the freshest tick window."""
    p = _as_array(prices, positive=True)
    if tick is not None and np.isfinite(tick) and tick > 0:
        if len(p) == 0 or float(tick) != float(p[-1]):
            p = np.append(p, float(tick))
    if len(p) < 3:
        return {
            "available": False,
            "reason": "insufficient_history",
            "velocity": 0.0,
            "acceleration": 0.0,
            "decay": 0.0,
            "units": "unavailable",
        }
    velocity, units = compute_tick_velocity_series(p, timestamps)
    if len(velocity) < 2:
        return {
            "available": False,
            "reason": "insufficient_history",
            "velocity": 0.0,
            "acceleration": 0.0,
            "decay": 0.0,
            "units": units,
        }
    recent_n = min(3, len(velocity))
    prior_n = min(8, max(len(velocity) - recent_n, 1))
    recent = float(np.mean(velocity[-recent_n:]))
    prior = float(np.mean(velocity[-(recent_n + prior_n) : -recent_n])) if len(velocity) > recent_n else recent
    accel = (recent - prior) / max(abs(prior), EPS)
    decay = (abs(recent) - abs(prior)) / max(abs(prior), EPS)
    return {
        "available": True,
        "velocity": _round(recent),
        "velocity_prior": _round(prior),
        "acceleration": _round(_clamp(accel / 3.0)),
        "decay": _round(_clamp(decay)),
        "units": units,
    }


def detect_momentum_divergence(
    prices: Sequence[float],
    timestamps: Optional[Sequence[float]] = None,
    window: int = 10,
) -> Dict[str, Any]:
    """Price/velocity divergence: a new extreme on fading participation."""
    p = _as_array(prices, positive=True)
    if len(p) < max(5, window + 1):
        return {"available": False, "score": 0.0, "kind": "insufficient_history"}
    velocity, _ = compute_tick_velocity_series(p, timestamps)
    w = max(3, min(int(window), len(velocity)))
    recent_prices = p[-w:]
    recent_velocity = velocity[-w:]
    price_up = float(recent_prices[-1]) >= float(np.max(recent_prices[:-1]))
    price_down = float(recent_prices[-1]) <= float(np.min(recent_prices[:-1]))
    vel_peak = float(np.max(np.abs(recent_velocity[:-1]))) if w > 1 else 0.0
    vel_now = float(recent_velocity[-1])
    fading = abs(vel_now) < vel_peak * 0.6
    if price_up and fading:
        return {"available": True, "score": -0.6, "kind": "bearish_divergence"}
    if price_down and fading:
        return {"available": True, "score": 0.6, "kind": "bullish_divergence"}
    return {"available": True, "score": 0.0, "kind": "none"}


# ---------------------------------------------------------------------------
# Order flow
# ---------------------------------------------------------------------------
def compute_order_flow_features(
    closes: Sequence[float],
    volumes: Optional[Sequence[float]] = None,
    bid_depth: Optional[float] = None,
    ask_depth: Optional[float] = None,
) -> Dict[str, Any]:
    """Signed aggression and resting depth imbalance from real observations."""
    c = _as_array(closes, positive=True)
    n = len(c)
    if n < 2:
        return {
            "available": False,
            "reason": "insufficient_history",
            "aggression": 0.0,
            "depth_imbalance": None,
        }
    deltas = np.diff(c)
    up = deltas > 0
    down = deltas < 0
    source = "tick_count"
    if volumes is not None:
        v = _as_array(volumes)
        if len(v) == n and np.all(v >= 0) and float(np.sum(v)) > EPS:
            signed = v[1:]
            up_mass = float(np.sum(signed[up]))
            down_mass = float(np.sum(signed[down]))
            aggression = (up_mass - down_mass) / max(up_mass + down_mass, EPS)
            source = "volume"
        else:
            aggression = (float(np.count_nonzero(up)) - float(np.count_nonzero(down))) / max(
                float(np.count_nonzero(up) + np.count_nonzero(down)), 1.0
            )
    else:
        aggression = (float(np.count_nonzero(up)) - float(np.count_nonzero(down))) / max(
            float(np.count_nonzero(up) + np.count_nonzero(down)), 1.0
        )

    depth_imbalance: Optional[float] = None
    depth_available = False
    if (
        bid_depth is not None
        and ask_depth is not None
        and np.isfinite(bid_depth)
        and np.isfinite(ask_depth)
        and bid_depth >= 0
        and ask_depth >= 0
        and (bid_depth + ask_depth) > EPS
    ):
        depth_imbalance = (float(bid_depth) - float(ask_depth)) / (
            float(bid_depth) + float(ask_depth)
        )
        depth_available = True

    return {
        "available": True,
        "aggression": _round(_clamp(aggression)) or 0.0,
        "aggression_source": source,
        "depth_imbalance": _round(depth_imbalance) if depth_available else None,
        "depth_available": depth_available,
    }


def compute_absorption(
    opens: Sequence[float],
    closes: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
    volumes: Sequence[float],
) -> Dict[str, Any]:
    """High effort / low result absorption: volume spikes on a compressed body."""
    o = _as_array(opens)
    c = _as_array(closes)
    h = _as_array(highs)
    l = _as_array(lows)
    v = _as_array(volumes)
    n = min(len(o), len(c), len(h), len(l), len(v))
    if n < 6 or float(np.sum(v[-n:])) <= EPS:
        return {"available": False, "absorbed": False, "score": 0.0}
    o, c, h, l, v = o[-n:], c[-n:], h[-n:], l[-n:], v[-n:]
    ranges = np.maximum(h - l, EPS)
    body = np.abs(c - o)
    vol_base = float(np.mean(v[-min(n, 20) : -1])) if n > 1 else float(v[-1])
    range_base = float(np.mean(ranges[-min(n, 20) : -1])) if n > 1 else float(ranges[-1])
    vol_ratio = float(v[-1]) / max(vol_base, EPS)
    body_ratio = float(body[-1]) / max(range_base, EPS)
    absorbed = bool(vol_ratio >= 1.4 and body_ratio <= 0.6)
    score = 0.0
    if absorbed:
        score = _clamp((vol_ratio - 1.4) * 0.5 + (0.6 - body_ratio), 0.0, 1.0)
    return {
        "available": True,
        "absorbed": absorbed,
        "score": _round(score) or 0.0,
        "volume_ratio": _round(vol_ratio, 3),
        "body_ratio": _round(body_ratio, 3),
    }


# ---------------------------------------------------------------------------
# Public aggregate: candles
# ---------------------------------------------------------------------------
def analyze_candle_microstructure(
    candles: Sequence[Dict[str, Any]],
    *,
    tick: Optional[float] = None,
    bid_depth: Optional[float] = None,
    ask_depth: Optional[float] = None,
    tick_prices: Optional[Sequence[float]] = None,
    tick_timestamps: Optional[Sequence[float]] = None,
) -> Dict[str, Any]:
    """Aggregate every microstructure signal from REAL candles and ticks."""
    if not candles or len(candles) < 2:
        raise ValueError("analyze_candle_microstructure requires >= 2 candles")

    def _col(name: str, fallback: Optional[str] = None) -> np.ndarray:
        values = []
        for candle in candles:
            raw = candle.get(name, candle.get(fallback) if fallback else 0.0)
            values.append(float(raw if raw is not None else 0.0))
        return np.asarray(values, dtype=np.float64)

    opens = _col("open", "close")
    closes = _col("close")
    highs = _col("high", "close")
    lows = _col("low", "close")
    volumes = _col("volume")
    if not (np.all(np.isfinite(opens)) and np.all(np.isfinite(closes))):
        raise ValueError("non-finite OHLC values")
    if np.any(closes <= 0):
        raise ValueError("candle closes must be positive")

    prices = closes
    effective_tick = tick
    if effective_tick is not None and np.isfinite(effective_tick) and effective_tick > 0:
        prices = np.append(closes, float(effective_tick))

    body = compute_body_metrics(opens, closes, highs, lows)
    sri = compute_strength_reversal_index(opens, closes, highs, lows)
    sweeps = detect_liquidity_sweeps(highs, lows, closes)
    velocity = compute_velocity_metrics(
        tick_prices if tick_prices is not None else prices,
        tick_timestamps,
        tick=None if tick_prices is not None else effective_tick,
    )
    divergence = detect_momentum_divergence(
        tick_prices if tick_prices is not None else prices,
        tick_timestamps,
    )
    flow = compute_order_flow_features(
        prices,
        volumes if float(np.sum(volumes)) > EPS else None,
        bid_depth=bid_depth,
        ask_depth=ask_depth,
    )
    absorption = compute_absorption(opens, closes, highs, lows, volumes)

    atr = _wilder_atr(highs, lows, closes)
    atr_last = float(atr[-1]) if len(atr) else 0.0
    atr_pct = atr / np.maximum(closes, EPS)
    hist = atr_pct[-min(len(atr_pct), 120) :]
    percentile = float(np.mean(hist <= hist[-1])) if len(hist) else 0.5
    closes_tail = closes[-min(len(closes), 30) :]
    total_move = float(np.sum(np.abs(np.diff(closes_tail)))) if len(closes_tail) > 1 else 0.0
    efficiency = abs(float(closes_tail[-1] - closes_tail[0])) / max(total_move, EPS) if len(closes_tail) > 1 else 0.0
    ranges = np.maximum(highs - lows, EPS)
    range_ratio = float(ranges[-1]) / max(float(np.mean(ranges[-min(len(ranges), 20) :])), EPS)
    compression = bool(range_ratio <= 0.55)
    relative_atr = atr_last / max(float(closes[-1]), EPS)
    low_volatility = bool(percentile <= 0.20 or relative_atr <= 1e-5)
    flat_zone = bool(efficiency < 0.12)
    chop = bool(efficiency < 0.20 and percentile < 0.35)

    suppression_reasons: List[str] = []
    if low_volatility and (flat_zone or compression):
        suppression_reasons.append("low_volatility_flat_zone")
    if chop:
        suppression_reasons.append("choppy_tape")
    if absorption["available"] and absorption["absorbed"]:
        suppression_reasons.append("volume_absorption")

    last = len(closes) - 1
    return {
        "available": True,
        "bar_count": len(closes),
        "brr": _round(body["brr"][last]) or 0.0,
        "wrr_upper": _round(body["wrr_upper"][last]) or 0.0,
        "wrr_lower": _round(body["wrr_lower"][last]) or 0.0,
        "close_position": _round(body["close_position"][last]) or 0.0,
        "sri": _round(sri) or 0.0,
        "body_direction": "up" if closes[-1] >= opens[-1] else "down",
        "liquidity": sweeps,
        "velocity": velocity,
        "divergence": divergence,
        "order_flow": flow,
        "absorption": absorption,
        "atr": _round(atr_last, 8) or 0.0,
        "atr_relative": _round(relative_atr, 10) or 0.0,
        "atr_percentile": _round(percentile, 3) or 0.0,
        "efficiency_ratio": _round(efficiency, 3) or 0.0,
        "range_ratio": _round(range_ratio, 3) or 0.0,
        "low_volatility": low_volatility,
        "flat_zone": flat_zone,
        "compression": compression,
        "suppressed": bool(suppression_reasons),
        "suppression_reasons": suppression_reasons,
    }


# ---------------------------------------------------------------------------
# Public aggregate: pure tick stream
# ---------------------------------------------------------------------------
def analyze_tick_stream(
    prices: Sequence[float],
    *,
    tick: Optional[float] = None,
    timestamps: Optional[Sequence[float]] = None,
    highs: Optional[Sequence[float]] = None,
    lows: Optional[Sequence[float]] = None,
    bid_depth: Optional[float] = None,
    ask_depth: Optional[float] = None,
) -> Dict[str, Any]:
    """Microstructure for a flat tick tape (no OHLC/volume required)."""
    p = _as_array(prices, positive=True)
    if len(p) < 2:
        raise ValueError("analyze_tick_stream requires >= 2 prices")
    series = p
    if tick is not None and np.isfinite(tick) and tick > 0:
        series = np.append(p, float(tick))
    velocity = compute_velocity_metrics(series, timestamps)
    divergence = detect_momentum_divergence(series, timestamps)
    flow = compute_order_flow_features(
        series,
        bid_depth=bid_depth,
        ask_depth=ask_depth,
    )
    sweeps: Dict[str, Any] = {
        "available": False,
        "reason": "tick_stream_has_no_wick",
        "sweep_high": False,
        "sweep_low": False,
        "pools": [],
    }
    if highs is not None and lows is not None and len(highs) == len(lows) and len(highs) >= 2:
        sweeps = detect_liquidity_sweeps(highs, lows, series[-len(highs) :])
    returns = np.diff(series) / np.maximum(series[:-1], EPS)
    realized_vol = float(np.std(returns)) if len(returns) else 0.0
    finite_recent = returns[-min(len(returns), 30) :]
    low_vol = bool(len(finite_recent) >= 5 and float(np.std(finite_recent)) <= 1e-6)
    return {
        "available": True,
        "bar_count": len(series),
        "velocity": velocity,
        "divergence": divergence,
        "order_flow": flow,
        "liquidity": sweeps,
        "realized_volatility": _round(realized_vol, 8) or 0.0,
        "low_volatility": low_vol,
        "suppressed": low_vol,
        "suppression_reasons": ["low_volatility_flat_zone"] if low_vol else [],
    }
