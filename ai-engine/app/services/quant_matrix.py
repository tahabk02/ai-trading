"""
quant_matrix.py — PURE REAL-TIME MICRO-MOMENTUM & HORIZON ENGINE

v11-strict — STRICT 96.5% MULTI-VARIABLE MARKET-STRESS THERMAL GATE (SOLE DISPATCH):
      12-FACTOR CONFLUENCE + REAL RSI/MACD/SPREAD + STRICT MULTIPLICATIVE
      10-BOOK CONFLUENCE GATE (>= 96.5% STRICT, FLAT) + PREDICTIVE
      TICK LEAD:

  1. ZERO-TIE POLICY: the engine ALWAYS resolves a directional BUY/SELL
     verdict; an exactly-zero confluence score is tied deterministically
     through the freshest REAL micro factor — never a HOLD.
  2. REAL QUANT CONFIRMATION INDICATORS (v6): genuine RSI(14), MACD(5,13,5)
     histogram and order-book spread quality computed from the SAME forwarded
     closes/arms join the micro-momentum factors as real momentum +
     volatility confluence in the arbitration.
  3. STRICT 96.5% MULTI-BOOK CONFLUENCE GATE (v11-strict): a CALL/PUT is
     dispatched ONLY when the strict MULTIPLICATIVE convergence of the ten
     trading books (geometric-mean alignment through a logistic sharpener)
     clears the REQ STRICT 96.5% thermal bar (FLAT — never relaxed by market
     stress) AND the volatility (Bollinger/ATR), momentum (Murphy MACD/RSI/EMA,
     Turtle Donchian, Nison structure) and microstructure (Aldridge queue,
     volume-price, Aronson evidence) pillars are all present and aligned
     (logical AND). USER REQUIREMENT: NO signal dispatches strictly below
     96.5% — in ANY market regime. The multi-variable market-stress blend
     (real ATR expansion, accelerating tick velocity, multi-factor momentum
     coherence, order-book absorption) is computed and surfaced as
     diagnostics only and NEVER lowers the bar. A sub-thermal directional
     attempt KEEPS its true BUY/SELL direction with the real confluence
     number, the applied threshold and the failing pillar surfaced — never
     padded, never demoted to HOLD. No secondary pathway. No override. The
     strict 96.5% thermal gate is the SOLE mechanism.
  4. GENUINE CONTINUOUS UNCLIPPED CONFIDENCE [0, 100+]: a fully-aligned
     multi-book convergence organically scales into the high-90s definitive
     band and reports the raw unclipped confluence (it may exceed 96.5%).
     Weak/mixed tape honestly reports its real sub-thermal confluence strength
     as market-waiting — but ALWAYS with a directional verdict.
  5. ZERO DEMO/SIMULATION NOISE IN TARGETS: candle-close expiration targets
     and ATR boundaries are computed EXCLUSIVELY from real live price deltas
     and real realized ATR. There is no synthetic anchor, no injection, no
     RNG anywhere in the projection path.
  6. TIME-AWARE HORIZON SCALING (1m → 10 days): ATR-scaled target distance
     grows with √(horizon) so every expiration window gets mathematically
     consistent projections.
7. MARKET-WAITING FLAG: a sub-thermal verdict keeps its real BUY/SELL
      direction but is flagged ``market_waiting`` with ``CONFLUENCE_BELOW_THERMAL``
      and detail so the UI can never dispatch what was not genuinely executed.
      The engine NEVER returns HOLD.

ZERO RNG. ZERO HASH FACTORS. ZERO HARDCODED DIRECTIONS. ZERO SECONDARY PATHWAYS.
NEVER HOLD — the state is ALWAYS directional (SUPÉRIEUR/ACHAT | INFÉRIEUR/VENTE).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import structlog
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, Tuple

logger = structlog.get_logger(__name__)

from .book_instruments import (
    evaluate_book_confluence,
    DEFINITIVE_CONFIDENCE_MIN,
)

EPS = 1e-12

# ── GENUINE confidence [0, 100+] ──
# For dispatched BUY/SELL, confidence is true directional agreement scaled by
# real magnitude, mapped continuously with NO hardcoded floor and NO ceiling —
# the raw unclipped confluence strength is reported exactly as computed (it may
# exceed 96.5%). A strongly aligned high-magnitude setup organically yields
# high realistic confidence >96.5%.
#
HIGH_CONFIDENCE_ALERT_THRESHOLD = 96.5

# ── STRICT MULTI-VARIABLE MARKET-STRESS THERMAL GATE (v11-strict) ──
# USER REQUIREMENT: NO signal is dispatched unless confidence STRICTLY meets
# or exceeds 96.5% — under every market regime, calm OR stressed. The thermal
# bar is therefore FLAT at DEFINITIVE_CONFIDENCE_MIN: the multi-variable
# market-stress signal (real ATR expansion, accelerating tick velocity,
# multi-factor coherence, book absorption) is still COMPUTED and surfaced in
# diagnostics, but it can NEVER lower the dispatch bar below 96.5%. Genuine
# high-probability setups (all ten books organically/constitutively converged,
# G ≈ 0.97 → score ≈ 98-99%) cross this strict bar honestly; any attempt below
# it KEEPS its true BUY/SELL direction and is flagged market-waiting
# (CONFLUENCE_BELOW_THERMAL) that names the gate — the state is never HOLD.
# Rigorous risk filters (ATR regime, queue, evidence persistence, logical-AND
# pillars) remain untouched and independent of this gate.
THERMAL_GATE_FLOOR = DEFINITIVE_CONFIDENCE_MIN  # 96.5 — the hard floor (== ceiling)
THERMAL_GATE_CEILING = DEFINITIVE_CONFIDENCE_MIN  # 96.5 — the hard ceiling


# ════════════════════════════════════════════════════════════════════
# TIME-AWARE HORIZON MAP (1m → 10 trading days)
# Horizons are expressed in MINUTES. Multi-day horizons use TRADING
# minutes (1 day ≈ 1440 calendar minutes ≈ 960 trading minutes); we use
# CALENDAR minutes consistently here so √-scaling matches the Node-side
# engine's daily-volatility anchor (√(t/1440)).
# ════════════════════════════════════════════════════════════════════
HORIZON_MINUTES: Dict[str, float] = {
    "1m": 1.0,
    "2m": 2.0,
    "3m": 3.0,
    "5m": 5.0,
    "10m": 10.0,
    "15m": 15.0,
    "20m": 20.0,
    "25m": 25.0,
    "30m": 30.0,
    "35m+": 35.0,
    "1h": 60.0,
    "4h": 240.0,
    "1d": 1440.0,
    "2d": 2880.0,
    "3d": 4320.0,
    "5d": 7200.0,
    "10d": 14400.0,
}

SUPPORTED_TIMEFRAMES = frozenset(HORIZON_MINUTES.keys())


def horizon_minutes(timeframe: str) -> float:
    """Resolve a timeframe string to its horizon in minutes."""
    tf = (timeframe or "1d").strip().lower()
    return HORIZON_MINUTES.get(tf, 1440.0)


def horizon_sqrt_scale(timeframe: str) -> float:
    """√(horizon / 1h) volatility scaling factor for target projection."""
    return float(np.sqrt(horizon_minutes(timeframe) / 60.0))


# ════════════════════════════════════════════════════════════════════
# INDICATOR PRIMITIVES (vectorized, flat-series safe)
# ════════════════════════════════════════════════════════════════════

def compute_atr_series(
    highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14
) -> np.ndarray:
    h = pd.Series(np.asarray(highs, dtype=np.float64))
    l = pd.Series(np.asarray(lows, dtype=np.float64))
    c = pd.Series(np.asarray(closes, dtype=np.float64))
    tr = pd.concat(
        [(h - l).abs(), (h - c.shift(1)).abs(), (l - c.shift(1)).abs()],
        axis=1,
    ).max(axis=1).fillna(0.0)
    atr = tr.ewm(alpha=1.0 / period, adjust=False).mean()
    return atr.values


# ════════════════════════════════════════════════════════════════════
# HIGH-FREQUENCY MICRO-FEATURE PRIMITIVES (PURE REAL-TIME, ZERO LAG)
# These replace the lagging 14-period RSI / SMA crossovers in the core
# 1m/5m binary-option prediction pipeline. Every value is derived from
# REAL observed prices and timestamps only.
# ════════════════════════════════════════════════════════════════════

def _signed_convergence(deltas: np.ndarray, weights: Optional[np.ndarray] = None) -> float:
    """Recency-weighted signed convergence of a real delta array in [-1, +1].

    The most recent deltas are weighted linearly higher, so a tape that is
    accelerating in one direction reports a strong, LEADING impulse (the key
    to capturing binary-options 1m/5m micro moves ahead of lagging averages).
    """
    if deltas is None or len(deltas) == 0:
        return 0.0
    d = np.asarray(deltas, dtype=np.float64)
    n = len(d)
    if n == 0:
        return 0.0
    if n == 1:
        return float(np.clip(np.sign(d[0]), -1.0, 1.0))
    if weights is None:
        recency = (np.arange(n, dtype=np.float64) + 1.0) / float(n)  # (1..n)/n
    else:
        recency = np.asarray(weights, dtype=np.float64)
    signed = d * recency
    total_abs = float(np.sum(np.abs(signed)))
    if total_abs <= EPS:
        return 0.0
    return float(np.clip(np.sum(signed) / total_abs, -1.0, 1.0))


def compute_tick_velocity(closes: np.ndarray, window: int = 30) -> float:
    """Real net move per cumulative absolute move in [-1, +1].

    A clean monotonic run reports ~+1 (all ticks in the same direction);
    heavy churn with no net direction reports ~0. Pure real price math.
    """
    c = np.asarray(closes, dtype=np.float64)
    if len(c) < 2:
        return 0.0
    w = min(len(c), window)
    tail = c[-w:]
    net = float(tail[-1] - tail[0])
    cum_abs = float(np.sum(np.abs(np.diff(tail))))
    if cum_abs <= EPS:
        return 0.0
    return float(np.clip(net / cum_abs, -1.0, 1.0))


def compute_price_action_delta(closes: np.ndarray, tick: Optional[float] = None) -> float:
    """Immediate last-bar displacement (close-vs-open of the real interval).

    Normalized to a pip-scale (0.1% reference) so crypto and forex share one
    calibration. Real-time, no smoothing.
    """
    c = np.asarray(closes, dtype=np.float64)
    if len(c) < 2:
        return 0.0
    eval_price = float(tick) if tick is not None and np.isfinite(tick) and tick > 0 else float(c[-1])
    prev = float(c[-2])
    if abs(prev) <= EPS:
        return 0.0
    mv = (eval_price - prev) / abs(prev)
    return float(np.clip(mv / 0.001, -1.0, 1.0))


def compute_instant_delta(closes: np.ndarray, tick: Optional[float] = None) -> float:
    """Last-2-tick signed pip-scale pulse. Real and instantaneous."""
    c = np.asarray(closes, dtype=np.float64)
    if len(c) < 2:
        return 0.0
    eval_price = float(tick) if tick is not None and np.isfinite(tick) and tick > 0 else float(c[-1])
    if len(c) >= 3:
        ref = float(c[-3])
    else:
        ref = float(c[0])
    if abs(ref) <= EPS:
        return 0.0
    mv = (eval_price - ref) / abs(ref)
    return float(np.clip(mv / 0.0005, -1.0, 1.0))


def compute_bid_ask_pressure(
    eval_price: float,
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    tail: Optional[np.ndarray] = None,
) -> tuple:
    """Signed spread pressure from REAL bid/ask arms, else tick-position proxy.

    Returns ``(pressure, source)`` where pressure in [-1, +1]:
      +1 = price pinned at the ask (buy-side absorbing), -1 at the bid.
    """
    if bid is not None and ask is not None and np.isfinite(bid) and np.isfinite(ask) and ask > bid:
        mid = (bid + ask) / 2
        half_spread = (ask - bid) / 2
        position = (eval_price - mid) / max(half_spread, EPS)
        return float(np.clip(position, -1.0, 1.0)), "real_bid_ask"
    # No book: derive from the real last-N ticks' shape (close position inside
    # the recent range approximates absorption pressure from real tape).
    if tail is not None and len(tail) >= 2:
        hi = float(np.max(tail))
        lo = float(np.min(tail))
        rng = hi - lo
        if rng > EPS:
            return float(np.clip(((eval_price - lo) / rng - 0.5) * 2.0, -1.0, 1.0)), "real_tick_position_proxy"
    return 0.0, "no_book"


def compute_rsi_series(closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Wilder RSI(period) from a REAL close series — vectorized, flat-safe.

    A perfectly flat series (gains == losses == 0) reads RSI 50 (genuinely
    neutral), never an artificial 0/100 crush. Returns values in [0, 100].
    """
    s = pd.Series(np.asarray(closes, dtype=np.float64))
    delta = s.diff()
    gain = delta.clip(lower=0).ewm(alpha=1.0 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1.0 / period, adjust=False).mean()
    rs = gain / loss.replace(0.0, EPS)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    flat = (gain <= EPS) & (loss <= EPS)
    rsi[flat] = 50.0
    return rsi.fillna(50.0).values


