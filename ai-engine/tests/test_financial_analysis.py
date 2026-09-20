import random

import pytest

from app.services.financial_analysis import (
    ROLLING_WINDOW,
    FinancialAnalysisService,
    FinancialAnalysisReport,
    compute_rolling_window_features,
)
from app.services.quality_gate import build_factor_inputs_from_candles
from app.services.signal_gatekeeper import TIER_THRESHOLDS


def _candles(trend: str = "flat", length: int = 40):
    candles = []
    price = 100.0
    for i in range(length):
        if trend == "up":
            price += 0.5
        elif trend == "down":
            price -= 0.5
        candles.append(
            {
                "open": round(price - 0.1, 4),
                "high": round(price + 0.3, 4),
                "low": round(price - 0.3, 4),
                "close": round(price, 4),
                "volume": 1000.0,
            }
        )
    return candles


def _random_walk_candles(length: int = 200, seed: int = 7):
    """A genuine random-walk close series (deterministic via fixed seed) so the
    PART 14 regime gate reliably classifies as random_walk."""
    rng = random.Random(seed)
    candles = []
    price = 100.0
    for _ in range(length):
        price += rng.gauss(0.0, 0.5)
        candles.append(
            {
                "open": round(price - 0.1, 4),
                "high": round(price + 0.3, 4),
                "low": round(price - 0.3, 4),
                "close": round(price, 4),
                "volume": 1000.0,
            }
        )
    return candles


def _trending_candles(length: int = 200, seed: int = 1):
    """AR(1) persistent-return momentum trend (the established pure-trend family
    from test_regime_detector) — positively autocorrelated returns, so the
    bias-corrected Hurst classifies it "trending" by construction."""
    rng = random.Random(seed)
    ret = 0.0
    price = 100.0
    candles = []
    for _ in range(length):
        ret = 0.50 * ret + rng.gauss(0.0, 0.02)
        price += ret
        candles.append(
            {
                "open": round(price - 0.01, 4),
                "high": round(price + 0.03, 4),
                "low": round(price - 0.03, 4),
                "close": round(price, 4),
                "volume": 1000.0,
            }
        )
    return candles


def test_analyze_requires_symbol():
    svc = FinancialAnalysisService()
    with pytest.raises(ValueError):
        svc.analyze(symbol="", candles=_candles())


def test_analyze_requires_at_least_two_candles():
    svc = FinancialAnalysisService()
    with pytest.raises(ValueError):
        svc.analyze(symbol="EUR/USD", candles=[{"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0}])
    with pytest.raises(ValueError):
        svc.analyze(symbol="EUR/USD", candles=[])


def test_analyze_returns_report_dataclass():
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_candles(),
        live_price=100.0,
        timeframe="1h",
    )
    assert isinstance(report, FinancialAnalysisReport)
    assert report.symbol == "EUR/USD"
    assert report.direction in ("BUY", "SELL")
    assert report.tier in ("T1", "T2", "T3", "T4", "T5")
    assert report.tier_label in ("PREMIUM", "HIGH", "MEDIUM", "LOW", "WEAK")
    assert report.regime in ("TRENDING", "SIDEWAYS/CHOP")
    assert report.confidence >= 0.0
    assert report.timestamp


def test_analyze_with_pre_resolved_verdict_uses_it():
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_candles(),
        direction="BUY",
        confidence=99.0,
    )
    assert report.direction == "BUY"
    assert report.confidence == 99.0
    assert report.tier == "T1"  # 99% clears T1 PREMIUM (96.5)


def test_analyze_to_dict_contract():
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_candles(),
        direction="SELL",
        confidence=72.0,
    )
    payload = svc.to_dict(report)
    assert payload["symbol"] == "EUR/USD"
    assert payload["direction"] == "SELL"
    assert payload["tier"] == "T4"  # 72% → T4 LOW (>=70)
    assert payload["executable"] is not None
    assert payload["indicators"]["adx"] >= 0.0
    assert "book_confluence" in payload


def test_tier_boundaries():
    svc = FinancialAnalysisService()
    # T1 PREMIUM  >= 96.5
    assert svc.analyze(symbol="X", candles=_candles(), direction="BUY", confidence=97.0).tier == "T1"
    # T2 HIGH     >= 90
    assert svc.analyze(symbol="X", candles=_candles(), direction="BUY", confidence=92.0).tier == "T2"
    # T3 MEDIUM   >= 80
    assert svc.analyze(symbol="X", candles=_candles(), direction="BUY", confidence=82.0).tier == "T3"
    # T4 LOW      >= 70
    assert svc.analyze(symbol="X", candles=_candles(), direction="BUY", confidence=71.0).tier == "T4"
    # T5 WEAK     < 70
    assert svc.analyze(symbol="X", candles=_candles(), direction="BUY", confidence=50.0).tier == "T5"


def test_sub_tier_market_waiting():
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_candles(),
        direction="BUY",
        confidence=50.0,
    )
    assert report.tier == "T5"
    assert report.executable is False
    assert report.market_waiting is True
    assert report.waiting_reason == "LOW_CONFIDENCE"


def test_regime_gate_scored_only_demotes_random_walk_even_at_t1_confidence():
    """PART 14 [46] — a random_walk symbol must NEVER be tradable, even at
    T1 (99%) confidence. The verdict is demoted to T5 scored-only."""
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_random_walk_candles(),
        direction="BUY",
        confidence=99.0,
    )
    assert report.regime_gate == "scored_only"
    assert report.suppressed_reason == "regime_scored_only"
    assert report.tier == "T5"  # demoted, NOT T1
    assert report.executable is False
    assert report.market_waiting is True
    assert report.waiting_reason == "REGIME_RANDOM_WALK"


