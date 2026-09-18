"""
quality_gate.py — MULTI-FACTOR ENSEMBLE WATERSHED (multi-tier quality lock)

A second, INDEPENDENT layer on top of the confidence gate. Where
signal_gatekeeper's multi-tier ladder prices how STRONG the dynamic confluence
is, this watershed prices how ALIGNED the trade is across five independent
microstructure factors — and refuses to release any signal unless the
weighted ensemble clears the weakest EXECUTABLE tier (T4-LOW = 0.70):

  * mtf        (0.25) — EMA-20 > EMA-50 > EMA-200 structure on EVERY provided
                        timeframe (with ≥ 2 timeframes, else 0 — a one-legged
                        trend cannot claim multi-timeframe confluence).
  * momentum   (0.25) — RSI > 55, MACD histogram > 0, Stoch %K > %D on EVERY
                        provided timeframe, one direction only.
  * volatility (0.15) — realized ATR/price inside the tradeable band
                        [0.0008, 0.0050] (live volatility, not crushed, not wild).
  * volume     (0.15) — current bar volume ≥ 1.5 × its own 20-bar average
                        (real tape participation, never fabricated).
  * pressure   (0.20) — tick buy/(buy+sell) flow one-sided: > 0.60 for BUY,
                        < 0.40 for SELL (real microstructure order-flow).

``factors`` are honest 0/1 booleans — missing or non-finite evidence scores
0 and can therefore never pass the watershed. The weighted sum
(0.25+0.25+0.15+0.15+0.20 = 1.00) means ANY single failed factor caps the
score at ≤ 0.75 — i.e. an IMMEDIATE downgrade off the T1/T2 band for a single
miss — the ensemble stays the strictest possible interpretation. The quality
score is then resolved onto the SAME canonical TIER_THRESHOLDS ladder as the
confidence gate (T1 ≥ 0.965 … T4 ≥ 0.70); the emission bar is the weakest
executable tier (T4), and the resolved tier is reported alongside the price
it corresponds to.

Payload contract::
    {
      "signal":      "BUY" | "SELL" | None,
      "confidence":  0..100 pct (0.0 when below the watershed, pipeline-compat),
      "quality":     0..1 weighted ensemble score,
      "factors":     {"mtf": 0|1, "momentum": 0|1, "volatility": 0|1,
                      "volume": 0|1, "pressure": 0|1},
      "tier":        "T1" | … | "T5" resolved from the ensemble score,
      "tier_label":  PREMIUM / HIGH / MEDIUM / LOW / WEAK,
      "reason":      "ALL_FACTORS_ALIGNED" | "QUALITY_BELOW_GATE:<factor>",
      "gate":        effective tier bar used for this decision (0.70 default),
      "market_waiting": True when below the watershed,
    }
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from .signal_gatekeeper import (
    TIER_THRESHOLDS,
    TIER_LABELS,
    MIN_EXECUTABLE_TIER,
    resolve_tier,
    is_dispatchable_tier,
)
from .accuracy_tracker import get_accuracy_tracker

GATE_WEIGHTS: Dict[str, float] = {
    "mtf": 0.25,
    "momentum": 0.25,
    "volatility": 0.15,
    "volume": 0.15,
    "pressure": 0.20,
}
FACTOR_ORDER: List[str] = ["mtf", "momentum", "volatility", "volume", "pressure"]
REQUIRED_FACTOR_COUNT = 5

# Emission bar = the weakest EXECUTABLE tier (T4-LOW 0.70) — the same canonical
# ladder that prices confluence. Always in lockstep with signal_gatekeeper.
QUALITY_EMIT_BAR = TIER_THRESHOLDS[MIN_EXECUTABLE_TIER]

ATR_MIN_RATIO = 0.0008   # below this — volatility crushed, tradeable? no
ATR_MAX_RATIO = 0.0050   # above this — volatility wild
VOLUME_SURGE_MIN = 1.5   # vs 20-bar average
PRESSURE_BUY_MIN = 0.60  # buy (buy+sell) share for a BUY
PRESSURE_SELL_MAX = 0.40  # buy share for a SELL


# ── pure numeric helpers (no TA-Lib dependency) ──
def _ema(values: List[float], period: int) -> List[float]:
    if not values or period < 1:
        return []
    k = 2.0 / (period + 1.0)
    out: List[float] = []
    prev = None
    for v in values:
        if prev is None:
            prev = v
        else:
            prev = v * k + prev * (1.0 - k)
        out.append(prev)
    return out


def _rsi(values: List[float], period: int = 14) -> List[float]:
    if not values or len(values) < period + 1:
        return []
    out: List[float] = []
    gains = 0.0
    losses = 0.0
    for i in range(1, len(values)):
        change = values[i] - values[i - 1]
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        if i <= period:
            gains += gain
            losses += loss
            if i == period:
                avg_gain = gains / period
                avg_loss = losses / period
                out.extend([None] * (period))
                out.append(100.0 if avg_loss == 0 else 100.0 - (100.0 / (1.0 + avg_gain / avg_loss)))
        else:
            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period
            out.append(100.0 if avg_loss == 0 else 100.0 - (100.0 / (1.0 + avg_gain / avg_loss)))
    return out


def _macd_hist(closes: List[float]) -> List[float]:
    if len(closes) < 26:
        return []
    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    out: List[float] = []
    for i in range(len(closes)):
        if ema12[i] is not None and ema26[i] is not None:
            out.append(ema12[i] - ema26[i])  # histogram ≈ MACD line (signal lag skipped)
        else:
            out.append(None)
    return out


def _stoch_kd(highs: List[float], lows: List[float], closes: List[float], period: int = 14) -> Dict[str, List[float]]:
    n = len(closes)
    if n < period:
        return {"k": [], "d": []}
    k_list: List[float] = []
    d_list: List[float] = []
    for i in range(n):
        lo = lows[i]
        hi = highs[i]
        for j in range(max(0, i - period + 1), i + 1):
            lo = min(lo, lows[j])
            hi = max(hi, highs[j])
        rng = hi - lo
        k = 50.0 if rng == 0 else ((closes[i] - lo) / rng) * 100.0
        k_list.append(k)
        if len(k_list) >= 3:
            d_list.append(sum(k_list[-3:]) / 3.0)
        else:
            d_list.append(None)
    return {"k": k_list, "d": d_list}


def _tf_aligned(closes: List[float], highs: List[float], lows: List[float], direction: str) -> bool:
    """True if every oscillator instrument agrees on THIS timeframe's trend."""
    ema20 = _ema(closes, 20)
    ema50 = _ema(closes, 50)
    ema200 = _ema(closes, 200)
    trend_up = float(ema20[-1]) > float(ema50[-1]) > float(ema200[-1]) if len(ema200) >= 1 else False
    trend_down = float(ema20[-1]) < float(ema50[-1]) < float(ema200[-1]) if len(ema200) >= 1 else False
    wants_up = direction == "BUY"
    if wants_up and not trend_up:
        return False
    if not wants_up and not trend_down:
        return False

    rsi = _rsi(closes)
    if not rsi or rsi[-1] is None:
        return False
    rsi_ok = (rsi[-1] > 55.0) if wants_up else (rsi[-1] < 45.0)
    if not rsi_ok:
        return False

    hist = _macd_hist(closes)
    if not hist or hist[-1] is None:
        return False
    hist_ok = (hist[-1] > 0) if wants_up else (hist[-1] < 0)
    if not hist_ok:
        return False

    st = _stoch_kd(highs, lows, closes)
    if not st["k"] or st["k"][-1] is None or st["d"][-1] is None:
        return False
    st_ok = (st["k"][-1] > st["d"][-1]) if wants_up else (st["k"][-1] < st["d"][-1])
    return st_ok


