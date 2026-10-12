"""
data_sanitization.py — ROLLING-WINDOW SANITIZATION (STRICT QUALITY UPGRADE)

Every signal evaluation runs through this layer BEFORE any tier/confidence is
trusted. It guarantees:

  * Non-finite / non-positive values (NaN, ±inf, 0, negatives) are dropped
    from price series and candle logs — the engine never feeds garbage into
    the 96.5% confluence math.
  * Per-asset-class minimum window enforcement:
      - REAL (institutional) assets require MIN_REAL_CLOSES (160) clean closes
        before the liquidity gate may pass — a shallow REAL tape is
        insufficient evidence.
      - OTC (synthetic) assets use an optimized rolling tick window
        (MIN_OTC_TICKS, 30) so fast micro-structure filters stay responsive.
  * Legitimate MTF resampling for the REAL liquidity gate: period-5 (M5) and
    period-60 (H1) OHLC aggregates are derived from the base M1 tape so trend
    alignment can be checked WITHOUT any extra feed.

The sanitizer is deterministic, input-focused (no network), and every output
carries ``dropped`` counts so the audit trail can show what was discarded.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

MIN_REAL_CLOSES = 160   # REAL institutional minimum clean-window (1H of M1s)
MIN_OTC_TICKS = 30      # OTC synthetic optimized rolling-tick minimum
MIN_CRYPTO_TICKS = 60   # CRYPTO 24/7 tape: deeper than OTC (trend + breakout
                        # confirmation needs run-rate context), far shallower
                        # than REAL (no session/book reconstruction needed).
M1_PER_M5 = 5           # 5 base bars → M5 bucket
M1_PER_H1 = 60          # 60 base bars → H1 bucket

# Per-class minimum rolling window, keyed by execution asset class.
MIN_CLOSES_BY_CLASS: Dict[str, int] = {
    "REAL": MIN_REAL_CLOSES,
    "OTC": MIN_OTC_TICKS,
    "CRYPTO": MIN_CRYPTO_TICKS,
}


def minimum_closes_for_class(asset_class: Any) -> int:
    """Minimum clean closes required for an asset class.

    Unknown classes fall back to the OTC window — the shallow, conservative
    default that cannot manufacture a deep-history claim.
    """
    return MIN_CLOSES_BY_CLASS.get(str(asset_class).upper(), MIN_OTC_TICKS)


def _finite_positive(value: Any) -> bool:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f) and f > 0.0


def sanitize_price_series(
    closes: Optional[List[Any]],
    *,
    min_required: int = MIN_REAL_CLOSES,
) -> Dict[str, Any]:
    """Drop non-finite/<=0 values from a price series.

    Returns::
        {
          "closes":      cleaned finite-positive floats (list),
          "original":    count of input values,
          "dropped":     count of values discarded (NaN/inf/<=0),
          "sufficient":  len(cleaned) >= min_required,
        }
    """
    raw = list(closes or [])
    cleaned: List[float] = []
    dropped = 0
    for v in raw:
        if _finite_positive(v):
            cleaned.append(float(v))
        else:
            dropped += 1
    return {
        "closes": cleaned,
        "original": len(raw),
        "dropped": dropped,
        "sufficient": len(cleaned) >= int(min_required or 0),
    }


def sanitize_candles(
    candles: Optional[List[Any]],
    *,
    ohlc_keys: Tuple[str, str, str, str] = ("open", "high", "low", "close"),
) -> Dict[str, Any]:
    """Drop candle rows where ANY OHLC value is non-finite or non-positive.

    Returns::
        {
          "candles":    cleaned candle rows,
          "original":   count of input candles,
          "dropped":    count of rows discarded,
          "sufficient": len(cleaned) >= MIN_REAL_CLOSES,
        }
    """
    raw = list(candles or [])
    o_key, h_key, l_key, c_key = ohlc_keys
    cleaned: List[Any] = []
    dropped = 0
    for row in raw:
        if isinstance(row, dict) and all(
            _finite_positive(row.get(k)) for k in (o_key, h_key, l_key, c_key)
        ):
            cleaned.append(row)
        else:
            dropped += 1
    return {
        "candles": cleaned,
        "original": len(raw),
        "dropped": dropped,
        "sufficient": len(cleaned) >= MIN_REAL_CLOSES,
    }


def sufficient_history(closes: List[Any], asset_class: str = "REAL") -> Dict[str, Any]:
    """Enforce the per-asset-class minimum rolling window.

    - REAL   requires >= MIN_REAL_CLOSES (160) clean closes.
    - OTC    requires >= MIN_OTC_TICKS (30).
    - CRYPTO requires >= MIN_CRYPTO_TICKS (60).

    Returns a sanitized-window report consumed by the class strategies::
        {
          "sufficient": bool,
          "minimum":    int,
          "available":  int,
          "reason":     None | "insufficient_history",
        }
    """
    cleaned = [float(c) for c in closes if _finite_positive(c)]
    available = len(cleaned)
    minimum = minimum_closes_for_class(asset_class)
    sufficient = available >= minimum
    return {
        "sufficient": sufficient,
        "minimum": minimum,
        "available": available,
        "reason": None if sufficient else "insufficient_history",
    }


def resample_ohlc(closes: List[Any], bucket: int) -> Dict[str, Any]:
    """Aggregate a base series into ``bucket``-bar OHLC buckets (legit MTF resample).

    Used to derive M5 (bucket=5) and H1 (bucket=60) from a base M1 tape.

    Returns::
        {
          "opens":   list,
          "highs":   list,
          "lows":    list,
          "closes":  list,
          "buckets": count of full buckets produced,
        }
    """
    prices = [float(c) for c in closes if _finite_positive(c)]
    b = max(1, int(bucket))
    opens: List[float] = []
    highs: List[float] = []
    lows: List[float] = []
    closings: List[float] = []
    for i in range(0, max(len(prices) - b + 1, 0), b):
        chunk = prices[i:i + b]
        if len(chunk) < b:
            continue
        opens.append(chunk[0])
        highs.append(max(chunk))
        lows.append(min(chunk))
        closings.append(chunk[-1])
    return {
        "opens": opens,
        "highs": highs,
        "lows": lows,
        "closes": closings,
        "buckets": len(closings),
    }


def last_atr14(closes: List[Any]) -> Optional[float]:
    """Approximate 14-bar ATR from clean closes (high-flow proxy, no TA-Lib).

    Uses the mean absolute bar-to-bar move over the LAST 14 clean closes.
    Returns None when insufficient data.
    """
    prices = [float(c) for c in closes if _finite_positive(c)]
    if len(prices) < 15:
        return None
    recent = prices[-15:]
    diffs = [abs(recent[i] - recent[i - 1]) for i in range(1, len(recent))]
    atr = sum(diffs) / len(diffs)
    return atr if math.isfinite(atr) and atr > 0.0 else None


def spread_metrics(
    bid: Any,
    ask: Any,
    live_price: Any = None,
) -> Dict[str, Any]:
    """Spread / slippage-risk metrics from the forwarded tape.

    Returns::
        {
          "mid":         float | None,
          "spread":      absolute | None,
          "spread_pct":  relative to mid | None,
          "spread_ratio_atr": spread_pct / (ATR rel to price) | None,
          "status":      "tight" | "wide" | "no_quotes",
        }
    """
    b = _finite_positive(bid) and float(bid) or None
    a = _finite_positive(ask) and float(ask) or None
    base = _finite_positive(live_price) and float(live_price) or (b or a)
    if b is None or a is None or base is None or b > a:
        return {
            "mid": None, "spread": None, "spread_pct": None,
            "spread_ratio_atr": None, "status": "no_quotes",
        }
    mid = (b + a) / 2.0
    spread = round(a - b, 12)
    spread_pct = spread / mid if mid > 0 else None
    return {
        "mid": round(mid, 12),
        "spread": spread,
        "spread_pct": spread_pct,
        "spread_ratio_atr": None,
        "status": "tight" if spread_pct is not None and spread_pct < 0.005 else "wide",
    }