def test_regime_gate_tradable_for_trending_window():
    """PART 14 [45] — a trending/momentum window keeps the full ensemble
    authority: regime_gate is "tradable" and the tier is NOT demoted."""
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_trending_candles(),
        direction="BUY",
        confidence=97.0,
    )
    assert report.regime_gate == "tradable"
    assert report.suppressed_reason is None
    assert report.tier == "T1"  # 97% keeps T1 — no regime demotion


def test_regime_gate_not_asserted_for_short_window():
    """PART 14 — fewer than MIN_CLOSES (100) closes cannot produce an honest
    regime classification, so the gate is NOT asserted and the existing
    multi-tier gate keeps full authority (no random_walk demotion invents data)."""
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_candles(trend="up", length=40),
        direction="BUY",
        confidence=97.0,
    )
    assert report.regime_gate is None
    assert report.suppressed_reason is None
    assert report.tier == "T1"


def test_regime_gate_scored_only_surfaces_in_payload():
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_random_walk_candles(),
        direction="SELL",
        confidence=99.0,
    )
    payload = svc.to_dict(report)
    assert payload["regime_gate"] == "scored_only"
    assert payload["suppressed_reason"] == "regime_scored_only"
    assert payload["tier"] == "T5"
    assert payload["executable"] is False


# ════════════════════════════════════════════════════════════════
# PART 19 [107]/[108] — NAMED 50-CANDLE ROLLING FEATURE WINDOW
# ════════════════════════════════════════════════════════════════

def test_rolling_window_constant_is_named_fifty():
    assert ROLLING_WINDOW == 50


def test_rolling_window_features_use_trailing_window():
    closes = [100.0 + i * 0.1 for i in range(200)]
    feat = compute_rolling_window_features(closes)
    assert feat["window_len"] == 50
    assert feat["candles_total"] == 200
    assert set(feat.keys()) == {
        "window_len",
        "candles_total",
        "atr14",
        "rsi14",
        "ewma_volatility",
        "garch11_forecast_vol",
        "garch11_persistence",
        "ou_half_life",
        "microstructure_queue",
        "volume_surge",
    }


def test_rolling_window_features_real_not_fabricated():
    closes = [c["close"] for c in _random_walk_candles(length=80)]
    feat = compute_rolling_window_features(closes)
    assert feat["window_len"] == 50
    assert feat["atr14"] is not None and feat["atr14"] > 0
    assert feat["rsi14"] is not None and 0.0 <= feat["rsi14"] <= 100.0
    assert feat["ewma_volatility"] is not None and feat["ewma_volatility"] > 0
    assert feat["garch11_forecast_vol"] is not None and feat["garch11_forecast_vol"] > 0
    assert 0.0 < feat["garch11_persistence"] < 1.0
    # OU half-life is None for a non-mean-reverting window (never invented)
    assert feat["ou_half_life"] is None or feat["ou_half_life"] > 0
    # no real quotes -> PART 3 queue reports 0.0, never invented
    assert feat["microstructure_queue"] == 0.0


def test_rolling_window_shrinks_when_tape_short():
    closes = [100.0 + 0.5 * i for i in range(20)]
    feat = compute_rolling_window_features(closes)
    assert feat["window_len"] == 20
    assert feat["candles_total"] == 20


def test_rolling_window_rejects_shorter_than_two():
    assert compute_rolling_window_features([100.0])["window_len"] == 0
    assert compute_rolling_window_features([])["candles_total"] == 0


def test_rolling_window_feeds_quality_inputs_and_report():
    svc = FinancialAnalysisService()
    candles = _trending_candles(length=200)
    report = svc.analyze(
        symbol="EUR/USD",
        candles=candles,
        direction="BUY",
        confidence=88.0,
        factor_inputs=build_factor_inputs_from_candles(candles),
    )
    assert "rolling_window" in report.factors
    assert report.factors["rolling_window"]["window_len"] == 50
    assert "rolling_window" in report.diagnostics
    assert report.quality is None or 0.0 <= report.quality <= 1.0
    assert isinstance(report.quality_field, dict)


def test_rolling_window_never_bypasses_regime_gate():
    """PART 19 [108] — a promising window must NOT convert a random_walk tape
    into a tradable one; regime evidence stays on the full >=100 tape."""
    svc = FinancialAnalysisService()
    candles = _random_walk_candles()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=candles,
        direction="BUY",
        confidence=99.0,
        factor_inputs=build_factor_inputs_from_candles(candles),
    )
    assert report.regime_gate == "scored_only"
    assert report.tier == "T5"
    assert report.executable is False
    assert report.waiting_reason == "REGIME_RANDOM_WALK"
    assert report.factors["rolling_window"]["window_len"] == 50


def test_regime_classification_surfaces_in_report_and_payload():
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_trending_candles(length=200),
        direction="BUY",
        confidence=97.0,
    )
    assert report.regime_classification["regime"] in (
        "trending",
        "mean_reverting",
        "random_walk",
    )
    assert "hurst" in report.regime_classification
    assert "adf_pvalue" in report.regime_classification
    assert report.regime_classification["closes"] >= 100
    payload = svc.to_dict(report)
    assert payload["regime_classification"]["regime"] == report.regime_classification["regime"]
    assert payload["factors"]["rolling_window"]["window_len"] == 50
    assert payload["diagnostics"]["rolling_window"]["window_len"] == 50


def test_regime_classification_stays_empty_for_short_tape():
    svc = FinancialAnalysisService()
    report = svc.analyze(
        symbol="EUR/USD",
        candles=_candles(trend="up", length=40),
        direction="BUY",
        confidence=97.0,
    )
    assert report.regime_classification == {}
    assert report.regime_gate is None