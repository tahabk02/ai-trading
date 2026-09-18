"""
book_hull.py — KNOWLEDGE MODULE · J. C. Hull, "Options, Futures, and Other Derivatives",
9th ed. (2015) / 10th ed. (2018)
Classification: OPTIONS / DERIVATIVES · Source book + chapter cited for every formula.

Pure reference implementation, no I/O.

References (10th ed.):
  · Black-Scholes-Merton formula & Greeks:   Ch. 19
  · Binomial tree (CRR):                     Ch. 13
  · Risk-neutral valuation:                 Ch. 12, Ch. 19
  · Ito's lemma / GBM:                       Ch. 14
  · Volatility smiles (sticky models):      Ch. 19-20
  · Delta hedging & the formula's logic:    Ch. 19
"""

from __future__ import annotations

import math
from typing import Optional, Sequence

# Hull's N() CDF — the standard normal CDF used throughout Ch. 19:

def standard_normal_cdf(x: float) -> float:
    """Standard normal CDF via the complementary error function (B&S N(d))."""
    return 0.5 * math.erfc(-x / math.sqrt(2.0))

N = standard_normal_cdf

EPS = 1e-12


def black_scholes_merton(
    spot: float,
    strike: float,
    ttm_years: float,
    rate: float,
    volatility: float,
    option_type: str = "call",
    dividend_yield: float = 0.0,
) -> float:
    """Black-Scholes-Merton price (Hull Ch. 19 eqs. 19.1-19.2, with q).

    call = S0 e^{−qT} N(d1) − K e^{−rT} N(d2)
    put  = K e^{−rT} N(−d2) − S0 e^{−qT} N(−d1)
    d1 = (ln(S0/K) + (r − q + σ²/2)T) / (σ√T), d2 = d1 − σ√T.
    """
    if spot <= 0 or ttm_years < 0 or volatility < 0:
        raise ValueError("spot>0, ttm>=0, vol>=0 required")
    if ttm_years == 0:
        return float(max((spot - strike) if option_type == "call" else (strike - spot), 0.0))
    d1, d2 = _d1d2(spot, strike, ttm_years, rate, volatility, dividend_yield)
    q = dividend_yield
    sPV = spot * math.exp(-q * ttm_years)
    kPV = strike * math.exp(-rate * ttm_years)
    if option_type == "call":
        return float(sPV * N(d1) - kPV * N(d2))
    if option_type == "put":
        return float(kPV * N(-d2) - sPV * N(-d1))
    raise ValueError("option_type must be 'call' or 'put'")


def black_scholes_greeks(
    spot: float,
    strike: float,
    ttm_years: float,
    rate: float,
    volatility: float,
    option_type: str = "call",
    dividend_yield: float = 0.0,
) -> dict:
    """The classic BSM Greeks (Hull Ch. 19): delta, gamma, vega, theta, rho."""
    if spot <= 0 or ttm_years < 0 or volatility <= 0:
        return {"delta": 0.0, "gamma": 0.0, "vega": 0.0, "theta": 0.0, "rho": 0.0}
    d1, d2 = _d1d2(spot, strike, ttm_years, rate, volatility, dividend_yield)
    q = dividend_yield
    is_call = option_type == "call"
    phi = standard_normal_pdf(d1)
    sqrtt = math.sqrt(ttm_years) if ttm_years > 0 else 0.0
    delta = math.exp(-q * ttm_years) * N(d1) if is_call else math.exp(-q * ttm_years) * (N(d1) - 1.0)
    gamma = math.exp(-q * ttm_years) * phi / (spot * volatility * sqrtt) if sqrtt > 0 else 0.0
    vega = spot * math.exp(-q * ttm_years) * phi * sqrtt
    if ttm_years == 0:
        theta = 0.0
        rho = 0.0
    else:
        if is_call:
            theta = ((-spot * phi * volatility * math.exp(-q * ttm_years)) / (2 * sqrtt)
                     + q * spot * N(d1) * math.exp(-q * ttm_years)
                     - rate * strike * math.exp(-rate * ttm_years) * N(d2))
            rho = strike * ttm_years * math.exp(-rate * ttm_years) * N(d2)
        else:
            theta = ((-spot * phi * volatility * math.exp(-q * ttm_years)) / (2 * sqrtt)
                     - q * spot * N(-d1) * math.exp(-q * ttm_years)
                     + rate * strike * math.exp(-rate * ttm_years) * N(-d2))
            rho = -strike * ttm_years * math.exp(-rate * ttm_years) * N(-d2)
    return {
        "delta": float(delta),
        "gamma": float(gamma),
        "vega": float(vega),
        "theta": float(theta),
        "rho": float(rho),
    }


