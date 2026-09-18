import pytest

from app.services.accuracy_tracker import AccuracyTracker


def test_tier_win_rates_breakdown():
    t = AccuracyTracker()
    for _ in range(10):
        t.record_outcome("EUR/USD", "BUY", 97.0, "WIN", tier="T1")
    for _ in range(5):
        t.record_outcome("EUR/USD", "SELL", 92.0, "LOSS", tier="T2")
    for _ in range(3):
        t.record_outcome("EUR/USD", "SELL", 75.0, "WIN", tier="T4")
    report = t.report()
    tiers = report["tier_win_rates"]
    assert tiers["T1"]["count"] == 10
    assert tiers["T1"]["win_rate"] == pytest.approx(1.0)
    assert tiers["T2"]["count"] == 5
    assert tiers["T2"]["win_rate"] == pytest.approx(0.0)
    assert tiers["T4"]["count"] == 3
    assert report["wins"] == 13
    assert report["losses"] == 5


def test_record_outcome_defaults_tier_to_t5():
    t = AccuracyTracker()
    t.record_outcome("EUR/USD", "BUY", 50.0, "WIN")
    report = t.report()
    assert report["tier_win_rates"]["T5"]["count"] == 1


def test_tier_win_rates_empty_is_empty():
    t = AccuracyTracker()
    assert t.report()["tier_win_rates"] == {}