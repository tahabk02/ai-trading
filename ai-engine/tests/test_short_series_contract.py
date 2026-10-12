"""Zero-fabrication contract for thin tapes.

The legacy probe `test_endpoint_mixed.py` asserted a 20-candle payload must be
rejected with 400/422. That expectation predates the micro-quant fast path and
is WRONG for this engine: the Node backend deliberately forwards only real
observed candles, and a live tape legitimately starts at 2 bars and grows. The
documented contract in signals.py is:

    below MINIMUM_FAST_PATH_BARS (2)  -> HTTP 400, never synthetic
    2 .. MINIMUM_REQUIRED_BARS (100)   -> HTTP 200 fast-path verdict, but it
                                         MUST NOT be executable and MUST carry
                                         an honest suppressed_reason

The dangerous failure mode is not the status code -- it is a thin tape quietly
becoming a dispatchable verdict. These tests pin the invariant that matters:
a tape below the real ML training minimum can never be executable, and a tape
below 2 bars is rejected outright.
"""
import pytest
from fastapi.testclient import TestClient

from app.api.v1.signals import MINIMUM_FAST_PATH_BARS, MINIMUM_REQUIRED_BARS
from app.main import app
from app.services.signal_lock import signal_lock

# A whitelisted symbol: /predict rejects anything outside the instrument
# universe, so a synthetic name like "THIN/2" would 400 on symbol validation
# and the test would pass for the wrong reason.
SYMBOL = "EUR/USD"


@pytest.fixture(autouse=True)
def _no_locked_verdict():
    """The expiry-scoped signal lock intentionally pins the first verdict for a
    symbol+timeframe. Several tests reuse EUR/USD 1h with different tape lengths,
    so the lock must be dropped between requests or they would assert on a
    carried-over verdict instead of their own payload."""
    signal_lock._local.clear()
    yield
    signal_lock._local.clear()


def _candles(n, base=1.1000):
    """Monotonic drift tape so the assertions are about data sufficiency, not
    about whether the tape happens to be a good one."""
    out = []
    for i in range(n):
        close = base * (1.0 + 0.0004 * i)
        out.append({
            "timestamp": 1_700_000_000 + i * 3600,
            "open": close * 0.999,
            "high": close * 1.001,
            "low": close * 0.998,
            "close": close,
            "volume": 1000.0,
        })
    return out


def _post(n, symbol=SYMBOL):
    candles = _candles(n)
    client = TestClient(app)
    # n=0 has no last bar to quote from; the request must still be well formed
    # so that the <2-bar rejection (and not a client-side crash) is what we see.
    live_price = candles[-1]["close"] if candles else _candles(1)[0]["close"]
    return client.post(
        "/api/v1/predict",
        json={
            "symbol": symbol,
            "timeframe": "1h",
            "candles": candles,
            "live_price": live_price,
            "dataSource": "forex_otc_test",
        },
    )


@pytest.mark.parametrize("n", [0, 1])
def test_below_fast_path_bars_is_rejected_not_fabricated(n):
    """The one hard boundary: <2 real bars cannot produce a verdict at all."""
    assert n < MINIMUM_FAST_PATH_BARS
    resp = _post(n)
    assert resp.status_code == 400, (
        "%d bars must be rejected with 400, got %s" % (n, resp.status_code)
    )
    body = resp.json()
    assert body.get("signal") in (None, ""), (
        "a rejected request must not carry a direction"
    )


@pytest.mark.parametrize("n", [2, 3, 10, 20, 29, 30, 50, 99])
def test_thin_tape_is_never_executable(n):
    """The invariant that actually matters: a tape shorter than the real ML
    training window may return 200, but it must never be dispatchable."""
    assert n < MINIMUM_REQUIRED_BARS
    resp = _post(n)
    assert resp.status_code == 200, (
        "the fast path is documented to answer; got %s" % resp.status_code
    )
    body = resp.json()

    assert body.get("executable") is False, (
        "%d bars must not be executable (confidence=%r, tier=%r)"
        % (n, body.get("confidence"), body.get("tier"))
    )
    assert body.get("suppressed_reason"), (
        "%d bars must carry an honest suppressed_reason, got %r"
        % (n, body.get("suppressed_reason"))
    )


@pytest.mark.parametrize("n", [2, 20, 99])
def test_thin_tape_never_raises_a_high_confidence_alert(n):
    """No thin tape may trip the alert path that downstream dispatch watches."""
    body = _post(n).json()
    assert body.get("high_confidence_alert") is not True, (
        "%d bars must not raise high_confidence_alert" % n
    )


def test_suppressed_reason_is_a_specific_stable_token():
    """Lock the token so a client can branch on it without string guessing."""
    body = _post(20).json()
    assert body.get("suppressed_reason") == "insufficient_history"


def test_unknown_symbol_is_rejected_by_the_schema_not_confused_with_a_thin_tape():
    """Guard the failure mode that would silently gut this whole file: a 400
    raised by symbol validation must not be mistaken for the <2-bar boundary."""
    resp = _post(20, symbol="NOT/AREAL")
    assert resp.status_code == 400
    detail = str(resp.json().get("detail"))
    assert "candles" not in detail.lower() or "NOT in" in detail, (
        "expected a symbol-validation error, got %s" % detail
    )

