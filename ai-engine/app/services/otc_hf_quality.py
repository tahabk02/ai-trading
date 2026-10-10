"""
otc_hf_quality.py — OTC HIGH-FREQUENCY PRICE-ACTION QUALITY FILTER
(STRICT QUALITY UPGRADE 2026-09-24)

For OTC (synthetic / retail-class) instruments the tape is fast but thin.
Before an OTC verdict may be marked executable its HIGH-FREQUENCY quality is
verified across four independent micro-structure factors — a weak/turbulent
micro market always vetoes the signal even when confluence is nominally high:

  * micro_momentum (weight 0.40) — real price-action delta: MACD(5,13,5)
    histogram, tick velocity and its acceleration ALL signed in the signal
    direction. Mixed signs → 0 (no single-leg trend may claim HF support).
  * order_flow    (weight 0.30) — bid/ask pressure (REAL arms) or the real
    tick-position proxy; flow must not oppose the signal direction.
  * volatility    (weight 0.20) — realized ATR/price inside the tradeable band
    [0.0008, 0.0050]: crushed volatility cannot express a trade, wild
    volatility cannot be trusted.
  * mean_reversion (weight 0.10) — synthetic mean-reversion boundaries: a
    signal entering an over-extended z-region ( |z| >= 2.5 ) is vetoed because
    the synthetic generator is expected to revert.

The combined weighted score must clear OTC_HF_PASS_BAR (0.65) AND every
REQUIRED factor must be non-zero. Signals only trigger when the internal
confluence score strictly exceeds 96.5% (enforced by the strict execution
gate — signal_gatekeeper.apply_strict_execution_gate).

Output is a class-gate verdict dict consumed by the strict execution gate::

    {
      "passes": bool,
      "reason": None | "otc_hf_fail" | "insufficient_history",
      "score": 0..1,
      "factors": {micro_momentum, order_flow, volatility, mean_reversion},
      "metrics": {"momentum", "flow", "atr_ratio", "z_last", "spread_status"},
    }
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

import numpy as np

from .data_sanitization import MIN_OTC_TICKS, last_atr14, sanitize_price_series
from .quant_matrix import (
    compute_bid_ask_pressure,
    compute_macd_histogram,
    compute_tick_velocity,
    compute_tick_velocity_acceleration,
)

OTC_HF_PASS_BAR = 0.65
ATR_MIN_RATIO = 0.0008
ATR_MAX_RATIO = 0.0050
Z_EXTREME = 2.5
WEIGHTS = {
    "micro_momentum": 0.40,
    "order_flow": 0.30,
    "volatility": 0.20,
    "mean_reversion": 0.10,
}
FACTOR_ORDER = ["micro_momentum", "order_flow", "volatility", "mean_reversion"]
REQUIRED_FACTORS = ["micro_momentum", "volatility", "mean_reversion"]


def _rolling_z_last(closes: List[float]) -> Optional[float]:
    """Standard score of the last close vs its trailing window (synthetic m-r)."""
    if not closes:
        return None
    arr = np.asarray(closes, dtype=np.float64)
    mean = float(np.mean(arr))
    std = float(np.std(arr))
    if std <= 1e-12:
        return 0.0
    return float((arr[-1] - mean) / std)


def evaluate_otc_hf_quality(
    closes: Optional[List[Any]],
    direction: Optional[str],
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    live_price: Optional[float] = None,
) -> Dict[str, Any]:
    """OTC high-frequency quality verdict (passes / score / factors / metrics).

    ``closes`` are raw; the filter sanitizes internally and requires ≥
    MIN_OTC_TICKS (30) clean trailing closes (optimized rolling-tick window).
    """
    cleaned = sanitize_price_series(closes, min_required=MIN_OTC_TICKS)
    series = cleaned["closes"]
    if not cleaned["sufficient"]:
        return {
            "passes": False,
            "reason": "insufficient_history",
            "score": 0.0,
            "factors": {f: 0 for f in FACTOR_ORDER},
            "metrics": {"spread_status": "no_quotes", "cleaned": len(series)},
        }

    direction = str(direction or "").upper()
    if direction not in ("BUY", "SELL"):
        return {
            "passes": False,
            "reason": "no_directional_signal",
            "score": 0.0,
            "factors": {f: 0 for f in FACTOR_ORDER},
            "metrics": {"spread_status": "no_quotes", "cleaned": len(series)},
        }

    arr = np.asarray(series, dtype=np.float64)
    sign = 1.0 if direction == "BUY" else -1.0
    price = float(live_price) if live_price and math.isfinite(float(live_price)) else float(arr[-1])

    # ── micro_momentum ──
    macd = compute_macd_histogram(arr)
    macd_last = float(macd[-1])
    velocity = compute_tick_velocity(arr)
    accel = compute_tick_velocity_acceleration(arr)
    momentum = 0
    # MACD and velocity must BOTH point with the signal; acceleration must
    # not oppose it (accel == 0 → steady trend, still valid HF support).
    if macd_last != 0.0 and (velocity > 0) == (accel >= 0) and (macd_last > 0) == (velocity > 0):
        aligned = (sign * velocity) > 0 and (sign * macd_last) > 0
        momentum = 1 if aligned else 0

    # ── order_flow ──
    pressure, source = compute_bid_ask_pressure(price, bid, ask, tail=arr[-30:])
    if pressure == 0.0:
        flow = 0  # no opposing flow observed — neutral, not supporting
    else:
        flow = 1 if (sign * pressure) > 0 else 0

    # ── volatility ──
    atr = last_atr14(series)
    atr_ratio = atr / price if atr and price > 0 else None
    volatility = 1 if atr_ratio is not None and ATR_MIN_RATIO <= atr_ratio <= ATR_MAX_RATIO else 0

    # ── mean_reversion ──
    z = _rolling_z_last(series)
    mean_reversion = 0 if z is None or abs(z) >= Z_EXTREME else 1

    factors = {
        "micro_momentum": momentum,
        "order_flow": flow,
        "volatility": volatility,
        "mean_reversion": mean_reversion,
    }
    score = round(sum(WEIGHTS[k] * v for k, v in factors.items()), 4)
    required_ok = all(factors[r] == 1 for r in REQUIRED_FACTORS)
    passes = bool(required_ok and score >= OTC_HF_PASS_BAR)

    return {
        "passes": passes,
        "reason": None if passes else "otc_hf_fail",
        "score": score,
        "factors": factors,
        "metrics": {
            "cleaned": len(series),
            "dropped": cleaned["dropped"],
            "momentum": round(macd_last, 6),
            "velocity": round(velocity, 4),
            "acceleration": round(accel, 4),
            "flow": round(pressure, 4),
            "flow_source": source,
            "atr_ratio": round(atr_ratio, 6) if atr_ratio is not None else None,
            "z_last": round(z, 3) if z is not None else None,
            "spread_status": "synthetic",
        },
    }