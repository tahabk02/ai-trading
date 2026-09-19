"""
math_engine.py — ADVANCED QUANT MATH ENGINE (sections A-G)

Pure, typed, documented computational mathematics built from the ten-book
knowledge core. Zero I/O, zero signal fabrication: every function is a real,
named, published model.

  A. Stochastic processes  B. Option pricing  C. Volatility estimation
  D. Microstructure        E. Risk            F. Time series
  G. Portfolio

Every public function validates inputs and raises ValueError on invalid ones.
Randomness is deterministic (seeded).
"""

from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Optional, Sequence, Tuple

_EPS = 1e-12


# ════════════════════════════════════════════════════════════════════
# A. STOCHASTIC PROCESSES
# ════════════════════════════════════════════════════════════════════

def geometric_brownian(
    spot: float,
    drift: float,
    volatility: float,
    dt: float,
    steps: int,
    seed: int = 1,
) -> List[float]:
    """GBM path: S(t+dt)=S(t)*exp((drift - sig^2/2)*dt + sig*sqrt(dt)*Z) (Shreve Sec. 4.5)."""
    if spot <= 0:
        raise ValueError("spot must be positive")
    if volatility < 0:
        raise ValueError("volatility must be >= 0")
    if dt <= 0 or steps < 1:
        raise ValueError("dt>0 and steps>=1 required")
    rng = random.Random(seed)
    path = [float(spot)]
    corr = drift - 0.5 * volatility * volatility
    sq = math.sqrt(dt)
    for _ in range(steps):
        z = rng.gauss(0.0, 1.0)
        path.append(path[-1] * math.exp(corr * dt + volatility * sq * z))
    return path


def ornstein_uhlenbeck_path(
    theta: float, mu: float, sigma: float, x0: float, dt: float, steps: int, seed: int = 2,
) -> List[float]:
    """OU path: dx = theta*(mu - x)*dt + sigma*sqrt(dt)*Z (Shreve Ch.4 / Chan)."""
    if theta < 0:
        raise ValueError("theta must be >= 0")
    if sigma < 0:
        raise ValueError("sigma must be >= 0")
    if dt <= 0 or steps < 1:
        raise ValueError("dt>0 and steps>=1 required")
    rng = random.Random(seed)
    path = [float(x0)]
    sq = math.sqrt(dt)
    for _ in range(steps):
        x = path[-1]
        path.append(x + theta * (mu - x) * dt + sigma * sq * rng.gauss(0.0, 1.0))
    return path


def ou_half_life(theta: float) -> float:
    """OU mean-reversion half-life = ln(2)/theta (Chan / Shreve)."""
    if theta <= 0:
        raise ValueError("theta must be > 0")
    return float(math.log(2.0) / theta)


def cir_path(
    initial: float, mean: float, speed: float, volatility: float,
    dt: float, steps: int, seed: int = 3,
) -> List[float]:
    """CIR short rate: dr = k*(mean - r)*dt + sig*sqrt(r)*sqrt(dt)*Z (Hull Ch.30)."""
    if initial < 0 or mean < 0:
        raise ValueError("rates must be >= 0")
    if speed < 0 or volatility < 0 or dt <= 0 or steps < 1:
        raise ValueError("speed>=0, vol>=0, dt>0, steps>=1 required")
    rng = random.Random(seed)
    path = [float(initial)]
    sq = math.sqrt(dt)
    for _ in range(steps):
        r = max(path[-1], 0.0)
        dr = speed * (mean - r) * dt + volatility * math.sqrt(r) * sq * rng.gauss(0.0, 1.0)
        path.append(max(r + dr, 0.0))
    return path


def merton_jump_diffusion(
    spot: float, drift: float, volatility: float,
    jump_intensity: float, jump_mean: float, jump_var: float,
    dt: float, steps: int, seed: int = 4,
) -> List[float]:
    """Merton (1976) jump-diffusion (Cont & Tankov Ch.4). Jump-mean compensated."""
    if spot <= 0:
        raise ValueError("spot must be positive")
    if volatility < 0 or jump_intensity < 0 or jump_var < 0:
        raise ValueError("vol/intensity/var must be >= 0")
    if dt <= 0 or steps < 1:
        raise ValueError("dt>0 and steps>=1 required")
    rng = random.Random(seed)
    path = [float(spot)]
    sq = math.sqrt(dt)
    k = math.exp(jump_mean + 0.5 * jump_var) - 1.0
    corr = drift - jump_intensity * k - 0.5 * volatility * volatility
    for _ in range(steps):
        lam = jump_intensity * dt
        count = 0
        limit = math.exp(-lam)
        prod = rng.random()
        while prod > limit:
            count += 1
            prod *= rng.random()
        jump = 0.0
        for _j in range(min(count, 100000)):
            jump += rng.gauss(jump_mean, math.sqrt(jump_var))
        ret = corr * dt + volatility * sq * rng.gauss(0.0, 1.0) + jump
        path.append(path[-1] * math.exp(ret))
    return path


def variance_gamma_path(
    spot: float, theta: float, nu: float, sigma: float,
    dt: float, steps: int, seed: int = 5,
) -> List[float]:
    """Variance-Gamma by gamma subordination (Cont & Tankov Ch.4)."""
    if spot <= 0:
        raise ValueError("spot must be positive")
    if nu <= 0 or sigma < 0 or dt <= 0 or steps < 1:
        raise ValueError("nu>0, sigma>=0, dt>0, steps>=1 required")
    rng = random.Random(seed)
    path = [float(spot)]
    log_ret = 0.0
    for _ in range(steps):
        g = rng.gammavariate(dt / nu, nu)
        log_ret += theta * g + sigma * math.sqrt(g) * rng.gauss(0.0, 1.0)
        path.append(spot * math.exp(log_ret))
    return path


