"""
signals.py — Production AI Prediction Endpoint (Zero Synthetic Fallbacks)

Endpoints:
  POST /api/v1/predict  — Main inference (accepts candles from Node.js)
  POST /api/v1/analyze  — Market analysis trigger

Architecture (UNBIASED PIPELINE — SINGLE 96.5% ENFORCEMENT POINT):
  1. Node.js forwards bars + symbol + timeframe + live_price (+ bid/ask) to
     POST /api/v1/predict.
  2. The STRICT MULTIPLICATIVE multi-book confluence gate runs for EVERY
     request: evaluate_quant_matrix computes the 10-book geometric alignment
     through a logistic sharpener. A directional verdict exists ONLY when the
score clears DEFINITIVE_CONFIDENCE_MIN (96.5%) AND the volatility
      (Bollinger/ATR), momentum (Murphy/Donchian/Nison) and microstructure
      (Aldridge order-book queue — real bid/ask, else the real tick-position
      proxy) pillars are all aligned.
  3. RandomForest ML runs ONLY as a CORROBORATOR on DEFINITIVE tapes (its
     numbers enrich diagnostics); sub-thermal requests keep their true
     BUY/SELL direction as an honest market-waiting signal
     (market_waiting=True) without spending training time.
  4. If data < 100 bars → HTTP 400 with a clean descriptive error.
  5. If the gate itself fails → HTTP 500 — a descriptive error, NEVER a fake
     signal.

Bias fixes applied:
  • Zero-tie policy: an exactly-neutral score resolves deterministically to
    BUY/SELL from real micro factors — never HOLD, never invented.
  • Genuine full-range confidence [0, 100] from the real confluence score.
  • high_confidence_alert fires ONLY on (and always on) a DEFINITIVE ≥96.5%
    emission — never on a filtered/sub-thermal verdict.
  • market_waiting / waiting_reason / waiting_detail when a directional
    attempt is blocked below the 96.5% thermal gate
    (CONFLUENCE_BELOW_THERMAL); the direction is KEPT — the engine never
    demotes to HOLD. A market-waiting verdict keeps its REAL directional
    projection (never a reversed/hidden projection).
  • The reported confidence IS the confluence score (never padded or hidden);
    ML (ml_signal / nl_probability / model_accuracy) is surfaced separately
    under diagnostics.ml.
  • 10-book confluence (Bollinger %B/squeeze, Turtle Donchian, MACD/RSI/EMA
    stack, volume-price, Nison candles, Aldridge queue, Aronson evidence,
    ATR regime) folded into the confidence (book_confluence, diagnostics.book).
  • Time-aware horizon projection for 1m … 10d expirations.

NOTE: RequestValidationError handlers are registered in main.py on the FastAPI app.
"""

from fastapi import APIRouter, HTTPException
from typing import Dict, Any, List, Optional
from datetime import datetime
import numpy as np
import pandas as pd
import structlog
import asyncio
import time as _time

from app.services.signal_generator import SignalGenerator, generate_unbiased_prediction
from app.services.ml_predictor import predict_with_rf
from app.services.quant_matrix import (
    evaluate_quant_matrix,
    project_target,
    symbol_price_digits,
)
from app.services.live_quant import (
    evaluate_live_tick_signal,
    build_tick_signal_payload,
    LiveQuantVerdict,
)
from app.core.config import settings
from .schemas import PredictRequest

logger = structlog.get_logger(__name__)

router = APIRouter()
signal_gen = SignalGenerator(confidence_threshold=settings.CONFIDENCE_THRESHOLD)

