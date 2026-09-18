"""
book_bouchaud.py — KNOWLEDGE MODULE · J.-P. Bouchaud & M. Potters, "Theory of Financial
Risk and Derivative Pricing", 2nd ed. (2003/2009)
Classification: STATISTICAL PHYSICS OF FINANCE · Source book + chapter cited.

Pure reference implementation, no I/O.

References:
  · Multivariate Gaussian risk & covariance matrices:  Ch. 2 (pp. 31-64)
  · VaR & the Gaussian hypothesis:                       Ch. 3 (pp. 65-110)
  · Power-law (fat-tailed) distributions:                Ch. 2, Ch. 3
  · Aggregation & implication for normality:             Ch. 2
"""

from __future__ import annotations

import math
from typing import Optional, Sequence

_EPS = 1e-12


def multivariate_gaussian_vol(weights: Sequence[float], cov_matrix: list) -> float:
    """Portfolio volatility of a weighted basket under the multivariate Gaussian
    model (Bouchaud Ch. 2): sigma_p = sqrt(w' Sigma w)."""
    w = [float(v) for v in weights]
    n = len(w)
    total = 0.0
    for i in range(n):
        for j in range(n):
            total += w[i] * w[j] * float(cov_matrix[i][j])
    return float(math.sqrt(max(0.0, total)))


def gaussian_var(volatility: float, horizon: float, confidence: float = 0.99) -> float:
    """Variance in the Gaussian hypothesis (Bouchaud Ch. 3):
    VaR = sqrt(horizon) * volatility * N^{-1}(confidence) — with N^{-1}(1%)=2.326,
    N^{-1}(5%)=1.645 per the standard table the book reproduces."""
    return float(volatility * math.sqrt(horizon) * _z_quantile(confidence))


def power_law_tail_cdf(alpha: float, x_min: float, x: float) -> float:
    """Survival probability of a power-law (fat-tail) distribution (Bouchaud Ch. 2):
    P(X > x) = (x/x_min)^{-alpha} for x >= x_min. The index alpha controls tail
    thickness — the fundamental deviation from the Gaussian.
    """
    if alpha <= 0 or x_min <= 0:
        raise ValueError("alpha>0, x_min>0 required (power-law domain)")
    if x < x_min:
        return 1.0
    return float((x / x_min) ** (-alpha))


def lognormal_density(x: float, mu: float, sigma: float) -> float:
    """Log-normal density (Bouchaud Ch. 2 — used for positive quantities)."""
    if x <= 0 or sigma <= 0:
        return 0.0
    return float(
        math.exp(-((math.log(x) - mu) ** 2) / (2 * sigma * sigma))
        / (x * sigma * math.sqrt(2 * math.pi))
    )


def realized_vol_from_returns(returns: Sequence[float], scale_sqrt_n: float = 1.0) -> float:
    """Realized volatility of an observed return series under the second moment
    (Bouchaud Ch. 2-3): the (possibly scaled) standard deviation."""
    r = [float(v) for v in returns]
    if len(r) < 2:
        return 0.0
    mean = sum(r) / len(r)
    var = sum((x - mean) ** 2 for x in r) / (len(r) - 1)
    return float(scale_sqrt_n * math.sqrt(var))


def _z_quantile(p: float) -> float:
    """Standard normal quantile (inverse CDF) via Acklam's rational approximation —
    the same values the book's Gaussian VaR tables use."""
    p = max(1e-12, min(1 - 1e-12, p))
    if p < 0.5:
        return -_z_quantile(1 - p)
    a = (-2.0 * math.log(1.0 - p)) ** 0.5
    num = (((((2.515517 * a + 0.802853) * a) + 0.010328) * a))
    den = 1.0 + 1.432788 * a + 0.189269 * a * a + 0.001308 * a * a * a
    return float(a - num / den)