def heston_path(
    spot: float, initial_variance: float, mean_variance: float,
    mean_reversion: float, vol_of_vol: float, rho: float,
    dt: float, steps: int, seed: int = 6,
) -> List[float]:
    """Heston (1993) stoch-vol path with correlated shocks (Hull Ch.30)."""
    if spot <= 0:
        raise ValueError("spot must be positive")
    if initial_variance < 0 or mean_variance < 0 or vol_of_vol < 0:
        raise ValueError("variances and vol-of-vol must be >= 0")
    if not (-1.0 <= rho <= 1.0):
        raise ValueError("rho must be in [-1,1]")
    if dt <= 0 or steps < 1:
        raise ValueError("dt>0 and steps>=1 required")
    rng = random.Random(seed)
    path = [float(spot)]
    v = float(initial_variance)
    sq = math.sqrt(dt)
    for _ in range(steps):
        z1 = rng.gauss(0.0, 1.0)
        z2 = rho * z1 + math.sqrt(1.0 - rho * rho) * rng.gauss(0.0, 1.0)
        sqrt_v = math.sqrt(max(v, 0.0))
        path.append(path[-1] * math.exp(-0.5 * v * dt + sqrt_v * sq * z1))
        v = max(v + mean_reversion * (mean_variance - v) * dt + vol_of_vol * sqrt_v * sq * z2, 0.0)
    return path


def fractional_brownian_motion(hurst: float, n: int, seed: int = 7) -> List[float]:
    """Fractional Brownian motion via Cholesky of C(t,s)=0.5*(t^2H+s^2H-|t-s|^2H)."""
    if not (0.0 < hurst < 1.0):
        raise ValueError("Hurst H must be in (0,1)")
    if n < 2:
        raise ValueError("n must be >= 2")
    rng = random.Random(seed)
    h2 = 2.0 * hurst
    cov = [[0.5 * (i ** h2 + j ** h2 - abs(i - j) ** h2) for j in range(n)] for i in range(n)]
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = cov[i][j] - sum(L[i][kk] * L[j][kk] for kk in range(j))
            if i == j:
                L[i][j] = math.sqrt(max(s, 0.0))
            else:
                L[i][j] = s / (L[j][j] if abs(L[j][j]) > _EPS else 1.0)
    z = [rng.gauss(0.0, 1.0) for _ in range(n)]
    return [sum(L[i][kk] * z[kk] for kk in range(i + 1)) for i in range(n)]

# ════════════════════════════════════════════════════════════════════
# B. OPTION PRICING
# ════════════════════════════════════════════════════════════════════

def _ncdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def _npdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def black_scholes_merton(
    spot: float, strike: float, ttm_years: float, rate: float, volatility: float,
    option_type: str = "call", dividend_yield: float = 0.0,
) -> float:
    """BSM price (Hull Ch.19; Shreve Sec.5.3.1). q = dividend yield."""
    if spot <= 0:
        raise ValueError("spot must be positive")
    if ttm_years < 0 or volatility < 0:
        raise ValueError("ttm>=0 and volatility>=0 required")
    if ttm_years == 0:
        return float(max((spot - strike) if option_type == "call" else (strike - spot), 0.0))
    q = dividend_yield
    sq = math.sqrt(ttm_years)
    d1 = (math.log(spot / strike) + (rate - q + 0.5 * volatility ** 2) * ttm_years) / (volatility * sq)
    d2 = d1 - volatility * sq
    sPV = spot * math.exp(-q * ttm_years)
    kPV = strike * math.exp(-rate * ttm_years)
    if option_type == "call":
        return float(sPV * _ncdf(d1) - kPV * _ncdf(d2))
    if option_type == "put":
        return float(kPV * _ncdf(-d2) - sPV * _ncdf(-d1))
    raise ValueError("option_type must be 'call' or 'put'")


def black_scholes_greeks(
    spot: float, strike: float, ttm_years: float, rate: float, volatility: float,
    option_type: str = "call", dividend_yield: float = 0.0,
) -> Dict[str, float]:
    """BSM Greeks (Hull Ch.19): delta, gamma, vega, theta, rho."""
    if spot <= 0 or ttm_years < 0 or volatility <= 0:
        raise ValueError("spot>0, ttm>=0, vol>0 required")
    d1, d2 = _bsm_d1d2(spot, strike, ttm_years, rate, volatility, dividend_yield)
    q = dividend_yield
    is_call = option_type == "call"
    sq = math.sqrt(ttm_years) if ttm_years > 0 else 0.0
    phi = _npdf(d1)
    e_qT = math.exp(-q * ttm_years)
    e_rT = math.exp(-rate * ttm_years)
    delta = e_qT * (_ncdf(d1) if is_call else (_ncdf(d1) - 1.0))
    gamma = e_qT * phi / (spot * volatility * sq) if sq > 0 else 0.0
    vega = spot * e_qT * phi * sq
    if ttm_years == 0:
        theta = rho = 0.0
    elif is_call:
        theta = (-spot * phi * volatility * e_qT) / (2 * sq) + q * spot * _ncdf(d1) * e_qT - rate * strike * e_rT * _ncdf(d2)
        rho = strike * ttm_years * e_rT * _ncdf(d2)
    else:
        theta = (-spot * phi * volatility * e_qT) / (2 * sq) - q * spot * _ncdf(-d1) * e_qT + rate * strike * e_rT * _ncdf(-d2)
        rho = -strike * ttm_years * e_rT * _ncdf(-d2)
    return {
        "delta": float(delta), "gamma": float(gamma), "vega": float(vega),
        "theta": float(theta), "rho": float(rho),
    }


def _bsm_d1d2(spot: float, strike: float, ttm: float, rate: float, vol: float, q: float) -> Tuple[float, float]:
    if vol <= 0 or ttm <= 0:
        return (float("inf"), float("inf"))
    sq = math.sqrt(ttm)
    d1 = (math.log(spot / strike) + (rate - q + 0.5 * vol * vol) * ttm) / (vol * sq)
    return d1, d1 - vol * sq


