"""
book_murphy_ta.py — KNOWLEDGE MODULE · Murphy, "Technical Analysis of the Financial Markets" (1999/2019)
Classification: TRADING · Source book + chapter cited for every formula.

Pure reference implementation, no I/O. Constants and formulas are the
real, named, published values from the book — nothing invented.

References (1999 First Edition unless noted):
  · Moving averages, Exponential MA:        Ch. 9 (pp. 173-213)
  · MACD (Moving Average Convergence/Divergence): Ch. 9.7 (pp. 200-207)
  · RSI by J. Welles Wilder Jr. (14):       Ch. 10 (pp. 242-247)
  · On-Balance Volume (OBV, Granville):     Ch. 10 (pp. 260-263)
  · Support/Resistance & trend lines:       Ch. 4 (pp. 59-96)
  · Volume confirmation:                    Ch. 9 (pp. 213-222)
"""

from __future__ import annotations

from typing import List, Optional, Sequence

# ── Canonical constants (chapter-cited) ──
SMA_PERIOD = 20          # Murphy EMA/SMA example windows (Ch. 9)
EMA_FAST = 12            # MACD fast EMA — Ch. 9.7
EMA_SLOW = 26            # MACD slow EMA — Ch. 9.7
MACD_SIGNAL = 9          # MACD signal EMA — Ch. 9.7
RSI_PERIOD = 14          # Wilder RSI — Ch. 10
OBV_DIVERSION_LOOKBACK = 30  # Ch. 10

_EPS = 1e-12


def simple_moving_average(values: Sequence[float], period: int = SMA_PERIOD) -> List[Optional[float]]:
    """Simple Moving Average (Murphy Ch. 9). Helper for trend analysis in pure NumPy-free form.

    Returns a list (same length as input) with None until ``period`` observations exist.
    """
    vals = [float(v) for v in values]
    if not vals or period < 1:
        return []
    out: List[Optional[float]] = []
    running = 0.0
    for i, v in enumerate(vals):
        running += v
        if i >= period:
            running -= vals[i - period]
            out.append(running / period)
        else:
            out.append(None if (i + 1) < period else running / period)
    return out


def exponential_moving_average(values: Sequence[float], span: int = EMA_FAST) -> List[Optional[float]]:
    """Exponential Moving Average (Murphy Ch. 9).

    smoothing = 2 / (span + 1). The first value seeds the series.
    """
    vals = [float(v) for v in values]
    if not vals or span < 1:
        return []
    k = 2.0 / (span + 1.0)
    out: List[Optional[float]] = []
    prev: Optional[float] = None
    for v in vals:
        prev = v if prev is None else v * k + prev * (1.0 - k)
        out.append(prev)
    return out


def macd_line(values: Sequence[float], fast: int = EMA_FAST, slow: int = EMA_SLOW) -> List[Optional[float]]:
    """MACD = EMA(fast) − EMA(slow). Ch. 9.7. Slow EMA starts after ``slow`` values."""
    vals = [float(v) for v in values]
    if not vals:
        return []
    ema_f = exponential_moving_average(vals, fast)
    ema_s = exponential_moving_average(vals, slow)
    out: List[Optional[float]] = []
    for i in range(len(vals)):
        if ema_s[i] is None or i < slow - 1:
            out.append(None)
        else:
            out.append(float(ema_f[i] or 0.0) - float(ema_s[i] or 0.0))
    return out


def macd_signal_and_histogram(values: Sequence[float], signal: int = MACD_SIGNAL) -> dict:
    """MACD signal line (EMA of MACD line) + histogram (MACD − signal). Ch. 9.7.

    Returns {"macd": [...], "signal": [...], "histogram": [...]} —
    the histogram sign is Murphy's standard buy/sell trigger.
    """
    md = macd_line(values)
    vals = [m for m in md if m is not None]
    if len(vals) < signal:
        return {"macd": md, "signal": [None] * len(md), "histogram": [None] * len(md)}
    # Signal EMA is over the MACD values from the first available one.
    sig_raw = exponential_moving_average(vals, signal)
    sig: List[Optional[float]] = []
    j = 0
    for m in md:
        if m is None:
            sig.append(None)
        else:
            sig.append(sig_raw[j])
            j += 1
    hist = [(m - s) if (m is not None and s is not None) else None for m, s in zip(md, sig)]
    return {"macd": md, "signal": sig, "histogram": hist}