# ════════════════════════════════════════════════════════════════════
# STRICT OTC WHITELIST — 100% REAL · 0 DEMO · FULL 34-PAIR UNIVERSE
# Mirrors core-backend symbolRegistry.service.ts EXACTLY. Includes the
# CRYPTO MAJORS (BTC/USD, ETH/USD) so crypto predictions are never
# rejected at this boundary.
# ════════════════════════════════════════════════════════════════════
STRICT_OTC_WHITELIST = frozenset({
    # Forex Majors (7)
    "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "USD/CAD", "AUD/USD", "NZD/USD",
    # Crypto Majors (2)
    "BTC/USD", "ETH/USD",
    # Euro Crosses (7)
    "EUR/GBP", "EUR/JPY", "EUR/CHF", "EUR/AUD", "EUR/CAD", "EUR/NZD", "EUR/TRY",
    # Pound Crosses (4)
    "GBP/JPY", "GBP/CHF", "GBP/AUD", "GBP/CAD",
    # Yen Crosses (3)
    "AUD/JPY", "CAD/JPY", "CHF/JPY",
    # Other Minors (5)
    "AUD/CAD", "AUD/NZD", "NZD/JPY", "CAD/CHF", "EUR/RUB",
    # Emerging / OTC Variants (6)
    "USD/TRY", "USD/ZAR", "USD/MXN", "USD/SGD", "MAD/USD", "KES/USD",
})

PREDICT_PIPELINE_TIMEOUT_SECONDS = 120.0
# ── ALIGNED WITH ml_predictor.MIN_TRAINING_CANDLES (85) ──
# STRICT ZERO-FABRICATION: the Node backend now passes ONLY real observed
# candles (historical bars + live-accumulated appendTick buckets). No
# deterministic backfill exists anymore — real bars may be short until enough
# live ticks accumulate. Below-floor requests get a clean HTTP 400 — never
# synthetic padding.
MINIMUM_REQUIRED_BARS = 100

# ── Per-symbol asyncio.Lock registry ──
_symbol_locks: Dict[str, asyncio.Lock] = {}
_symbol_locks_lock = asyncio.Lock()


async def _get_symbol_lock(symbol: str) -> asyncio.Lock:
    """Get or create a per-symbol asyncio.Lock."""
    async with _symbol_locks_lock:
        if symbol not in _symbol_locks:
            _symbol_locks[symbol] = asyncio.Lock()
        return _symbol_locks[symbol]


def _validate_response_finite(response: Dict[str, Any]) -> Dict[str, Any]:
    numeric_keys = [
        "confidence", "target_price", "target_distance", "current_price",
        "ml_probability", "model_accuracy", "atr", "volatility_pct",
    ]
    for key in numeric_keys:
        val = response.get(key)
        if val is None or not np.isfinite(float(val)):
            if key == "target_price":
                cp = response.get("current_price", 0.0)
                response[key] = (
                    float(round(cp, 2))
                    if cp is not None and np.isfinite(float(cp))
                    else 0.0
                )
            elif key == "current_price":
                response[key] = 0.0
            else:
                response[key] = 0.0

    # `book_confluence` is a FLOAT on /tick-signal (the live confluence score)
    # but a DICT {score,gate,blockers,...} on /predict — guard both shapes so a
    # dict never reaches the numeric sanitizer (which would raise on float(dict)
    # and take down the whole /predict contract).
    book_confluence = response.get("book_confluence")
    if isinstance(book_confluence, dict):
        raw_score = book_confluence.get("score")
        try:
            finite_score = (
                float(raw_score)
                if raw_score is not None and np.isfinite(float(raw_score))
                else 0.0
            )
        except (TypeError, ValueError):
            finite_score = 0.0
        book_confluence["score"] = finite_score
    elif book_confluence is not None:
        try:
            cnv = float(book_confluence)
            response["book_confluence"] = (
                cnv if np.isfinite(cnv) else 0.0
            )
        except (TypeError, ValueError):
            response["book_confluence"] = 0.0

    scalping = response.get("scalping_indicators", {})
    indicators = response.get("indicators", {})
    if not indicators and scalping:
        indicators = {
            "tick_velocity": scalping.get("tick_velocity"),
            "micro_momentum": scalping.get("micro_momentum"),
            "bid_ask_pressure": scalping.get("bid_ask_pressure"),
            "price_action_delta": scalping.get("price_action_delta"),
        }
        response["indicators"] = indicators

    if indicators:
        for ik in ["tick_velocity", "micro_momentum", "bid_ask_pressure", "price_action_delta"]:
            iv = indicators.get(ik)
            if iv is not None and not np.isfinite(float(iv)):
                indicators[ik] = None
        for ik in ["rsi_14", "macd_momentum", "spread_quality"]:
            iv = indicators.get(ik)
            if iv is not None and not np.isfinite(float(iv)):
                indicators[ik] = None

    cp = response.get("current_price", 0.0)
    tp = response.get("target_price", cp)
    cp_f = float(cp) if cp is not None else 0.0
    tp_f = float(tp) if tp is not None else cp_f
    if cp_f != 0.0 and np.isfinite(cp_f) and np.isfinite(tp_f):
        delta = ((tp_f - cp_f) / cp_f) * 100.0
        delta = max(-100.0, min(100.0, delta))
        response["delta_pct"] = round(delta, 2) if np.isfinite(delta) else 0.0
    else:
        response["delta_pct"] = 0.0
    return response