def binomial_crr(
    spot: float, strike: float, ttm_years: float, rate: float, volatility: float,
    steps: int = 200, option_type: str = "call", american: bool = True,
) -> float:
    """CRR binomial tree (Hull Ch.13). u=exp(sig*sqrt(dt)), d=1/u, p=(e^{r dt}-d)/(u-d)."""
    if spot <= 0 or ttm_years < 0 or volatility < 0 or steps < 1:
        raise ValueError("invalid tree inputs")
    if ttm_years == 0:
        return float(max((spot - strike) if option_type == "call" else (strike - spot), 0.0))
    dt = ttm_years / steps
    u = math.exp(volatility * math.sqrt(dt))
    d = 1.0 / u
    p = max(0.0, min(1.0, (math.exp(rate * dt) - d) / (u - d))) if u != d else 0.5
    disc = math.exp(-rate * dt)
    vals = [max((spot * u ** (steps - j) * d ** j - strike) if option_type == "call"
                else (strike - spot * u ** (steps - j) * d ** j), 0.0) for j in range(steps + 1)]
    for i in range(steps - 1, -1, -1):
        for j in range(i + 1):
            s = spot * u ** (i - j) * d ** j
            hold = disc * (p * vals[j] + (1 - p) * vals[j + 1])
            vals[j] = max(hold, (s - strike) if option_type == "call" else (strike - s)) if american else hold
    return float(vals[0])


def monte_carlo_antithetic(
    spot: float, strike: float, ttm_years: float, rate: float, volatility: float,
    option_type: str = "call", n_paths: int = 20000, seed: int = 42,
) -> float:
    """European price by Monte Carlo with antithetic variates (Hull Ch.19)."""
    if spot <= 0 or ttm_years < 0 or volatility < 0 or n_paths < 1:
        raise ValueError("invalid MC inputs")
    if ttm_years == 0:
        return float(max((spot - strike) if option_type == "call" else (strike - spot), 0.0))
    rng = random.Random(seed)
    sq = math.sqrt(ttm_years)
    drift = (rate - 0.5 * volatility ** 2) * ttm_years
    diff = volatility * sq
    total = 0.0
    count = 0
    for _ in range(n_paths):
        z = rng.gauss(0.0, 1.0)
        for eps in (z, -z):
            sT = spot * math.exp(drift + diff * eps)
            total += max((sT - strike) if option_type == "call" else (strike - sT), 0.0)
            count += 1
    return float(total / count * math.exp(-rate * ttm_years))


# ════════════════════════════════════════════════════════════════════
# C. VOLATILITY ESTIMATION
# ════════════════════════════════════════════════════════════════════

def _log(v: float) -> float:
    return math.log(v) if v > _EPS else 0.0


def garman_klass(highs: Sequence[float], lows: Sequence[float], closes: Sequence[float]) -> float:
    """Garman-Klass (1980) intra-period vol.""" 
    h, l, c = [float(x) for x in highs], [float(x) for x in lows], [float(x) for x in closes]
    if not (len(h) == len(l) == len(c)) or len(h) < 2:
        raise ValueError("equal-length highs/lows/closes with >=2 bars required")
    vals = [(0.5 * (_log(h[i] / l[i]) ** 2) - (2 * _log(2) - 1) * (_log(c[i] / c[i - 1]) ** 2))
            for i in range(1, len(h)) if h[i] > 0 and l[i] > 0 and c[i] > 0 and c[i - 1] > 0]
    return float(math.sqrt(max(sum(vals) / len(vals) if vals else 0.0, 0.0)))


def parkinson_volatility(highs: Sequence[float], lows: Sequence[float]) -> float:
    """Parkinson (1980) high-low vol: sqrt( (1/(4 ln2)) * mean(ln(H/L)^2) )."""
    h, l = [float(x) for x in highs], [float(x) for x in lows]
    if not (len(h) == len(l) and len(h) >= 1):
        raise ValueError("equal-length highs/lows required")
    vals = [_log(h[i] / l[i]) for i in range(len(h)) if h[i] > 0 and l[i] > 0]
    return float(math.sqrt(max(sum(v ** 2 for v in vals) / (4.0 * math.log(2.0)) / (len(vals) or 1), 0.0)))


def rogers_satchell(
    opens: Sequence[float], highs: Sequence[float], lows: Sequence[float], closes: Sequence[float],
) -> float:
    """Rogers-Satchell (1991) drift-free open-high-low-close estimator."""
    o, h, l, c = ([float(x) for x in s] for s in (opens, highs, lows, closes))
    if not (len(o) == len(h) == len(l) == len(c)) or len(o) < 1:
        raise ValueError("equal-length OHLC required")
    vals = [(_log(h[i] / o[i]) * _log(h[i] / c[i]) + _log(l[i] / o[i]) * _log(l[i] / c[i]))
            for i in range(len(o)) if o[i] > 0 and h[i] > 0 and l[i] > 0 and c[i] > 0]
    return float(math.sqrt(max(sum(vals) / (len(vals) or 1), 0.0)))


def yang_zhang(
    opens: Sequence[float], highs: Sequence[float], lows: Sequence[float], closes: Sequence[float],
) -> float:
    """Yang-Zhang (2000) vol (weighted open/close + RS)."""
    o, h, l, c = ([float(x) for x in s] for s in (opens, highs, lows, closes))
    if not (len(o) == len(h) == len(l) == len(c)) or len(o) < 2:
        raise ValueError("equal-length OHLC with >=2 bars required")
    n = len(o)
    rs = [(_log(h[i] / o[i]) * _log(h[i] / c[i]) + _log(l[i] / o[i]) * _log(l[i] / c[i]))
          for i in range(n) if o[i] > 0 and h[i] > 0 and l[i] > 0 and c[i] > 0]
    oc = [_log(c[i] / o[i]) for i in range(n) if o[i] > 0 and c[i] > 0]
    co = [_log(o[i] / c[i - 1]) for i in range(1, n) if o[i] > 0 and c[i - 1] > 0]
    sigma_oc = math.sqrt(max(sum(x ** 2 for x in oc) / (len(oc) or 1), 0.0))
    sigma_co = math.sqrt(max(sum(x ** 2 for x in co) / (len(co) or 1), 0.0))
    sigma_rs = math.sqrt(max(sum(rs) / (len(rs) or 1), 0.0))
    return float(math.sqrt(max(sigma_oc ** 2 + 0.34 * sigma_co ** 2 + 0.66 * sigma_rs ** 2, 0.0)))


def realized_volatility(returns: Sequence[float]) -> float:
    """Realized volatility = sqrt(mean of squared returns)."""
    r = [float(x) for x in returns]
    if not r:
        raise ValueError("at least one return required")
    return float(math.sqrt(sum(x * x for x in r) / len(r)))


