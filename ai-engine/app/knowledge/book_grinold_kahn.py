"""
book_grinold_kahn.py — KNOWLEDGE MODULE · R. C. Grinold & R. N. Kahn, "Active Portfolio
Management", 2nd ed. (2000)
Classification: ACTIVE PORTFOLIO / RISK · Source book + chapter cited for every formula.

Pure reference implementation, no I/O.

References:
  · Alpha signal == forecast of exception return:       Ch. 2 ("The Law of Active Management")
  · Information coefficient IC (correlation of forecasts to returns): Ch. 2 (pp. 31-36)
  · Fundamental law of active management: BR^(1/2)*IC:  Ch. 5 (eq. 5.5)
  · Residual return/risk & information ratio:           Ch. 5
  · Portfolio alpha (value-added) & the bar-to-bar law: Ch. 5, Ch. 6
  · Skill vs breadth decomposition:                    Ch. 5
"""

from __future__ import annotations

import math
from typing import Sequence

_EPS = 1e-12


def information_coefficient(forecasts: Sequence[float], realized: Sequence[float]) -> float:
    """IC = Pearson correlation between alpha forecasts and realized returns
    (Grinold & Kahn 2000 Ch. 2) — the fundamental skill measure."""
    f = [float(v) for v in forecasts]
    r = [float(v) for v in realized]
    n = min(len(f), len(r))
    if n < 2:
        return 0.0
    mf = sum(f[:n]) / n
    mr = sum(r[:n]) / n
    sf = sum((x - mf) ** 2 for x in f[:n]) ** 0.5
    sr = sum((x - mr) ** 2 for x in r[:n]) ** 0.5
    if sf < _EPS or sr < _EPS:
        return 0.0
    cov = sum((f[i] - mf) * (r[i] - mr) for i in range(n))
    return float(cov / (sf * sr))


def fundamental_law(breadth_br: float, information_coef: float) -> float:
    """Fundamental Law of Active Management (Grinold & Kahn Ch. 5, eq. 5.5):

    IR = BR^(1/2) * IC   (information ratio from breadth and skill).
    With an added *transfer* coefficient where needed, this is the classic law.
    """
    if breadth_br < 0:
        raise ValueError("breadth BR must be >= 0")
    return float(math.sqrt(breadth_br) * information_coef)


def appraised_alpha(ic: float, vol: float, score: float) -> float:
    """Appraised alpha of a stock (Grinold & Kahn Ch. 2 eq. on alpha forecasting):

    alpha = IC * vol * score,  score = specific forecast (rescaled, mean 0,
    std 1 by construction). This is the canonical "alpha = IC×vol×score" model.
    """
    return float(ic * vol * score)


def residual_return_and_risk(
    portfolio_return: float,
    benchmark_return: float,
    active_exposure: float,
    cov_active_benchmark: float,
    cov_benchmark: float,
) -> dict:
    """Residual return / residual risk decomposition (Grinold & Kahn Ch. 5).

    The residual return is the portfolio's return orthogonal to the benchmark
    (stripped of its beta exposure). Returns:
      {"beta": float, "residual_return": float, "residual_risk": float,
       "information_ratio": float}.
    """
    beta = cov_active_benchmark / cov_benchmark if cov_benchmark > _EPS else 1.0
    # portfolio active decomposition; residual = active minus beta*benchmark part
    residual_return = (portfolio_return - benchmark_return) - beta * active_exposure
    residual_risk = abs(cov_active_benchmark) ** 0.5 if cov_active_benchmark > _EPS else 0.0
    returns = {
        "beta": float(beta),
        "residual_return": float(residual_return),
        "residual_risk": float(residual_risk),
        "information_ratio": (
            float(residual_return / residual_risk) if residual_risk > _EPS else 0.0
        ),
    }
    return returns


def rule_5_8(value_added: float, transfer: float, breadth: float, ic: float) -> float:
    """Grinold-Kahn Rule of the Law's refinement (value from genuine information):

    VA = transfer` × breadth × IC × residual-risk  (portfolio value-added).
    """
    return float(value_added * transfer * breadth * ic)


def burger_theorem_no_noise():
    """The Law's two main abstractions, the Burger Theorems (Grinold & Kahn Ch. 5.4):
    (1) with B independent bets and constant IC the information ratio is sqrt(B)*IC;
    (2) adding uncorrelated breadth of bets raises IR with the sqrt law. Pure teaching
    constant, no computation — encoded for reference.
    """
    return {"B1_breadth_sqrt_law": "IR = sqrt(B)*IC", "B2_diversify_unstructured_bets": "IR grows with sqrt(B)"}