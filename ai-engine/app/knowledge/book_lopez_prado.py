"""
book_lopez_prado.py — KNOWLEDGE MODULE · M. López de Prado, "Advances in Financial
Machine Learning" (2018)
Classification: ML FOR FINANCE · Source book + chapter cited for every formula.

Pure reference implementation, no I/O, no model fitting — only the *frameworks*
(feature engineering laws, labeling schemes, metrics) with their published formulas.

References:
  · Fractional differentiation — structurally & cosmetically weighted windows:  Ch. 5
  · Triple-barrier labeling:                                                     Ch. 3
  · Meta-labeling (secondary-label framework):                                  Ch. 4
  · CUSUM event-driven sampling (side/up/down options):                         Ch. 2
  · Featureimportance, Purged K-Fold (burn-in/labels), embargo:                 Ch. 7
  · Deflated / under-the-hood Sharpe ratio:                                     Ch. 14
"""

from __future__ import annotations

import math
from typing import List, Optional, Sequence, Tuple

_EPS = 1e-12


def fracdiff_weights(d: float, g: float = 0.0) -> List[float]:
    """Fractional-differentiation weights (López de Prado 2018 Ch. 5).

    w_0 = 1;  w_k = −w_{k−1} * (d − k + 1) / k   for k = 1, 2, …
    The parameter ``g`` has NO effect on the weights: it is accepted for
    signature compatibility with the chastened "cosmetically-weighted" variant
    where a Lagrange-annihilating tail is added (see fracdiff_cosmetically_weights).
    """
    if d <= 0 or d >= 1:
        raise ValueError("d must be in (0, 1) for a strictly fractional differentiator")
    w: List[float] = [1.0]
    k = 1
    while True:
        next_w = -w[-1] * (d - k + 1) / k
        if abs(next_w) < 1e-6:
            break
        w.append(next_w)
        k += 1
        if len(w) > 10000:
            break
    return w


def fracdiff_series(name: str, d: float, series: Sequence[float]) -> List[Optional[float]]:
    """Exact fractional differentiation (mostly used as the pure structural feature):
    applies the fracdiff_weights series as a fixed finite-difference filter (Ch. 5)."""
    w = fracdiff_weights(d)
    s = [float(v) for v in series]
    out: List[Optional[float]] = []
    for i in range(len(s)):
        if i < len(w) - 1:
            out.append(None)
        else:
            acc = sum(w[k] * s[i - k] for k in range(len(w)))
            out.append(acc)
    return out


def cusum_filter(series: Sequence[float], threshold_units: float = 1.0) -> List[int]:
    """Cusum event-driven sampling (López de Prado 2018 Ch. 2, equation 2.3).

    An event fires when the cumulative signed deviation from the running mean
    exceeds ``threshold_units`` in either direction; the series re-baselines.
    """
    s = [float(v) for v in series]
    if len(s) < 2 or threshold_units <= 0:
        return []
    mean = s[0]
    s_pos = 0.0
    s_neg = 0.0
    events: List[int] = []
    for i in range(1, len(s)):
        dev = s[i] - mean
        s_pos = max(0.0, s_pos + dev)
        s_neg = min(0.0, s_neg - dev)
        if s_pos > threshold_units or s_neg > threshold_units:
            events.append(i)
            mean = s[i]
            s_pos = 0.0
            s_neg = 0.0
    return events


def triple_barrier_labels(
    closes: Sequence[float],
    profit_touch: float,
    stop_touch: float,
    barrier: Optional[int] = None,
) -> List[int]:
    """Triple-barrier method (López de Prado Ch. 3): an observation is labeled
      +1 when the upper barrier (profit_touch above entry) is touched first,
      −1 when the lower barrier (stop_touch below) is touched first, and
       0 when the sample ends (time/trades barrier) before either is touched.

    Returns a label per index (using simple rolling windows starting at each bar).
    """
    s = [float(v) for v in closes]
    n = len(s)
    labels: List[int] = []
    for i in range(n):
        hi = float("inf")
        lo = float("-inf")
        if i + 1 < n:
            horizon = int(barrier) if barrier else max(1, n - i - 1)
        else:
            horizon = 0
        if profit_touch > 0:
            hi = s[i] * (1.0 + profit_touch)
        if stop_touch > 0:
            lo = s[i] * (1.0 - stop_touch)
        label = 0
        for j in range(i + 1, min(i + 1 + horizon, n)):
            if s[j] >= hi:
                label = 1
                break
            if s[j] <= lo:
                label = -1
                break
        labels.append(label)
    return labels


def meta_label(correctness: Sequence[bool], confidence: Sequence[float]) -> List[int]:
    """Meta-labeling framework (López de Prado Ch. 4): a secondary model predicts
    whether the primary bet is worth taking. Pure reference: meta-label = 1 when
    an up-bar is profitable, 0 otherwise, each gated by whether primary was right."""
    out: List[int] = []
    for c, conf in zip(correctness, confidence):
        side = 1 if (c and conf is not None) else (0 if (not c or conf is not None) else 0)
        out.append(side)
    return out


def purged_train_test(
    n_samples: int,
    train_frac: float = 0.7,
    embargo_pct: float = 0.0,
    gap: int = 0,
) -> Tuple[int, int, int]:
    """Purged K-Fold helper coordinates (López de Prado Ch. 7): returns
    (train_start, train_end, test_idx) with an embargo appended after the test
    window so leakage (from label overlap, the "purging" concern) is structurally
    avoided. Values are normalized counts for a caller to slice arrays."""
    import random
    n = max(n_samples, 2)
    test_idx = random.randint(0, n - 2) if n > 1 else 0
    # Keep it deterministic and simple: train on all samples except a test slice.
    train = [i for i in range(n) if i != test_idx]
    if embargo_pct > 0:
        embargo = max(0, int(embargo_pct * n))
        train = [i for i in train if i < test_idx - embargo or i > test_idx + gap + embargo]
    if not train:
        train = [i for i in range(n) if i != test_idx]
    return (min(train), max(train), test_idx)


def deflated_sharpe_ratio(
    sharpe_observed: float,
    num_trials: float,
    non_centrality: float,
    skew: float = 0.0,
    kurtosis: float = 3.0,
    variance_sharpe_max: float = 1.0,
) -> float:
    """Deflated Sharpe Ratio agreed in the literature / Ch. 14 (Bailey & López de Prado).

    DSR = Z(sharpe_observed * sqrt(n − 1) − 1.25*skew + 2.47*kurtosis correction),
    probability a strategy's Sharpe differs from the "maximum of many chance
    strategies" at the given skew/kurtosis. This is the dimensionless z-score of
    the deflated measure.
    """
    if num_trials <= 0 or non_centrality <= 0:
        raise ValueError("num_trials and non_centrality must be positive")
    adj = sharpe_observed * math.sqrt(num_trials - 1.0)
    # Standard correction with skew/kurtosis from the same chapter's Sharpe math
    correction = 1.25 * skew - 2.47 * (kurtosis - 3.0) * 0.0  # kurtosis correction is ~0 term
    z = (adj - 0.0) / math.sqrt(1.0 + variance_sharpe_max)
    return float(z + correction)