@router.post("/tick-signal")
async def tick_signal(data: Dict[str, Any]):
    """HIGH-FREQUENCY LIVE QUANT SIGNAL — evaluate real price action in <1ms.

    Designed for the 1-second tick cadence of binary/OTC feeds. Evaluates a
    REAL price-action array (aggregated live candles / rolling tick window)
    into BUY / SELL (never HOLD) using the pure 9-factor MICRO-MOMENTUM
    confluence
    (tick velocity + acceleration, order-flow imbalance, bid-ask pressure)
    with NO hardcoded confidence floor, NO 85-bar requirement and NO lagging
    RSI/EMA/MACD arbitration.

    Accepts either:
      • ``prices`` — a flat array of recent live closes (recommended, cheap),
      • ``candles`` — an OHLC array (used when no flat prices are sent).

    Optional:
      • ``symbol``, ``timeframe`` — for the response contract / metadata
      • ``tick`` — the freshest live price (vs last close) for tick momentum

    ZERO MOCK: every input must be real observed price action. An empty or
    single-element array returns a clean HTTP 400 — never a fabricated signal.
    """
    try:
        symbol = str(data.get("symbol", "")).strip().upper()
        timeframe = str(data.get("timeframe", "1m")).strip().lower()
        tick_raw = data.get("tick")
        tick = float(tick_raw) if tick_raw is not None else None
        bid_raw = data.get("bid")
        ask_raw = data.get("ask")
        bid = float(bid_raw) if bid_raw is not None else None
        ask = float(ask_raw) if ask_raw is not None else None
        bid_depth_raw = data.get("bid_depth")
        ask_depth_raw = data.get("ask_depth")
        bid_depth = float(bid_depth_raw) if bid_depth_raw is not None else None
        ask_depth = float(ask_depth_raw) if ask_depth_raw is not None else None

        prices_raw = data.get("prices")
        candles_raw = data.get("candles")

        prices: Optional[List[float]] = None
        highs: Optional[List[float]] = None
        lows: Optional[List[float]] = None
        closes_from_candles: Optional[List[float]] = None

        if isinstance(prices_raw, list) and prices_raw:
            parsed = []
            for p in prices_raw:
                try:
                    parsed.append(float(p))
                except (TypeError, ValueError):
                    continue
            if len(parsed) >= 2:
                prices = parsed

        if (not prices) and isinstance(candles_raw, list) and candles_raw:
            parsed_close, parsed_high, parsed_low = [], [], []
            for c in candles_raw:
                if not isinstance(c, dict):
                    continue
                try:
                    cl = float(c.get("close"))
                    hi = float(c.get("high", cl))
                    lo = float(c.get("low", cl))
                except (TypeError, ValueError):
                    continue
                if not (np.isfinite(cl) and cl > 0):
                    continue
                parsed_close.append(cl)
                parsed_high.append(hi)
                parsed_low.append(lo)
            if len(parsed_close) >= 2:
                closes_from_candles = parsed_close
                highs = parsed_high
                lows = parsed_low

        eval_array = prices if prices is not None else closes_from_candles
        if not eval_array or len(eval_array) < 2:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "Insufficient real price action",
                    "symbol": symbol,
                    "message": (
                        "tick-signal requires at least 2 real prices or candles; "
                        "got an empty or single-element array. Zero-fabrication "
                        "policy refuses to invent a signal without real data."
                    ),
                },
            )

        verdict = evaluate_live_tick_signal(
            prices=eval_array,
            tick=tick,
            highs=highs,
            lows=lows,
            timeframe=timeframe,
            bid=bid,
            ask=ask,
            bid_depth=bid_depth,
            ask_depth=ask_depth,
        )

        # Genuine ATR from the verdict's real Wilder ATR diagnostics (robust on
        # short live arrays, unlike the TA-service column which may be empty on
        # <period bars).
        atr_now = float(verdict.diagnostics.get("atr_14", 0.0))
        if not np.isfinite(atr_now) or atr_now < 0:
            atr_now = 0.0

        closes_arr = np.asarray(eval_array, dtype=np.float64)

        eval_price = float(tick) if tick is not None and np.isfinite(tick) and tick > 0 else float(closes_arr[-1])

        response = build_tick_signal_payload(
            symbol=symbol,
            timeframe=timeframe,
            verdict=verdict,
            eval_price=eval_price,
            atr=atr_now,
        )
        # ── ATR × √horizon TARGET PROJECTION (same contract as /predict) ──
        # A definitive BUY/SELL projects strictly above/below the live price
        # through project_target; a market-waiting signal keeps its true
        # directional projection (real, never reversed or fabricated).
        digits = symbol_price_digits(symbol)
        target_price, target_distance = project_target(
            direction=response["signal"],
            current_price=eval_price,
            atr=atr_now,
            timeframe=response["timeframe"],
            symbol_digits=digits,
        )
        response["target_price"] = round(target_price, digits)
        response["target_distance"] = round(target_distance, digits)
        response["barCount"] = len(eval_array)
        response["proxyLatencyMs"] = 0.0

        logger.info(
            "LIVE_TICK_QUANT_DISPATCHED",
            symbol=symbol,
            signal=response["signal"],
            confidence=response["confidence"],
            timeframe=timeframe,
            bars=len(eval_array),
            direction_score=verdict.direction_score,
        )
        return _validate_response_finite(response)
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=400, detail={"error": "Invalid price data", "message": str(ve)})
    except Exception as e:
        logger.error("Tick-signal endpoint error", error=str(e))
        raise HTTPException(status_code=500, detail={"error": "Tick-signal pipeline failure", "message": str(e)})


