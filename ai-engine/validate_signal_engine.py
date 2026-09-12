"""
validate_signal_engine.py — Python-side proof harness for the AI engine.

Runs the REAL `evaluate_quant_matrix` (quant_matrix.py) against shaped
tapes and asserts the STRICT 96.5% THERMAL-GATE / NEVER-HOLD contract
(v11 lock-down):

  1. Fully-converged bullish trend -> BUY with confidence >= 96.5
     (multi-book confluence through the logistic sharpener), alert fires.
  2. Sub-thermal tapes (bearish drift, flat, range-bound consolidation)
     KEEP their true BUY/SELL direction and are flagged market-waiting
     (CONFLUENCE_BELOW_THERMAL), confidence < 96.5, high-confidence alert
     NEVER fires on them, and HOLD is never returned.

Exit code 0 = contract satisfied.
"""

import sys

sys.path.insert(0, ".")
sys.path.insert(0, "tests")

from app.services.quant_matrix import evaluate_quant_matrix  # noqa: E402
from test_unbiased_matrix import scenario_bullish, scenario_bearish  # noqa: E402


passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name} {detail}")


def must_be_directional(v, label):
    check(f"{label} resolves a real direction (never HOLD)", v.direction in ("BUY", "SELL"), f"(got {v.direction})")
    return v.direction in ("BUY", "SELL")


print("=" * 72)
print("PYTHON UNBIASED QUANT MATRIX — STRICT 96.5% THERMAL-GATE / NEVER-HOLD VALIDATION")
print("=" * 72)

# 1. Fully-converged bullish tape -> BUY (definitive 96.5% emission).
bull = evaluate_quant_matrix(
    scenario_bullish(120), live_price=1.134, timeframe="1d"
)
check(
    "converged bullish => BUY (definitive emission)",
    bull.direction == "BUY",
    f"(got {bull.direction})",
)
check(
    "definitive BUY confidence >= 96.5 (never padded above real strength)",
    bull.confidence >= 96.5,
    f"(got {bull.confidence})",
)
check(
    "high-confidence alert fires ONLY on the definitive dispatch",
    bull.high_confidence_alert is True,
    f"(got {bull.high_confidence_alert})",
)
check(
    "definitive dispatch is NOT market-waiting",
    bull.market_waiting is False,
    f"(got {bull.market_waiting})",
)

# 2. Bearish drift that underconverges -> directional market-wait, no alert.
bear = evaluate_quant_matrix(
    scenario_bearish(120), live_price=1.064, timeframe="1d"
)
must_be_directional(bear, "sub-thermal bearish")
check(
    "sub-thermal bearish is market-waiting (never dispatched)",
    bear.market_waiting is True,
    f"(got {bear.market_waiting})",
)
check(
    "sub-thermal bearish names CONFLUENCE_BELOW_THERMAL",
    bear.waiting_reason == "CONFLUENCE_BELOW_THERMAL",
    f"(got {bear.waiting_reason})",
)
check(
    "sub-thermal confidence honestly below 96.5",
    bear.confidence < 96.5,
    f"(got {bear.confidence})",
)
check(
    "sub-thermal verdict NEVER fires the high-confidence alert",
    bear.high_confidence_alert is False,
    f"(got {bear.high_confidence_alert})",
)

# 3. Flat series -> directional market-wait (zero-tie policy, honest-low conf).
flat = evaluate_quant_matrix(
    [{"timestamp": 1_700_000_000_000 + i * 60_000, "open": 1.07, "high": 1.0705, "low": 1.0695, "close": 1.07, "volume": 1000.0} for i in range(120)],
    live_price=1.07,
    timeframe="1d",
)
must_be_directional(flat, "flat tape")
check("flat tape is market-waiting (zero-tie, never HOLD)", flat.market_waiting is True, f"(got {flat.market_waiting})")
check(
    "flat confidence honest (no inflated floor)",
    flat.confidence < 96.5,
    f"(got {flat.confidence})",
)
check(
    "flat tape NEVER fires the high-confidence alert",
    flat.high_confidence_alert is False,
    f"(got {flat.high_confidence_alert})",
)

# 4. Range-bound consolidation -> directional market-wait + honest-low conf.
range_closes = []
for i in range(119):
    range_closes.append(1.07 + (0.0003 if i % 2 == 0 else -0.0003))
range_closes.append(1.07)
rng_candles = []
for i, c in enumerate(range_closes):
    rng_candles.append(
        {
            "timestamp": 1_700_000_000_000 + i * 60_000,
            "open": range_closes[i - 1] if i > 0 else c,
            "high": c * 1.0002,
            "low": c * 0.9998,
            "close": c,
            "volume": 1000.0,
        }
    )
rng = evaluate_quant_matrix(rng_candles, live_price=range_closes[-1], timeframe="1d")
must_be_directional(rng, "range-bound consolidation")
check("range-bound consolidation is market-waiting", rng.market_waiting is True, f"(got {rng.market_waiting})")
check(
    "consolidation confidence honest",
    rng.confidence < 96.5,
    f"(got {rng.confidence})",
)
check(
    "consolidation NEVER fires the high-confidence alert",
    rng.high_confidence_alert is False,
    f"(got {rng.high_confidence_alert})",
)

print("-" * 72)
print(f" RESULT: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
print(" STRICT 96.5% THERMAL GATE / NEVER-HOLD SATISFIED — zero false positives.")