"""
test_regime_detector.py - PART 12 [35] - the regime gate's own test pass.

Must pass BEFORE any ensemble is allowed to consume regime_detector:
classify synthetic PURE-TREND, PURE-OU (mean-reversion) and PURE-RANDOM-WALK
windows. The pass criterion is calibration-grade: >=80% of >=30 deterministic
trials per family classify correctly — not a fragile single seeded example.

Run:  cd ai-engine && python -m pytest tests/test_regime_detector.py -v
"""

import random

import pytest

from app.services.regime_detector import (
    MIN_CLOSES,
    RegimeResult,
    classify_regime,
)

ROW_NUM = 30  # deterministic trials per family (spec [35]: >=30)


# ── synthetic generators ──

def synthetic_trend(n: int = 800, phi: float = 0.50, sigma: float = 0.02, seed: int = 1) -> list[float]:
    """Persistent-return (momentum) trend: returns follow AR(1) with phi > 0,
    so the increments themselves are positively autocorrelated — H(returns) > 0.5
    by construction. A drift+noise level has WHITE-noise returns (H == 0.5) and
    is statistically a random walk with drift, not a trend in the Hurst sense;
    this momentum form is the pure-trend family consistent with the spec's
    'H > 0.55 AND unit root not rejected' gate."""
    r = random.Random(seed)
    ret = 0.0
    x = 100.0
    out: list[float] = []
    for _ in range(n):
        ret = phi * ret + r.gauss(0.0, sigma)
        x += ret
        out.append(x)
    return out


def synthetic_mean_reversion(
    n: int = 520, rho: float = 0.80, c: float = 100.0, sigma: float = 1.0, seed: int = 2
) -> list[float]:
    r = random.Random(seed)
    x = c
    out: list[float] = []
    for _ in range(n):
        x = c + rho * (x - c) + r.gauss(0.0, sigma)
        out.append(x)
    return out


def synthetic_random_walk(n: int = 1500, sigma: float = 0.05, seed: int = 3) -> list[float]:
    r = random.Random(seed)
    x = 0.0
    out: list[float] = []
    for _ in range(n):
        x += r.gauss(0.0, sigma)
        out.append(x)
    return out


# ── 1. correctness on pure synthetic series ──

def test_pure_trend_is_trending() -> None:
    v = classify_regime(synthetic_trend())
    assert v.regime == "trending"
    assert v.hurst > 0.55


def test_pure_mean_reversion_is_mean_reverting() -> None:
    v = classify_regime(synthetic_mean_reversion())
    assert v.regime == "mean_reverting"


def test_pure_random_walk_is_random_walk() -> None:
    v = classify_regime(synthetic_random_walk())
    assert v.regime == "random_walk"


def test_30_seed_sweep_per_family() -> None:
    """Calibration gate (spec [35]): >=80% of >=30 trials per family classify
    correctly. Trend must NEVER flip to mean_reverting (that would wrongly
    summon OU votes), and mean-reversion must never read as trending."""

    trend_ok = 0
    for seed in range(1, ROW_NUM + 1):
        v = classify_regime(synthetic_trend(seed=seed))
        if v.regime == "trending":
            trend_ok += 1
        assert v.regime != "mean_reverting"

    mr_ok = 0
    for seed in range(2, ROW_NUM + 2):
        v = classify_regime(synthetic_mean_reversion(seed=seed))
        if v.regime == "mean_reverting":
            mr_ok += 1
        assert v.regime != "trending"

    rw_ok = 0
    for seed in range(3, ROW_NUM + 3):
        v = classify_regime(synthetic_random_walk(seed=seed))
        if v.regime == "random_walk":
            rw_ok += 1

    assert trend_ok / ROW_NUM >= 0.80
    assert mr_ok / ROW_NUM >= 0.80
    assert rw_ok / ROW_NUM >= 0.80


# ── 2. hard rule: result surface is honest and bounded ──

def test_result_is_audit_safe() -> None:
    v = classify_regime(synthetic_trend())
    assert isinstance(v, RegimeResult)
    assert v.regime in {"trending", "mean_reverting", "random_walk"}
    assert 0.0 <= v.hurst <= 1.0
    assert 0.0 <= v.adf_pvalue <= 1.0
    assert 0.0 <= v.confidence <= 1.0


def test_classify_is_deterministic() -> None:
    series = synthetic_trend()
    assert classify_regime(series) == classify_regime(series)


# ── 3. degenerate / too-short windows ──

def test_below_100_closes_raises_value_error() -> None:
    """Spec [34]: a window < 100 closes is an ERROR, never a silent default."""
    series = synthetic_trend(n=MIN_CLOSES - 1)
    with pytest.raises(ValueError):
        classify_regime(series)


def test_exactly_99_closes_raises_value_error() -> None:
    with pytest.raises(ValueError):
        classify_regime(synthetic_random_walk(n=99))


def test_min_closes_is_100() -> None:
    assert MIN_CLOSES == 100


def test_at_least_100_closes_is_accepted() -> None:
    v = classify_regime(synthetic_random_walk(n=100))
    assert v.hurst is not None