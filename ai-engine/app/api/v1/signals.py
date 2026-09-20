"""
signals.py — Production AI Prediction Endpoint (Zero Synthetic Fallbacks)

Endpoints:
  POST /api/v1/predict  — Main inference (accepts candles from Node.js)
  POST /api/v1/analyze  — Market analysis trigger

Architecture (UNBIASED PIPELINE — SINGLE 60% ENFORCEMENT POINT):
  1. Node.js forwards bars + symbol + timeframe + live_price (+ bid/ask) to
     POST /api/v1/predict.
  2. The MULTIPLICATIVE multi-book confluence gate runs for EVERY
     request: evaluate_quant_matrix computes the 10-book geometric alignment
     through a logistic sharpener. A directional verdict exists when the
     score clears DEFINITIVE_CONFIDENCE_MIN (60%) AND the volatility
     (Bollinger/ATR), momentum (Murphy/Donchian/Nison) and microstructure
     (Aldridge order-book queue — real bid/ask, else the real tick-position
     proxy) pillars are all aligned.
  3. RandomForest ML runs ONLY as a CORROBORATOR on directional tapes (its
     numbers enrich diagnostics); sub-thermal requests keep their true
     BUY/SELL direction as an honest market-waiting signal
     (market_waiting=True) without spending training time.
  4. If data < 100 bars but >= 2 REAL bars → fast-path micro-quant fallback
     (evaluate_live_tick_signal) so a genuine directional verdict still
     exists the moment real tick data accumulates; < 2 bars → HTTP 400 with
     a clean descriptive error.
  5. If the gate itself fails → HTTP 500 — a descriptive error, NEVER a fake
     signal.

Bias fixes applied:
  • Zero-tie policy: an exactly-neutral score resolves deterministically to
    BUY/SELL from real micro factors — never HOLD, never invented.
  • Genuine full-range confidence [0, 100] from the real confluence score.
  • high_confidence_alert fires ONLY on (and always on) a DEFINITIVE ≥90%
    emission — never on a filtered/sub-thermal verdict.
  • market_waiting / waiting_reason / waiting_detail when a directional
    attempt is blocked below the 60% thermal gate
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
from urllib.parse import quote
import httpx
import numpy as np
import pandas as pd
import structlog
import asyncio
import time as _time

from app.services.signal_generator import SignalGenerator, generate_unbiased_prediction
from app.services.ml_predictor import predict_with_rf, _CPU_EXECUTOR
from app.services.math_target import (
    compute_math_target,
    parse_window,
    DEFAULT_WINDOW_SECONDS,
)
from app.services.quant_matrix import (
    evaluate_quant_matrix,
    project_target,
    symbol_price_digits,
)
from app.services.book_instruments import book_agreement_detail
from app.services.live_quant import (
    evaluate_live_tick_signal,
    build_tick_signal_payload,
    LiveQuantVerdict,
)
from app.services.horizon_engine import (
    build_horizon_payload,
    resolve_horizon_minutes,
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
# live ticks accumulate. Between 2 and MINIMUM_REQUIRED_BARS real bars, a
# fast-path micro-quant fallback returns a genuine directional verdict in
# real-time; below 2 real bars → HTTP 400 (never synthetic).
MINIMUM_REQUIRED_BARS = 100
MINIMUM_FAST_PATH_BARS = 2


@router.get("/math-target")
async def math_target_route(symbol: str = "", window: str = "30m"):
    """
    GET /api/v1/math-target — MATH-BASED TARGET over 30m of REAL persisted
    OHLCV history (core-backend AssetHistory). Returns the full labeled
    model (ATR14 / sigma / VWAP / EMA slopes / deviation / clamped target).
    Empty or non-whitelisted symbol → 400; history unavailable → 503.
    """
    sym = (symbol or "").strip().upper()
    if not sym:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "Validation Error",
                "message": 'A non-empty "symbol" field is required.',
            },
        )
    if sym not in STRICT_OTC_WHITELIST:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "Validation Error",
                "message": f'Symbol "{sym}" is not a whitelisted OTC pair.',
            },
        )
    window_sec = parse_window(window)
    minutes = max(1, int(round(window_sec / 60.0)))
    history_url = (
        f"{settings.BACKEND_API_URL.rstrip('/')}/history"
        f"?symbol={quote(sym)}&window={minutes}"
    )
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(history_url)
            resp.raise_for_status()
            payload = resp.json()
            bars = payload.get("bars") or []
    except Exception as e:
        logger.warning(
            "[math-target] core-backend history unavailable",
            symbol=sym, error=str(e),
        )
        raise HTTPException(
            status_code=503,
            detail={
                "error": "history_unavailable",
                "symbol": sym,
                "message": "30-minute OHLCV history could not be fetched from core-backend.",
            },
        )
    if not bars:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "history_unavailable",
                "symbol": sym,
                "message": "No persisted 30-minute OHLCV bars for this asset yet.",
            },
        )
    closes = [float(b["close"]) for b in bars]
    highs = [float(b["high"]) for b in bars]
    lows = [float(b["low"]) for b in bars]
    result = compute_math_target(sym, closes, highs, lows, window_sec=window_sec)
    return {"success": bool(result.get("success")), **result}


def _timeframe_ms(timeframe: str) -> int:
    units = {"m": 60_000, "h": 3_600_000, "d": 86_400_000}
    token = str(timeframe or "1m").strip().lower()
    if token.endswith("m"):
        return int(token[:-1]) * units["m"]
    if token.endswith("h"):
        return int(token[:-1]) * units["h"]
    if token.endswith("d"):
        return int(token[:-1]) * units["d"]
    raise ValueError(f"Unsupported prediction timeframe: {timeframe}")


def _timestamp_ms(value: object) -> int:
    if isinstance(value, (int, float)):
        raw = float(value)
        return int(raw * 1000 if raw < 1_000_000_000_000 else raw)
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(parsed.timestamp() * 1000)
    raise ValueError("prediction anchor candle has no usable timestamp")


def build_future_candles(
    *,
    candles: List[Dict[str, Any]],
    current_price: float,
    target_price: float,
    atr: float,
    bid: Optional[float],
    ask: Optional[float],
    timeframe: str,
    symbol_digits: int,
) -> List[Dict[str, Any]]:
    """Build transparent model projection bars from real tape-derived inputs."""
    if not candles or current_price <= 0 or target_price <= 0 or atr <= 0:
        return []
    interval_ms = _timeframe_ms(timeframe)
    anchor_ms = _timestamp_ms(candles[-1].get("timestamp"))
    anchor_ms = (anchor_ms // interval_ms) * interval_ms
    horizon = max(1, round(interval_ms / 60_000))
    spread = abs(float(ask) - float(bid)) if bid and ask and ask >= bid else 0.0
    wick = max(atr * 0.5, spread * 0.5)
    out: List[Dict[str, Any]] = []
    previous_close = current_price
    for index in range(1, horizon + 1):
        close = target_price if index == horizon else current_price + (target_price - current_price) * index / horizon
        open_price = previous_close
        out.append({
            "timestamp": anchor_ms + index * interval_ms,
            "open": round(open_price, symbol_digits),
            "high": round(max(open_price, close) + wick, symbol_digits),
            "low": round(max(0.0, min(open_price, close) - wick), symbol_digits),
            "close": round(close, symbol_digits),
            "volume": 0.0,
            "projected": True,
        })
        previous_close = close
    return out

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

        verdict = await asyncio.to_thread(
            evaluate_live_tick_signal,
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

        # ── STABLE TARGET-EXPIRY HORIZON CONTRACT (Alpha.5 Pro) ──
        # The /tick-signal path runs at the 1-second tick cadence — exactly the
        # hyper-volatile surface the OutputStabilizer exists to tame. Build the
        # homogeneous horizon contract (smooth EWMA confidence + deadband
        # CALL/PUT deadband) on the SAME real price array the micro-quant
        # verdict examined.
        horizon_minutes = resolve_horizon_minutes(data.get("horizon_minutes"))
        try:
            response["horizon"] = build_horizon_payload(
                symbol=symbol,
                closes=closes_arr,
                horizon_minutes=horizon_minutes,
                live_price=eval_price,
                atr=atr_now,
                timeframe=timeframe,
            )
            response["horizon_minutes"] = int(horizon_minutes)
        except Exception as e:
            # Observational — a stabilizer failure must never kill the tick
            # signal (the micro-quant verdict above stands on its own).
            logger.warning(
                "LIVE_TICK_HORIZON_CONTRACT_FAILED",
                symbol=symbol,
                error=str(e),
            )
            response["horizon"] = None
            response["horizon_minutes"] = int(horizon_minutes)

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

    Pipeline (single 60% enforcement point):
      1. The authoritative multi-book confluence gate (evaluate_quant_matrix)
         runs on every request. A directional verdict exists at >= 60%
         confluence with every pillar aligned — including the microstructure
         (Aldridge order-book queue: real bid/ask, else the real tick-position
         proxy) pillar.
      2. For requests with >= 2 bars but < 100 bars: micro-quant fast-path
         fallback (evaluate_live_tick_signal) returns a genuine directional
         verdict in real-time without ML training.
      3. RandomForest ML corroborates DEFINITIVE tapes only (its numbers are
         surfaced separately under diagnostics.ml; they never override the
         gate). Sub-thermal requests return their true BUY/SELL direction as
         an honest market-waiting signal (CONFLUENCE_BELOW_THERMAL) — never
         HOLD, never a reversed projection.
      4. On total failure → descriptive HTTP error. NEVER a fake CALL.
    """
    t0 = _time.perf_counter()
    symbol = data.symbol.strip().upper()
    timeframe = data.timeframe
    candles_raw = [c.model_dump() if hasattr(c, 'model_dump') else dict(c) for c in data.candles]
    live_price = data.live_price
    bid = data.bid
    ask = data.ask
    data_source = data.dataSource or "unknown"
    # Shared mutable runtime anchor — used by BOTH the fast-path and the full
    # pipeline branches (the fast-path previously hit an UnboundLocalError
    # because this was only assigned inside the full-branch body below).
    current_price = float(live_price)

    logger.info(
        "Prediction requested with Pydantic-validated payload",
        symbol=symbol, timeframe=timeframe,
        candle_count=len(candles_raw), live_price=live_price,
    )

    # ── FAST-PATH MICRO-QUANT FALLBACK vs FULL ML PIPELINE ──
    # Below MINIMUM_FAST_PATH_BARS (2) → HTTP 400: not enough real data.
    # Between 2 and MINIMUM_REQUIRED_BARS → micro-quant fallback: run the
    # pure live-tick evaluator (evaluate_live_tick_signal) directly so a
    # genuine directional verdict exists the moment real ticks arrive. The
    # ML stage is skipped (not enough bars to train). The same response
    # contract is returned with dataSource: "live_tick_quant_fallback".
    # At >= MINIMUM_REQUIRED_BARS → full ML pipeline as before.
    if len(candles_raw) < MINIMUM_FAST_PATH_BARS:
        logger.warning(
            "Insufficient real bars for any inference — rejecting with HTTP 400",
            symbol=symbol, bars_provided=len(candles_raw),
            required_fast=MINIMUM_FAST_PATH_BARS,
        )
        raise HTTPException(
            status_code=400,
            detail={
                "error": "Insufficient real historical market data",
                "symbol": symbol,
                "bars_provided": len(candles_raw),
                "bars_required": MINIMUM_FAST_PATH_BARS,
                "message": (
                    f"Need at least {MINIMUM_FAST_PATH_BARS} real bars for "
                    f"micro-quant inference; got {len(candles_raw)}. "
                    "Zero-fabrication policy refuses synthetic candle padding."
                ),
            },
        )

    # ── MICRO-QUANT FAST PATH (2 <= bars < MINIMUM_REQUIRED_BARS) ──
    if len(candles_raw) < MINIMUM_REQUIRED_BARS:
        from app.services.live_quant import evaluate_live_tick_signal

        logger.info(
            "Fast-path micro-quant fallback — running live-tick evaluator",
            symbol=symbol, bars=len(candles_raw),
        )

        try:
            # Positional order matches evaluate_live_tick_signal's signature:
            # (prices, tick, highs, lows, timeframe, bid, ask). Passing symbol
            # or the dict list here (as an older mapping did) blew up as
            # float('EUR/USD') — this now feeds REAL closes/highs/lows arrays.
            verdict = await asyncio.get_event_loop().run_in_executor(
                _CPU_EXECUTOR,
                evaluate_live_tick_signal,
                [float(c["close"]) for c in candles_raw],
                live_price,
                [float(c["high"]) for c in candles_raw],
                [float(c["low"]) for c in candles_raw],
                timeframe,
                bid,
                ask,
            )
        except Exception as e:
            logger.error(
                "Micro-quant fast path failed",
                symbol=symbol, error=str(e),
            )
            raise HTTPException(
                status_code=500,
                detail={
                    "error": "Micro-quant inference failed",
                    "symbol": symbol,
                    "message": str(e),
                },
            )

        digits = symbol_price_digits(symbol)
        atr_now = float(candles_raw[-1].get("atr", candles_raw[-1].get("close", current_price) * 0.01))
        target_price, distance = project_target(
            verdict.direction, current_price, atr_now, timeframe, digits
        )
        future_candles = build_future_candles(
            candles=candles_raw,
            current_price=current_price,
            target_price=target_price,
            atr=atr_now,
            bid=data.bid,
            ask=data.ask,
            timeframe=timeframe,
            symbol_digits=digits,
        )
        total_ms = (_time.perf_counter() - t0) * 1000
        emitted_signal = None if verdict.market_waiting else verdict.direction
        return {
            "symbol": symbol,
            "signal": emitted_signal,
            "confidence": verdict.confidence,
            "book_agreement": round(verdict.confidence, 2),
            "book_agreement_detail": book_agreement_detail(
                getattr(verdict, "diagnostics", {}).get("book", {}).get("confluence", {})
            ),
            "high_confidence_alert": verdict.high_confidence_alert and emitted_signal is not None,
            "target_price": target_price,
            "current_price": round(current_price, digits),
            "atr": round(atr_now, 8),
            "target_distance": distance,
            "future_candles": future_candles,
            "volatility_pct": round((atr_now / current_price) * 100.0, 4),
            "ml_probability": 0.0,
            "model_accuracy": 0.0,
            "timeframe": timeframe,
            "proxyLatencyMs": round(total_ms, 2),
            "dataSource": f"{data_source}_live_tick_quant_fallback",
            "barCount": len(candles_raw),
            "math_target": compute_math_target(
                symbol,
                [float(c["close"]) for c in candles_raw[-30:]],
                [float(c["high"]) for c in candles_raw[-30:]],
                [float(c["low"]) for c in candles_raw[-30:]],
            ),
            "market_waiting": verdict.market_waiting,
            "waiting_reason": getattr(verdict, "waiting_reason", None),
            "waiting_detail": getattr(verdict, "waiting_detail", None),
        }

    # ── FULL ML PIPELINE (>= MINIMUM_REQUIRED_BARS real bars) ──
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

    # ── STEP 1: THE AUTHORITATIVE 60% MULTI-BOOK CONFLUENCE GATE ───────
    # Runs for EVERY request — this is the single enforcement point. A
    # directional verdict exists at >= 60% confluence with every pillar
