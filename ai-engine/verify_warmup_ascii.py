# verify_warmup_ascii.py -- ZERO-DEMO WARMUP VERIFICATION HARNESS (pure ASCII)
#
# Proves, against the LIVE Frankfurter API:
#   1. The expanded calendar window yields >= MIN_TRAINING_CANDLES real bars.
#   2. The strict guard accepts exactly that many bars (no ValueError).
#   3. The full ML warmup path trains a RandomForest and caches it.
# Exit code 0 == warmup pipeline healthy.

import asyncio
import sys

sys.path.insert(0, r"C:\Users\hp\trading-ai-platform\ai-engine")

from app.data.collector import MarketDataCollector
from app.services.ml_predictor import (
    pad_candles_if_needed,
    predict_with_rf,
    _model_cache,
    MIN_TRAINING_CANDLES,
)


async def main() -> int:
    print("MIN_TRAINING_CANDLES =", MIN_TRAINING_CANDLES)
    assert MIN_TRAINING_CANDLES == 85

    collector = MarketDataCollector()
    candles = await collector.fetch_historical_candles(
        symbol="EUR/USD", interval="1d", limit=MIN_TRAINING_CANDLES
    )
    n = len(candles)
    print("FRANKFURTER_FETCH_COUNT =", n, "(limit=%d)" % MIN_TRAINING_CANDLES)
    assert n >= MIN_TRAINING_CANDLES, "feed still starved: got=%d" % n

    # Strict guard must ACCEPT the real fetch (this raised before the fix).
    kept = pad_candles_if_needed(candles, target_count=MIN_TRAINING_CANDLES)
    assert len(kept) == n, "guard mutated real candles"
    print("STRICT_GUARD_PASSED = True")

    last_close = float(candles[-1]["close"])
    print("TRAINING on %d real bars @ live_price=%s ..." % (n, last_close))
    await predict_with_rf(
        symbol="EUR/USD",
        timeframe="1d",
        candles=candles,
        live_price=last_close,
        force_retrain=True,
    )

    cached = _model_cache.get("EUR/USD", "1d")
    assert cached is not None, "model was not cached after training"
    print("MODEL_TRAINED_AND_CACHED = True")
    print("WARMUP_VERIFICATION = PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
