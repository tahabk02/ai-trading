"""
expiry_engine.py — deterministic expiry + price-target regression vectors.

Pure, no-fabrication math for point-in-time trade boundaries:

  * a sub-minute-capable horizon set ``HORIZON_SECONDS = (5, 15, 30, 60, 300)``
  * a boundary-aligned expiry timestamp (``align_expiry_ms``)
  * the price-target regression ``P_target = f(X_t, Δt)`` with a residual-Gaussian
    confidence band and a MODELED directional-hold probability.

HONESTY CONTRACT (docs/DATA-PROVENANCE-POLICY.md)
-------------------------------------------------
The tape carries the only truth. When it is too short (< ``MIN_REGRESSION_SAMPLES``)
or degenerate (zero index variance / zero residual variance) the regression
returns ``available=False`` and every derived value is ``None`` — the engine
WITHHOLDS rather than inventing a number. The hold probability is a MODELED
estimate: ``probability_basis`` discloses how it was derived, so no consumer can
mistake it for a calibrated frequency, and it is never a surrogate for an un-run
model. A probability is only reported when a real residual σ exists.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Sequence, Tuple

import numpy as np

# Supported regression horizons (SECONDS). Sub-minute capable and independent of
# the minute-based contract table in signal_lock.py.
HORIZON_SECONDS: Tuple[int, ...] = (5, 15, 30, 60, 300)

# Minimum finite samples before a regression is considered to have a basis.
MIN_REGRESSION_SAMPLES = 5

# z-score for the confidence band (≈95% two-sided normal interval).
DEFAULT_Z = 1.959963984540054

# Disclosure string stamped on the modeled probability — the "what is this
# number" label the provenance policy requires next to any probability-shaped
# value.
PROBABILITY_BASIS = "regression_residual_gaussian"

_EPS = 1e-12

_CRYPTO = frozenset({"BTC/USD", "ETH/USD"})


def symbol_price_digits(symbol: str) -> int:
    """Decimal precision per asset class: crypto → 2, JPY quote → 3, else 5."""
    sym = (symbol or "").strip().upper()
    if sym in _CRYPTO:
        return 2
    try:
        quote = sym.split("/")[1]
    except IndexError:
        return 5
    return 3 if quote == "JPY" else 5


def resolve_horizon_seconds(value: Any) -> int:
    """Snap an arbitrary horizon request onto the supported SECOND set.

    Unknown/None/≤0 falls back to the shortest supported horizon (floor bias):
    an unsupported 45s request resolves to 30s, never silently to 60s.
    """
    try:
        iv = int(float(value))
    except (TypeError, ValueError):
        return HORIZON_SECONDS[0]
    if iv <= 0:
        return HORIZON_SECONDS[0]
    if iv in HORIZON_SECONDS:
        return iv
    return min(HORIZON_SECONDS, key=lambda s: (abs(s - iv), s))


def align_expiry_ms(entry_ms: int, delta_seconds: int) -> int:
    """Smallest Δt boundary at/after ``entry + Δt`` (boundary-aligned expiry).

    Boundaries sit at integer multiples of the horizon. A 5s contract entered at
    ``t=1000ms`` expires at ``t+5000=6000ms`` → snapped to the ``10000ms``
    boundary, so the contract always lands ON a timeframe edge rather than
    mid-bar. An entry already exactly on a boundary is preserved.
    """
    try:
        e = int(entry_ms)
        d = int(delta_seconds)
    except (TypeError, ValueError) as exc:  # pragma: no cover - defensive
        raise ValueError("entry_ms and delta_seconds must be integers") from exc
    if d <= 0:
        raise ValueError("delta_seconds must be positive")
    delta_ms = d * 1000
    target = e + delta_ms
    aligned = ((target + delta_ms - 1) // delta_ms) * delta_ms
    return int(aligned)


def build_expiry_boundaries(entry_ms: int, horizon_seconds: int) -> Dict[str, int]:
    """Entry + boundary-aligned expiry for a horizon (ms)."""
    e = int(entry_ms)
    d = int(horizon_seconds)
    return {
        "entry_ms": e,
        "expiry_ms": align_expiry_ms(e, d),
        "horizon_seconds": d,
    }


def _normal_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _withheld(samples: int, horizon_seconds: int, reason: str) -> Dict[str, Any]:
    """The honest empty state — every derived value None, never a zero-fill."""
    return {
        "available": False,
        "reason": reason,
        "direction": None,
        "horizon_seconds": int(horizon_seconds),
        "entry_price": None,
        "predicted_end_price": None,
        "confidence_margin": None,
        "confidence_lower": None,
        "confidence_upper": None,
        "hold_probability": None,
        "probability_basis": None,
        "samples": int(samples),
        "residual_sigma": None,
        "regression": None,
    }


def compute_price_target_regression(
    closes: Sequence[float],
    *,
    entry_price: Optional[float],
    horizon_seconds: int,
    direction: Optional[str] = None,
    symbol_digits: int = 5,
    z: float = DEFAULT_Z,
) -> Dict[str, Any]:
    """Regress the real close tape and project it ``horizon_seconds`` ahead.

    Model: ordinary least squares over the (1 Hz) sample index, projected Δt
    steps beyond the last sample. The confidence band is ±z·σ·√Δt (diffusive
    scaling of the residual σ), and ``hold_probability`` is the normal CDF of the
    projected edge over that band — a MODELED directional-hold estimate whose
    basis is disclosed. All numbers are rounded to the instrument's precision.

    Returns ``available=False`` with null vectors when the tape is too short or
    degenerate — the engine withholds instead of fabricating a target.
    """
    arr = np.asarray(list(closes) if closes is not None else [], dtype=np.float64)
    if arr.ndim != 1:
        arr = arr.reshape(-1)
    arr = arr[np.isfinite(arr) & (arr > 0)]
    n = int(arr.size)
    steps = max(1, int(horizon_seconds))
    digits = int(symbol_digits) if symbol_digits and symbol_digits > 0 else 5

    if n < MIN_REGRESSION_SAMPLES:
        return _withheld(n, steps, "insufficient_history")

    xs = np.arange(n, dtype=np.float64)
    denom = n * float(np.sum(xs * xs)) - float(np.sum(xs)) ** 2
    if denom <= _EPS:
        return _withheld(n, steps, "degenerate_index")

    slope = (
        n * float(np.sum(xs * arr)) - float(np.sum(xs)) * float(np.sum(arr))
    ) / denom
    intercept = (float(np.sum(arr)) - slope * float(np.sum(xs))) / n
    resid = arr - (slope * xs + intercept)
    sigma = float(np.sqrt(float(np.mean(resid ** 2))))
    ss_tot = float(np.sum((arr - float(np.mean(arr))) ** 2))
    r2 = 1.0 - float(np.sum(resid ** 2)) / ss_tot if ss_tot > _EPS else 0.0

    predicted = intercept + slope * (float(n - 1) + steps)
    sigma_h = sigma * math.sqrt(float(steps))

    dirn = str(direction or "").strip().upper()
    if dirn not in {"BUY", "SELL"}:
        dirn = "BUY" if slope >= 0 else "SELL"

    entry: Optional[float] = None
    if entry_price is not None:
        try:
            cand = float(entry_price)
        except (TypeError, ValueError):
            cand = float("nan")
        if math.isfinite(cand) and cand > 0:
            entry = cand

    margin = z * sigma_h
    lower = predicted - margin
    upper = predicted + margin

    hold: Optional[float] = None
    if entry is not None and sigma_h > _EPS:
        edge = (predicted - entry) if dirn == "BUY" else (entry - predicted)
        hold = float(max(0.0, min(1.0, _normal_cdf(edge / sigma_h))))

    return {
        "available": True,
        "reason": None,
        "direction": dirn,
        "horizon_seconds": steps,
        "entry_price": round(entry, digits) if entry is not None else None,
        "predicted_end_price": round(predicted, digits),
        "confidence_margin": round(margin, digits),
        "confidence_lower": round(lower, digits),
        "confidence_upper": round(upper, digits),
        "hold_probability": round(hold, 4) if hold is not None else None,
        "probability_basis": PROBABILITY_BASIS if hold is not None else None,
        "samples": n,
        "residual_sigma": round(sigma, max(digits, 6)),
        "regression": {
            "slope": round(slope, 8),
            "intercept": round(intercept, digits),
            "r2": round(float(max(0.0, min(1.0, r2))), 4),
        },
    }


# =============================================================================
#  DEPARTURE LINE  ("Ligne du Départ" — exact strike + entry window)
# =============================================================================
# Pure, derived metadata that turns an already-computed regression vector into
# the explicit entry contract the terminal overlay renders:
#
#     strike_price           — the exact entry level (the REAL live price at
#                              projection time, i.e. regression entry_price)
#     target_price           — the projected level (predicted_end_price)
#     entry_window_start_ms  — epoch-ms the contract opened (entry_ts)
#     entry_window_end_ms    — epoch-ms the entry window closes (expiry)
#     max_allowed_slippage   — POLICY tolerance derived from the REAL ATR
#     status                 — see the vocabulary below
#
# HONESTY CONTRACT
# ----------------
# This function NEVER invents a level. If the regression is unavailable
# (short/degenerate tape) or the strike/target are missing or non-finite, it
# returns ``status = WAITING_FOR_VALID_ENTRY_LEVEL`` with every price None — the
# UI then renders "WAITING FOR VALID ENTRY LEVEL" rather than a synthetic line.
# ``max_allowed_slippage`` is only reported when a REAL ATR exists; it is a risk
# bound, not a price.

# Status vocabulary (rendered verbatim by the terminal).
DEPARTURE_ACTIVE = "ACTIVE"
DEPARTURE_PENDING = "PENDING"
DEPARTURE_EXPIRED_ZONE = "EXPIRED_ZONE"
DEPARTURE_MISSED_ENTRY = "MISSED_ENTRY"
DEPARTURE_WAITING = "WAITING_FOR_VALID_ENTRY_LEVEL"

#: Slippage tolerance as a fraction of the real ATR. A POLICY constant, never
#: tape data: it bounds how far price may drift from the strike before the
#: modelled entry is no longer the one the verdict was scored on.
SLIPPAGE_ATR_FRACTION = 0.5

def _call_put(side: Any) -> Optional[str]:
    """Normalise BUY/SELL → CALL/PUT (the terminal's departure vocabulary)."""
    s = str(side or "").strip().upper()
    if s in ("CALL", "BUY"):
        return "CALL"
    if s in ("PUT", "SELL"):
        return "PUT"
    return None


def _departure_empty(status: str, reason: str) -> Dict[str, Any]:
    """The honest empty state — every level None, never a zero-fill."""
    out: Dict[str, Any] = {
        "available": False,
        "status": status,
        "reason": reason,
        "side": None,
        "strike_price": None,
        "target_price": None,
        "entry_window_start_ms": None,
        "entry_window_end_ms": None,
        "max_allowed_slippage": None,
        "slippage": None,
    }
    return out


def _finite_positive(value: Any) -> Optional[float]:
    try:
        cand = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(cand) or cand <= 0:
        return None
    return cand


def _finite(value: Any) -> Optional[float]:
    try:
        cand = float(value)
    except (TypeError, ValueError):
        return None
    return cand if math.isfinite(cand) else None


def compute_departure_line(
    regression: Optional[Dict[str, Any]],
    *,
    side: Optional[str] = None,
    atr: Optional[float] = None,
    entry_ms: Optional[int] = None,
    expiry_ms: Optional[int] = None,
    current_price: Optional[float] = None,
    symbol_digits: int = 5,
    now_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Derive the exact departure (strike/entry) contract from a regression.

    ``regression`` is the output of :func:`compute_price_target_regression`.
    ``entry_ms`` / ``expiry_ms`` bound the valid entry window; ``current_price``
    (optional) drives the live slippage check; ``atr`` (optional) sets the
    slippage tolerance. Returns a dict with the departure contract keys.

    Status precedence (first match wins):
      WAITING_FOR_VALID_ENTRY_LEVEL — no usable regression/levels
      EXPIRED_ZONE                  — now is past entry_window_end_ms
      MISSED_ENTRY                  — |price − strike| > max_allowed_slippage
      PENDING                       — now is before entry_window_start_ms
      ACTIVE                        — inside the window and within tolerance
    """
    digits = int(symbol_digits) if symbol_digits and symbol_digits > 0 else 5

    if not isinstance(regression, dict) or not regression.get("available"):
        return _departure_empty(DEPARTURE_WAITING, "regression_unavailable")

    strike = _finite_positive(regression.get("entry_price"))
    target = _finite_positive(regression.get("predicted_end_price"))
    if strike is None or target is None:
        # available=True but a level is missing/degenerate → withhold, never guess.
        return _departure_empty(DEPARTURE_WAITING, "levels_unavailable")

    resolved_side = _call_put(side) or _call_put(regression.get("direction"))

    start_ms = int(entry_ms) if isinstance(entry_ms, (int, float)) and math.isfinite(float(entry_ms)) else None
    end_ms = int(expiry_ms) if isinstance(expiry_ms, (int, float)) and math.isfinite(float(expiry_ms)) else None

    atr_val = _finite_positive(atr)
    max_slippage = (
        round(atr_val * SLIPPAGE_ATR_FRACTION, digits) if atr_val is not None else None
    )

    price = _finite_positive(current_price)
    slippage = round(abs(price - strike), digits) if price is not None else None

    now = _finite(now_ms)
    if now is None:
        now = _finite(entry_ms)

    # ── Status resolution (ordered, fail-honest) ──
    reason: Optional[str] = None
    if end_ms is not None and now is not None and now > end_ms:
        status = DEPARTURE_EXPIRED_ZONE
        reason = "entry_window_elapsed"
    elif (
        slippage is not None
        and max_slippage is not None
        and slippage > max_slippage
    ):
        status = DEPARTURE_MISSED_ENTRY
        reason = "slippage_exceeded"
    elif (
        start_ms is not None and now is not None and now < start_ms
    ):
        status = DEPARTURE_PENDING
        reason = "awaiting_entry_window"
    else:
        status = DEPARTURE_ACTIVE

    return {
        "available": status not in (DEPARTURE_WAITING,),
        "status": status,
        "reason": reason,
        "side": resolved_side,
        "strike_price": round(strike, digits),
        "target_price": round(target, digits),
        "entry_window_start_ms": start_ms,
        "entry_window_end_ms": end_ms,
        "max_allowed_slippage": max_slippage,
        "slippage": slippage,
    }
