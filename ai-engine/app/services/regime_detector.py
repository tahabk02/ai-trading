"""
regime_detector.py - PART 12 [34] - REGIME GATE for the ensemble (step 28).

classify_regime(closes) is the ONLY public surface. It labels the current price
window as "trending" / "mean_reverting" / "random_walk" so later ensemble steps
know which book-submodel families are even allowed to vote (PART 12 [27a]).

REUSE, NOT REIMPLEMENTATION (spec [34]):
  * Hurst exponent H - rescaled-range (R/S) analysis, Weron's overlapping-window
    estimator, reused unchanged from math_engine.hurst_rs (the same R/S model
    cited by Bouchaud & Potters, "Theory of Financial Risk"). No reimplementation.
  * Augmented Dickey-Fuller unit-root test - the tau statistic from
    math_engine.adf_statistic (demeaned AR(1) difference regression, no trend)
    and the MacKinnon (1994/2010) response-surface p-value from
    math_engine.adf_pvalue — the same numbers statsmodels.adfuller reports.
    No statsmodels dependency was added.

IDEA (documented thresholds, spec [34]):
  H is measured on the window's first-difference (returns) series — R/S on the
  raw price level of ANY integrated series reads H ~ 1.0 whether the level is a
  trend or a random walk, so it cannot separate them; on returns, a persistent
  (momentum) trend reads H > 0.5, an OU/mean-reverting series reads H < 0.5,
  and a cumulative-sum random walk reads H == 0.5 (Bouchaud & Potters measure
  persistence on the increments). ADF is tested on the LEVEL series — the unit
  root question is about the price itself.

  A currency window with BOTH strong positive dependence in its returns
  (H >> 0.5) AND a unit root in its level that cannot be rejected (high ADF p)
  is a TREND: the increments keep pushing the level one way and no mean
  reversion is expected. A window with BOTH negative dependence in returns
  (H << 0.5) AND stationarity of the level (low ADF p) is MEAN-REVERTING: the
  series oscillates around a well-defined level. Every other combination
  (e.g., drifting but stationary, or persistent but weakly mean-reverting) has
  contradictory evidence and is treated conservatively as RANDOM_WALK — the
  ensemble then lets both families vote at minimum weight instead of risking a
  wrong gate.

  HARD RULE (PART 12): a regime gate that misclassifies is worse than no gate.
  This module's own unit suite (tests/test_regime_detector.py) must pass on
  synthetic pure series BEFORE any ensemble consumes it. It never fabricates
  evidence — the label is a pure function of the observed window.

  DECISION RULE (spec [34], hard-coded, not tunable here):
    "trending"        iff  H > 0.55 AND ADF p-value > 0.10
    "mean_reverting"  iff  H < 0.45 AND ADF p-value < 0.05
    "random_walk"     otherwise

  MIN_CLOSES = 100 — a shorter window raises ValueError rather than silently
  guessing on too little data (spec [34]). Never a silent default.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .math_engine import adf_pvalue, adf_statistic, hurst_rs

# Specced classification thresholds (PART 12 [34]). Documented rationale in the
# module docstring; they are part of the contract tested by the module suite.
_HURST_TREND_MIN = 0.55   # strong positive dependence
_ADF_P_TREND_MIN = 0.10   # unit root NOT rejected -> no mean reversion expected
_HURST_MR_MAX = 0.45      # strong negative dependence
_ADF_P_MR_MAX = 0.05      # stationarity at the conventional 5% level

MIN_CLOSES = 100  # lowest defensible window for both R/S and ADF estimation

_TRENDING = "trending"
_MEAN_REVERTING = "mean_reverting"
_RANDOM_WALK = "random_walk"


@dataclass(frozen=True)
class RegimeResult:
    """One classification of one price window. Pure function of the observed
    closes — evidence is never fabricated."""

    regime: str
    hurst: float
    adf_pvalue: float
    confidence: float  # 0..1, how far the window sits inside its regime region


def classify_regime(closes: List[float]) -> RegimeResult:
    """Classify a price window as trending / mean_reverting / random_walk.

    :raises ValueError: fewer than ``MIN_CLOSES`` (100) observations. A blind
        window is an error, never a silent RANDOM_WALK guess (spec [34]).
    """
    prices = [float(x) for x in closes]
    n = len(prices)
    if n < MIN_CLOSES:
        raise ValueError(
            f"regime classification needs >= {MIN_CLOSES} closes, got {n}"
        )

    # H is estimated on the first-difference series (returns): R/S on the LEVEL
    # of any integrated series reads H ~ 1 whether it is a trend or a random
    # walk, so it cannot separate them. On returns, a persistent (momentum)
    # trend reads H > 0.5, an OU/mean-reverting series reads H < 0.5, and a
    # cumulative-sum random walk reads H ~ 0.5 exactly — matching Bouchaud &
    # Potters' persistence-of-increments reading of the Hurst exponent. ADF is
    # computed on the LEVEL series (the unit-root question is about the price).
    returns: list[float] = [
        prices[i] - prices[i - 1] for i in range(1, n)
    ]
    h = float(hurst_rs(returns))
    tau = float(adf_statistic(prices))
    p = float(adf_pvalue(tau))

    # --- confidence formula (0..1, how far inside the region) ---
    # Normalize each statistic's margin past its threshold to [0,1]:
    #   trend:   H above 0.55, full span to 1.00; p above 0.10, span to 1.00.
    #   MR:      H below 0.45, span to 0.00; p below 0.05, span to 0.00.
    #   RW:      how far the window is from EITHER decision boundary.

    def _clip(x: float) -> float:
        return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)

    if h > _HURST_TREND_MIN and p > _ADF_P_TREND_MIN:
        regime = _TRENDING
        margin_h = _clip((h - _HURST_TREND_MIN) / (1.0 - _HURST_TREND_MIN))
        margin_p = _clip((p - _ADF_P_TREND_MIN) / (1.0 - _ADF_P_TREND_MIN))
        confidence = min(margin_h, margin_p)
    elif h < _HURST_MR_MAX and p < _ADF_P_MR_MAX:
        regime = _MEAN_REVERTING
        margin_h = _clip((_HURST_MR_MAX - h) / _HURST_MR_MAX)
        margin_p = _clip((_ADF_P_MR_MAX - p) / _ADF_P_MR_MAX)
        confidence = min(margin_h, margin_p)
    else:
        regime = _RANDOM_WALK
        toward_trend = max(
            _clip((h - _HURST_TREND_MIN) / (1.0 - _HURST_TREND_MIN)),
            _clip((p - _ADF_P_TREND_MIN) / (1.0 - _ADF_P_TREND_MIN)),
        )
        toward_mr = max(
            _clip((_HURST_MR_MAX - h) / _HURST_MR_MAX),
            _clip((_ADF_P_MR_MAX - p) / _ADF_P_MR_MAX),
        )
        confidence = _clip(1.0 - max(toward_trend, toward_mr))

    return RegimeResult(
        regime=regime,
        hurst=round(h, 4),
        adf_pvalue=round(p, 6),
        confidence=round(confidence, 4),
    )