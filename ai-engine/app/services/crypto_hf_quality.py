"""
crypto_hf_quality.py — CRYPTO MOMENTUM-BREAKOUT / VOLATILITY-BAND GATE

Crypto majors are a structurally different microstructure from both wholesale
FX and the broker's synthetic OTC book, so neither existing gate fits them:

  * ``real_liquidity_gate`` demands a bid/ask spread-to-ATR margin, 160 clean
    closes and M1/M5/H1 session alignment. This stack has no consolidated L2
    feed for BTC/ETH and crypto has no FX session to resample against — the
    FX gate grades crypto with the wrong instrument.
  * ``otc_hf_quality`` uses an FX-sized volatility band
    (ATR/price in [0.0008, 0.0050]). Real crypto moves several percent per bar;
    every crypto tick would sit far above that band and be vetoed as "wild
    volatility", permanently suppressing every crypto signal.

This gate is built for a 24/7 tape with four factors:

  * breakout (weight 0.40) — the last close must clear a Donchian-style
    channel high/low on a crypto-sized lookback, in the signal direction. This
    is the primary crypto structure: crypto trends in expansions.
  * momentum (weight 0.30) — MACD histogram + tick velocity aligned to the
    signal direction, same primitives the OTC gate uses but with crypto's
    run-rate in mind.
  * volatility_band (weight 0.20) — realized ATR/price inside a CRYPTO band
    [0.0015, 0.0600]. The lower bound rejects a dead/compressed tape that
    cannot express a 1–10m move; the upper bound rejects a disorderly spike
    where the target math is unreliable. Note this is ~3x wider at the top
    than the FX/OTC band and deliberately includes the crypto regime.
  * trend_structure (weight 0.10) — the trailing run must be directional
    rather than a flat chop: the mean absolute step over the recent window
    must clear a crypto-scaled floor. Mirrors the OTC gate's mean-reversion
    role (a signal must not enter pure noise) without assuming FX mean
    reversion, which does not hold on crypto.

Output is the SAME class-gate verdict contract the strict execution gate and
the execution audit already consume — no new shape for downstream code::

    {
      "passes": bool,
      "reason": None | "crypto_hf_fail" | "insufficient_history"
                | "no_directional_signal" | "flow_against_direction",
      "score": 0..1,
      "factors": {breakout, momentum, volatility_band, trend_structure},
      "metrics": {...},
    }
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

import numpy as np

from .data_sanitization import (
    MIN_CRYPTO_TICKS,
    last_atr14,
    sanitize_price_series,
    spread_metrics,
)
from .quant_matrix import (
    compute_bid_ask_pressure,
    compute_macd_histogram,
    compute_tick_velocity,
)

CRYPTO_HF_PASS_BAR = 0.65
# Crypto-sized volatility band. Upper bound is ~12x the OTC/FX ceiling: a real
# BTC bar routinely moves >0.5% of price, which the FX band calls "wild".
CRYPTO_ATR_MIN_RATIO = 0.0015
CRYPTO_ATR_MAX_RATIO = 0.0600
CRYPTO_BREAKOUT_LOOKBACK = 20
# Minimum mean absolute step (as a fraction of price) for the trailing run to
# count as structured rather than flat chop.
CRYPTO_TREND_STEP_FLOOR = 0.0002

WEIGHTS = {
    "breakout": 0.40,
    "momentum": 0.30,
    "volatility_band": 0.20,
    "trend_structure": 0.10,
}
FACTOR_ORDER = ["breakout", "momentum", "volatility_band", "trend_structure"]
REQUIRED_FACTORS = ["breakout", "momentum", "volatility_band"]


def _donchian_breakout(closes: List[float], direction: str) -> Dict[str, Any]:
    """Donchian channel test on the trailing ``CRYPTO_BREAKOUT_LOOKBACK`` bars.

    Compares the LAST close (the acting bar) against the channel formed by the
    PRIOR ``lookback`` bars, so a bar can break the channel it just extended
    only by closing beyond the previous extremes.
    """
    look = CRYPTO_BREAKOUT_LOOKBACK
    if len(closes) < look + 2:
        return {"broken": False, "channel_high": None, "channel_low": None,
                "extension": None, "available": len(closes)}
    prior = closes[-(look + 1):-1]
    channel_high = max(prior)
    channel_low = min(prior)
    last = closes[-1]
    if direction == "BUY":
        broken = last > channel_high
        extension = (last - channel_high) / channel_high if channel_high > 0 else None
    else:
        broken = last < channel_low
        extension = (channel_low - last) / channel_low if channel_low > 0 else None
    return {
        "broken": bool(broken),
        "channel_high": round(channel_high, 8),
        "channel_low": round(channel_low, 8),
        "extension": round(extension, 6) if extension is not None else None,
        "available": len(closes),
    }


def _trend_structure(closes: List[float], price: float) -> Dict[str, Any]:
    """Is the trailing run directional (structured) or flat chop (noise)?"""
    if len(closes) < 6 or price <= 0:
        return {"structured": False, "step_ratio": None}
    recent = closes[-6:]
    mean_step = sum(abs(recent[i] - recent[i - 1]) for i in range(1, len(recent))) / (len(recent) - 1)
    step_ratio = mean_step / price
    return {
        "structured": bool(step_ratio >= CRYPTO_TREND_STEP_FLOOR),
        "step_ratio": round(step_ratio, 6),
    }


def evaluate_crypto_hf_quality(
    closes: Optional[List[Any]],
    direction: Optional[str],
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    live_price: Optional[float] = None,
) -> Dict[str, Any]:
    """Crypto momentum-breakout / volatility-band verdict.

    ``closes`` are raw; the filter sanitizes internally and requires
    >= MIN_CRYPTO_TICKS (60) clean trailing closes.
    """
    cleaned = sanitize_price_series(closes, min_required=MIN_CRYPTO_TICKS)
    series = cleaned["closes"]

    def _fail(reason: str, score: float = 0.0, metrics: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "passes": False,
            "reason": reason,
            "score": round(score, 4),
            "factors": {f: 0 for f in FACTOR_ORDER},
            "metrics": metrics or {"spread_status": "no_quotes", "cleaned": len(series)},
        }

    if not cleaned["sufficient"]:
        return _fail("insufficient_history", 0.0,
                     {"spread_status": "no_quotes", "cleaned": len(series),
                      "minimum": MIN_CRYPTO_TICKS})

    direction = str(direction or "").upper()
    if direction not in ("BUY", "SELL"):
        return _fail("no_directional_signal", 0.0,
                     {"spread_status": "no_quotes", "cleaned": len(series)})

    arr = np.asarray(series, dtype=np.float64)
    sign = 1.0 if direction == "BUY" else -1.0
    price = float(live_price) if live_price and math.isfinite(float(live_price)) else float(arr[-1])

    # ── breakout ──
    bo = _donchian_breakout(series, direction)
    breakout = 1 if bo["broken"] else 0

    # ── momentum ──
    macd = compute_macd_histogram(arr)
    macd_last = float(macd[-1])
    velocity = compute_tick_velocity(arr)
    momentum = 1 if (sign * velocity) > 0 and (sign * macd_last) > 0 else 0

    # ── volatility_band ──
    atr = last_atr14(series)
    atr_ratio = atr / price if atr and price > 0 else None
    volatility_band = 1 if (
        atr_ratio is not None
        and CRYPTO_ATR_MIN_RATIO <= atr_ratio <= CRYPTO_ATR_MAX_RATIO
    ) else 0

    # ── trend_structure ──
    ts = _trend_structure(series, price)
    trend_structure = 1 if ts["structured"] else 0

    # ── order-flow check (VETO only, not a scored factor) ──
    # Crypto has no consolidated L2 in this stack, so when no real bid/ask
    # exists the tick-position proxy is used. A strong opposition is a veto
    # rather than a weighted factor: entering against the tape is wrong in
    # any market.
    pressure, flow_source = compute_bid_ask_pressure(price, bid, ask, tail=arr[-30:])
    if abs(pressure) >= 0.5 and (sign * pressure) < 0:
        return _fail("flow_against_direction", 0.0, {
            "cleaned": len(series), "dropped": cleaned["dropped"],
            "flow": round(pressure, 4), "flow_source": flow_source,
            "spread_status": spread_metrics(bid, ask, price)["status"],
        })

    factors = {
        "breakout": breakout,
        "momentum": momentum,
        "volatility_band": volatility_band,
        "trend_structure": trend_structure,
    }
    score = round(sum(WEIGHTS[k] * v for k, v in factors.items()), 4)
    required_ok = all(factors[r] == 1 for r in REQUIRED_FACTORS)
    passes = bool(required_ok and score >= CRYPTO_HF_PASS_BAR)

    return {
        "passes": passes,
        "reason": None if passes else "crypto_hf_fail",
        "score": score,
        "factors": factors,
        "metrics": {
            "cleaned": len(series),
            "dropped": cleaned["dropped"],
            "minimum": MIN_CRYPTO_TICKS,
            "momentum": round(macd_last, 6),
            "velocity": round(velocity, 4),
            "flow": round(pressure, 4),
            "flow_source": flow_source,
            "atr_ratio": round(atr_ratio, 6) if atr_ratio is not None else None,
            "atr_band": [CRYPTO_ATR_MIN_RATIO, CRYPTO_ATR_MAX_RATIO],
            "breakout": bo,
            "trend_step_ratio": ts["step_ratio"],
            "spread_status": spread_metrics(bid, ask, price)["status"],
        },
    }