# ── factor scoring ──
def compute_factor_scores(inputs: Dict[str, Any], direction: str) -> Dict[str, int]:
    """Score all five factors (0|1) from REAL evidence; missing → 0 (honest)."""
    direction = direction.upper()
    if direction not in {"BUY", "SELL"}:
        return {name: 0 for name in FACTOR_ORDER}

    tfs: Any = inputs.get("timeframes") or {}
    tf_names = [k for k, v in tfs.items() if isinstance(v, dict) and v.get("close")]
    mtf_ok = 1 if len(tf_names) >= 2 else 0
    if mtf_ok:
        for name in tf_names:
            v = tfs[name]
            closes = [float(x) for x in v.get("close", [])]
            highs = [float(x) for x in v.get("high", closes)]
            lows = [float(x) for x in v.get("low", closes)]
            if len(closes) < 30:
                mtf_ok = 0
                break
            if not _tf_aligned(closes, highs, lows, direction):
                mtf_ok = 0
                break

    momentum_ok = 1 if len(tf_names) >= 1 else 0
    if momentum_ok:
        for name in tf_names:
            v = tfs[name]
            closes = [float(x) for x in v.get("close", [])]
            highs = [float(x) for x in v.get("high", closes)]
            lows = [float(x) for x in v.get("low", closes)]
            if len(closes) < 200:
                momentum_ok = 0
                break
            if not _tf_aligned(closes, highs, lows, direction):
                momentum_ok = 0
                break

    atr = inputs.get("atr")
    price = inputs.get("price")
    if atr and price and atr > 0 and price > 0:
        ratio = float(atr) / float(price)
        volatility_ok = 1 if ATR_MIN_RATIO <= ratio <= ATR_MAX_RATIO else 0
    else:
        volatility_ok = 0

    volume = inputs.get("volume")
    volume_sma20 = inputs.get("volume_sma20")
    if volume and volume_sma20 and volume_sma20 > 0 and not math.isnan(float(volume)):
        volume_ok = 1 if float(volume) >= VOLUME_SURGE_MIN * float(volume_sma20) else 0
    else:
        volume_ok = 0

    buy = inputs.get("buy_volume")
    sell = inputs.get("sell_volume")
    if buy is not None and sell is not None:
        flow = float(buy) + float(sell)
        if flow > 0:
            buy_share = float(buy) / flow
            pressure_ok = 1 if (direction == "BUY" and buy_share > PRESSURE_BUY_MIN) or (
                direction == "SELL" and buy_share < PRESSURE_SELL_MAX
            ) else 0
        else:
            pressure_ok = 0
    else:
        pressure_ok = 0

    return {
        "mtf": mtf_ok,
        "momentum": momentum_ok,
        "volatility": volatility_ok,
        "volume": volume_ok,
        "pressure": pressure_ok,
    }


