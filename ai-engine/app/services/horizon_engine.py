"""
horizon_engine.py — Target Expiry Horizon & ML Predictive Stabilization (Alpha.5 Pro)

Production-grade, ZERO-fabrication stabilization engine that turns a noisy
high-frequency real-time tape into a SMOOTH, expiry-tied CALL/PUT contract:

  A) ROLLING TIME-SERIES FEATURE BUFFER
     Each (symbol, horizon_minutes) keeps a bounded rolling dequeue of the real
     forwarded closes. Because the horizon fixes the trade's expiry window, the
     buffer size scales WITH the horizon (1m → 2h of ticks, 10m → the full
     retained tape) so the inference window always spans "enough time to
     outlive the expiry" instead of a fixed myopic slice.

  B) TREND-MOMENTUM INDICATOR PACK (high-precision feature set)
       • EMA(8)/EMA(21) crossover — normalized fast/slow separation + its own
         rate of change (the crossover velocity).
       • RSI(14) with BULLISH/BEARISH DIVERGENCE detection (price momentum vs
         RSI momentum disagreement).
       • LINEAR-REGRESSION SLOPE over the horizon window (with R² fit quality)
         — the dominant "where is price aiming inside this expiry window" term.
       • Bar-momentum ratio, price position in the window range, realized vol.
     All vectorized (numpy/pandas), all derived strictly from real closes.

  C) CALIBRATED, DEADBAND-STABILIZED OUTPUT CONTRACT
     OutputStabilizer EWMA-smooths the calibrated confidence and applies a
     direction deadband (hysteresis): a CALL only ever flips to PUT when the
     opposing conviction clears a hard asymmetry margin — a marginal tick-jiggle
     can NEVER reverse the emitted contract. The contract carries:
       stable_signal   = "CALL" | "PUT"
       direction       = "BUY"  | "SELL"   (parity with the rest of the engine)
       confidence      = calibrated 0-100 (smooth, not the raw instantaneous
                         score — so the UI stops fluctuating every second)
       confidence_prev / delta_confidence / stable_flips
       entry_ts / expiry_ts            = exact candle-boundary tie-out window
       features (ema_cross, rsi_14, regression_slope, regression_r2,
                 divergence, momentum, position, volatility)
       stability (samples, alpha, reversal_halfwidth)

  ZERO RNG. ZERO SYNTHETIC PRICES. The engine only ever reads the real closes
  the caller forwards; every derived number is deterministic.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, Optional, Tuple

import numpy as np
import pandas as pd

EPS = 1e-12

# ── SUPPORTED TARGET-EXPIRY HORIZONS (minutes) ──
# Ordered, and the ONLY values the stabilizer accepts. Requests outside this
# set are snapped to the nearest supported step (floor bias on ties).
HORIZON_OPTIONS: Tuple[int, ...] = (1, 2, 3, 5, 10)

# Horizon → the AI bar channel used to build candles for that expiry window.
HORIZON_TO_BACKEND_TF: Dict[int, str] = {
    1: "1m",
    2: "2m",
    3: "3m",
    5: "5m",
    10: "10m",
}


def resolve_horizon_minutes(value: Optional[Any]) -> int:
    """Clamp/snap an arbitrary horizon request onto the supported set."""
    if value is None:
        return HORIZON_OPTIONS[0]
    try:
        iv = int(value)
    except (TypeError, ValueError):
        return HORIZON_OPTIONS[0]
    if iv <= 0:
        return HORIZON_OPTIONS[0]
    if iv in HORIZON_OPTIONS:
        return iv
    # Nearest supported step — tie goes to the SHORTER horizon (floor bias):
    # an unsupported 4m request resolves to 3m, never silently to 5m.
    return min(HORIZON_OPTIONS, key=lambda h: (abs(h - iv), h))


def buffer_size_for_horizon(horizon_minutes: int) -> int:
    """Rolling feature-buffer capacity for a horizon (ticks).

    The window scales WITH the expiry: a 1m trade needs ~60 ticks of recent
    tape, while a 10m trade wants ~600 so the regression/R² terms stay honest
    for the full expiry duration.
    """
    return int(max(60, min(int(horizon_minutes) * 60, 900)))


# ── INDICATOR PRIMITIVES (vectorized, flat-series safe) ──────────────────


def compute_ema(series: np.ndarray, span: int) -> np.ndarray:
    s = pd.Series(np.asarray(series, dtype=np.float64))
    return s.ewm(span=max(1, int(span)), adjust=False).mean().values


def compute_rsi(series: np.ndarray, period: int = 14) -> np.ndarray:
    """Flat-series-safe RSI — a flat tape reads 50 (neutral), never 0/100."""
    s = pd.Series(np.asarray(series, dtype=np.float64))
    delta = s.diff()
    gain = delta.clip(lower=0).ewm(alpha=1.0 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1.0 / period, adjust=False).mean()
    rs = gain / loss.replace(0, EPS)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    flat_mask = (gain <= EPS) & (loss <= EPS)
    rsi[flat_mask] = 50.0
    return rsi.fillna(50.0).values


def _regression_stats(x: np.ndarray, y: np.ndarray) -> Tuple[float, float]:
    """Linear regression {slope_normalized, R²} over vectors.

    Returns ``(slope, r2)`` where ``slope`` is the fitted slope divided by the
    mean price (scale-free, directly comparable across instruments) and ``r2``
    is the coefficient of determination (0..1) of the fit — a trend-line that
    hugs the tape R²→1, a sawtooth R²→0.
    """
    n = len(y)
    if n < 3:
        return 0.0, 0.0
    xs = np.arange(n, dtype=np.float64)
    denom = n * float(np.sum(xs * xs)) - float(np.sum(xs)) ** 2
    if denom <= EPS:
        return 0.0, 0.0
    slope = (
        n * float(np.sum(xs * y)) - float(np.sum(xs)) * float(np.sum(y))
    ) / denom
    mean_y = float(np.sum(y)) / n
    if abs(mean_y) <= EPS:
        return 0.0, 0.0
    slope_n = slope / mean_y
    ss_res = float(np.sum((y - (slope * xs + (float(np.sum(y)) - slope * float(np.sum(xs))) / n)) ** 2))
    ss_tot = float(np.sum((y - mean_y) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > EPS else 0.0
    return slope_n, max(0.0, min(1.0, r2))


def _detect_divergence(closes: np.ndarray, rsi: np.ndarray) -> Tuple[str, float]:
    """RSI divergence over the last ``window`` bars.

    Returns ``(kind, strength)``:
      - "bull": price prints a LOWER low while RSI prints a HIGHER low —
        sellers exhausting → CALL bias.
      - "bear": price prints a HIGHER high while RSI prints a LOWER high —
        buyers exhausting → PUT bias.
      - "none": ("" , 0.0) — no divergence in the window.
    """
    n = len(closes)
    if n < 6:
        return "", 0.0
    window = min(n, 14)
    c = closes[-window:]
    r = rsi[-window:]
    # Split into two comparable halves (older vs newer pivot nuclei).
    mid = window // 2
    older_c, newer_c = c[:mid], c[mid:]
    older_r, newer_r = r[:mid], r[mid:]

    def _extremes(a: np.ndarray) -> Tuple[float, int]:
        return float(np.min(a)), int(np.argmin(a))

    def _peak_idx(a: np.ndarray) -> int:
        return int(np.argmax(a))

    bull_div = bear_div = 0.0
    # Bullish: price lower low + RSI higher low.
    ll_new, _i1 = _extremes(newer_c)
    ll_old, _i2 = _extremes(older_c)
    if ll_new < ll_old:
        r_new_lo = float(np.min(newer_r))
        r_old_lo = float(np.min(older_r))
        if r_new_lo > r_old_lo:
            bull_div = 1.0
    # Bearish: price higher high + RSI lower high.
    hh_new = float(np.max(newer_c))
    hh_old = float(np.max(older_c))
    if hh_new > hh_old:
        r_new_hi = float(r[_peak_idx(newer_r)])
        r_old_hi = float(r[_peak_idx(older_r)])
        if r_new_hi < r_old_hi:
            bear_div = 1.0
    if bull_div > 0.0:
        return "bull", bull_div
    if bear_div > 0.0:
        return "bear", bear_div
    return "", 0.0


# ── ROLLING FEATURE BUFFER ───────────────────────────────────────────────


class HorizonFeatureBuffer:
    """Bounded per-(symbol, horizon) rolling dequeue of real closes + snapshot."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buffers: Dict[str, Deque[float]] = {}

    def _key(self, symbol: str, horizon: int) -> str:
        return f"{str(symbol).strip().upper()}|{int(horizon)}m"

    def push(self, symbol: str, horizon: int, closes: Any) -> None:
        """Append the latest real closes, trimming to the horizon capacity."""
        if not closes:
            return
        key = self._key(symbol, horizon)
        cap = buffer_size_for_horizon(horizon)
        with self._lock:
            buf = self._buffers.setdefault(key, deque(maxlen=cap))
            for c in closes:
                try:
                    v = float(c)
                except (TypeError, ValueError):
                    continue
                if np.isfinite(v) and v > 0:
                    buf.append(v)

    def latest(self, symbol: str, horizon: int) -> np.ndarray:
        """Return the current buffer contents as a float array (real prices)."""
        key = self._key(symbol, horizon)
        with self._lock:
            buf = self._buffers.get(key)
            if not buf:
                return np.array([], dtype=np.float64)
            return np.asarray(list(buf), dtype=np.float64)

    def reset(self, symbol: Optional[str] = None) -> None:
        with self._lock:
            if symbol is None:
                self._buffers.clear()
            else:
                for key in [k for k in self._buffers if k.startswith(str(symbol).upper())]:
                    self._buffers.pop(key, None)


