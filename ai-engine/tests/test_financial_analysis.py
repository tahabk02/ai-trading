import pytest

from app.services.financial_analysis import FinancialAnalysisService, FinancialAnalysisReport
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