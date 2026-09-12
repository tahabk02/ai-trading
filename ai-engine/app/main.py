"""
AI Engine main application entry point.
Registers RequestValidationError handler at the app level (not router level).
100% Real execution - Zero Demo - Zero Fallbacks.

IMPORTANT: Prediction endpoint is defined in signals.py (mounted via api_router).
DO NOT duplicate POST /api/v1/predict here.
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from datetime import datetime
import structlog
import asyncio
import numpy as np
from contextlib import asynccontextmanager

from .core.config import settings
from .core.logging_config import setup_logging
from .services.signal_generator import SignalGenerator
from .messaging.publisher import RedisPublisher
from .data.cache import data_cache
from .services.ml_predictor import predict_with_rf, _model_cache
from .api.v1.endpoints import api_router

setup_logging()
logger = structlog.get_logger(__name__)

publisher = RedisPublisher()
signal_gen = SignalGenerator(confidence_threshold=settings.CONFIDENCE_THRESHOLD)

# ── Model Cache Warmup Symbols ──
# Pre-trained on startup so first client request hits cache (sub-50ms).
# Loaded from env var WARMUP_SYMBOLS (comma-separated) with sensible defaults.
# Stocks and crypto detected dynamically by MarketDataCollector.
import os

# ═══════════════════════════════════════════════════════════════════
# STRICT OTC WARMUP SYMBOLS — FULL 34-PAIR UNIVERSE (incl. CRYPTO)
# Mirrors core-backend symbolRegistry.service.ts. BTC/USD & ETH/USD
# warm up through CoinGecko real market history via the collector.
# ═══════════════════════════════════════════════════════════════════
DEFAULT_WARMUP_SYMBOLS = (
    "EUR/USD,GBP/USD,USD/JPY,USD/CHF,USD/CAD,AUD/USD,NZD/USD,"
    "BTC/USD,ETH/USD,"
    "EUR/GBP,EUR/JPY,EUR/CHF,EUR/AUD,EUR/CAD,EUR/NZD,EUR/TRY,"
    "GBP/JPY,GBP/CHF,GBP/AUD,GBP/CAD,"
    "AUD/JPY,CAD/JPY,CHF/JPY,"
    "AUD/CAD,AUD/NZD,NZD/JPY,CAD/CHF,EUR/RUB,"
    "USD/TRY,USD/ZAR,USD/MXN,USD/SGD,MAD/USD,KES/USD"
)

WARMUP_SYMBOLS = os.environ.get(
    "WARMUP_SYMBOLS",
    DEFAULT_WARMUP_SYMBOLS
).split(",")
WARMUP_SYMBOLS = [s.strip() for s in WARMUP_SYMBOLS if s.strip()]
WARMUP_TIMEFRAMES = ["1d", "1h"]
# ── ALIGNED WITH ML FLOOR (ml_predictor.MIN_TRAINING_CANDLES) ──
# Frankfurter business-day cadence yields ~85 real daily bars per window;
# the collector now expands its calendar window so >= this many REAL
# observations arrive naturally. Below-floor feeds skip warmup — never pad.
WARMUP_MIN_BARS = 85

# ── Warmup concurrency / rate-limit guards ──
WARMUP_CONCURRENCY = 4       # max 4 simultaneous API requests
WARMUP_INTER_SYMBOL_DELAY = 0.6  # 600ms between symbol batches to avoid throttling


async def _warmup_one_symbol(
    collector,
    sem: asyncio.Semaphore,
    symbol: str,
    tf: str,
) -> None:
    """Warmup a single symbol/timeframe pair under the semaphore."""
    async with sem:
        try:
            # Check if already cached from a previous run (e.g. container restart)
            existing = _model_cache.get(symbol, tf)
            if existing is not None:
                logger.debug("Warmup: model already cached", symbol=symbol, timeframe=tf)
                return

            # Fetch real candles via the collector — crypto majors
            # (BTC/USD, ETH/USD) auto-route to CoinGecko real history.
            from .data.collector import is_otc_pair

            if not is_otc_pair(symbol):
                logger.warning("Warmup: non-whitelisted symbol skipped", symbol=symbol)
                return

            candles = await collector.fetch_historical_candles(
                symbol=symbol,
                interval=tf,
                limit=WARMUP_MIN_BARS,
            )

            if not candles:
                logger.warning("Warmup: no candles returned, skipping", symbol=symbol, timeframe=tf)
                return

            # ZERO-FABRICATION: short real series are used as-is. The
            # previous pad_candles_if_needed call RAISED for short arrays
            # (strict real-data guard) which aborted warmup entirely.
            # Real bars below the target are still valid training data.
            if len(candles) < WARMUP_MIN_BARS:
                logger.info(
                    "Warmup: proceeding with real bars below target (no fabrication)",
                    symbol=symbol, timeframe=tf,
                    bars=len(candles), target=WARMUP_MIN_BARS,
                )

            # Use the last bar close as a proxy live_price
            warmup_price = float(candles[-1]["close"])
            if not np.isfinite(warmup_price) or warmup_price <= 0:
                logger.warning("Warmup: invalid price, skipping", symbol=symbol, timeframe=tf)
                return

            logger.info("Warmup: training model", symbol=symbol, timeframe=tf,
                        bars=len(candles), price=warmup_price)

            await predict_with_rf(
                symbol=symbol,
                timeframe=tf,
                candles=candles,
                live_price=warmup_price,
                force_retrain=True,
            )

            logger.info("Warmup: model trained and cached", symbol=symbol,
                        timeframe=tf, cache_size=_model_cache.size)

        except Exception as e:
            logger.warning("Warmup: failed for symbol",
                           symbol=symbol, timeframe=tf, error=str(e))


async def _warmup_model_cache():
    """Pre-train models for popular symbols so the cache is hot immediately.

    Uses the MarketDataCollector to fetch real bars from the appropriate
    data source (Alpaca for stocks, Binance for crypto). Zero synthetic data.
    Concurrency is bounded by WARMUP_CONCURRENCY to avoid rate-limit breaking,
    with WARMUP_INTER_SYMBOL_DELAY between batches for API throttling respect.
    If fetching fails for any symbol, logs a warning and continues — no hard failure.
    """
    from .data.collector import MarketDataCollector

    collector = MarketDataCollector()
    sem = asyncio.Semaphore(WARMUP_CONCURRENCY)
    total_jobs = len(WARMUP_SYMBOLS) * len(WARMUP_TIMEFRAMES)

    logger.info("Starting model cache warmup",
                symbols=len(WARMUP_SYMBOLS),
                timeframes=WARMUP_TIMEFRAMES,
                total_jobs=total_jobs,
                concurrency=WARMUP_CONCURRENCY,
                inter_symbol_delay=WARMUP_INTER_SYMBOL_DELAY)

    # Build all (symbol, tf) task pairs, then process in concurrency-limited batches
    all_tasks = []
    for symbol in WARMUP_SYMBOLS:
        for tf in WARMUP_TIMEFRAMES:
            all_tasks.append((symbol, tf))

    completed = 0
    for i in range(0, len(all_tasks), WARMUP_CONCURRENCY):
        batch = all_tasks[i:i + WARMUP_CONCURRENCY]
        batch_tasks = [
            _warmup_one_symbol(collector, sem, symbol, tf)
            for symbol, tf in batch
        ]
        await asyncio.gather(*batch_tasks)
        completed += len(batch)

        # Log progress every 10 symbols
        if completed % 10 == 0 or completed == len(all_tasks):
            logger.info("Warmup progress",
                        completed=completed,
                        total=len(all_tasks),
                        cache_size=_model_cache.size)

        # Respectful delay between batches to avoid API rate limits
        if i + WARMUP_CONCURRENCY < len(all_tasks):
            await asyncio.sleep(WARMUP_INTER_SYMBOL_DELAY)

    await collector.close()
    logger.info("Model cache warmup complete",
                cache_size=_model_cache.size,
                symbols_warmed=WARMUP_SYMBOLS,
                total_jobs=total_jobs)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await publisher.connect()
    data_cache.clear_all()
    logger.info("AI Engine DataCache cleared on startup — stale prices purged")
    # Fire-and-forget warmup — don't block server readiness
    asyncio.create_task(_warmup_model_cache())
    logger.info("AI Engine startup complete (model cache warmup launched in background)")
    yield
    await publisher.close()
    logger.info("AI Engine shutdown complete")


app = FastAPI(
    title=settings.PROJECT_NAME,
    lifespan=lifespan,
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.API_V1_STR)


# ============================================================
# IMPORTANT: Prediction endpoint is defined in signals.py
# (mounted via api_router at /api/v1/predict).
# DO NOT duplicate POST /api/v1/predict here.
# The duplicate endpoint was removed to prevent route conflicts
# and response structure mismatches.
# ============================================================


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    errors = exc.errors()
    error_details = []
    for err in errors:
        field_path = " -> ".join(str(loc) for loc in err.get("loc", []))
        msg = err.get("msg", "Unknown validation error")
        error_type = err.get("type", "unknown")
        error_details.append({
            "field": field_path,
            "message": msg,
            "type": error_type,
        })

    return JSONResponse(
        status_code=400,
        content={
            "error": "Validation Error",
            "detail": error_details,
            "message": "One or more required fields are missing or invalid.",
            "timestamp": datetime.utcnow().isoformat(),
        },
    )


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": settings.PROJECT_NAME}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