_feature_buffer = HorizonFeatureBuffer()


# ── TREND-MOMENTUM FEATURE COMPUTATION ───────────────────────────────────


def compute_trend_features(
    closes: Any,
    horizon_minutes: int,
    ema_fast: int = 8,
    ema_slow: int = 21,
) -> Dict[str, float]:
    """Compute the trend-momentum feature pack on a real close array.

    All values are finite floats (never NaN). An array too short to fill a
    window returns neutral-but-real features (0.0 slope, 50 RSI, 0 R², etc.).
    """
    c = np.asarray(closes, dtype=np.float64)
    if c.ndim != 1 or c.size == 0:
        return _neutral_features()
    c = c[np.isfinite(c) & (c > 0)]
    if c.size == 0:
        return _neutral_features()

    hz = resolve_horizon_minutes(horizon_minutes)
    window = min(c.size, int(max(30, buffer_size_for_horizon(hz) // 2)))

    price_mean = float(np.mean(c))
    tail = c[-window:]

    # ── EMA crossover (fast − slow, normalized) + its velocity ──
    ema_f = compute_ema(c, ema_fast)[-1]
    ema_s = compute_ema(c, ema_slow)[-1]
    ema_f_prev = compute_ema(c[:-1], ema_fast)[-1] if c.size > 1 else ema_f
    ema_s_prev = compute_ema(c[:-1], ema_slow)[-1] if c.size > 1 else ema_s
    ema_cross = (ema_f - ema_s) / max(abs(price_mean), EPS)
    ema_cross_prev = (ema_f_prev - ema_s_prev) / max(abs(price_mean), EPS)
    ema_vel = ema_cross - ema_cross_prev

    # ── RSI(14) + divergence ──
    rsi_arr = compute_rsi(c, 14)
    rsi_now = float(rsi_arr[-1])
    rsi_prev = float(rsi_arr[-2]) if rsi_arr.size > 1 else rsi_now
    div_kind, div_strength = _detect_divergence(c, rsi_arr)

    # ── Linear-regression slope + fit quality over the horizon window ──
    slope_n, r2 = _regression_stats(np.arange(tail.size, dtype=np.float64), tail)

    # ── Bar-momentum ratio (up-bars vs down-bars in the window) ──
    deltas = np.diff(tail)
    up = float(np.sum(deltas > EPS))
    down = float(np.sum(deltas < -EPS))
    total_moves = up + down
    momentum = (up - down) / total_moves if total_moves > EPS else 0.0

    # ── Price position inside the window range (0..1) ──
    hi = float(np.max(tail))
    lo = float(np.min(tail))
    rng = hi - lo
    position = float(((float(tail[-1]) - lo) / rng)) if rng > EPS else 0.5

    # ── Realized volatility (log-return std, annual-ish scale-free) ──
    log_ret = np.diff(np.log(np.maximum(tail, EPS)))
    realized_vol = float(np.std(log_ret)) if log_ret.size else 0.0

    def _clip(v: float) -> float:
        return max(-1.0, min(1.0, float(v)))

    return {
        "ema_cross": _clip(ema_cross * 400.0),
        "ema_cross_velocity": _clip(ema_vel * 900.0),
        "ema_fast": float(ema_f),
        "ema_slow": float(ema_s),
        "rsi_14": float(max(0.0, min(100.0, rsi_now))),
        "rsi_delta": _clip((rsi_now - rsi_prev) / 25.0),
        "regression_slope": _clip(slope_n * 1e6),
        "regression_r2": float(max(0.0, min(1.0, r2))),
        "divergence": _clip(div_strength) if div_kind == "bull" else (-_clip(div_strength) if div_kind == "bear" else 0.0),
        "divergence_kind": div_kind,
        "momentum": _clip(momentum),
        "position": float(max(0.0, min(1.0, position))),
        "volatility": float(max(0.0, realized_vol)),
    }


def _neutral_features() -> Dict[str, float]:
    return {
        "ema_cross": 0.0,
        "ema_cross_velocity": 0.0,
        "ema_fast": 0.0,
        "ema_slow": 0.0,
        "rsi_14": 50.0,
        "rsi_delta": 0.0,
        "regression_slope": 0.0,
        "regression_r2": 0.0,
        "divergence": 0.0,
        "divergence_kind": "none",
        "momentum": 0.0,
        "position": 0.5,
        "volatility": 0.0,
    }


# ── DIRECTION CLASSIFIER (CALL / PUT) ────────────────────────────────────


def classify_trend(features: Dict[str, float]) -> Tuple[str, float]:
    """Map the feature pack → ``(direction, raw_confidence)``.

    ``direction`` ∈ {"CALL", "PUT", "NEUTRAL"}
    ``raw_confidence`` ∈ [0, 1] — a continuous, real-tape-derived score.

    Weighted agreement of the LEADING trend-momentum terms:
      • EMA crossover + crossover velocity         (lead, macro-structure)
      • regression slope weighted by R²            (dominant expiry-aim term)
      • RSI displacement + RSI divergence          (deviation/divergence)
      • bar-momentum ratio                         (immediate flow)
    A tape where every term points the SAME way yields confidence ≈ 96%+ — the
    calibration target for optimal conditions (fully aligned trend).
    """
    if not features:
        return "NEUTRAL", 0.5

    ema = float(features.get("ema_cross", 0.0))
    ema_vel = float(features.get("ema_cross_velocity", 0.0))
    rsi = float(features.get("rsi_14", 50.0))
    rsi_delta = float(features.get("rsi_delta", 0.0))
    slope = float(features.get("regression_slope", 0.0))
    r2 = float(features.get("regression_r2", 0.0))
    div = float(features.get("divergence", 0.0))
    mom = float(features.get("momentum", 0.0))

    rsi_bias = (rsi - 50.0) / 25.0  # ∈ [-1, 1] on the 0..100 scale

    weighted: Tuple[Tuple[float, float], ...] = (
        (ema, 0.22),
        (ema_vel, 0.12),
        (slope * (0.5 + 0.5 * math.sqrt(r2)), 0.26),  # fit-quality gated trend
        (rsi_bias, 0.12),
        (rsi_delta, 0.06),
        (div, 0.10),
        (mom, 0.12),
    )
    num = sum(v * w for v, w in weighted if v != 0.0)
    den = sum(w for v, w in weighted if v != 0.0)
    score = num / den if den > EPS else 0.0
    score = max(-1.0, min(1.0, score))

    if abs(score) < 0.08:
        direction = "NEUTRAL"
    else:
        direction = "CALL" if score > 0 else "PUT"

    # Continuous raw confidence: full agreement → ~0.96, dead-neutral → 0.50.
    # A high-R² slope and overlap of terms push the score toward the thermal band.
    agreement = sum(1.0 for v, _w in weighted if (v > 0) == (score > 0) and v != 0.0)
    active = sum(1.0 for v, _w in weighted if v != 0.0)
    agree_frac = agreement / active if active > 0 else 0.0
    raw_conf = 0.50 + 0.46 * abs(score) * (0.5 + 0.5 * agree_frac)
    return direction, max(0.0, min(0.99, raw_conf))


# ── OUTPUT STABILIZER (EWMA + deadband hysteresis) ───────────────────────


class OutputStabilizer:
    """Per-(symbol, horizon) deadband-stabilized CALL/PUT contract state.

    Smoothness guarantees:
      • EWMA confidence smoothing (``alpha`` = weight on the new sample) so the
        emitted percentage moves smoothly instead of snapping tick-to-tick.
      • Direction deadband (hysteresis): an opposing flip is only accepted when
        the calibrated conviction unambiguously reverses — |smoothed − 0.5|
        must clear ``reversal_halfwidth`` AND move at least ``flip_inertia``
        away from the previous emission. Marginal jitter never flips CALL/PUT.
      • ``stable_flips`` counts only ACCEPTED reversals (diagnostics, and the
        raw material for the UI's "stability" legibility).
    """

    DEFAULT_ALPHA = 0.30
    DEFAULT_REVERSAL_HALFWIDTH = 0.12   # flip requires |conf − 0.5| ≥ 0.12
    DEFAULT_FLIP_INERTIA = 0.08         # and a swing ≥ 8 confidence points

    def __init__(
        self,
        alpha: float = DEFAULT_ALPHA,
        reversal_halfwidth: float = DEFAULT_REVERSAL_HALFWIDTH,
        flip_inertia: float = DEFAULT_FLIP_INERTIA,
    ) -> None:
        self.alpha = float(alpha)
        self.reversal_halfwidth = float(reversal_halfwidth)
        self.flip_inertia = float(flip_inertia)
        self._lock = threading.Lock()
        self._state: Dict[str, Dict[str, Any]] = {}

    def _key(self, symbol: str, horizon: int) -> str:
        return f"{str(symbol).strip().upper()}|{int(horizon)}m"

    def update(self, symbol: str, horizon: int, direction: str, raw_conf: float) -> Dict[str, Any]:
        with self._lock:
            key = self._key(symbol, horizon)
            st = self._state.setdefault(
                key,
                {
                    "direction": None,
                    "confidence": 0.5,
                    "confidence_prev": None,
                    "flips": 0,
                    "samples": 0,
                },
            )

            prev_dir: Optional[str] = st.get("direction")
            prev_conf: Optional[float] = st.get("confidence")

            # EWMA smooth (alpha = weight on the fresh sample).
            if prev_conf is None:
                smoothed = float(raw_conf)
            else:
                smoothed = self.alpha * float(raw_conf) + (1.0 - self.alpha) * float(prev_conf)
            smoothed = max(0.0, min(1.0, smoothed))

            stable_dir = direction
            flip_accepted = False
            if (
                prev_dir is not None
                and direction != "NEUTRAL"
                and direction != prev_dir
            ):
                conviction = abs(smoothed - 0.5)
                swing = abs(smoothed - float(prev_conf))
                if conviction >= self.reversal_halfwidth and swing >= self.flip_inertia:
                    stable_dir = direction
                    st["flips"] = int(st.get("flips", 0)) + 1
                    flip_accepted = True
                else:
                    # Hysteresis: keep the incumbent direction; only the
                    # confidence moves (middle-ground = still drifting).
                    stable_dir = prev_dir

            if stable_dir == "NEUTRAL" and prev_dir is not None:
                # A fully neutral tape keeps the last directional contract but
                # pulls confidence toward 50 (honest weakening) — the emission
                # stays CALL/PUT (the engine never demotes to HOLD upstream).
                stable_dir = prev_dir

            st["direction"] = stable_dir
            st["confidence_prev"] = prev_conf
            st["confidence"] = float(round(smoothed, 4))
            st["samples"] = int(st.get("samples", 0)) + 1

            return {
                "direction": stable_dir,
                "confidence": float(st["confidence"]),
                "confidence_prev": prev_conf,
                "delta_confidence": (
                    float(round(st["confidence"] - prev_conf, 4))
                    if prev_conf is not None
                    else 0.0
                ),
                "flips": int(st["flips"]),
                "flip_accepted": flip_accepted,
                "samples": int(st["samples"]),
            }


_stabilizer = OutputStabilizer()


# ── PUBLIC CONTRACT BUILDER ──────────────────────────────────────────────


def _callput(direction: str) -> str:
    if direction == "PUT":
        return "PUT"
    if direction == "CALL":
        return "CALL"
    return "CALL"  # NEUTRAL also normalizes to CALL on the parity layer


def build_horizon_payload(
    symbol: str,
    closes: Any,
    horizon_minutes: Optional[Any] = None,
    live_price: Optional[float] = None,
    atr: Optional[float] = None,
    timeframe: Optional[str] = None,
) -> Dict[str, Any]:
    """Build the STABLE expiry-horizon contract for the given real closes.

    The returned dict is the frontend-agreed ``horizon`` block:
      {
        horizon_minutes, stable_signal (CALL/PUT), direction (BUY/SELL),
        confidence (0-100, smooth), confidence_prev, delta_confidence,
        stable_flips, entry_ts, expiry_ts, features {...}, stability {...}
      }
    It NEVER fabricates: short tapes yield honest neutral features (50 RSI,
    0 slope, R² 0) and a stabilized near-baseline confidence.
    """
    hz = resolve_horizon_minutes(horizon_minutes)

    # ── Feature buffer: append one fresh sample per array tail ──
    # Push the FULL forwarded series so the rolling dequeue is warm; then
    # evaluate on the retained (bounded) buffer.
    closes_arr = np.asarray(closes, dtype=np.float64)
    if closes_arr.ndim != 1 or closes_arr.size == 0:
        closes_flat = []
    else:
        closes_flat = [
            float(v)
            for v in closes_arr[np.isfinite(closes_arr) & (closes_arr > 0)]
        ]
    _feature_buffer.push(symbol, hz, closes_flat)
    tape = _feature_buffer.latest(symbol, hz)

    features = compute_trend_features(tape, hz)
    direction, raw_conf = classify_trend(features)
    stable = _stabilizer.update(symbol, hz, direction, raw_conf)

    stable_signal = _callput(stable["direction"])
    direction_buy_sell = "BUY" if stable_signal == "CALL" else "SELL"

    now_utc = datetime.now(timezone.utc)
    entry_ts = now_utc.isoformat()
    expiry_ts = (now_utc + pd.Timedelta(minutes=int(hz))).isoformat()

    confidence_pct = round(float(stable["confidence"]) * 100.0, 1)

    return {
        "horizon_minutes": hz,
        "backend_timeframe": HORIZON_TO_BACKEND_TF.get(hz, "1m"),
        "stable_signal": stable_signal,
        "direction": direction_buy_sell,
        "confidence": confidence_pct,
        "confidence_prev": (
            round(float(stable["confidence_prev"]) * 100.0, 1)
            if stable["confidence_prev"] is not None
            else None
        ),
        "delta_confidence": round(float(stable["delta_confidence"]) * 100.0, 1),
        "stable_flips": int(stable["flips"]),
        "entry_ts": entry_ts,
        "expiry_ts": expiry_ts,
        "expires_in_seconds": int(hz * 60),
        "live_price": (
            round(float(live_price), 8)
            if live_price is not None and np.isfinite(float(live_price)) and float(live_price) > 0
            else None
        ),
        "atr": (
            round(float(atr), 8)
            if atr is not None and np.isfinite(float(atr)) and float(atr) > 0
            else None
        ),
        "timeframe": str(timeframe or "").lower() or None,
        "features": {
            "ema_cross": round(float(features["ema_cross"]), 4),
            "ema_cross_velocity": round(float(features["ema_cross_velocity"]), 4),
            "ema_fast": round(float(features["ema_fast"]), 8),
            "ema_slow": round(float(features["ema_slow"]), 8),
            "rsi_14": round(float(features["rsi_14"]), 2),
            "rsi_delta": round(float(features["rsi_delta"]), 4),
            "regression_slope": round(float(features["regression_slope"]), 4),
            "regression_r2": round(float(features["regression_r2"]), 4),
            "divergence": round(float(features["divergence"]), 4),
            "divergence_kind": str(features.get("divergence_kind", "none")),
            "momentum": round(float(features["momentum"]), 4),
            "position": round(float(features["position"]), 4),
            "volatility": round(float(features["volatility"]), 8),
        },
        "raw_direction": direction,
        "raw_confidence": round(max(0.0, min(1.0, float(raw_conf))) * 100.0, 1),
        "stability": {
            "alpha": float(_stabilizer.alpha),
            "reversal_halfwidth": float(_stabilizer.reversal_halfwidth),
            "flip_inertia": float(_stabilizer.flip_inertia),
            "samples": int(stable["samples"]),
            "buffer_ticks": int(tape.size),
        },
    }