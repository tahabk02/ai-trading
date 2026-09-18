"""
math_target.py — MATH-BASED TARGET PROJECTION (Alpha.5 Pro, Part 4).

Deterministic, zero-Date.now() target-price model computed over a REAL
rolling window of OHLCV bars (default 30 minutes of 1m bars):

  • ATR(14)     — Wilder true-range seed over the last 14 genuine TRs
  • sigma       — population std-dev of the window closes
  • VWAP        — equal-weight typical-price average (the OTC series is
                  volume-zero, so equal-weight VWAP is the honest estimator)
  • EMA12/EMA26 — normalized momentum slope = (EMA12 − EMA26) / live

  direction = BUY   when live > VWAP AND EMA12 > EMA26
              SELL  when live < VWAP AND EMA12 < EMA26
              HOLD  otherwise (sign = 0)

  deviation   = 0.5·(VWAP − live)      ← mean-reversion pull to the mean
              + 0.5·(live·slope)       ← momentum continuation leg
              + ATR14·0.20·sign        ← volatility-flavored directional leg
  deviation is CLAMPED to ±3·ATR14
  target      = live + deviation

Every numerical field is honest math on real bars — nothing fabricated, no
random seeds, no wall-clock anchoring. The caller decides how to act when a
series is too short (`success: False, error: "insufficient_data"`).
"""

from __future__ import annotations

from statistics import pstdev
from typing import Any, Dict, List, Optional

DEFAULT_WINDOW_SECONDS = 1800  # 30 minutes
MIN_WINDOW_SECONDS = 60
MAX_WINDOW_SECONDS = 86400

_MEAN_REV_WEIGHT = 0.5
_MOMENTUM_WEIGHT = 0.5
_ATR_DIRECTIONAL_WEIGHT = 0.20
_CLAMP_MULTIPLIER = 3.0


def parse_window(raw: str) -> int:
    """Parse a window spec into seconds. Accepts "30m", "1h", "1800", "1800s",
    "15m". Garbage/absent → the DEFAULT 30m window, bounded to [60s, 86400s]."""
    try:
        s = (raw or "").strip().lower()
        if not s:
            return DEFAULT_WINDOW_SECONDS
        if s.endswith("m"):
            seconds = float(s[:-1]) * 60.0
        elif s.endswith("h"):
            seconds = float(s[:-1]) * 3600.0
        elif s.endswith("d"):
            seconds = float(s[:-1]) * 86400.0
        elif s.endswith("s"):
            seconds = float(s[:-1])
        else:
            seconds = float(s)
        return int(max(MIN_WINDOW_SECONDS, min(MAX_WINDOW_SECONDS, round(seconds))))
    except (ValueError, TypeError):
        return DEFAULT_WINDOW_SECONDS


def _ema(values: List[float], span: int) -> List[float]:
    """One-pass EMA seeded on the first close (deterministic)."""
    k = 2.0 / (span + 1.0)
    out: List[float] = []
    seed = values[0]
    for v in values:
        seed = v * k + seed * (1.0 - k)
        out.append(seed)
    return out


def _atr14(
    highs: List[float],
    lows: List[float],
    closes: List[float],
) -> Optional[float]:
    """Wilder ATR(14) seed: simple mean of the last 14 TRUE ranges."""
    n = len(closes)
    if n < 2:
        return None
    trs: List[float] = []
    for i in range(1, n):
        h, l, pc = highs[i], lows[i], closes[i - 1]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if len(trs) < 14:
        return None
    return sum(trs[-14:]) / 14.0


def compute_math_target(
    symbol: str,
    closes: List[float],
    highs: Optional[List[float]] = None,
    lows: Optional[List[float]] = None,
    window_sec: int = DEFAULT_WINDOW_SECONDS,
) -> Dict[str, Any]:
    """Math target over the LAST ``window`` seconds of real OHLCV bars.

    Returns a fully-labeled dict (never raises). A series shorter than 2 bars
    returns ``success: False`` with ``error: "insufficient_data"`` so the
    caller degrades honestly instead of fabricating a target.
    """
    sym = (symbol or "").strip().upper()
    closes = [float(c) for c in closes if c is not None]
    highs = [float(h) for h in highs] if highs else list(closes)
    lows = [float(l) for l in lows] if lows else list(closes)

    if len(closes) < 2:
        return {
            "success": False,
            "symbol": sym,
            "error": "insufficient_data",
            "bars": len(closes),
            "window_sec": int(window_sec),
        }

    bucket_minutes = max(1, int(round(window_sec / 60.0)))
    n = min(len(closes), bucket_minutes)
    series = closes[-n:]
    hh = highs[-n:]
    ll = lows[-n:]
    live = float(series[-1])

    # VWAP — volume-zero OTC series → equal-weight typical-price average.
    vwap = sum((hh[i] + ll[i] + series[i]) / 3.0 for i in range(n)) / n
    sigma = pstdev(series) if n >= 2 else 0.0

    ema12 = _ema(series, 12)[-1]
    ema26 = _ema(series, 26)[-1]
    slope = (ema12 - ema26) / live if abs(live) > 1e-12 else 0.0

    atr = _atr14(hh, ll, series)
    if atr is None:
        atr = sigma if sigma > 0 else None

    if live > vwap and ema12 > ema26:
        direction = "BUY"
    elif live < vwap and ema12 < ema26:
        direction = "SELL"
    else:
        direction = "HOLD"

    sign = 1.0 if direction == "BUY" else (-1.0 if direction == "SELL" else 0.0)
    mean_rev = vwap - live
    momentum_leg = live * slope
    atr_leg = (atr * _ATR_DIRECTIONAL_WEIGHT * sign) if atr else 0.0
    deviation = (
        _MEAN_REV_WEIGHT * mean_rev
        + _MOMENTUM_WEIGHT * momentum_leg
        + atr_leg
    )

    clamped = False
    if atr and _CLAMP_MULTIPLIER * atr > 1e-12:
        lo = -_CLAMP_MULTIPLIER * atr
        hi = _CLAMP_MULTIPLIER * atr
        if deviation < lo or deviation > hi:
            deviation = max(lo, min(hi, deviation))
            clamped = True

    target = live + deviation

    return {
        "success": True,
        "symbol": sym,
        "window_sec": n * 60,
        "bars": n,
        "atr14": round(atr, 8) if atr else None,
        "sigma": round(sigma, 8),
        "vwap": round(vwap, 8),
        "ema12": round(ema12, 8),
        "ema26": round(ema26, 8),
        "momentum_slope": round(slope, 8),
        "direction": direction,
        "live_price": round(live, 8),
        "mean_rev": round(mean_rev, 8),
        "momentum_leg": round(momentum_leg, 8),
        "atr_leg": round(atr_leg, 8),
        "deviation": round(deviation, 8),
        "target_price": round(target, 8),
        "clamped": bool(clamped),
    }