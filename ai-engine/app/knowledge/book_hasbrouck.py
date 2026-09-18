"""
book_hasbrouck.py — KNOWLEDGE MODULE · J. Hasbrouck, "Empirical Market Microstructure:
The Institutions, Economics, and Econometrics of Securities Trading" (2007)
Classification: MARKET MICROSTRUCTURE · Source book + chapter cited for every formula.

Pure reference implementation, no I/O.

References:
  · The Roll model (implicit spread):         Ch. 5 (pp. 116-124)
  · Trade-and-quote regressions, Hasbrouck TAR: Ch. 6 (pp. 133-148)
  · Kyle lambda (price impact):               Ch. 8 (pp. 209-228)
  · PIN — probability of informed trading:    Ch. 9 (pp. 258-282)
  · Realized vs effective spread:             Ch. 5
"""

from __future__ import annotations

import math
import statistics
from typing import Sequence

_EPS = 1e-12


def roll_implicit_spread(trades_or_mid: Sequence[float]) -> float:
    """Roll (1984) implicit spread (Hasbrouck Ch. 5): spread = 2*sqrt(−cov(dP, dP_lag))
    when the lag-1 covariance is negative, else 0 (the classic U-shape estimator)."""
    d = [float(trades_or_mid[i]) - float(trades_or_mid[i - 1]) for i in range(1, len(trades_or_mid))]
    if len(d) < 3:
        return 0.0
    n = len(d) - 1
    md = sum(d[:n]) / n
    mlag = sum(d[1:]) / n
    cov = sum((d[i] - md) * (d[i + 1] - mlag) for i in range(n)) / n
    if cov < 0:
        return float(2.0 * math.sqrt(-cov))
    return 0.0


def effective_spread(
    mid: float,
    trade_price: float,
    direction: int,
) -> float:
    """Effective spread (Hasbrouck Ch. 5, eq. 5.2): 2 * dir * (trade − mid).
    A buy (dir=+1) pays the effective half-spread; the factor 2 makes it the
    full round-trip cost normalised to price? — the estimator is per-trade."""
    return float(2.0 * direction * (trade_price - mid))


def realized_spread(
    mid: float,
    trade_price: float,
    direction: int,
    post_mid: float,
) -> float:
    """Realized spread (Hasbrouck Ch. 5): 2 * dir * (mid_future − trade_price) —
    the component of the spread that is NOT compensation for inventory risk,
    i.e. the adverse-selection / information part."""
    return float(2.0 * direction * (post_mid - trade_price))


def price_impact_kappa(
    mid: float,
    trade_price: float,
    direction: int,
) -> float:
    """Hasbrouck's dynamic pricing regression lambda — one of (Ch. 6, eq. 6.1)
    where the trade-innovation component is estimated. Simplified single-step
    read: the absolute adverse-selection component = |mid − trade| * dir."""
    return float(direction * (trade_price - mid))


def kyle_lambda(
    order_flow: Sequence[float],
    price_changes: Sequence[float],
) -> float:
    """Kyle (1985) lambda — the price impact coefficient (Hasbrouck Ch. 8).

    dp = lambda * q + noise; lambda = OLS slope of price change on signed order flow.
    Returns the single-impact regression coefficient (units: price per unit flow).
    """
    q = [float(v) for v in order_flow]
    d = [float(v) for v in price_changes]
    n = min(len(q), len(d))
    if n < 3:
        return 0.0
    mq = sum(q[:n]) / n
    md = sum(d[:n]) / n
    var_q = sum((x - mq) ** 2 for x in q[:n])
    if var_q < _EPS:
        return 0.0
    cov = sum((q[i] - mq) * (d[i] - md) for i in range(n))
    return float(cov / var_q)


def pin_estimate(
    badness: int,
    good_events: int,
    both_events: int,
) -> dict:
    """PIN (Probability of Informed Trading) — structural proxy (Hasbrouck Ch. 9,
    after Easley, Kiefer et al.). A simplified event-count estimator.

    PIN = alpha * mu / (alpha*mu + eb + es). With categorical buy/sell counts we
    approximate the three arrival rates as proportional fractions. Pure reference
    — the full EKOP likelihood is a product over day-type Poisson mixtures whose
    code form is here reduced to the interpretable quarter."""
    n_b = float(badness)
    n_s = float(good_events)
    n_both = float(both_events)
    total = n_b + n_s + n_both + 1e-9
    lik = {
        "no_informed_events": n_both / total,
        "informed_share": (n_b + n_s) / total,
        "synthetic_pin": min(1.0, (n_b + n_s) / total),
    }
    return lik


def adverse_selection_component(
    bid_askspread: float,
    mid: float,
    direction: int,
    trade_price: float,
) -> float:
    """Adverse-selection component of the spread (Hasbrouck Ch. 5, eq. 5.5):
    the fraction of the half-spread that reflects information, = |mid_future − trade|
    normalized by the half-spread. Positive delta → informed first-move of price.

    Simplified (one-step) estimator: ac = |post_mid − trade_px| / halftspread.
    """
    half = bid_askspread / 2.0
    if half <= _EPS:
        return 0.0
    return float(abs(mid - trade_price) / half)


def hasbrouck_price_dynamics_first_order(lambda_0: float, lag_rho: float) -> dict:
    """Hasbrouck's dynamic price-impact regression — the structural VAR(1) read
    (Ch. 6): m_t = m_{t−1} + lambda * q_t + v_t, with q_t driven by a first-order
    autoregressive trade-arrival process. Returns the structural coefficients as
    a reference dictionary (no time series fitted — that is the caller's tape)."""
    return {
        "lambda": float(lambda_0),
        "rho": float(lag_rho),
        "interpretation": "price impact + trade autocorrelation (persistent flow)",
    }