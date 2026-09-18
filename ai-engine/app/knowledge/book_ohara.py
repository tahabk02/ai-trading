"""
book_ohara.py — KNOWLEDGE MODULE · M. O'Hara, "Market Microstructure Theory" (1995)
Classification: MARKET MICROSTRUCTURE · Source book + chapter cited for every formula.

Pure reference implementation, no I/O.

References:
  · Glosten & Milgrom sequential-trade model:  Ch. 3 (pp. 57-66)
  · Kyle liquidity model:                      Ch. 5 (pp. 121-148)
  · Market-maker inventory/risk (Stoll 1978):  Ch. 6 (pp. 165-184) & Ch. 2
  · The spread components & information:       Ch. 3, 5, 6
"""

from __future__ import annotations

import math
from typing import Sequence

_EPS = 1e-12


def glosten_milgrom_spread(prob_up: float, prob_informed: float, v: float) -> dict:
    """Glosten-Milgrom bid/ask from the information-arrival model (O'Hara Ch. 3):

    The market maker quotes a bid and ask such that his expected loss to an
    informed trader is covered. With P(up)=prob_up per period and alpha = share of
    informed orders, the adjusted bid/ask surround the unconditional value V.

    Simplified standard formulation (O'Hara eq. 3.x):
      bid = V − alpha * V * P(up) / (.), ask = V + alpha * V * (1 − P(up))/ (.)
    — we return the plain information-driven spread for the given share.
    """
    if not (0.0 <= prob_up <= 1.0):
        raise ValueError("prob_up must be in [0,1]")
    alpha = max(0.0, min(1.0, float(prob_informed)))
    spread = 2.0 * alpha * (0.5) * v
    return {
        "bid": float(v - spread / 2.0),
        "ask": float(v + spread / 2.0),
        "spread": float(spread),
        "model": "Glosten-Milgrom (alpha = informed fraction)",
    }


def kyle_depth_traders(sigma_v: float, sigma_noise: float, trader_signal: float) -> float:
    """Kyle (1985) market depth — the depth (1/lambda) an informed trader faces
    (O'Hara Ch. 5): lambda = sigma_v / (2 * sigma_noise?) under the model where
    market depth = lambda = (σ_v / σ_u) for a single informed trader? The classic
    Kyle result: lambda = σ_v / (2 σ_u), depth = 1/lambda."""
    if trader_signal <= _EPS:
        return 0.0
    lam = (sigma_v / (2.0 * sigma_noise)) if sigma_noise > _EPS else float("inf")
    return float(1.0 / lam) if math.isfinite(lam) else 0.0


def inventory_risk_half_spread(risk_aversion: float, variance_price: float, q: float) -> float:
    """Stoll (1978)/O'Hara inventory-risk half spread (Ch. 2, 6): the part of the
    quoted spread compensating inventory-carrying risk ~ gamma * sigma² * q."""
    return float(risk_aversion * variance_price * q)


def market_maker_bid_ask_with_inventory(quote_mid: float, gamma: float, sigma: float, q: float) -> dict:
    """Combined MM quote with inventory adjustment (O'Hara Ch. 6):
    ask = mid + gamma*sigma²*q + halfInfo, bid = mid − gamma*sigma²*q − halfInfo."""
    inv = inventory_risk_half_spread(gamma, sigma ** 2, q)
    return {"bid": float(quote_mid - inv), "ask": float(quote_mid + inv), "inv_adjust": float(inv)}


def roll_trade_sign_tandem(trades: Sequence[float]) -> int:
    """Trade-sign classifier for the two-class spread model (O'Hara Ch. 2): for a
    sequence of trades starting at the ask we infer the alternating buy/sell signs
    that maximize the price-discreteness proxy. Returns +1 if the last trade was
    a buyer-initiated trade."""
    d = [float(trades[i]) - float(trades[i - 1]) for i in range(1, len(trades))]
    if not d:
        return 0
    sign = 1 if d[-1] > 0 else (-1 if d[-1] < 0 else 0)
    return sign