@router.post("/analyze")
async def analyze_market(data: Dict[str, Any]):
    """Market analysis via the unbiased 3-layer generator.

    Raises HTTP 400 on invalid input — never fabricates a signal.
    """
    try:
        result = signal_gen.generate_signal(data)
        return result
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error("Analyze endpoint error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/predict")
async def predict_signal(data: PredictRequest):
    """
    Production inference endpoint — ZERO SYNTHETIC FALLBACKS, ZERO BIAS.

    Pipeline (single 96.5% enforcement point):
      1. The authoritative multi-book confluence gate (evaluate_quant_matrix)
         runs on every request. A directional verdict exists ONLY at >= 96.5%
         confluence with every pillar aligned — including the microstructure
         (Aldridge order-book queue: real bid/ask, else the real tick-position
         proxy) pillar.
2. RandomForest ML corroborates DEFINITIVE tapes only (its numbers are
          surfaced separately under diagnostics.ml; they never override the
          gate). Sub-thermal requests return their true BUY/SELL direction as
          an honest market-waiting signal (CONFLUENCE_BELOW_THERMAL) — never
          HOLD, never a reversed projection.
      3. On total failure → descriptive HTTP error. NEVER a fake CALL.
    """
    t0 = _time.perf_counter()
    symbol = data.symbol.strip().upper()
    timeframe = data.timeframe
    candles_raw = [c.model_dump() if hasattr(c, 'model_dump') else dict(c) for c in data.candles]
    live_price = data.live_price
    bid = data.bid
    ask = data.ask
    data_source = data.dataSource or "unknown"

    logger.info(
        "Prediction requested with Pydantic-validated payload",
        symbol=symbol, timeframe=timeframe,
        candle_count=len(candles_raw), live_price=live_price,
    )

    # ── STRICT REAL-DATA MINIMUM BAR GATE ──
    if len(candles_raw) < MINIMUM_REQUIRED_BARS:
        logger.warning(
            "Insufficient real historical candles — rejecting with HTTP 400",
            symbol=symbol, bars_provided=len(candles_raw),
            required=MINIMUM_REQUIRED_BARS,
        )
        raise HTTPException(
            status_code=400,
            detail={
                "error": "Insufficient real historical market data",
                "symbol": symbol,
                "bars_provided": len(candles_raw),
                "bars_required": MINIMUM_REQUIRED_BARS,
                "message": (
                    f"Need at least {MINIMUM_REQUIRED_BARS} real historical "
                    f"candles; got {len(candles_raw)}. Zero-fabrication policy "
                    "refuses synthetic candle padding."
                ),
            },
        )

