"""
book_cont_tankov.py — KNOWLEDGE MODULE · R. Cont & P. Tankov, "Financial Modelling with
Jump Processes" (2004)
Classification: JUMP PROCESSES / LEVY · Source book + chapter cited for every formula.

Pure reference implementation, no I/O.

References:
  · Levy processes & characteristic exponent:      Ch. 3 (Sec. 3.1-3.3)
  · Merton jump-diffusion (compound Poisson):       Ch. 4 (Sec. 4.2)
  · Variance-Gamma (VG) representation:             Ch. 8 (exponential Levy)
  · CGMY / Kunita-Watanabe decomposition:           Ch. 4
  · Semi-continuous hedging and jump risk:          Ch. 10
"""

from __future__ import annotations

import math
from typing import Optional, Sequence

_EPS = 1e-12


def compound_poisson_step(
    intensity: float,
    jump_mean: float,
    jump_sigma: float,
    dt: float,
    rng_seed: int = 7,
) -> dict:
    """One compound-Poisson jump step (Cont & Tankov, Merton model Sec. 4.2):
    a jump with Poisson arrival intensity*dt and normally-distributed (mean, var)
    jump size; returns {"jump_count", "jump_size"}."""
    import random
    rng = random.Random(rng_seed)
    lam = max(0.0, intensity * dt)
    # Direct Poisson sampler (Knuth): count exp(-lam) arrivals.
    count = 0
    limit = math.exp(-lam)
    prod = rng.random()
    while prod > limit:
        count += 1
        prod *= rng.random()
    count = min(count, 100000)
    size = 0.0
    for _ in range(count):
        size += rng.gauss(jump_mean, jump_sigma)
    return {"jump_count": count, "jump_size": float(size)}


class LevyNIG:
    """Normal Inverse Gaussian (NIG) Levy process — a specific Levy with closed-form
    characteristic exponent (Cont & Tankov Ch. 3, Sec. 3.3, NIG example).

    Parse: ln φ(θ) = δ*(sqrt(α² − β²) − sqrt(α² − (β + iθ)²)) with iθ discretized
    as the IMAGINARY Fourier argument; pure reference: we expose the MAD-implied
    exponent for the real part.
    """

    def __init__(self, alpha: float, beta: float, delta: float) -> None:
        if alpha <= 0:
            raise ValueError("alpha must be positive")
        if abs(beta) >= alpha:
            raise ValueError("|beta| < alpha required for a well-defined NIG")
        self.alpha = float(alpha)
        self.beta = float(beta)
        self.delta = float(delta)

    def characteristic_exponent(self, theta: float) -> float:
        """φ(θ) = exp(ln E[e^{iθX_1}]) — the exponent function at Fourier freq θ.
        For the NIG: δ*(sqrt(α²−β²) − sqrt(α²−(β+iθ)²)). We return the analytic
        value on the real axis via the standard identity."""
        inner = self.alpha ** 2 - (self.beta + 1j * theta) ** 2
        return float((self.delta * (math.sqrt(self.alpha ** 2 - self.beta ** 2)
                                    - (inner) ** 0.5)).real if inner else 0.0)


def variance_gamma_time_change(dt: float, theta: float, nu: float, sigma: float, rng_seed: int = 3) -> float:
    """One step of a Variance-Gamma (VG) jump process via subordination
    (Cont & Tankov Ch. 4: VG = Brownian motion subordinated by a gamma process):
    X_t = theta*G_t + sigma*W_{G_t}, with subordinator G_t ~ Gamma(dt/nu, nu).
    Sample one realized VG increment (the reference form)."""
    import random
    rng = random.Random(rng_seed)
    g = rng.gammavariate(dt / nu if nu > _EPS else dt, nu if nu > _EPS else 1.0)
    w = rng.gauss(0.0, math.sqrt(g))
    return theta * g + sigma * w


def levy_exponent_gaussian(theta_mean: float, sigma: float) -> dict:
    """Characteristic exponent of the pure Gaussian Levy process (Cont & Tankov Ch. 3):
    ψ(u) = iθ*u − σ²u²/2 (for the REAL Fourier parameter u). Reference analytic form.
    """
    return {
        "drift_term": theta_mean,
        "diffusion_term": -0.5 * sigma ** 2,
        "jump_term": "none (pure diffusion)",
    }


def jump_risk_hedging(lambda_j: float, jump_std: float) -> float:
    """Jump-risk premium (Cont & Tankov Ch. 10, "Jump-risk hedging in incomplete
    markets" framing): the extra risk premium for unresolved jump variance is
    proportional to the square root of the cumulative jump variance per unit time.
    Returns a dimensionless volatility-premium surrogate."""
    return float(math.sqrt(max(0.0, lambda_j * jump_std ** 2))) if lambda_j >= 0 else 0.0