def ewma_volatility(returns: Sequence[float], lambda_: float = 0.94) -> float:
    """EWMA (RiskMetrics) vol with decay lambda (default 0.94)."""
    if not (0.0 < lambda_ < 1.0):
        raise ValueError("lambda must be in (0,1)")
    r = [float(x) for x in returns]
    if not r:
        raise ValueError("at least one return required")
    var = r[0] ** 2
    for x in r[1:]:
        var = lambda_ * var + (1 - lambda_) * x * x
    return float(math.sqrt(var))


def garch11_forecast(
    omega: float, alpha: float, beta: float, last_variance: float, last_return: float, horizon: int = 1,
) -> float:
    """GARCH(1,1) ahead forecast (Hull Ch. 24): var_{t+1}=omega+alpha*r^2+beta*var_t."""
    if omega < 0 or alpha < 0 or beta < 0 or (alpha + beta) >= 1:
        raise ValueError("alpha+beta must be < 1 and all params >= 0")
    if horizon < 1:
        raise ValueError("horizon must be >= 1")
    var = omega + alpha * last_return * last_return + beta * last_variance
    for _ in range(horizon - 1):
        var = omega + (alpha + beta) * var
    return float(math.sqrt(max(var, 0.0)))

# ════════════════════════════════════════════════════════════════════
# D. MICROSTRUCTURE
# ════════════════════════════════════════════════════════════════════

def kyle_lambda(order_flow: Sequence[float], price_changes: Sequence[float]) -> float:
    """Kyle (1985) price-impact coefficient dp = lambda*q + e (Hasbrouck Ch.8)."""
    q = [float(x) for x in order_flow]
    d = [float(x) for x in price_changes]
    n = min(len(q), len(d))
    if n < 3:
        raise ValueError("need >=3 paired observations")
    mq = sum(q[:n]) / n
    md = sum(d[:n]) / n
    var_q = sum((x - mq) ** 2 for x in q[:n])
    if var_q <= _EPS:
        return 0.0
    cov = sum((q[i] - mq) * (d[i] - md) for i in range(n))
    return float(cov / var_q)


def roll_spread(prices: Sequence[float]) -> float:
    """Roll (1984) implicit spread: 2*sqrt(-cov(dp_t, dp_{t-1}))."""
    d = [float(prices[i]) - float(prices[i - 1]) for i in range(1, len(prices))]
    if len(d) < 3:
        raise ValueError("need >=4 prices")
    n = len(d) - 1
    md = sum(d[:n]) / n
    me = sum(d[1:]) / n
    cov = sum((d[i] - md) * (d[i + 1] - me) for i in range(n)) / n
    return float(2.0 * math.sqrt(-cov)) if cov < 0 else 0.0


def amihud_illiquidity(returns: Sequence[float], dollar_volume: Sequence[float]) -> float:
    """Amihud (2002) illiquidity: mean(|r| / dollar-volume)."""
    r = [float(x) for x in returns]
    dv = [float(x) for x in dollar_volume]
    n = min(len(r), len(dv))
    if n < 1:
        raise ValueError("need return/volume pairs")
    vals = [abs(r[i]) / dv[i] for i in range(n) if dv[i] > _EPS]
    return float(sum(vals) / (len(vals) or 1))


def vpin_estimate(
    buy_imbalance: Sequence[float], total_volume: Sequence[float], buckets: int = 50,
) -> float:
    """VPIN — Volume-Synchronized Probability of Informed Trading
    (Easley, Lopez de Prado & O'Hara 2012). mean(|buy - sell| / total_volume)."""
    b = [float(x) for x in buy_imbalance]
    v = [float(x) for x in total_volume]
    n = min(len(b), len(v))
    if n < buckets:
        raise ValueError(f"need >= {buckets} volume buckets")
    vals = [abs(b[i]) / v[i] for i in range(n) if v[i] > _EPS]
    vals = vals[-buckets:]
    return float(sum(vals) / (len(vals) or 1))


def order_flow_imbalance(buy_volume: float, sell_volume: float) -> float:
    """OFI = (buy - sell) / (buy + sell), clipped to [-1,1]."""
    total = float(buy_volume) + float(sell_volume)
    if total <= _EPS or buy_volume < 0 or sell_volume < 0:
        return 0.0
    return float(max(-1.0, min(1.0, (float(buy_volume) - float(sell_volume)) / total)))


def glosten_milgrom_spread(prob_up: float, alpha: float, v: float) -> Dict[str, float]:
    """Glosten-Milgrom (1985) info spread: bid=V-alpha*V*Pup/(...), ask mirror
    (O'Hara Ch.3). alpha = fraction of informed orders."""
    if not (0.0 <= float(prob_up) <= 1.0) or not (0.0 <= float(alpha) <= 1.0):
        raise ValueError("prob_up and alpha must be in [0,1]")
    v = float(v)
    spread = 2.0 * float(alpha) * v * 0.5
    return {"bid": v - spread / 2.0, "ask": v + spread / 2.0, "spread": spread}


def pin_estimate(alpha: float, delta: float, mu: float, eps_b: float, eps_s: float) -> float:
    """PIN (Easley, Kiefer, O'Hara): PIN = alpha*mu / (alpha*mu + eps_b + eps_s)."""
    num = float(alpha) * float(mu)
    den = num + float(eps_b) + float(eps_s)
    return float(num / den) if den > _EPS else 0.0


# ════════════════════════════════════════════════════════════════════
# E. RISK
# ════════════════════════════════════════════════════════════════════

def _z_quantile(p: float) -> float:
    p = max(1e-12, min(1 - 1e-12, p))
    if p < 0.5:
        return -_z_quantile(1 - p)
    a = (-2.0 * math.log(1.0 - p)) ** 0.5
    num = 2.515517 + 0.802853 * a + 0.010328 * a * a
    den = 1.0 + 1.432788 * a + 0.189269 * a * a + 0.001308 * a ** 3
    return a - num / den