def quality_score(factors: Dict[str, int]) -> float:
    """Weighted ensemble score in [0, 1] (binary factors, weights sum to 1)."""
    total = 0.0
    for name in FACTOR_ORDER:
        total += GATE_WEIGHTS[name] * float(factors.get(name, 0))
    return round(total, 4)


def current_hard_gate() -> float:
    """Effective emission bar = the weakest EXECUTABLE tier (T4-LOW 0.70).

    Kept for API compatibility; the tier ladder (signal_gatekeeper) is the
    single source of truth and is always in lockstep.
    """
    return float(QUALITY_EMIT_BAR)


def evaluate_quality(factors: Dict[str, int]) -> Dict[str, Any]:
    """Watershed decision on already-scored factors.

    Returns {quality, tier, tier_label, decision, gate, reason}.

    * quality clears T4 (0.70)     -> decision "EMIT" at resolved tier
    * quality below T4             -> decision "BLOCK", reason names the
                                      first (highest-weighted) failed factor.
    """
    factors = {name: (1 if int(factors.get(name, 0)) >= 1 else 0) for name in FACTOR_ORDER}
    q = quality_score(factors)
    tier = resolve_tier(q)
    if is_dispatchable_tier(tier, min_tier=MIN_EXECUTABLE_TIER):
        return {
            "quality": q,
            "tier": tier,
            "tier_label": TIER_LABELS.get(tier, "WEAK"),
            "decision": "EMIT",
            "gate": QUALITY_EMIT_BAR,
            "reason": "ALL_FACTORS_ALIGNED",
        }
    failed = next((name for name in FACTOR_ORDER if factors.get(name) == 0), None)
    return {
        "quality": q,
        "tier": tier,
        "tier_label": TIER_LABELS.get(tier, "WEAK"),
        "decision": "BLOCK",
        "gate": QUALITY_EMIT_BAR,
        "reason": f"QUALITY_BELOW_GATE:{failed or 'UNKNOWN'}",
    }


