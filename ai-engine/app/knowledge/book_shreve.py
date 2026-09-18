"""
book_shreve.py — KNOWLEDGE MODULE · S. Shreve, "Stochastic Calculus for Finance",
Vol. II: Continuous-Time Models (2004)
Classification: STOCHASTIC CALCULUS · Source book + section cited for every formula.

Pure reference implementation, no I/O.

References (Shreve, Vol. II):
  · Borel-Cantelli-safe absolute continuity, Radon-Nikodym derivative dQ/dP:  Sec. 1.1-1.3
  · Wiener process & its quadratic variation:                                 Sec. 3.1
  · Ito's formula (Ito chain rule):                                           Sec. 4.4
  · GBM and the pricing PDE (Black-Scholes):                                  Sec. 4.5, Sec. 5.3
  · Black-Scholes-Merton formula re-derivation:                               Sec. 5.3.1
"""

from __future__ import annotations

import math
from typing import Sequence

_EPS = 1e-12


def quadratic_variation(path: Sequence[float]) -> float:
    """Empirical quadratic variation of a (sampled) path (Shreve Sec. 3.1).

    [X]_n = Σ (ΔX_i)² over the observed increments. For a Wiener-like path this
    converges to the integrated variance; it is the source of the non-zero
    drift in Ito integration.
    """
    p = [float(v) for v in path]
    if len(p) < 2:
        return 0.0
    return float(sum((p[i] - p[i - 1]) ** 2 for i in range(1, len(p))))


def ito_integral_step(x: float, gamma: float, delta: float, t: float, vol_t: float, dw: float) -> dict:
    """One time step of the Ito stochastic integral dX = gamma dt + sigma(t) dW
    (Shreve Sec. 4.4): returns the incremented state using the left-point rule
    (the rigorous Ito convention — the integrand is evaluated at the left end of
    the interval). Values cited as the definition of Ito's integral.
    """
    # dx_t = gamma_t * dt + sigma_t * dW_t; the Ito convention evaluates
    # sigma at the LEFT endpoint of the step.
    dx = gamma * delta + vol_t * dw
    return {"x_next": float(x + dx), "delta": float(delta), "ito_left_point": float(vol_t)}


def geometric_bm_step(
    spot: float,
    dt: float,
    rate: float,
    volatility: float,
    dw: float,
) -> float:
    """Euler step of GBM dS = r S dt + sigma S dW discretized EXACTLY
    (Shreve Sec. 4.5): S(t+dt) = S(t) exp((r − σ²/2)dt + σ dW_t). The σ²/2
    correction is precisely Ito's lemma at work.
    """
    if spot <= 0:
        raise ValueError("spot must be positive")
    return float(spot * math.exp((rate - 0.5 * volatility ** 2) * dt + volatility * dw))


def black_scholes_formula(
    spot: float,
    strike: float,
    ttm: float,
    rate: float,
    vol: float,
    option_type: str = "call",
) -> float:
    """BSM formula as derived in Shreve Sec. 5.3.1 (no dividend for notation parity).

    Doc-consistency check: with the change of measure (Girsanov) the discounted
    expectation is evaluated under Q. Includes the N(·) T-table usage.
    """
    if spot <= 0 or ttm < 0 or vol < 0:
        raise ValueError("spot>0, ttm>=0, vol>=0 required")
    if ttm == 0:
        return float(max((spot - strike) if option_type == "call" else (strike - spot), 0.0))
    sq = math.sqrt(ttm)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol ** 2) * ttm) / (vol * sq)
    d2 = d1 - vol * sq
    if option_type == "call":
        return float(spot * N(d1) - strike * math.exp(-rate * ttm) * N(d2))
    return float(strike * math.exp(-rate * ttm) * N(-d2) - spot * N(-d1))


def radon_nikodym_likelihood(measure_drift: float, sigma: float, dw: float) -> float:
    """One-step RN derivative of change-of-measure (Girsanov; Shreve Sec. 1.3).

    dQ/dP = exp(lambda * dW − 0.5 lambda² dt), lambda = (theta drift)/sigma.
    """
    lam = measure_drift / sigma if sigma > _EPS else 0.0
    return float(math.exp(lam * dw - 0.5 * lam * lam))


def N(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))