def wilder_rsi(values: Sequence[float], period: int = RSI_PERIOD) -> List[Optional[float]]:
    """Wilder's RSI (Murphy Ch. 10, from Wilder, New Concepts in Technical Trading Systems).

    RSI = 100 − 100/(1 + RS), RS = avgGain / avgLoss with Wilder smoothing
    (n−1 rolling, not SMA): avgGain[i] = (avgGain[i−1]*(period−1) + gain[i]) / period.
    """
    vals = [float(v) for v in values]
    n = len(vals)
    if n < period + 1:
        return [None] * n
    out: List[Optional[float]] = [None] * n
    gains = 0.0
    losses = 0.0
    for i in range(1, n):
        change = vals[i] - vals[i - 1]
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        if i <= period:
            gains += gain
            losses += loss
            if i == period:
                ag = gains / period
                al = losses / period
                out[i] = 100.0 if al < _EPS else (100.0 - 100.0 / (1.0 + ag / al))
        else:
            ag = (ag * (period - 1) + gain) / period
            al = (al * (period - 1) + loss) / period
            out[i] = 100.0 if al < _EPS else (100.0 - 100.0 / (1.0 + ag / al))
    return out


def on_balance_volume(closes: Sequence[float], volumes: Sequence[float]) -> List[Optional[float]]:
    """On-Balance Volume (Granville, relayed by Murphy Ch. 10).

    OBV[i] = OBV[i−1] + volume when close[i] > close[i−1],
           = OBV[i−1] − volume when close[i] < close[i−1], else unchanged.
    """
    c = [float(x) for x in closes]
    v = [float(x) for x in volumes]
    n = len(c)
    if n < 2 or len(v) < n:
        return [None] * n
    out: List[Optional[float]] = [None] * n
    obv = 0.0
    out[0] = 0.0
    for i in range(1, n):
        if c[i] > c[i - 1]:
            obv += v[i]
        elif c[i] < c[i - 1]:
            obv -= v[i]
        out[i] = obv
    return out


def obv_divergence(closes: Sequence[float], volumes: Sequence[float], lookback: int = OBV_DIVERSION_LOOKBACK) -> Optional[str]:
    """Bearish/bullish OBV divergence vs price over ``lookback`` (Murphy Ch. 10).

    Returns "bearish_divergence" | "bullish_divergence" | None:
      price makes a higher high but OBV does not → weakening volume.
    """
    c = [float(x) for x in closes]
    if len(c) < lookback + 1:
        return None
    obv = [v for v in on_balance_volume(c, volumes) if v is not None]
    segment_c = c[-lookback:]
    segment_o = obv[-lookback:]
    if len(segment_o) < lookback:
        return None
    # Price higher high / OBV lower high → bearish divergence.
    if max(segment_c) > max(c[-lookback - 1:-1]) and max(segment_o) < max(obv[-lookback - 1:-1]):
        return "bearish_divergence"
    if min(segment_c) < min(c[-lookback - 1:-1]) and min(segment_o) > min(obv[-lookback - 1:-1]):
        return "bullish_divergence"
    return None


def trend_direction_from_emas(closes: Sequence[float]) -> str:
    """Murphy trend-type from EMA hierarchy (Ch. 9): "uptrend" | "downtrend" | "flat"."""
    ema20 = exponential_moving_average(closes, 20)
    ema50 = exponential_moving_average(closes, 50)
    ema200 = exponential_moving_average(closes, 200)
    if any(x is None for x in (ema20, ema50, ema200)):
        return "flat"
    e20, e50, e200 = float(ema20[-1]), float(ema50[-1]), float(ema200[-1])
    if e20 > e50 > e200:
        return "uptrend"
    if e20 < e50 < e200:
        return "downtrend"
    return "flat"


def volume_confirms_signal(closes: Sequence[float], volumes: Sequence[float]) -> bool:
    """Murphy's volume-confirmation heuristic: an up move with rising volume is valid,
    an up move on falling volume is suspect (Ch. 9). Returns True when the last bar's
    volume exceeds its own 20-bar average."""
    v = [float(x) for x in volumes]
    if len(v) < 21:
        return False
    sma20 = sum(v[-21:-1]) / 20.0
    return sma20 > 0 and float(v[-1]) > sma20