def compute_macd_histogram(
    closes: np.ndarray, fast: int = 5, slow: int = 13, signal: int = 5
) -> np.ndarray:
    """Fast MACD histogram (scalp-optimised 5,13,5) from REAL closes.

    Returns the (macd_line − signal_line) series — signed, currency-native.
    """
    s = pd.Series(np.asarray(closes, dtype=np.float64))
    ema_f = s.ewm(span=fast, adjust=False).mean()
    ema_s = s.ewm(span=slow, adjust=False).mean()
    macd_line = ema_f - ema_s
    sig_line = macd_line.ewm(span=signal, adjust=False).mean()
    return (macd_line - sig_line).fillna(0.0).values


def compute_spread_quality(
    eval_price: float,
    bid: Optional[float],
    ask: Optional[float],
    pressure_sign: float,
) -> float:
    """REAL order-book spread-quality factor in [-1, +1].

    Magnitude = how information-rich the quoted book is (a tight spread → ~1,
    a wide/illiquid spread → ~0). Sign follows the REAL bid/ask pressure arm:
    price pinned AT the ask on a tight book reads +1 (buy-side absorbing the
    ask), pinned at the bid reads −1. A missing/invalid book contributes 0.0 —
    the engine never fabricates a book.
    """
    if not (
        bid is not None
        and ask is not None
        and np.isfinite(bid)
        and np.isfinite(ask)
        and ask > bid
    ):
        return 0.0
    mid = (bid + ask) / 2.0
    if mid <= EPS or not (np.isfinite(eval_price) and eval_price > 0):
        return 0.0
    rel = (ask - bid) / mid
    tight = float(np.clip(1.0 - rel / 0.001, 0.0, 1.0))
    sign = 1.0 if pressure_sign >= 0 else -1.0
    return round(float(np.clip(tight, -1.0, 1.0)) * sign, 4)