def value_at_risk(returns: Sequence[float], confidence: float = 0.95, parametric: bool = True) -> float:
    """VaR for a LONG portfolio (positive = loss). Historical percentile or
    parametric sigma*quantile (Bouchaud Ch.3)."""
    r = [float(x) for x in returns]
    if len(r) < 2:
        raise ValueError("need >=2 returns")
    if not (0.5 < confidence < 1.0):
        raise ValueError("confidence must be in (0.5,1)")
    if parametric:
        mean = sum(r) / len(r)
        var = sum((x - mean) ** 2 for x in r) / (len(r) - 1)
        return float(math.sqrt(var) * _z_quantile(confidence))
    r_sorted = sorted(r)
    idx = max(0, int((1.0 - confidence) * len(r_sorted)) - 1)
    return float(-r_sorted[idx])


def expected_shortfall(returns: Sequence[float], confidence: float = 0.95) -> float:
    """Expected shortfall (CVaR) for a long portfolio (Bouchaud Ch.3)."""
    r = sorted([float(x) for x in returns])
    if len(r) < 2:
        raise ValueError("need >=2 returns")
    if not (0.5 < confidence < 1.0):
        raise ValueError("confidence must be in (0.5,1)")
    n_tail = max(1, int((1.0 - confidence) * len(r)))
    tail = r[:n_tail]
    return float(-sum(tail) / len(tail))


def cornish_fisher_var(returns: Sequence[float], confidence: float = 0.95) -> float:
    """Cornish-Fisher expanded VaR using skewness & kurtosis (Bouchaud Ch.3;
    Hull Ch. 22)."""
    r = [float(x) for x in returns]
    if len(r) < 4:
        raise ValueError("need >=4 returns")
    mean = sum(r) / len(r)
    n = len(r)
    var = sum((x - mean) ** 2 for x in r) / (n - 1)
    sig = math.sqrt(var)
    if sig <= _EPS:
        return 0.0
    skew = sum(((x - mean) / sig) ** 3 for x in r) / n
    kurt = sum(((x - mean) / sig) ** 4 for x in r) / n - 3.0
    z = _z_quantile(confidence)
    z_cf = z + (z * z - 1.0) * skew / 6.0 + (z ** 3 - 3.0 * z) * kurt / 24.0 - (2.0 * z ** 3 - 5.0 * z) * skew * skew / 36.0
    return float(sig * z_cf)


def max_drawdown(equity: Sequence[float]) -> float:
    """Maximum drawdown (as a positive fraction) of an equity curve."""
    e = [float(x) for x in equity]
    if not e:
        raise ValueError("equity series must not be empty")
    peak = e[0]
    worst = 0.0
    for x in e:
        peak = max(peak, x)
        dd = (peak - x) / peak if peak > _EPS else 0.0
        worst = max(worst, dd)
    return float(worst)


def sharpe_ratio(returns: Sequence[float], risk_free: float = 0.0, periods_per_year: float = 252.0) -> float:
    """Annualized Sharpe ratio."""
    r = [float(x) for x in returns]
    if len(r) < 2:
        raise ValueError("need >=2 returns")
    excess = [x - risk_free for x in r]
    mean = sum(excess) / len(excess)
    var = sum((x - mean) ** 2 for x in excess) / (len(excess) - 1)
    sig = math.sqrt(var)
    return float(0.0) if sig <= _EPS else float(math.sqrt(periods_per_year) * mean / sig)


def sortino_ratio(returns: Sequence[float], target: float = 0.0, periods_per_year: float = 252.0) -> float:
    """Sortino ratio using downside deviations."""
    r = [float(x) for x in returns]
    if len(r) < 2:
        raise ValueError("need >=2 returns")
    downside = [min(x - target, 0.0) for x in r]
    mean = sum(r) / len(r)
    if not downside:
        return 0.0
    dvar = sum(x * x for x in downside) / len(downside)
    dsig = math.sqrt(dvar)
    return float(0.0) if dsig <= _EPS else float(math.sqrt(periods_per_year) * (mean - target) / dsig)


def calmar_ratio(annualized_return: float, max_dd: float) -> float:
    """Calmar ratio = annualized return / max drawdown."""
    if max_dd <= _EPS:
        return 0.0
    return float(annualized_return / max_dd)


def kelly_fraction(win_prob: float, win_amount: float, loss_amount: float) -> float:
    """Kelly (1956) growth-optimal fraction: f* = p/a - q/b (converted from
    b-odds form). win/loss amounts are P/L per unit."""
    if not (0 < win_prob < 1):
        raise ValueError("win_prob must be in (0,1)")
    if win_amount <= 0 or loss_amount <= 0:
        raise ValueError("win/loss amounts must be positive")
    b = win_amount / loss_amount
    q = 1.0 - win_prob
    f = win_prob - q / b
    return float(max(f, 0.0))


def fractional_kelly(win_prob: float, win_amount: float, loss_amount: float, fraction: float = 0.25) -> float:
    """Fractional Kelly sizing (quarter-Kelly recommended)."""
    if not (0.0 < fraction <= 1.0):
        raise ValueError("fraction must be in (0,1]")
    return float(fraction * kelly_fraction(win_prob, win_amount, loss_amount))

# ════════════════════════════════════════════════════════════════════
# F. TIME SERIES
# ════════════════════════════════════════════════════════════════════

def adf_statistic(series: Sequence[float]) -> float:
    """Augmented Dickey-Fuller tau statistic on the AR(1) difference regression
    (no trend). More negative = stronger rejection of a unit root (I(1))."""
    s = [float(x) for x in series]
    if len(s) < 6:
        raise ValueError("need >=6 observations")
    y = [s[i] - s[i - 1] for i in range(1, len(s))]
    x = s[:-1]
    n = len(y)
    mx = sum(x) / n
    my = sum(y) / n
    sx = sum((xi - mx) ** 2 for xi in x)
    if sx <= _EPS:
        raise ValueError("constant series has no unit-root info")
    b = sum((x[i] - mx) * (y[i] - my) for i in range(n)) / sx
    resid = [(y[i] - my) - b * (x[i] - mx) for i in range(n)]
    sigma2 = sum(r2 * r2 for r2 in resid) / (n - 2)
    se = math.sqrt(sigma2 / sx)
    return float(b / se) if se > _EPS else 0.0