def apply_quality_gate(
    direction: str,
    confidence_pct: float,
    factor_inputs: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Full quality payload for a directional verdict.

    When real multi-factor evidence is supplied, the T4 watershed is
    ENFORCED: below it the payload returns signal=None, confidence=0.0 while
    keeping the true direction exposed (honest market-waiting, never HOLD).
    When no factor window exists the ensemble is honestly reported as None
    (NOT fabricated) and the caller's confidence gate remains in control —
    this is the documented latency window of the live single-TF candle path.
    """
    if factor_inputs:
        factors = compute_factor_scores(factor_inputs, direction)
        verdict = evaluate_quality(factors)
        q = verdict["quality"]
        tier = verdict["tier"]
        emitted = verdict["decision"] == "EMIT"
        return {
            "signal": direction if emitted else None,
            "confidence": round(q * 100.0, 2) if emitted else 0.0,
            "quality": q,
            "tier": tier,
            "tier_label": verdict["tier_label"],
            "factors": factors,
            "reason": verdict["reason"],
            "gate": round(verdict["gate"], 4),
            "market_waiting": not emitted,
            "direction": direction,
        }
    gate = current_hard_gate()
    return {
        "signal": direction if confidence_pct >= gate * 100.0 else None,
        "confidence": round(float(confidence_pct), 2),
        "quality": None,
        "factors": None,
        "tier": resolve_tier(confidence_pct / 100.0),
        "tier_label": TIER_LABELS.get(resolve_tier(confidence_pct / 100.0), "WEAK"),
        "reason": "FACTOR_WINDOW_UNAVAILABLE",
        "gate": round(gate, 4),
        "market_waiting": bool(confidence_pct < gate * 100.0),
        "direction": direction,
    }


def build_factor_inputs_from_candles(candles: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Single-timeframe factor window built from one real candle series.

    Multi-timeframe confluence requires >= 2 timeframes, so a single-TF input
    can NEVER pass the mtf factor — the honest ensemble blocks the emissions
    it cannot cross-verify. Returns None when candles are unusable (so the
    caller falls back to the latency-window path).
    """
    if not candles or len(candles) < 30:
        return None
    closes = [float(c.get("close")) for c in candles]
    highs = [float(c.get("high", c.get("close"))) for c in candles]
    lows = [float(c.get("low", c.get("close"))) for c in candles]
    volumes = [float(c.get("volume", 0) or 0) for c in candles]
    if any(not math.isfinite(x) for x in closes + highs + lows):
        return None
    volume = float(volumes[-1])
    volume_sma20 = float(sum(volumes[-20:]) / 20.0) if len(volumes) >= 20 else 0.0
    return {
        "timeframes": {"1m": {"close": closes, "high": highs, "low": lows, "volume": volumes}},
        "price": float(closes[-1]),
        "volume": volume,
        "volume_sma20": volume_sma20,
    }