def _d1d2(spot: float, strike: float, ttm: float, rate: float, vol: float, q: float) -> tuple:
    if vol <= 0 or ttm <= 0:
        return (float("inf"), float("inf"))
    sqrt_t = math.sqrt(ttm)
    d1 = (math.log(spot / strike) + (rate - q + vol ** 2 / 2.0) * ttm) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t
    return d1, d2


def standard_normal_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def binomial_american_price(
    spot: float,
    strike: float,
    ttm_years: float,
    rate: float,
    volatility: float,
    steps: int = 200,
    option_type: str = "call",
    dividend_yield: float = 0.0,
) -> float:
    """CRR binomial tree for American options (Hull Ch. 13).

    u = e^{σ√Δt}, d = 1/u, p = (e^{(r−q)Δt} − d)/(u − d); the option is
    valued by backward induction with early-exercise check at each node.
    """
    if spot <= 0 or ttm_years < 0 or volatility < 0 or steps < 1:
        raise ValueError("invalid tree inputs")
    dt = ttm_years / steps
    if dt <= 0:
        return float(max((spot - strike) if option_type == "call" else (strike - spot), 0.0))
    u = math.exp(volatility * math.sqrt(dt))
    d = 1.0 / u
    growth = math.exp((rate - dividend_yield) * dt)
    p = max(0.0, min(1.0, (growth - d) / (u - d))) if u != d else 0.5
    disc = math.exp(-rate * dt)
    # terminal layer
    values = []
    for j in range(steps + 1):
        s = spot * (u ** (steps - j)) * (d ** j)
        values.append(max((s - strike) if option_type == "call" else (strike - s), 0.0))
    for i in range(steps - 1, -1, -1):
        for j in range(i + 1):
            s = spot * (u ** (i - j)) * (d ** j)
            hold = disc * (p * values[j] + (1 - p) * values[j + 1])
            exercise = max((s - strike) if option_type == "call" else (strike - s), 0.0)
            values[j] = max(hold, exercise)
    return float(values[0])


def monte_carlo_european_price(
    spot: float,
    strike: float,
    ttm_years: float,
    rate: float,
    volatility: float,
    option_type: str = "call",
    n_paths: int = 20000,
    seed: int = 42,
) -> float:
    """Monte Carlo European option pricing with antithetic paths (Hull Ch. 19 exercise
    on control variates / antithetics). GBM simulation, risk-neutral starting level.
    """
    import random
    if spot <= 0 or ttm_years < 0 or volatility < 0 or n_paths < 1:
        raise ValueError("invalid MC inputs")
    if ttm_years == 0:
        return float(max((spot - strike) if option_type == "call" else (strike - spot), 0.0))
    rng = random.Random(seed)
    sqrt_t = math.sqrt(ttm_years)
    drift = (rate - 0.5 * volatility ** 2) * ttm_years
    diff = volatility * sqrt_t
    total = 0.0
    count = 0
    for _ in range(n_paths):
        for eps in (rng.gauss(0.0, 1.0), -rng.gauss(0.0, 1.0)):
            sT = spot * math.exp(drift + diff * eps)
            payoff = max((sT - strike) if option_type == "call" else (strike - sT), 0.0)
            total += payoff
            count += 1
    return float(total / max(count, 1) * math.exp(-rate * ttm_years))


def gbm_price_path(spot: float, ttm_years: float, rate: float, volatility: float, steps: int = 100, seed: int = 1) -> list:
    """Geometric Brownian Motion path (Hull Ch. 14 symptom of the model)."""
    import random
    if spot <= 0 or steps < 2:
        return []
    rng = random.Random(seed)
    dt = ttm_years / steps
    out = [float(spot)]
    for _ in range(steps):
        z = rng.gauss(0.0, 1.0)
        s = out[-1] * math.exp((rate - 0.5 * volatility ** 2) * dt + volatility * math.sqrt(dt) * z)
        out.append(float(s))
    return out