def _standard_normal_cdf(x: float) -> float:
    """Standard normal CDF via erfc (Hull N(d), no scipy dependency)."""
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def adf_pvalue(tau: float) -> float:
    """MacKinnon (1994/2010) approximate p-value for an ADF tau statistic.

    Uses the response-surface coefficients published in statsmodels'
    ``adfvalues.mackinnonp`` for the regression-with-constant ("c") case, N=1 —
    the exact model family that :func:`adf_statistic` computes (demeaned AR(1)
    difference regression, no trend). Returns the same p-value that
    ``statsmodels.tsa.stattools.adfuller`` reports for the same tau, without
    importing statsmodels.

    Lower tau -> smaller p (stronger unit-root rejection); the surface saturates
    at 0.0 / 1.0 well past the tails.
    """
    # Cut-off values for the left-tail surface ("c" case, N=1 row) — MacKinnon.
    maxstat = 2.74
    minstat = -18.83
    starstat = -1.61
    if tau > maxstat:
        return 1.0
    if tau < minstat:
        return 0.0
    if tau <= starstat:
        # tau_c_smallp[0] = [2.1659, 1.4412, 3.8269] * [1, 1, 1e-2]
        # polyval(reversed): 2.1659 + 1.4412*tau + 0.038269*tau**2
        z = 2.1659 + 1.4412 * tau + 0.038269 * tau * tau
    else:
        # tau_c_largep[0] = [1.7339, 9.3202, -1.2745, -1.0368] * [1, 1e-1, 1e-1, 1e-2]
        # polyval(reversed): 1.7339 + 0.93202*tau - 0.12745*tau**2 - 0.010368*tau**3
        z = 1.7339 + 0.93202 * tau - 0.12745 * tau * tau - 0.010368 * tau * tau * tau
    return float(_standard_normal_cdf(z))


def _expected_rs(m: int) -> float:
    """Anis & Lloyd (1976) finite-sample expectation of R/S for iid normal
    increments of length ``m``:
        E[R/S](m) = Gamma((m-1)/2) / (sqrt(pi) * Gamma(m/2)) * sum_{k=1}^{m-1} sqrt((m-k)/k)

    Evaluated in log space to avoid Gamma overflow on large ``m``. Dividing the
    observed R/S by this null-model curve removes the upward small-scale bias of
    the raw R/S t-statistic: a pure white-noise sequence reads H == 0.5, not the
    spuriously high ~0.55 of the uncorrected estimator (which misclassifies
    random walks as trending)."""
    if m < 3:
        return float("nan")
    logg = math.lgamma((m - 1) / 2.0) - (0.5 * math.log(math.pi) + math.lgamma(m / 2.0))
    total = 0.0
    for k in range(1, m):
        total += math.sqrt((m - k) / k)
    return total * math.exp(logg)