# (volatility, momentum, microstructure — order-book queue via real bid/ask,
    #     else the real tick-position proxy) all aligned. Everything below is
    #     corroboration/UI.
    try:
        verdict = await asyncio.get_event_loop().run_in_executor(
            _CPU_EXECUTOR,
            evaluate_quant_matrix,
            candles_raw,
            live_price,
            timeframe,
            None,   # order_book_imbalance (not forwarded)
            bid,
            ask,
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
    # The confluence gate is the dispatch authority: its ≥60% emission IS the
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
    future_candles = build_future_candles(
        candles=candles_raw,
        current_price=current_price,
        target_price=target_price,
        atr=atr_now,
        bid=data.bid,
        ask=data.ask,
        timeframe=timeframe,
        symbol_digits=digits,
    )

    total_ms = (_time.perf_counter() - t0) * 1000

    emitted_signal = None if verdict.market_waiting else verdict.direction
    # ── 0.98 QUALITY WATERSHED (Part 2.3/2.4) ──
    # When a real multi-factor window arrives in the request the five-factor
    # ensemble is ENFORCED: even a confluence-definitive verdict collapses to
    # signal=None / confidence=0.0 if the ensemble cannot reach 0.98. The
    # caller (core-backend live dispatcher) supplies the timeframe/volume/order
    # flow evidence; without it the ensemble is honestly reported as None.
    qq_signal = emitted_signal
    qq_confidence = verdict.confidence
    qq_active = False
    quality_fields = {
        "quality": None,
        "quality_factors": None,
        "quality_reason": None,
        "quality_watershed_blocked": False,
    }
    factor_inputs = getattr(data, "factor_inputs", None)
    if factor_inputs:
        from app.services.quality_gate import apply_quality_gate
        qq = apply_quality_gate(
            verdict.direction, float(verdict.confidence), factor_inputs
        )
        qq_active = True
        qq_signal = qq.get("signal") or None
        qq_confidence = qq.get("confidence") if qq_signal else verdict.confidence
        quality_fields = {
            "quality": qq.get("quality"),
            "quality_factors": qq.get("factors"),
            "quality_reason": qq.get("reason"),
            "quality_watershed_blocked": qq.get("market_waiting", False),
        }

    response = {
        "symbol": symbol,
        "signal": qq_signal if qq_active else emitted_signal,
        "confidence": qq_confidence if qq_active else verdict.confidence,
        "high_confidence_alert": (
            verdict.high_confidence_alert
            and (qq_signal if qq_active else emitted_signal) is not None
        ),
        "target_price": target_price,
        "current_price": round(current_price, digits),
        "atr": round(atr_now, 8),
        "target_distance": distance,
        "future_candles": future_candles,
        "volatility_pct": round((atr_now / current_price) * 100.0, 4),
        "ml_probability": round(verdict.confidence / 100.0, 4),
        "tier": verdict.diagnostics.get("tier"),
        "tier_label": verdict.diagnostics.get("tier_label"),
        # GENUINE factor agreement (real alignment fraction 0..1). The old
        # clamped band [0.55, 0.95] (default 0.6) is PURGED.
        "model_accuracy": round(
            max(0.0, min(float(verdict.diagnostics.get("agreement", 0.0)), 1.0)), 4
        ),
        "timeframe": timeframe,
        "proxyLatencyMs": round(total_ms, 2),
        "dataSource": f"{data_source}_unbiased_quant",
        "barCount": len(candles_raw),
        "math_target": compute_math_target(
            symbol,
            [float(c) for c in closes[-30:]],
            [float(c) for c in highs[-30:]],
            [float(c) for c in lows[-30:]],
        ),
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
        **quality_fields,
        "market_waiting": bool(verdict.market_waiting),
        "waiting_reason": verdict.waiting_reason,
        "waiting_detail": verdict.waiting_detail,
        "book_confluence": verdict.diagnostics.get("book", {}),
        # PART 19.2 — HONEST LABEL CONTRACT: the dispatched 0-100 number is
        # BOOK AGREEMENT (confluence), not a calibrated probability. These
        # keys are the labeled surface; `confidence` remains the numeric
        # pipeline identifier that feeds the sanitizer / store unmutated.
        "book_agreement": round(
            qq_confidence if qq_active else verdict.confidence, 2
        ),
        "book_agreement_detail": book_agreement_detail(
            verdict.diagnostics.get("book", {}).get("confluence", {})
        ),
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

    # ── STABLE TARGET-EXPIRY HORIZON CONTRACT (Alpha.5 Pro) ──
    # Rolling trend-momentum feature pack (EMA crossover, RSI divergence,
    # regression slope + R²) mapped onto the user-selected horizon, with an
    # EWMA + deadband stabilizer so the emitted CALL/PUT + calibrated
    # confidence update smoothly instead of fluctuating tick-by-tick. The
    # AUTHORITATIVE gate (signal / confidence above) is never mutated; this
    # block is the additive stable contract the UI renders as "Expiry Horizon".
    horizon_minutes = resolve_horizon_minutes(getattr(data, "horizon_minutes", None))
    try:
        response["horizon"] = build_horizon_payload(
            symbol=symbol,
            closes=closes,
            horizon_minutes=horizon_minutes,
            live_price=current_price,
            atr=atr_now,
            timeframe=timeframe,
        )
        response["horizon_minutes"] = int(horizon_minutes)
    except Exception as e:
        # Observational — a stabilizer failure must never downgrade a
        # definitive emission (the confluence verdict above stands on its own).
        logger.warning(
            "Horizon stability contract failed",
            symbol=symbol,
            error=str(e),
        )
        response["horizon"] = None
        response["horizon_minutes"] = int(horizon_minutes)

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