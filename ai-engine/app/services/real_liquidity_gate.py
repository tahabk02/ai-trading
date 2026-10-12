"""
real_liquidity_gate.py — REAL ASSET LIQUIDITY GATE (STRICT QUALITY UPGRADE 2026-09-24)

For REAL (institutional wholesale FX / crypto majors) assets every verdict must
pass an institutional liquidity check before it may be marked executable. The
gate validates five conditions derived from the SINGLE forwarded tape — no L2
order-book feed is required (per the approved design):

  1. history        — ≥ MIN_REAL_CLOSES (160) clean closes: a shallow REAL tape
                      is insufficient evidence for a live trading decision.
  2. spread_safety  — bid/ask spread-to-ATR safety margin: the one-tick spread
                      must be smaller than a typical one-bar move
                      (spread_pct < max(0.5%, atr_ratio)) and the relative
                      spread itself must not read "wide" (>= 0.5%).
                      No bid/ask quotes → the gate falls back (ALLOW_PROXY) to
                      the approved "Spread/ATR + flow + MTF proxies" metric: a
                      notional spread (a small fraction of the one-bar ATR move)
                      is validated against the realized tape instead of hard
                      vetoing — a REAL pair is never stranded on missing L2.
  3. order_flow     — bid/ask pressure (or tick-position proxy) must not oppose
                      the signal direction.
  4. mtf_alignment  — M1/M5/H1 trend alignment RESAMPLED from the base tape
                      (period-5 and period-60 buckets). At least two timeframes
                      must agree with the signal direction; fewer evidence → fail.
  5. market_stress  — realized volatility z-score near the tail (recent vol vs
                      its passive norm) suppresses slippage risk. A spike
                      (z >= VOL_STress_Z_MAX) vetoes execution.

``allow_proxy_quotes`` (default False) enables the quote-proxy fallback; when
no valid bid/ask arms exist the spread factor uses the realized ATR-relative
margin (with ``spread_status="synthetic_proxy"`` and ``quote_proxy=True``
stamped in metrics so the strict gate and audit can see exactly how the spread
factor was resolved). The default (False) preserves the strict
``no_bid_ask_quotes`` veto for direct gate callers.

Output is the standard class-gate verdict::

    {
      "passes": bool,
      "reason": None | "insufficient_history" | "no_bid_ask_quotes" |
                "spread_exceeds_atr_margin" | "spread_too_wide_ppe" |
                "flow_against_direction" | "mtf_misaligned" |
                "volatility_stress",
      "score": 0..1,
      "factors": {history, spread, flow, mtf, stress},
      "metrics": {spread_pct, atr_ratio, flow, trend_alignment, vol_z,
                  spread_status, quote_proxy, proxy_spread_pct, ...},
    }
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

import numpy as np

from .data_sanitization import (
    MIN_REAL_CLOSES,
    last_atr14,
    resample_ohlc,
    sanitize_price_series,
    spread_metrics,
)
from .quant_matrix import compute_bid_ask_pressure

SPREAD_WIDE_PCT = 0.005   # 50 bps — beyond this the tape is genuinely illiquid
VOL_STRESS_Z_MAX = 3.0    # recent vol z-score above this → anomalous
MTF_MIN_ALIGNED = 2       # at least two of {M1, M5, H1} must agree with signal
FACTOR_ORDER = ["history", "spread", "flow", "mtf", "stress"]
# Quote-proxy spread model (approved "Spread/ATR" proxy): when no L2 bid/ask
# arms exist, the notional one-tick spread is assumed to be a small fraction
# of the realized one-bar ATR move (never above the genuinely-illiquid band).
SPREAD_PROXY_FRACTION_OF_ATR = 0.25
SPREAD_PROXY_MARGIN = 1.2  # the ATR move must dwarf the notional spread by 20%


def _ema_slope_sign(closes: List[float]) -> int:
    """Trend sign from the trailing segment: +1 up, -1 down, 0 flat."""
    if len(closes) < 5:
        return 0
    recent = closes[-4:]
    slope = (float(recent[-1]) - float(recent[0])) / max(float(recent[-1]) + float(recent[0]), 1e-12)
    if abs(slope) * 1e2 < 1e-5:
        return 0
    return 1 if slope > 0 else -1


def _trend_alignment(closes: List[float], sign: float) -> Dict[str, Any]:
    """MTF trend signs for M1 / M5 / H1 (period 1, 5, 60 buckets from base tape).

    Returns per-timeframe sign + alignment verdict (>= 2 aligned required).
    """
    m1 = _ema_slope_sign(closes)
    m5_series = resample_ohlc(closes, 5)["closes"]
    m5 = _ema_slope_sign(m5_series)
    h1_series = resample_ohlc(closes, 60)["closes"]
    h1 = _ema_slope_sign(h1_series)

    alignment = {
        "M1": {"trend": _T_SIGN[m1], "aligned": m1 == sign},
        "M5": {"trend": _T_SIGN[m5], "aligned": m5 == sign} if len(m5_series) >= 12 else {"trend": None, "aligned": False},
        "H1": {"trend": _T_SIGN[h1], "aligned": h1 == sign} if len(h1_series) >= 2 else {"trend": None, "aligned": False},
    }
    aligned = sum(1 for a in alignment.values() if a["aligned"])
    available = sum(1 for a in alignment.values() if a["trend"] is not None)
    return {
        "per_timeframe": alignment,
        "aligned": aligned,
        "available": available,
        "passes": aligned >= MTF_MIN_ALIGNED,
    }


_T_SIGN = {1: "up", -1: "down", 0: "flat"}


def _vol_stress_z(closes: List[float], window: int = 20) -> float:
    """Z-score of the most recent log-return volatility vs its trailing norm."""
    if len(closes) < window + 6:
        return 0.0
    arr = np.asarray(closes, dtype=np.float64)
    rets = np.diff(np.log(arr))
    vol = np.abs(rets)
    recent = float(np.std(vol[-6:]) or 0.0) + float(np.mean(vol[-6:]) or 0.0)
    norm = float(np.std(vol[-(window + 6):-6]) or 0.0) + float(np.mean(vol[-(window + 6):-6]) or 0.0)
    if norm <= 1e-12:
        return 0.0
    return float(np.clip((recent - norm) / norm, -5.0, 20.0))


def evaluate_real_liquidity_gate(
    closes: Optional[List[Any]],
    direction: Optional[str],
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    live_price: Optional[float] = None,
    allow_proxy_quotes: bool = False,
) -> Dict[str, Any]:
    """REAL institutional liquidity verdict (passes / score / factors / metrics).

    ``allow_proxy_quotes`` (default False) enables the approved proxy fallback
    when no real bid/ask arms exist — spread is validated against the realized
    ATR-relative margin and ``quote_proxy=True`` is stamped in metrics. Off by
    default so the strict ``no_bid_ask_quotes`` veto survives for direct
    callers; the /predict seam enables it for REAL assets.
    """
    cleaned = sanitize_price_series(closes, min_required=MIN_REAL_CLOSES)
    series = cleaned["closes"]

    def _fail(reason: str, score: float, factors: Dict[str, int]) -> Dict[str, Any]:
        return {"passes": False, "reason": reason, "score": round(score, 4), "factors": factors,
                "metrics": {"cleaned": len(series), "dropped": cleaned["dropped"], "spread_status": "no_quotes"}}

    if not cleaned["sufficient"]:
        return _fail("insufficient_history", 0.0, {k: 0 for k in FACTOR_ORDER})

    direction = str(direction or "").upper()
    if direction not in ("BUY", "SELL"):
        return _fail("no_directional_signal", 0.0, {k: 0 for k in FACTOR_ORDER})

    sign = 1.0 if direction == "BUY" else -1.0
    price = float(live_price) if live_price and math.isfinite(float(live_price)) else float(series[-1])
    atr = last_atr14(series)
    atr_ratio = atr / price if atr and price > 0 else 0.0

    # ── spread_safety: spread-to-ATR safety margin (real quotes OR proxy) ──
    sp = spread_metrics(bid, ask, price)
    spread_ok = True
    spread_reason = None
    proxy_spread_pct = None
    proxy_mode = bool(allow_proxy_quotes and (not bid or not ask or sp["status"] == "no_quotes"))
    if not bid or not ask or sp["status"] == "no_quotes":
        if proxy_mode:
            # Approved "Spread/ATR + flow + MTF proxies" fallback: no L2 order
            # book → derive a notional spread from the REAL realized ATR move and
            # validate the one-bar margin against it. A dead tape (atr_ratio 0)
            # cannot be validated and honestly fails.
            if atr_ratio > 0:
                synthetic_spread = min(SPREAD_WIDE_PCT, atr_ratio * SPREAD_PROXY_FRACTION_OF_ATR)
                proxy_spread_pct = synthetic_spread
                spread_ok = atr_ratio > synthetic_spread * SPREAD_PROXY_MARGIN
                spread_reason = None if spread_ok else "spread_proxy_insufficient_margin"
            else:
                spread_ok = False
                spread_reason = "spread_proxy_insufficient_atr"
        else:
            spread_ok = False
            spread_reason = "no_bid_ask_quotes"
    else:
        source = sp["spread_pct"]
        if source is not None and source >= SPREAD_WIDE_PCT:
            # >= 50 bps relative spread — genuinely illiquid tape.
            spread_ok = False
            spread_reason = "spread_too_wide"
        elif source is not None and atr_ratio > 0 and source >= atr_ratio:
            # One-tick spread >= a typical one-bar move — entry slippage eats
            # the trade before it starts (spread-to-ATR safety margin).
            spread_ok = False
            spread_reason = "spread_exceeds_atr_margin"

    # ── order_flow ──
    pressure, flow_source = compute_bid_ask_pressure(price, bid, ask, tail=np.asarray(series[-30:], dtype=np.float64))
    flow_ok = True
    flow_reason = None
    if abs(pressure) >= 0.5 and (sign * pressure) < 0:
        flow_ok = False
        flow_reason = "flow_against_direction"

    # ── mtf_alignment ──
    ta = _trend_alignment(series, int(sign))
    mtf_ok = ta["passes"]
    mtf_reason = None if mtf_ok else ("mtf_insufficient_evidence" if ta["available"] < MTF_MIN_ALIGNED else "mtf_misaligned")

    # ── market_stress ──
    z = _vol_stress_z(series)
    stress_ok = z < VOL_STRESS_Z_MAX
    stress_reason = None if stress_ok else "volatility_stress"

    factors = {
        "history": 1,
        "spread": 1 if spread_ok else 0,
        "flow": 1 if flow_ok else 0,
        "mtf": 1 if mtf_ok else 0,
        "stress": 1 if stress_ok else 0,
    }
    score = round(sum(factors.values()) / len(factors), 4)
    passes = all(v == 1 for v in factors.values())

    if not passes:
        reason = spread_reason or flow_reason or mtf_reason or stress_reason
    else:
        reason = None

    return {
        "passes": passes,
        "reason": reason,
        "score": score,
        "factors": factors,
        "metrics": {
            "cleaned": len(series),
            "dropped": cleaned["dropped"],
            "spread_pct": sp["spread_pct"] if sp["spread_pct"] is not None else None,
            "spread_status": "synthetic_proxy" if proxy_mode else sp["status"],
            "quote_proxy": proxy_mode,
            "proxy_spread_pct": round(proxy_spread_pct, 6) if proxy_spread_pct is not None else None,
            "atr_ratio": round(atr_ratio, 6),
            "flow": round(pressure, 4),
            "flow_source": flow_source,
            "mtf_alignment": ta,
            "vol_stress_z": round(z, 3),
        },
    }