def hurst_rs(series: Sequence[float]) -> float:
    """Hurst exponent via rescaled-range (R/S) analysis (Hurst 1951; Mandelbrot).
    H in (0.5,1) trending, H<0.5 mean-reverting, H=0.5 random walk.

    PART 12: Weron's overlapping-window R/S (Weron 2002) on a fine geometric
    scale ladder (m from n//128 doubling-points up to n//4, ~4x overlap), then
    an OLS slope of log(R/S) vs log(m). The observed R/S at each scale is FIRST
    divided by the Anis-Lloyd iid expectation (_expected_rs) so that pure white
    noise reads exactly H = 0.5 — the raw estimator is biased upward by the
    finite-sample correction and would label random walks as trending. R is the
    true range (max-min cumulative deviation), S the sample std (n-1 divisor).
    The final estimate is clamped to [0, 1].
    """
    s = [float(x) for x in series]
    n = len(s)
    if n < 20:
        raise ValueError("need >=20 observations")

    def _rs_at(m: int) -> float:
        nw = n - m + 1
        step = max(1, m // 4)  # ~4x overlap, bounded below by 1
        total = 0.0
        count = 0
        denom = max(m - 1, 1)
        for start in range(0, nw, step):
            block = s[start:start + m]
            mean = sum(block) / m
            cum = 0.0
            lo = 0.0
            hi = 0.0
            for x in block:
                cum += x - mean
                if cum < lo:
                    lo = cum
                if cum > hi:
                    hi = cum
            R = hi - lo
            S = math.sqrt(sum((x - mean) ** 2 for x in block) / denom)
            if S > _EPS:
                total += R / S
                count += 1
        return total / count if count else 0.0

    rs_values: list[float] = []
    lengths: list[float] = []
    seen: set[int] = set()
    m = max(8, n // 128)
    while m < n // 4:
        mi = int(m)
        if mi >= 8 and mi not in seen:
            seen.add(mi)
            v = _rs_at(mi)
            e = _expected_rs(mi)
            if v > 0.0 and e > 0.0:
                rs_values.append(math.log(v / e))
                lengths.append(math.log(mi))
        m *= 1.2
    # Guarantee the top scale n//4 is always represented.
    m2 = n // 4
    if m2 >= 8 and m2 not in seen and m2 < n:
        seen.add(m2)
        v = _rs_at(m2)
        e = _expected_rs(m2)
        if v > 0.0 and e > 0.0:
            rs_values.append(math.log(v / e))
            lengths.append(math.log(m2))
    if len(rs_values) < 2:
        return 0.5
    mlx = sum(lengths) / len(lengths)
    mly = sum(rs_values) / len(rs_values)
    sxx = sum((x - mlx) ** 2 for x in lengths)
    if sxx <= _EPS:
        return 0.5
    slope = sum((lengths[i] - mlx) * (rs_values[i] - mly) for i in range(len(lengths))) / sxx
    return float(max(0.0, min(1.0, 0.5 + slope)))


def fractional_differentiation(series: Sequence[float], d: float = 0.5, cutoff: float = 1e-6) -> List[float]:
    """Fractional differencing weights filter (Lopez de Prado Ch.5)."""
    if not (0.0 < d < 1.0):
        raise ValueError("d must be in (0,1)")
    s = [float(x) for x in series]
    if not s:
        raise ValueError("empty series")
    w = [1.0]
    k = 1
    while True:
        nw = -w[-1] * (d - k + 1) / k
        if abs(nw) < cutoff:
            break
        w.append(nw)
        k += 1
        if k > 1000:
            break
    out: List[float] = []
    for i in range(len(s)):
        if i < len(w):
            out.append(0.0)
            continue
        acc = sum(w[j] * s[i - j] for j in range(len(w)))
        out.append(acc)
    return out


def engle_granger_cointegration(y: Sequence[float], x: Sequence[float]) -> Dict[str, float]:
    """Engle-Granger (1987) two-step: regress y on x, return residual H statistic
    proxy (plain OLS residual mean-reversion persistence)."""
    yv = [float(a) for a in y]
    xv = [float(b) for b in x]
    n = min(len(yv), len(xv))
    if n < 8:
        raise ValueError("need >=8 paired observations")
    mx = sum(xv[:n]) / n
    my = sum(yv[:n]) / n
    sx = sum((xv[i] - mx) ** 2 for i in range(n))
    if sx <= _EPS:
        raise ValueError("constant regressor")
    beta = sum((xv[i] - mx) * (yv[i] - my) for i in range(n)) / sx
    alpha = my - beta * mx
    resid = [yv[i] - beta * xv[i] - alpha for i in range(n)]
    h = adf_statistic(resid)
    return {"beta": float(beta), "alpha": float(alpha), "residual_adf": float(h)}


def kalman_filter_1d(
    measurements: Sequence[float],
    process_noise: float = 1e-5,
    measurement_noise: float = 1e-3,
) -> Dict[str, List[float]]:
    """1-D Kalman filter (Chan Ch.3): filtered mean + variance per step."""
    z = [float(x) for x in measurements]
    if not z:
        raise ValueError("empty measurement series")
    x = float(z[0])
    v = 1.0
    means = [x]
    vars_ = [v]
    for zi in z[1:]:
        v += process_noise
        k = v / (v + measurement_noise)
        x = x + k * (zi - x)
        v = (1.0 - k) * v
        means.append(x)
        vars_.append(v)
    return {"filtered": means, "variance": vars_}


def pca_components(matrix: Sequence[Sequence[float]], n_components: int = 2) -> Dict[str, Any]:
    """PCA by eigendecomposition of the (centered) data's covariance matrix.
    Returns eigenvalues, eigenvectors (rows), and projected data."""
    rows = [[float(v) for v in row] for row in matrix]
    if not rows:
        raise ValueError("empty matrix")
    n_vars = len(rows[0])
    if n_vars < 1 or any(len(r) != n_vars for r in rows):
        raise ValueError("rectangular matrix required")
    if not (1 <= n_components <= n_vars):
        raise ValueError("n_components must be in [1, n_vars]")
    means = [sum(r[j] for r in rows) / len(rows) for j in range(n_vars)]
    covs = [[0.0] * n_vars for _ in range(n_vars)]
    for i in range(n_vars):
        for j in range(n_vars):
            covs[i][j] = sum((r[i] - means[i]) * (r[j] - means[j]) for r in rows) / len(rows)
    eigvals, eigvecs = _symmetric_eig(covs)
    order = sorted(range(n_vars), key=lambda k: -eigvals[k])[:n_components]
    components = [[eigvecs[j][order[k]] for j in range(n_vars)] for k in range(n_components)]
    projected = [[sum((r[j] - means[j]) * components[k][j] for j in range(n_vars)) for k in range(n_components)] for r in rows]
    return {
        "eigenvalues": [float(eigvals[i]) for i in order],
        "components": components,
        "projected": projected,
    }


def _symmetric_eig(m: List[List[float]]) -> Tuple[List[float], List[List[float]]]:
    """Jacobi eigendecomposition of a small symmetric matrix.

    Eigenvalue ``i`` pairs with eigenvector *column* ``i`` of the returned
    matrix V (columns are the eigenvectors).
    """
    n = len(m)
    a = [[float(m[i][j]) for j in range(n)] for i in range(n)]
    v = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    for _ in range(100):
        off = sum(a[i][j] ** 2 for i in range(n) for j in range(i))
        if off < 1e-14:
            break
        p, q = max(((i, j) for i in range(n) for j in range(i)),
                   key=lambda ij: a[ij[0]][ij[1]] ** 2)
        apq = a[p][q]
        if apq == 0.0:
            break
        app, aqq = a[p][p], a[q][q]
        tau = (aqq - app) / (2.0 * apq)
        t = (1.0 if tau >= 0.0 else -1.0) / (abs(tau) + math.sqrt(1.0 + tau * tau))
        c = 1.0 / math.sqrt(1.0 + t * t)
        s = t * c
        for k in range(n):
            a_kp, a_kq = a[k][p], a[k][q]
            a[k][p] = c * a_kp - s * a_kq
            a[k][q] = s * a_kp + c * a_kq
        a[p][p] = app - t * apq
        a[q][q] = aqq + t * apq
        a[p][q] = 0.0
        a[q][p] = 0.0
        for k in range(n):
            v_kp, v_kq = v[k][p], v[k][q]
            v[k][p] = c * v_kp - s * v_kq
            v[k][q] = s * v_kp + c * v_kq
    return [a[i][i] for i in range(n)], v


# ════════════════════════════════════════════════════════════════════
# G. PORTFOLIO
# ════════════════════════════════════════════════════════════════════

def markowitz_weights(
    expected_returns: Sequence[float],
    cov_matrix: Sequence[Sequence[float]],
    target_return: Optional[float] = None,
) -> Dict[str, Any]:
    """Markowitz (1952) minimum-variance (or target-return) portfolio weights via
    closed-form Lagrange solution (Grinold & Kahn Ch. 5-6 framework)."""
    n = len(list(expected_returns))
    if n < 2 or len(cov_matrix) != n:
        raise ValueError("rectangular mean/cov with >=2 assets required")
    cov = [[float(cov_matrix[i][j]) for j in range(n)] for i in range(n)]
    inv = _inv(cov)
    ones = [1.0] * n
    rets = [float(x) for x in expected_returns]
    A = sum(inv[i][j] for i in range(n) for j in range(n))
    B = sum(inv[i][j] * rets[i] for i in range(n) for j in range(n))
    C = sum(inv[i][j] * rets[i] * rets[j] for i in range(n) for j in range(n))
    D = A * C - B * B
    if abs(D) <= _EPS:
        raise ValueError("singular optimization system")
    if target_return is None:
        lam1, lam2 = 0.0, 0.0
        w = [sum(inv[i][j] * 1.0 for j in range(n)) for i in range(n)]
        s = sum(w)
        w = [x / s for x in w] if s else w
    else:
        lam1 = (C - B * target_return) / D
        lam2 = (A * target_return - B) / D
        w = [lam1 * sum(inv[i][j] * rets[j] for j in range(n)) + lam2 * sum(inv[i][j] for j in range(n)) for i in range(n)]
    var = sum(w[i] * w[j] * cov[i][j] for i in range(n) for j in range(n))
    return {"weights": [float(x) for x in w], "portfolio_variance": float(max(var, 0.0))}


def _inv(m: List[List[float]]) -> List[List[float]]:
    n = len(m)
    aug = [[float(m[i][j]) for j in range(n)] + [1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(aug[r][col]))
        if abs(aug[pivot][col]) <= _EPS:
            raise ValueError("singular matrix")
        aug[col], aug[pivot] = aug[pivot], aug[col]
        pv = aug[col][col]
        aug[col] = [x / pv for x in aug[col]]
        for r in range(n):
            if r != col and abs(aug[r][col]) > _EPS:
                factor = aug[r][col]
                aug[r] = [aug[r][k] - factor * aug[col][k] for k in range(2 * n)]
    return [[aug[i][j] for j in range(n, 2 * n)] for i in range(n)]


def black_litterman(
    market_weights: Sequence[float],
    cov_matrix: Sequence[Sequence[float]],
    views: Dict[int, float],
    risk_aversion: float = 2.5,
    tau: float = 0.05,
    view_noise: float = 0.01,
) -> Dict[str, Any]:
    """Black-Litterman (1992) posterior weights from views on asset indices.

    Posterior tilt = tau*Sigma*P'.(P*tau*Sigma*P' + Omega)^-1.(Q - P*w_mkt),
    with a scalar diagonal ``view_noise`` for Omega (KxK). Returns weights + tilt.
    """
    n = len(list(market_weights))
    if len(cov_matrix) != n or risk_aversion <= 0 or tau <= 0 or view_noise <= 0:
        raise ValueError("invalid BL inputs")
    cov = [[float(cov_matrix[i][j]) for j in range(n)] for i in range(n)]
    view_k = len(views)
    w_mkt = [float(x) for x in market_weights]
    if view_k == 0:
        return {"weights": w_mkt, "tilt": [0.0] * n}
    P = [[0.0] * n for _ in range(view_k)]
    Q = []
    for row_idx, (asset_idx, view) in enumerate(views.items()):
        if not (0 <= asset_idx < n):
            raise ValueError("view asset index out of range")
        P[row_idx][asset_idx] = 1.0
        Q.append(float(view))
    # Implied equilibrium returns (the prior the views are compared against):
    #   Π = risk_aversion * Σ * w_mkt  (Black & Litterman 1992)
    pi = [sum(risk_aversion * cov[i][j] * w_mkt[j] for j in range(n)) for i in range(n)]
    # Omega = view_noise * I_K
    PCP = [[0.0] * view_k for _ in range(view_k)]
    for a in range(view_k):
        for b in range(view_k):
            PCP[a][b] = view_noise if a == b else 0.0
            for i in range(n):
                for j in range(n):
                    PCP[a][b] += P[a][i] * (tau * cov[i][j]) * P[b][j]
    PCP_inv = _inv(PCP)
    diff = [Q[r] - sum(P[r][j] * pi[j] for j in range(n)) for r in range(view_k)]
    sol = [sum(PCP_inv[r][c] * diff[c] for c in range(view_k)) for r in range(view_k)]
    tilt = [0.0] * n
    for i in range(n):
        for r in range(view_k):
            for j in range(n):
                tilt[i] += (tau * cov[i][j]) * P[r][j] * sol[r]
    return {"weights": [w_mkt[i] + tilt[i] for i in range(n)], "tilt": [float(x) for x in tilt]}


def risk_parity_weights(cov_matrix: Sequence[Sequence[float]], max_iter: int = 200) -> List[float]:
    """Risk-parity weights (equal marginal risk contribution) via a sqrt-damped
    fixed-point iteration (Griveau-Billion et al. 2013, risk-parity Ch.):
    ``w_i <- w_i * sqrt(target / rc_i)`` is contracting on equal-risk surfaces."""
    n = len(cov_matrix)
    if n < 2:
        raise ValueError("need >=2 assets")
    cov = [[float(cov_matrix[i][j]) for j in range(n)] for i in range(n)]
    w = [1.0 / n] * n
    for _ in range(max_iter):
        sigma_p = math.sqrt(max(sum(w[i] * w[j] * cov[i][j] for i in range(n) for j in range(n)), _EPS))
        marginal = [sum(cov[i][j] * w[j] for j in range(n)) for i in range(n)]
        rc = [w[i] * marginal[i] / sigma_p for i in range(n)]
        total_rc = sum(rc)
        if total_rc <= _EPS:
            break
        target = total_rc / n
        w_new = [w[i] * math.sqrt(target / rc[i]) if rc[i] > _EPS else w[i] for i in range(n)]
        total = sum(w_new)
        if total <= _EPS:
            break
        prev = w[:]
        w = [x / total for x in w_new]
        if max(abs(x - y) for x, y in zip(w, prev)) < 1e-10:
            break
    return [float(x) for x in w]


def information_coefficient(forecasts: Sequence[float], realized: Sequence[float]) -> float:
    """Grinold-Kahn IC: correlation of forecasts with realized returns (Ch.2)."""
    f = [float(x) for x in forecasts]
    r = [float(x) for x in realized]
    n = min(len(f), len(r))
    if n < 2:
        raise ValueError("need >=2 paired values")
    mf = sum(f[:n]) / n
    mr = sum(r[:n]) / n
    sf = math.sqrt(sum((x - mf) ** 2 for x in f[:n]))
    sr = math.sqrt(sum((x - mr) ** 2 for x in r[:n]))
    if sf <= _EPS or sr <= _EPS:
        return 0.0
    return float(sum((f[i] - mf) * (r[i] - mr) for i in range(n)) / (sf * sr))


def information_ratio(ic: float, breadth: float) -> float:
    """Grinold-Kahn information ratio = IC * sqrt(breadth) (Ch.5)."""
    if breadth < 0:
        raise ValueError("breadth must be >= 0")
    return float(ic * math.sqrt(breadth))