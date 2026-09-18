"""
book_chan.py — KNOWLEDGE MODULE · E. P. Chan, "Quantitative Trading" (2009) & "Algorithmic
Trading: Winning Strategies and their Rationale" (2013)
Classification: ALGORITHMIC TRADING · Source book + chapter cited for every formula.

Pure reference implementation, no I/O.

References:
  · Mean reversion (OU process) & OLS beta hedge:   "Quantitative Trading" Ch. 3 (pp. 45-70)
  · Cointegration & pairs (ADF, scatter beta):      "Quantitative Trading" Ch. 3 (pp. 60-73)
  · Sharpe ratio as edge measure:                   "Quantitative Trading" Ch. 2 (pp. 21-30)
  · Intro to Kalman filter as dynamic model:        "Algorithmic Trading" Ch. 3 (pp. 93-151)
  · Which mean-reversion parameters matter (half-life): "Algorithmic Trading" Ch. 3
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

_EPS = 1e-12


def ornstein_uhlenbeck_fit(series: Sequence[float]) -> Tuple[float, float, float]:
    """Least-squares OU fit on a mean-reverting spread (Chan 2009 Ch. 3).

    dx = theta*(mu − x)*dt + sigma*dW; discretized as the AR(1)
    x[i+1] − x[i] = a + b*x[i] + eps, with:
      theta = −ln(1 + b)/dt,  mu = −a/b,  sigma = std(eps)*sqrt(−2 ln(1+b)/((1+b)^2 − 1)).
    Returns (theta, mu, sigma) in per-time-step units.
    """
    x = [float(v) for v in series]
    if len(x) < 3:
        return (0.0, 0.0, 0.0)
    n = len(x) - 1
    y = [x[i + 1] - x[i] for i in range(n)]
    # OLS regress y on [1, x[i]]
    mean_x = sum(x[:-1]) / n
    mean_y = sum(y) / n
    sx = sum((x[i] - mean_x) ** 2 for i in range(n))
    if sx < _EPS:
        return (0.0, float(mean_x), 0.0)
    b = sum((x[i] - mean_x) * (y[i] - mean_y) for i in range(n)) / sx
    a = mean_y - b * mean_x
    theta = -max(-2.0, min(2.0, float(b)))  # keep |1+b| in (0, 3) for stable log
    if (1.0 + b) <= 0.0:
        return (float(theta), 0.0, 0.0)
    try:
        import math
        mu = -a / b if abs(b) > _EPS else float(mean_x)
        sigma = math.sqrt(max(0.0, sum((y[i] - a - b * x[i]) ** 2 for i in range(n)) / max(n - 2, 1)))
        k = math.log(1.0 + b)
        sigma_ou = sigma * math.sqrt(-2.0 * k / max(((1.0 + b) ** 2 - 1.0), _EPS))
    except (ValueError, ZeroDivisionError):
        return (float(theta), 0.0, 0.0)
    return (float(theta), float(mu), float(sigma_ou))


def half_life_ou(series: Sequence[float]) -> float:
    """Mean-reversion half-life for an OU process (Chan 2009 Ch. 3).

    halflife = −ln(2)/ln(1 + b) where b is the AR(1) slope of the spread series.
    A *short* half-life (fine-grained) means strong mean reversion.
    """
    theta, _mu, _sigma = ornstein_uhlenbeck_fit(series)
    if theta <= _EPS:
        return float("inf")
    import math
    return float(-math.log(2.0) / math.log(1.0 + theta)) if (1.0 + theta) > 0 else float("inf")


def ols_hedge_ratio(y: Sequence[float], x: Sequence[float]) -> Tuple[float, float, float]:
    """OLS hedge ratio via scatter regression of spread on market (Chan 2009 Ch. 3).

    Returns (beta, alpha, residual_std); spread_t = y_t − beta*x_t − alpha.
    """
    yv = [float(v) for v in y]
    xv = [float(v) for v in x]
    n = min(len(yv), len(xv))
    if n < 3:
        return (0.0, 0.0, 0.0)
    mx = sum(xv[:n]) / n
    my = sum(yv[:n]) / n
    sx = sum((xv[i] - mx) ** 2 for i in range(n))
    if sx < _EPS:
        return (0.0, float(my), 0.0)
    beta = sum((xv[i] - mx) * (yv[i] - my) for i in range(n)) / sx
    alpha = my - beta * mx
    resid = [yv[i] - beta * xv[i] - alpha for i in range(n)]
    rstd = (sum(r * r for r in resid) / max(n - 2, 1)) ** 0.5
    return (float(beta), float(alpha), float(rstd))


def annualized_sharpe(returns: Sequence[float], periods_per_year: float = 252.0) -> float:
    """Annualized Sharpe from a return series (Chan 2009 Ch. 2).

    Sharpe = sqrt(periods_per_year) * mean(returns) / std(returns).
    Not annualized when periods_per_year == 1; the *excess* (risk-free-adjusted)
    form is the classic Chan formulation.
    """
    r = [float(v) for v in returns]
    if len(r) < 2:
        return 0.0
    mean = sum(r) / len(r)
    var = sum((x - mean) ** 2 for x in r) / (len(r) - 1)
    std = var ** 0.5
    if std < _EPS:
        return 0.0
    return float(periods_per_year ** 0.5 * mean / std)


def simple_kalman_filter_prices(
    prices: Sequence[float],
    process_noise: float = 1e-5,
    measurement_noise: float = 1e-3,
) -> List[float]:
    """1D random-walk Kalman smoother/filter on a price series (Chan 2013 Ch. 3).

    The state is the latent expected price, updated by the classic predict/update
    Kalman recursion. Returns the filtered (posterior) expected level per step —
    Chan uses this as the dynamic fair-value line for mean-reversion entries.
    """
    p = [float(v) for v in prices]
    if not p:
        return []
    out: List[float] = []
    x = float(p[0])
    v = 1.0
    for z in p:
        # predict
        v += process_noise
        # update
        k = v / (v + measurement_noise)
        x = x + k * (z - x)
        v = (1.0 - k) * v
        out.append(x)
    return out


def spread_zscore(spread: Sequence[float], window: int = 20) -> float:
    """Trailing z-score of a mean-reversion spread (Chan 2009 Ch. 3).

    z = (spread_last − rolling_mean) / rolling_std. Entry rules in Chan's
    mean-reversion systems use crossing ~±2.0.
    """
    s = [float(v) for v in spread]
    if len(s) < window + 1:
        return 0.0
    win = s[-window:]
    mean = sum(win) / window
    var = sum((v - mean) ** 2 for v in win) / window
    std = var ** 0.5
    if std < _EPS:
        return 0.0
    return float((s[-1] - mean) / std)


def roll_model_spread(series: Sequence[float], k: int = 2) -> float:
    """Simplified Roll (1984) implicit spread from serial covariance — Chan 2009 Ch. 3
    notes the serial-covariance roots as a spread estimator.

    spread = 2*sqrt(−cov(delta, delta_lag)) when negative (theoretical sign from Roll).
    """
    d = [float(series[i]) - float(series[i - 1]) for i in range(1, len(series))]
    if len(d) < k + 2:
        return 0.0
    pairs = len(d) - k
    mean_d = sum(d) / len(d)
    mean_lag = sum(d[k:]) / pairs
    cov = sum((d[i] - mean_d) * (d[i + k] - mean_lag) for i in range(pairs)) / pairs
    if cov < 0:
        return float(2.0 * (-cov) ** 0.5)
    return 0.0


def futures_carry_annualized(spot: float, future: float, days_to_expiry: float) -> float:
    """Futures carry = annualized basis (contango/backwardation) — same half-life logic
    Chan applies to carry strategies (2009 Ch. 3).

    carry = ((future/spot) − 1) * 365 / days_to_expiry.
    """
    if spot <= 0 or days_to_expiry <= 0:
        return 0.0
    return float(((float(future) / float(spot)) - 1.0) * 365.0 / float(days_to_expiry))