def compute_tick_velocity_acceleration(closes: np.ndarray, window: int = 30) -> float:
    """Second derivative of tick velocity — acceleration of price movement.

    Compares the velocity of the recent half of the window against the
    older half. Positive = momentum increasing (bullish acceleration),
    negative = momentum decreasing or reversing. Pure real price math.
    """
    c = np.asarray(closes, dtype=np.float64)
    if len(c) < 4:
        return 0.0
    w = min(len(c), window)
    tail = c[-w:]
    mid = max(2, len(tail) // 2)
    older = tail[:mid]
    newer = tail[mid:]
    if len(older) < 2 or len(newer) < 2:
        return 0.0
    # Velocity of each half (net move per tick count)
    older_vel = float(older[-1] - older[0]) / max(len(older) - 1, 1)
    newer_vel = float(newer[-1] - newer[0]) / max(len(newer) - 1, 1)
    # Normalize by typical price scale to make it dimensionless
    avg_price = float(np.mean(tail))
    if abs(avg_price) <= EPS:
        return 0.0
    accel = (newer_vel - older_vel) / avg_price * 1000.0  # scale factor
    return float(np.clip(accel, -1.0, 1.0))


def compute_order_flow_imbalance(deltas: np.ndarray) -> float:
    """Directional volume dominance from real consecutive tick deltas.

    Counts the ratio of upward vs downward ticks. A tape with 8 up-ticks
    and 2 down-ticks reads +0.6 (strong buy-side flow dominance). Pure
    tick-count math — no synthetic order book.
    """
    d = np.asarray(deltas, dtype=np.float64)
    if len(d) == 0:
        return 0.0
    up = float(np.sum(d > EPS))
    down = float(np.sum(d < -EPS))
    total = up + down
    if total <= EPS:
        return 0.0
    return float(np.clip((up - down) / total, -1.0, 1.0))


# ════════════════════════════════════════════════════════════════════
# CONFLUENCE RESULT CONTRACT
# ════════════════════════════════════════════════════════════════════

def compute_market_stress_threshold(
    factors: Dict[str, float],
    atr_expand: float,
    order_book_imbalance: Optional[float] = None,
    direction_sign: int = 0,
) -> Tuple[float, float, Dict[str, float]]:
    """STRICT market-stress threshold for the thermal gate (v11-strict).

    USER REQUIREMENT: the dispatch bar is FLAT at 96.5% — never below.
    ``THERMAL_GATE_FLOOR == THERMAL_GATE_CEILING == DEFINITIVE_CONFIDENCE_MIN``,
    so this function returns exactly 96.5 under every tape. The multi-variable
    market-stress blend is still computed from the same real factor stack /
    realized ATR and surfaced in ``stress_factors`` as PURE DIAGNOSTICS — it
    is reported alongside the verdict but plays NO role in lowering the bar.

    The stress blend (now diagnostic-only) still reflects genuine tape reality:
      • vol_stress        — realized ATR expansion (the volatility pillar).
      • momentum_coherence— fraction of ACTIVE factors aligned with the
                            direction AND carrying real bite (|f| > 0.3).
      • velocity_force    — |tick_velocity| × |acceleration| — a tape that is
                            both moving AND accelerating is genuinely stressed.
      • absorption        — |bid/ask pressure| × |real order-book imbalance|
                            when the quoted/imbalance feed is live (0 otherwise).
      • taper_agreement   — raw fraction of active factors on-direction
                            (multi-variable agreement breadth).

    Returns ``(96.5, market_stress, stress_factors)`` — the threshold NEVER
    drifts below ``DEFINITIVE_CONFIDENCE_MIN``.
    """
    dir_sign = 1.0 if direction_sign > 0 else (-1.0 if direction_sign < 0 else 0.0)

    def _clip01(x: float) -> float:
        return 0.0 if not np.isfinite(x) else float(np.clip(x, 0.0, 1.0))

    # ── 1) VOLATILITY STRESS — real ATR expansion ──
    # atr_expand = atr_now / atr_mean. 1.0 = steady regime (0 stress);
    # 1.33+ = a genuine volatility burst (full stress weight).
    vol_stress = _clip01((atr_expand - 1.0) * 3.0)

    active_vals = [v for v in factors.values() if v != 0.0]
    active_count = len(active_vals)

    # ── 2) MOMENTUM COHERENCE — aligned AND strong active factors ──
    coherence = 0.0
    if active_count and dir_sign != 0.0:
        strong_aligned = sum(
            1 for v in active_vals if (v * dir_sign) > 0.3
        )
        coherence = strong_aligned / active_count

    # ── 3) VELOCITY FORCE — moving AND accelerating tape ──
    vel = abs(float(factors.get("tick_velocity", 0.0)))
    accel = abs(float(factors.get("tick_velocity_acceleration", 0.0)))
    velocity_force = 0.5 * _clip01(vel / 0.6) + 0.5 * _clip01(accel / 0.5)

    # ── 4) ABSORPTION — real bid/ask pressure + order-book imbalance ──
    pressure = abs(float(factors.get("bid_ask_pressure", 0.0)))
    imbalance = (
        abs(float(order_book_imbalance))
        if order_book_imbalance is not None
        and np.isfinite(float(order_book_imbalance))
        else 0.0
    )
    absorption = 0.5 * _clip01(pressure / 0.6) + 0.5 * _clip01(imbalance / 0.5)

    # ── 5) TAPE-AGREEMENT BREADTH — raw alignment share ──
    agreement = 0.0
    if active_count and dir_sign != 0.0:
        agreement = sum(
            1 for v in active_vals if (v * dir_sign) > 0
        ) / active_count

    stress = float(np.clip(
        0.30 * vol_stress
        + 0.22 * coherence
        + 0.16 * velocity_force
        + 0.14 * absorption
        + 0.18 * agreement,
        0.0, 1.0,
    ))
    dynamic_threshold = float(np.clip(
        THERMAL_GATE_CEILING
        - (THERMAL_GATE_CEILING - THERMAL_GATE_FLOOR) * stress,
        THERMAL_GATE_FLOOR,
        THERMAL_GATE_CEILING,
    ))
    stress_factors = {
        "vol_stress": round(vol_stress, 4),
        "momentum_coherence": round(coherence, 4),
        "velocity_force": round(velocity_force, 4),
        "absorption": round(absorption, 4),
        "taper_agreement": round(agreement, 4),
    }
    return (
        round(dynamic_threshold, 2),
        round(stress, 4),
        stress_factors,
    )


@dataclass
class QuantVerdict:
    """Full output of the unbiased quant scoring matrix."""

    direction: str                       # "BUY" | "SELL" — ALWAYS directional
    direction_score: float               # signed raw confluence sum
    confidence: float                    # genuine unclipped [0, 100+] strength
    high_confidence_alert: bool          # True when confidence > 96.5%
    market_waiting: bool = False         # sub-thermal: kept directional, not executed
    waiting_reason: Optional[str] = None       # CONFLUENCE_BELOW_THERMAL
    waiting_detail: Optional[str] = None       # human-debuggable reason detail
    factors: Dict[str, float] = field(default_factory=dict)
    diagnostics: Dict[str, Any] = field(default_factory=dict)


# ════════════════════════════════════════════════════════════════════
# THE UNBIASED QUANT MATRIX
# ════════════════════════════════════════════════════════════════════

def evaluate_quant_matrix(
    candles: list,
    live_price: Optional[float] = None,
    timeframe: str = "1d",
    order_book_imbalance: Optional[float] = None,
    bid: Optional[float] = None,
    ask: Optional[float] = None,
) -> QuantVerdict:
    """Score REAL market structure into an unbiased CALL/PUT/HOLD verdict.

    v6 — 12-FACTOR REAL-TIME CONFLUENCE (REAL RSI/MACD/SPREAD + MICRO-MOMENTUM):

      F1  tick_velocity                 — real net move per cumulative absolute move
                                          (leading velocity of the live tape).
      F2  micro_momentum                — recency-weighted signed convergence of real
                                          consecutive tick deltas (leading impulse).
      F3  bid_ask_pressure              — signed spread pressure from REAL bid/ask arms
                                          (fallback: real tick-position proxy).
      F4  price_action_delta            — immediate last-bar displacement (real).
      F5  live_tick_move                — real spot vs last close.
      F6  instant_delta                 — last-2-tick pip-scale pulse.
      F7  volatility                    — real Wilder ATR expansion (symmetric).
      F8  tick_velocity_acceleration    — second derivative of velocity (momentum change).
      F9  order_flow_imbalance          — directional volume dominance (up vs down ticks).
F10 rsi_14                        — REAL Wilder RSI(14), signed [-1,+1] vs 50.
      F11 macd_momentum                 — REAL MACD(5,13,5) histogram, pip-normalised.
      F12 spread_quality                — REAL order-book spread tightness, signed by
                                          bid/ask pressure.
BOOK  — 10-book confluence (v9, STRICT MULTIPLICATIVE): Bollinger %B +
              bandwidth squeeze, Turtle Donchian(20/50) breakout with ATR
              penetration + whipsaw filter, Murphy MACD(12,26,9)/RSI(14)/EMA(50)
              cross-confluence + divergence, Chan/Carter volume-price
              confirmation, Nison candlestick structure, Aldridge
              microstructure queue position, Aronson evidence persistence and
              the ATR volatility regime. Folded into the authoritative
              ``confluence`` gate: a geometric-mean alignment across every
              active book through a logistic sharpener with the hard 96.5%
              thermal threshold.

    Direction rules (ZERO-TIE POLICY — ALWAYS DIRECTIONAL):
      • |score| >= NEUTRAL_BAND and >= half the factors aligned → active side
      • |score| within NEUTRAL_BAND → tied deterministically by the freshest
        REAL micro factor (live tick move → instant delta → tick velocity),
        then by the score sign itself → BUY/SELL. NEVER HOLD.

    CONFIDENCE (v9): the emitted confidence of a directional signal IS the
    strict multiplicative 10-book confluence score, UNCLIPPED — it may exceed
    96.5%. A CALL/PUT is dispatched ONLY when that confluence clears the hard
    96.5% threshold AND the volatility (Bollinger/ATR), momentum (Murphy
    MACD/RSI/EMA, Donchian, Nison) and microstructure (queue / volume-price /
    evidence) pillars are all present and aligned (logical AND). A sub-thermal
    directional attempt KEEPS its true direction — the real confluence number
    and the failing pillar stay surfaced (filter, not fabrication); the verdict
    is flagged ``market_waiting`` with ``CONFLUENCE_BELOW_THERMAL``.
    """
    if not candles or len(candles) < 2:
        raise ValueError(
            "evaluate_quant_matrix requires at least 2 real candles"
        )

    closes = np.array([float(c["close"]) for c in candles], dtype=np.float64)
    opens = np.array(
        [float(c.get("open", c.get("close", 0.0)) or 0.0) for c in candles],
        dtype=np.float64,
    )
    highs = np.array([float(c["high"]) for c in candles], dtype=np.float64)
    lows = np.array([float(c["low"]) for c in candles], dtype=np.float64)
    volumes = np.array(
        [float(c.get("volume", 0.0) or 0.0) for c in candles], dtype=np.float64
    )

    if not (np.all(np.isfinite(closes)) and np.all(np.isfinite(highs)) and np.all(np.isfinite(lows))):
        raise ValueError("Non-finite OHLC values in candle series")

    last_close = float(closes[-1])
    if last_close <= 0:
        raise ValueError("Last candle close must be positive")

    # Live price evaluation
    spot = float(live_price) if live_price is not None else last_close
    if not np.isfinite(spot) or spot <= 0:
        raise ValueError("live_price must be a finite positive number")

    # ── F1: TICK VELOCITY (real net move per cumulative absolute move) ──
    f_velocity = compute_tick_velocity(closes, window=30)

    # ── F2: MICRO_MOMENTUM — recency-weighted signed convergence ──
    deltas = np.diff(closes)
    f_momentum = _signed_convergence(deltas)

    # ── F3: BID_ASK_PRESSURE — real quoted arms or tick-position proxy ──
    f_pressure, pressure_source = compute_bid_ask_pressure(
        spot, bid=bid, ask=ask, tail=closes[-30:] if len(closes) >= 30 else closes
    )

    # ── F4: PRICE_ACTION_DELTA — immediate last-bar displacement ──
    f_delta = compute_price_action_delta(closes, tick=spot)

    # ── F5: LIVE_TICK_MOVE ──
    live_move_pct = (spot - last_close) / max(last_close, EPS)
    f_live = float(np.clip(live_move_pct / 0.003, -1.0, 1.0))

    # ── F6: INSTANT_DELTA — last-2-tick pip-scale pulse ──
    f_instant = compute_instant_delta(closes, tick=spot)

    # ── F7: VOLATILITY EXPANSION (symmetric) ──
    atr_series = compute_atr_series(highs, lows, closes, 14)
    atr_now = float(atr_series[-1]) if len(atr_series) else 0.0
    atr_mean = float(np.mean(atr_series[-20:])) if len(atr_series) else atr_now
    atr_expand = (atr_now / max(atr_mean, EPS)) if atr_mean > 0 else 1.0
    trend_sign = 1.0 if f_momentum >= 0 else -1.0
    f_vol = float(np.clip((atr_expand - 1.0) * 2.5, -1.0, 1.0) * trend_sign)

    # ── F8: TICK VELOCITY ACCELERATION (second derivative) ──
    f_accel = compute_tick_velocity_acceleration(closes, window=30)

    # ── F9: ORDER FLOW IMBALANCE ──
    f_flow = compute_order_flow_imbalance(deltas)

    # ── F10–F12: REAL QUANT CONFIRMATION INDICATORS (v6) ──
    # GENUINE RSI(14), MACD histogram and order-book spread quality computed
    # from the SAME real forwarded closes/arms as the micro factors. These are
    # real quantitative momentum/volatility measurements (no random, no static
    # mock, no hash) and they participate in the confidence confluence:
    #   • f_rsi    — signed momentum zone of RSI in [-1, +1] (50 → 0 = neutral,
    #                 anything moving away from 50 is real directional pressure).
    #   • f_macd   — MACD(5,13,5) histogram normalised to pip scale in [-1, +1].
    #   • f_spread — order-book spread quality, signed by real bid/ask pressure.
    rsi_series = compute_rsi_series(closes, 14)
    rsi_now = float(rsi_series[-1]) if len(rsi_series) else 50.0
    f_rsi = float(np.clip((rsi_now - 50.0) / 50.0, -1.0, 1.0))

    macd_hist = compute_macd_histogram(closes, 5, 13, 5)
    macd_now = float(macd_hist[-1]) if len(macd_hist) else 0.0
    avg_close = float(np.mean(closes)) if len(closes) else max(last_close, EPS)
    macd_norm = macd_now / max(abs(avg_close), EPS)
    f_macd = float(np.clip(macd_norm / 0.0001, -1.0, 1.0))

    f_spread = compute_spread_quality(spot, bid, ask, f_pressure)

    factors = {
        "tick_velocity": round(f_velocity, 4),
        "micro_momentum": round(f_momentum, 4),
        "bid_ask_pressure": round(f_pressure, 4),
        "price_action_delta": round(f_delta, 4),
        "live_tick_move": round(f_live, 4),
        "instant_delta": round(f_instant, 4),
        "volatility": round(f_vol, 4),
        "tick_velocity_acceleration": round(f_accel, 4),
        "order_flow_imbalance": round(f_flow, 4),
        "rsi_14": round(f_rsi, 4),
        "macd_momentum": round(f_macd, 4),
        "spread_quality": f_spread,
    }

    # v6 MICRO-MOMENTUM-HEAVY 12-FACTOR WEIGHTS: the leading high-frequency
    # micro factors dominate, with the REAL quant confirmation trio
    # (RSI / MACD / spread) contributing a genuine confluence share (~0.15).
    weights = {
        "tick_velocity": 0.136,
        "micro_momentum": 0.153,
        "bid_ask_pressure": 0.102,
        "price_action_delta": 0.102,
        "live_tick_move": 0.068,
        "instant_delta": 0.068,
        "volatility": 0.034,
        "tick_velocity_acceleration": 0.102,
        "order_flow_imbalance": 0.085,
        "rsi_14": 0.06,
        "macd_momentum": 0.05,
        "spread_quality": 0.04,
    }
    direction_score = float(sum(factors[k] * weights[k] for k in weights))

    # ── DIRECTION — ALWAYS DEFINITIVE (NEVER HOLD) ──
    # The engine ALWAYS emits a directional trading state from the real
    # 12-factor micro-confluence: BUY (SUPÉRIEUR/ACHAT) when weighted momentum
    # is positive, SELL (INFÉRIEUR/VENTE) when negative. An exactly-zero
    # weighted score is tied deterministically through the freshest REAL micro
    # factor (live tick move → instant delta → tick velocity) and finally the
    # score sign itself — momentum/order-book/volatility are always evaluated,
    # never stubbed; the verdict is never invented and NEVER a HOLD.
    NEUTRAL_BAND = 0.05
    sign = 1 if direction_score > NEUTRAL_BAND else (-1 if direction_score < -NEUTRAL_BAND else 0)
    if sign == 0:
        for tie_factor in ("live_tick_move", "instant_delta", "tick_velocity"):
            tie_val = factors.get(tie_factor, 0.0)
            if tie_val != 0.0:
                sign = 1 if tie_val > 0 else -1
                break
    if sign == 0:
        sign = 1 if direction_score >= 0 else -1

    all_factors = list(factors.values())
    active_factors = [v for v in all_factors if v != 0.0]
    active_count = len(active_factors)
    aligned_count = sum(
        1 for v in active_factors if (v > 0) == (sign > 0)
    ) if sign != 0 else 0

    direction = "BUY" if sign > 0 else "SELL"

    # ── STRICT 96.5% MULTI-VARIABLE MARKET-STRESS THERMAL GATE (v11-strict) ──
    # USER REQUIREMENT: the dispatch bar is FLAT at 96.5% — STRICTLY no signal
    # dispatches below it, in every market regime. The multi-variable stress
    # blend is computed but serves PURELY as diagnostics (surfaced next to the
    # verdict for tape transparency) — the bar never drifts below 96.5% and
    # never invents a direction for a sign==0 tape.
    dynamic_threshold, market_stress, stress_factors = compute_market_stress_threshold(
        factors,
        atr_expand,
        order_book_imbalance=order_book_imbalance,
        direction_sign=sign,
    )

    # ── BOOK CONFLUENCE (v7 — 10 classic strategy instruments) ──
    # GENUINE mathematical confluence from the ten books: Bollinger %B +
    # bandwidth squeeze, Turtle Donchian(20/50) breakout with ATR penetration,
    # Murphy MACD(12,26,9)/RSI(14)/EMA(50) cross-confluence + divergence, the
    # Chan/Carter volume-price confirmation, Nison candlestick structure,
    # Aldridge microstructure queue position, Aronson evidence persistence and
    # the ATR volatility regime. Evaluated on the SAME real OHLCV forwarded to
    # the engine — a missing feed (e.g. no volume) only deactivates its own
    # instrument; nothing is ever fabricated. `book_confirm` is the legacy
    # linear fold; `book.confluence` is the authoritative v9 STRICT
    # MULTIPLICATIVE gate that drives the 96.5% dispatch decision below.
    book = evaluate_book_confluence(
        closes=closes,
        opens=opens,
        highs=highs,
        lows=lows,
        volumes=volumes,
        live_price=spot,
        bid=bid,
        ask=ask,
        direction_sign=sign,
        threshold=dynamic_threshold,
    )
    book_confirm = book.book_confirm
    confluence = book.confluence
    conf_score = float(confluence.get("score", 0.0))
    confluence_gate = str(confluence.get("gate", "INSUFFICIENT"))

    # ── TRUE 96.5% MULTI-BOOK CONFLUENCE CONFIDENCE (v9) ──
    # The emitted confidence of a directional signal IS the strict
    # MULTIPLICATIVE convergence of the ten trading books (geometric-mean
    # alignment through a logistic sharpener with the hard 96.5% thermal
    # threshold) — NOT the retired diluted linear average
    # (0.30*commitment + 0.36*magnitude + 0.16*agreement + 0.08*vol_confirm
    # + 0.10*book_confirm), which could only reach ~60-80% on genuinely
    # strong setups and therefore manufactured low-confidence "dispatchable"
    # signals. A CALL/PUT is emitted ONLY when the volatility (Bollinger/ATR),
    # momentum (Murphy MACD/RSI/EMA, Donchian, Nison) and microstructure
    # (queue / volume-price / evidence) pillars ALL clear the 96.5% gate
    # (logical AND). Below the thermal threshold the verdict is an honest
    # market-waiting diagnostic (CONFLUENCE_BELOW_THERMAL) that names the
    # failing pillar — never a padded or phased signal.
    # The strength aggregates below (commitment / magnitude / agreement /
    # vol_confirm) are preserved ONLY for the human-readable diagnostics;
    # they no longer manufacture confidence.
    sign_dir = 1.0 if sign > 0 else -1.0
    total_votes = max(active_count, 1)
    agreement = aligned_count / total_votes if sign != 0 else 0.5

    commitment = 0.0
    magnitude = 0.0
    vol_confirm = 0.0
    if direction in ("BUY", "SELL"):
        velocity = float(factors.get("tick_velocity", 0.0))
        accel = float(factors.get("tick_velocity_acceleration", 0.0))
        micro_mom = float(factors.get("micro_momentum", 0.0))
        flow = float(factors.get("order_flow_imbalance", 0.0))
        _core_factors = (velocity, accel, micro_mom, flow)
        commitment = sum(
            1.0 for fv in _core_factors if (fv * sign_dir) > 0.3
        ) / 4.0
        confluent = [abs(fv) for fv in factors.values() if (fv * sign_dir) > 0.3]
        magnitude = float(np.mean(confluent)) if confluent else 0.0
        # Bounded directional volatility-expansion confirmation (0..1).
        vol_confirm = float(
            np.clip(sign_dir * float(factors.get("volatility", 0.0)), 0.0, 1.0)
        )

    # ── THE STRICT 96.5% THERMAL GATE (exact, requirement-compliant) ──
    # conf_score = strict multiplicative 10-book convergence; the gate collapses
    # to DEFINITIVE ONLY when every pillar (volatility / momentum /
    # microstructure) is present and aligned AND the score clears the STRICT
    # 96.5% thermal bar (FLAT — the market-stress blend is diagnostic only and
    # can never lower it) — the canonical dispatch metric. A genuine
    # institutional setup where every active book's evidence e_i ≈ 1.0 yields
    # G ≈ 0.95+ → score ≈ 98%, organically crossing the strict bar. Below the
    # strict bar the verdict KEEPS its true BUY/SELL direction and is flagged
    # market-waiting (never HOLD).
    definitive = bool(
        direction in ("BUY", "SELL")
        and conf_score >= dynamic_threshold
        and confluence_gate == "DEFINITIVE"
    )
    if definitive:
        # True CALL/PUT — the books have mathematically converged at >=96.5%.
        # The emitted confidence IS the strict multiplicative book-confluence
        # score. No ceiling, no override, no clipping: the organic UNCLIPPED
        # strength is reported exactly as computed by the geometric-mean
        # logistic sharpener — it may exceed 96.5% and does so organically.
        confidence = round(float(conf_score), 2)
    else:
        # Honest sub-thermal directional verdict: the real confluence number is
        # kept attached (never padded, never hidden, never clipped). The
        # direction stays BUY/SELL — the engine NEVER demotes to HOLD. Below
        # thermal the signal keeps its true direction and is flagged
        # market_waiting (CONFLUENCE_BELOW_THERMAL) so no host dispatches a
        # sub-thermal directional state, but the surface never shows HOLD.
        confidence = round(float(conf_score), 2)

    # ── STRICT 96.5% THERMAL GATE — EXECUTION FILTER (direction NEVER HOLD) ──
    # A directional verdict is ALWAYS returned (BUY/SELL). When confluence
    # strictly clears 96.5% the verdict is executable (market_waiting=false)
    # with the UNCLIPPED real confidence. Sub-thermal attempts keep their true
    # direction and are flagged market_waiting with CONFLUENCE_BELOW_THERMAL so
    # a host never dispatches a low-confidence state — but HOLD is never
    # returned and never displayed.
    confidence_gated = bool(
        direction in ("BUY", "SELL") and not definitive
    )
    gated_direction: Optional[str] = direction if confidence_gated else None
    if confidence_gated:
        logger.info(
            "Sub-thermal confluence — direction kept (market_waiting)",
            direction=direction,
            confluence=confidence,
            threshold=dynamic_threshold,
            market_stress=market_stress,
        )

    # ── MARKET-WAITING FLAG (strict 96.5% confluence thermal gate, surfaced to UI) ──
    # Below the strict bar the engine still emits the true BUY/SELL direction,
    # but flags the verdict market-waiting so the UI can render "converging"
    # instead of dispatching. The signal state is ALWAYS directional.
    if confidence_gated:
        market_waiting = True
        waiting_reason = "CONFLUENCE_BELOW_THERMAL"
        waiting_detail = (
            f"Direction {gated_direction} held below thermal: 10-book multiplicative "
            f"confluence {confidence:.2f}% < {dynamic_threshold:.1f}% strict 96.5% "
            f"thermal gate (market_stress={market_stress:.2f}; gate={confluence_gate}; "
            f"blockers: {', '.join(confluence.get('blockers', [])) or 'none'})"
        )
    else:
        market_waiting = False
        waiting_reason = None
        waiting_detail = None

    diagnostics = {
        "tick_velocity": round(f_velocity, 4),
        "micro_momentum": round(f_momentum, 4),
        "bid_ask_pressure": round(f_pressure, 4),
        "price_action_delta": round(f_delta, 4),
        "live_tick_move": round(f_live, 4),
        "instant_delta": round(f_instant, 4),
        "volatility": round(f_vol, 4),
        "tick_velocity_acceleration": round(f_accel, 4),
        "order_flow_imbalance": round(f_flow, 4),
        "rsi_14": round(rsi_now, 4),
        "macd_momentum": round(f_macd, 4),
        "spread_quality": f_spread,
        "atr_14": round(atr_now, 8),
        "atr_expansion": round(atr_expand, 4),
        "aligned_factors": aligned_count,
        "agreement": round(agreement, 4),
        "velocity_volume_commitment": round(
            commitment if direction in ("BUY", "SELL") else 0.0, 4
        ),
        "confluence_magnitude": round(
            magnitude if direction in ("BUY", "SELL") else 0.0, 4
        ),
        "volatility_confirmation": round(
            vol_confirm if direction in ("BUY", "SELL") else 0.0, 4
        ),
        "pressure_source": pressure_source,
        "neutral_band": NEUTRAL_BAND,
        "market_stress": market_stress,
        "stress_factors": stress_factors,
        "dispatch_threshold": round(dynamic_threshold, 2),
        "thermal_floor": THERMAL_GATE_FLOOR,
        "thermal_ceiling": THERMAL_GATE_CEILING,
        "confluence_threshold": round(dynamic_threshold, 2),
        "confluence_score": round(conf_score, 2),
        "confluence_gate": confluence_gate,
        "confidence_gated": confidence_gated,
        "gated_direction": gated_direction,
        "market_waiting": market_waiting,
        "waiting_reason": waiting_reason,
        "waiting_detail": waiting_detail,
        "book": {
            "book_confirm": round(book_confirm, 4),
            "agreement": round(book.agreement, 4),
            "magnitude": round(book.magnitude, 4),
            "active_count": book.active_count,
            "aligned_count": book.aligned_count,
            "factors": book.factors,
            "detail": book.diagnostics,
            "confluence": confluence,
        },
    }

    return QuantVerdict(
        direction=direction,
        direction_score=round(direction_score, 4),
        confidence=confidence,
        high_confidence_alert=bool(
            direction in ("BUY", "SELL")
            and not confidence_gated
            and confidence > HIGH_CONFIDENCE_ALERT_THRESHOLD
        ),
        market_waiting=market_waiting,
        waiting_reason=waiting_reason,
        waiting_detail=waiting_detail,
        factors=factors,
        diagnostics=diagnostics,
    )


# ════════════════════════════════════════════════════════════════════
# TIME-AWARE TARGET PROJECTION (1m → 10 days)
# ════════════════════════════════════════════════════════════════════

def project_target(
    direction: str,
    current_price: float,
    atr: float,
    timeframe: str,
    symbol_digits: int = 5,
) -> Tuple[float, float]:
    """ATR × √horizon target projection for ANY supported expiration.

    Returns ``(target_price, distance)``. Direction is honored strictly:
      BUY  → target strictly ABOVE current price
      SELL → target strictly BELOW current price
    (no HOLD state exists — the engine always resolves a direction)

    The √(horizon) law keeps multi-day projections mathematically
    consistent with intraday ones under diffusive price dynamics.
    """
    if not np.isfinite(current_price) or current_price <= 0:
        raise ValueError("current_price must be a finite positive number")

    # GENUINE ATR only — the `cp * 0.005` proxy is PURGED. A realized ATR of
    # zero means zero realized volatility, and the target honestly reflects it.
    eff_atr = float(atr) if np.isfinite(atr) and atr > 0 else 0.0
    scale = horizon_sqrt_scale(timeframe)

    # Base distance calibrated on the 1h horizon; √-scaled outward/inward.
    base_distance = eff_atr * 1.5 * max(scale, 0.15)
    # Perceptibility floor so BUY/SELL targets never pin to the live price.
    min_distance = max(eff_atr * 0.25, current_price * 0.0002)
    distance = max(base_distance, min_distance)

    if direction == "BUY":
        target = current_price + distance
    elif direction == "SELL":
        target = current_price - distance
    else:  # defensive only — the engine always resolves BUY/SELL upstream
        target = current_price

    digits = int(symbol_digits) if symbol_digits and symbol_digits > 0 else 5
    return round(target, digits), round(distance, digits)


def symbol_price_digits(symbol: str) -> int:
    """Decimal precision per asset class: crypto → 2, JPY quote → 3, else 5."""
    sym = (symbol or "").strip().upper()
    if sym in {"BTC/USD", "ETH/USD"}:
        return 2
    try:
        quote = sym.split("/")[1]
        return 3 if quote == "JPY" else 5
    except (IndexError, AttributeError):
        return 5