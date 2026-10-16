"""PART 50 [534] — reason priority: no direction outranks the class gate.

Production defect: a MARKET WAIT verdict (non-directional) whose authoritative
`verdict.direction` was passed to `build_execution_surface` surfaced the class
sub-reason (`otc_hf_fail`) as its `suppressed_reason` — so the terminal read
"MARKET WAIT 12.4% (4/6)" beside "OTC_HF_FAIL". The first blocker is that no
direction exists; a class filter's verdict on a direction that was never
emitted is not a reason at all.

`_validate_response_finite` now reconciles the reason: on a non-directional /
market-waiting verdict a class sub-reason is replaced by the real waiting
reason, or the honest awaiting-direction default. A genuine non-class blocker
is preserved.

Run:  python -m pytest tests/test_reason_priority.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.api.v1.signals import _validate_response_finite
from app.services.signal_gatekeeper import SUPPRESSED_REASON_AWAITING_DIRECTION


def _response(**overrides):
    base = {
        "signal": None,
        "executable": False,
        "market_waiting": True,
        "tier": "T5",
        "confidence": 12.4,
        "current_price": 1.0850,
        "target_price": 1.0850,
        "diagnostics": {},
    }
    base.update(overrides)
    return base


def test_market_wait_with_class_reason_shows_awaiting_direction():
    """The exact bug: MARKET WAIT 12.4% (4/6) carrying otc_hf_fail."""
    out = _validate_response_finite(
        _response(suppressed_reason="otc_hf_fail", market_waiting=True, signal=None)
    )
    assert out["suppressed_reason"] == SUPPRESSED_REASON_AWAITING_DIRECTION
    assert out["suppressed_reason"] != "otc_hf_fail"


def test_market_wait_with_real_waiting_reason_preserves_it():
    out = _validate_response_finite(
        _response(
            suppressed_reason="otc_hf_fail",
            market_waiting=True,
            waiting_reason="CONFLUENCE_BELOW_THERMAL",
        )
    )
    assert out["suppressed_reason"] == "CONFLUENCE_BELOW_THERMAL"


def test_directional_hf_failure_keeps_the_class_reason():
    """A REAL directional verdict vetoed by HF must still name HF."""
    out = _validate_response_finite(
        _response(
            signal="SELL",
            market_waiting=False,
            executable=False,
            suppressed_reason="otc_hf_fail",
        )
    )
    assert out["suppressed_reason"] == "otc_hf_fail"
    assert out["signal"] == "SELL"


def test_mtf_and_history_sub_reasons_are_also_overridden_when_non_directional():
    for reason in ("mtf_misaligned", "mtf_insufficient_evidence", "insufficient_history"):
        out = _validate_response_finite(
            _response(suppressed_reason=reason, market_waiting=True, signal=None)
        )
        assert out["suppressed_reason"] == SUPPRESSED_REASON_AWAITING_DIRECTION, reason


def test_honest_default_when_no_reason_present():
    out = _validate_response_finite(_response(market_waiting=True, signal=None))
    assert out["suppressed_reason"] == SUPPRESSED_REASON_AWAITING_DIRECTION