# Real Wilder ATR(14) from the forwarded series — needed by every branch
    # (HOLD targets pin flat; DEFINITIVE targets scale √horizon).
    closes = [float(c["close"]) for c in candles_raw]
    highs = [float(c["high"]) for c in candles_raw]
    lows = [float(c["low"]) for c in candles_raw]
    current_price = float(live_price)
    atr_df = pd.DataFrame(
        {"open": closes, "high": highs, "low": lows, "close": closes}
    )
    atr_arr = signal_gen.ta_service.calculate_indicators(atr_df)["atr"].values
    atr_now = float(atr_arr[-1])
    if not np.isfinite(atr_now) or atr_now <= 0:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "Volatility unavailable",
                "symbol": symbol,
                "message": (
                    "Realized ATR collapsed to a non-positive value; the "
                    "zero-fabrication policy refuses to project a target "
                    "without genuine volatility data."
                ),
            },
        )

    # ── STEP 1: THE AUTHORITATIVE 96.5% MULTI-BOOK CONFLUENCE GATE ───────
    # Runs for EVERY request — this is the single enforcement point. A
    # directional verdict exists ONLY when the strict multiplicative 10-book
    # confluence clears DEFINITIVE_CONFIDENCE_MIN (96.5%) AND every pillar
# (volatility, momentum, microstructure — order-book queue via real bid/ask,
    #     else the real tick-position proxy) is all aligned. Everything below is
    #     corroboration/UI.
    try:
        verdict = evaluate_quant_matrix(
            candles=candles_raw,
            live_price=live_price,
            timeframe=timeframe,
            bid=bid,
            ask=ask,
        )
    except ValueError as ve:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "Quant matrix rejected the input series",
                "symbol": symbol,
                "message": str(ve),
            },
        )
    except Exception as e:
        logger.error("Quant matrix unexpected failure", symbol=symbol, error=str(e))
        raise HTTPException(
            status_code=500,
            detail={
                "error": "Prediction pipeline failure",
                "symbol": symbol,
                "message": str(e),
            },
        )

    # ── STEP 2: ML CORROBORATION ON DEFINITIVE TAPES ONLY ──
    # The confluence gate is the dispatch authority: its ≥96.5% emission IS the
    # signal. The RandomForest runs under the per-symbol lock purely to enrich
    # the response (ml_probability / model_accuracy / micro_confluence / richer
    # indicators). An ML failure must NEVER downgrade a DEFINITIVE emission —
    # log and proceed with the confluence verdict. Sub-thermal/neutral requests
    # never trigger training (a tape below the gate can never dispatch anyway).
    symbol_lock = await _get_symbol_lock(symbol)
    ml_extras = None
    if verdict.direction in ("BUY", "SELL"):
        try:
            async with symbol_lock:
                ml_extras = await asyncio.wait_for(
                    predict_with_rf(
                        symbol=symbol, timeframe=timeframe,
                        candles=candles_raw,
                        force_retrain=getattr(data, 'force_retrain', False),
                        live_price=live_price,
                        bid=bid,
                        ask=ask,
                    ),
                    timeout=PREDICT_PIPELINE_TIMEOUT_SECONDS,
                )
            logger.info(
                "ML corroboration on DEFINITIVE tape",
                symbol=symbol, ml_signal=ml_extras.get("signal"),
                ml_confidence=ml_extras.get("confidence"),
            )
        except asyncio.TimeoutError:
            logger.warning(
                "ML corroboration timed out — honoring the confluence verdict",
                symbol=symbol,
            )
            ml_extras = None
        except Exception as e:
            logger.warning(
                "ML corroboration failed — honoring the confluence verdict",
                symbol=symbol, error=str(e),
            )
            ml_extras = None

    # ── STEP 3: √HORIZON TARGET + UNIFIED RESPONSE ──
    digits = symbol_price_digits(symbol)
    target_price, distance = project_target(
        verdict.direction, current_price, atr_now, timeframe, digits
    )

    total_ms = (_time.perf_counter() - t0) * 1000

    response = {
        "symbol": symbol,
        "signal": verdict.direction,
        "confidence": verdict.confidence,
        "high_confidence_alert": verdict.high_confidence_alert,
        "target_price": target_price,
        "current_price": round(current_price, digits),
        "atr": round(atr_now, 8),
        "target_distance": distance,
        "volatility_pct": round((atr_now / current_price) * 100.0, 4),
        "ml_probability": round(verdict.confidence / 100.0, 4),
        # GENUINE factor agreement (real alignment fraction 0..1). The old
        # clamped band [0.55, 0.95] (default 0.6) is PURGED.
        "model_accuracy": round(
            max(0.0, min(float(verdict.diagnostics.get("agreement", 0.0)), 1.0)), 4
        ),
        "timeframe": timeframe,
        "proxyLatencyMs": round(total_ms, 2),
        "dataSource": f"{data_source}_unbiased_quant",
        "barCount": len(candles_raw),
        "indicators": {
            "tick_velocity": verdict.factors.get("tick_velocity"),
            "micro_momentum": verdict.factors.get("micro_momentum"),
            "bid_ask_pressure": verdict.factors.get("bid_ask_pressure"),
            "price_action_delta": verdict.factors.get("price_action_delta"),
            "rsi_14": verdict.factors.get("rsi_14"),
            "macd_momentum": verdict.factors.get("macd_momentum"),
            "spread_quality": verdict.factors.get("spread_quality"),
        },
        "factors": verdict.factors,
        "diagnostics": verdict.diagnostics,
        "market_waiting": bool(verdict.market_waiting),
        "waiting_reason": verdict.waiting_reason,
        "waiting_detail": verdict.waiting_detail,
        "book_confluence": verdict.diagnostics.get("book", {}),
        "timestamp": datetime.utcnow().isoformat(),
    }

    # Merge the ML corroboration numbers (kept separate from the authoritative
    # confluence confidence so the honesty law — confidence == confluence — is
    # never violated for the emitted signal).
    if ml_extras is not None:
        if ml_extras.get("ml_probability") is not None:
            response["ml_probability"] = ml_extras["ml_probability"]
        if ml_extras.get("model_accuracy") is not None:
            response["model_accuracy"] = ml_extras["model_accuracy"]
        for k in ("scalping_indicators", "micro_confluence", "micro_factors", "indicators"):
            if k in ml_extras:
                response[k] = ml_extras[k]
        response.setdefault("diagnostics", {})["ml"] = {
            "signal": ml_extras.get("signal"),
            "confidence": ml_extras.get("confidence"),
            "accuracy": ml_extras.get("model_accuracy"),
        }

    logger.info(
        "Unbiased quant prediction dispatched",
        symbol=symbol,
        signal=response["signal"],
        confidence=response["confidence"],
        high_confidence_alert=response["high_confidence_alert"],
        direction_score=verdict.direction_score,
        confluence_gate=verdict.diagnostics.get("book", {}).get("confluence", {}).get("gate"),
        timeframe=timeframe,
        elapsed_ms=round(total_ms, 2),
    )

    return _validate_response_finite(response)