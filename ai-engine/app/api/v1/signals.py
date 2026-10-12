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
from datetime import UTC, datetime
from urllib.parse import quote
import httpx
import numpy as np
import pandas as pd
import structlog
import asyncio
import os
import time as _time

from app.services.signal_generator import SignalGenerator, generate_unbiased_prediction
import app.services.ml_predictor as ml_predictor
from app.services.ml_predictor import (
    predict_with_rf,
    _CPU_EXECUTOR,
    run_inference,
    InferenceAdmissionTimeout,
    InferenceBudgetExceeded,
)
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
from app.services.signal_lock import (
    build_identity as build_lock_identity,
    locked_projection_fields,
    resolve_expiration_seconds,
    signal_lock,
)
from app.core.config import settings
from app.services.regime_detector import classify_regime, MIN_CLOSES as REGIME_MIN_CLOSES
from app.services.signal_gatekeeper import (
    REGIME_GATE_TRADABLE,
    REGIME_GATE_SCORED_ONLY,
    REGIME_GATE_BYPASS_CLOSES,
    REGIME_STATUS_PENDING_HIGH_PRECISION,
    SUPPRESSED_REASON_REGIME,
    SUPPRESSED_REASON_AWAITING_DIRECTION,
    SUPPRESSED_TIER,
    TIER_LABELS,
)
def _is_truthy_flag(value: Any) -> bool:
    """Strictly decide whether a flag field means "yes, released".

    The coherence clamp below MUST NOT use ``value is True``. In this module
    ``executable`` reaches the response dict from numpy/pandas computations, so
    it is frequently a ``numpy.bool_``. Python identity checks do NOT hold
    across those types::

        numpy.bool_(False) is False   ->  False   # clamp silently SKIPPED
        numpy.bool_(True)  is True    ->  False   # clamp would fire wrongly

    That identity bug let a "T1 / PREMIUM" tier ship next to
    ``executable=false`` on the direct-FastAPI path while the Node proxy path
    (which coerces to a real bool at its own boundary) showed the corrected
    T5 / WEAK. Same engine, two different verdicts for the same call.

    This helper normalises across the representations the flag can take
    (bool, numpy bool, 0/1, "true"/"false" strings, None) and FAILS CLOSED:
    anything that is not unambiguously truthy counts as "not released", so a
    missing or malformed value can never advertise an actionable tier.
    """
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    try:
        return bool(value)
    except Exception:  # pragma: no cover - defensive
        return False
from .schemas import PredictRequest

from app.services.execution_gate import build_execution_surface

logger = structlog.get_logger(__name__)

router = APIRouter()
signal_gen = SignalGenerator(confidence_threshold=settings.CONFIDENCE_THRESHOLD)

# ════════════════════════════════════════════════════════════════════
# STRICT OTC WHITELIST — 100% REAL · 0 DEMO · FULL 44-PAIR UNIVERSE
# Mirrors core-backend symbolRegistry.service.ts EXACTLY (44 real assets).
# PART 28.3 — the 10 real wholesale pairs (EUR/CZK, USD/SEK …) are part of
# that canonical 44, so they MUST be accepted here too: the card grid and
# the PRO expiry bar read regime_gate / suppressed_reason from /predict
# responses, and the audit universe_regime_audit.py audits them on real
# Yahoo intraday bars. Rejecting them at this boundary is what kept real
# pro terminals locked with no gateway verdict at all.
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
    # PART 28.3 — the 10 REAL NON-OTC wholesale pairs (assetSubType "forex",
    # Yahoo intraday tape, ECB reference baseline). Mirrors
    # REAL_FOREX_PAIRS in app/data/collector.py.
    "EUR/SEK", "EUR/NOK", "EUR/DKK", "EUR/PLN", "EUR/CZK", "EUR/HUF",
    "USD/SEK", "USD/NOK", "USD/PLN", "USD/CZK",
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


def _surface_regime_gate(closes: List[float]) -> Dict[str, Any]:
    """Regime gate for a /predict response (PART 28.2 [215]).

    The terminal card grid (prediction.data.regime_gate) and the PRO expiry
    bar (suppressed_reason === "regime_scored_only") both decide real-forex
    interactivity from these exact fields. The gate uses the SAME Hurst/ADF
    window the audits and the OTC live pipeline use (classify_regime, >= 100
    real closes): trending / mean_reverting windows come back "tradable";
    random_walk comes back "scored_only". A tape too short for a defensible
    verdict stays honestly null → the client renders "regime review pending"
    rather than inventing one.

    LIVE-TEST [2026-09-23] GLOBAL FORCE OVERRIDE was removed from this gate: it
    returned tradable / active / executable / CONFIRMED for EVERY instrument,
    any tape length or classification, so it could only ever fabricate
    tradability. On a system whose contract is "never fabricate" there is no
    environment in which that switch is legitimate, so the bypass is gone
    rather than defaulted off. tests/test_no_force_emit_escape.py pins the
    invariant that this gate has no override.
    """
    series = [float(x) for x in closes if np.isfinite(x)]
    regime = None
    if len(series) >= REGIME_MIN_CLOSES:
        regime = classify_regime(series).regime
    if len(series) < REGIME_MIN_CLOSES:
        return {"regime": None, "regime_gate": None, "suppressed_reason": None}
    result = classify_regime(series)
    if result.regime == "random_walk":
        if len(series) >= REGIME_GATE_BYPASS_CLOSES:
            return {
                "regime": result.regime,
                "regime_gate": REGIME_GATE_TRADABLE,
                "suppressed_reason": None,
            }
        return {
            "regime": result.regime,
            "regime_gate": REGIME_GATE_SCORED_ONLY,
            "suppressed_reason": SUPPRESSED_REASON_REGIME,
        }
    return {
        "regime": result.regime,
        "regime_gate": REGIME_GATE_TRADABLE,
        "suppressed_reason": None,
    }


def _strict_execution_surface(
    *,
    symbol: str,
    closes: List[float],
    direction: Optional[str],
    confidence_pct: Any,
    bid: Optional[float],
    ask: Optional[float],
    current_price: Optional[float],
    timeframe: str,
    min_confidence: Optional[float] = None,
    min_tier: Optional[str] = None,
    allow_real_quote_proxy: Optional[bool] = None,
) -> Dict[str, Any]:
    """STRICT HIGH-PRECISION EXECUTION SURFACE (PRINCIPAL QUALITY UPGRADE).

    Merged into every /predict response. Owns the executable /
    regime_gate / regime_status / suppressed_reason contract driven by the
    strict 96.5% bar (or a user-supplied ``min_confidence`` override, floored
    at T4) + the per-asset-class filter (OTC HF / REAL liquidity), while
    ``regime`` stays the honest Hurst/ADF label from
    :func:`_surface_regime_gate`. Fail-soft: a wrapper failure is logged and
    returns {} — the response keeps its legacy regime-gate fields.

    REAL resilience: ``allow_real_quote_proxy`` defaults to the environment
    toggle AI_ENGINE_REAL_QUOTE_PROXY (default "1" = ENABLED) — a REAL pair
    without L2 bid/ask arms falls back to the approved "Spread/ATR + flow +
    MTF proxies" validator (with the dynamic per-class floor,
    bar_source="real_proxy_floor") instead of being permanently blocked as
    "NO ACTIONABLE SIGNAL". Set AI_ENGINE_REAL_QUOTE_PROXY=0 to force the
    strict no_bid_ask_quotes veto everywhere.
    """
    if allow_real_quote_proxy is None:
        allow_real_quote_proxy = os.getenv("AI_ENGINE_REAL_QUOTE_PROXY", "1") != "0"
    try:
        surface = build_execution_surface(
            symbol=symbol,
            closes=closes,
            direction=direction,
            confidence_pct=confidence_pct,
            bid=bid,
            ask=ask,
            live_price=current_price,
            timeframe=timeframe,
            min_confidence=min_confidence,
            min_tier=min_tier,
            allow_real_quote_proxy=bool(allow_real_quote_proxy),
        )
        # Payload-owned keys: /predict already stamps `signal` and `confidence`
        # from the authoritative verdict (confidence is 0..100 per the response
        # schema). The surface only *reads* them for its verdict — never
        # overwrites — so they are dropped from the merge.
        surface.pop("signal", None)
        surface.pop("confidence", None)
        return surface
    except Exception as e:
        logger.error(
            "STRICT_EXECUTION_SURFACE_FAILED",
            symbol=symbol,
            error=str(e),
        )
        return {}


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


def _timestamp_ms(value: object) -> Optional[int]:
    """Coerce a candle timestamp to epoch-ms, or None when it is unusable.

    NEVER RAISES. ``CandleModel.timestamp`` is Optional, so a caller may
    legitimately send a tape whose newest bar carries no anchor. The
    projection bars are an OPTIONAL add-on to an otherwise valid prediction;
    letting a missing anchor escape as a ValueError crashed the whole
    /predict request and surfaced as an opaque HTTP 500, which the frontend
    could not distinguish from a real engine outage. Callers degrade to an
    empty projection instead, and the signal/target/verdict still return.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        raw = float(value)
        # Reject NaN/inf and negative epochs without importing math.
        if raw != raw or raw in (float("inf"), float("-inf")) or raw < 0:
            return None
        return int(raw * 1000 if raw < 1_000_000_000_000 else raw)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            # Tolerate a bare epoch delivered as a string ("1790640000000").
            try:
                raw = float(text)
            except ValueError:
                return None
            if raw != raw or raw in (float("inf"), float("-inf")) or raw < 0:
                return None
            return int(raw * 1000 if raw < 1_000_000_000_000 else raw)
        return int(parsed.timestamp() * 1000)
    return None


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
    if anchor_ms is None:
        # No usable anchor on the newest bar → emit NO projection bars rather
        # than failing the request. The prediction itself stays valid and
        # dispatchable; only the optional forward-projection is omitted.
        logger.info(
            "FUTURE_CANDLES_SKIPPED_NO_ANCHOR",
            timeframe=timeframe,
            bars=len(candles),
        )
        return []
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
        # NOTE (PART 22.1): ml_probability / model_accuracy were REMOVED from
        # this sanitizer — they are now Optional RF aliases (null until the
        # corroborator runs) and must NEVER be force-zeroed here; the rf_*
        # nulls survive via the non-finite guard below.
        "confidence", "target_price", "target_distance", "current_price",
        "atr", "volatility_pct",
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

    # PART 22.1 — rf_* are Optional floats: keep null null, but guard against
    # any non-finite value arriving here (the sources already clamp to [0,1]).
    for rf_key in ("rf_probability", "rf_holdout_accuracy"):
        rf_val = response.get(rf_key)
        if rf_val is not None and not np.isfinite(float(rf_val)):
            response[rf_key] = None

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

    # ══ EXECUTABLE ⇄ SIGNAL STATE RECONCILIATION ══════════════════════
    # `executable` is produced by apply_strict_execution_gate (class filter +
    # the executable bar), while `signal` and `market_waiting` are produced by
    # the confluence gate + the horizon lock. They are evaluated from DIFFERENT
    # inputs, so they could disagree: the class gate passes and the 96.5% bar is
    # cleared, yet the confluence gate still holds the verdict market-waiting
    # and emits no direction. That shipped the illegal state
    # `executable: true` beside `signal: null`.
    #
    # Executability is the AND of every gate. A verdict that emits no direction
    # — or that is still market-waiting — is SCORED-ONLY by definition and must
    # never advertise executable=true, because a dispatcher that trusts
    # `executable` would act on a null direction. This reconciles only the
    # `executable` FLAG; it never rewrites `tier` and never nulls a real
    # direction, so a low-tier signal stays visible as scored-only.
    _emitted = response.get("signal")
    _directional = (
        isinstance(_emitted, str)
        and _emitted.strip().upper() in ("BUY", "SELL", "CALL", "PUT")
    )
    _still_waiting = bool(response.get("market_waiting", False))
    if _is_truthy_flag(response.get("executable", False)) and (
        not _directional or _still_waiting
    ):
        response["executable"] = False
        response["regime_gate"] = REGIME_GATE_SCORED_ONLY
        response["regime_status"] = REGIME_STATUS_PENDING_HIGH_PRECISION
        response["suppressed_reason"] = (
            response.get("waiting_reason")
            or response.get("suppressed_reason")
            or SUPPRESSED_REASON_AWAITING_DIRECTION
        )

    # ══ HONEST TIER + DISPATCHABLE / SCORED-ONLY SURFACE ═════════════════
    # Applied HERE, at the single function every `return` in this module
    # funnels through, rather than inline in a handler.
    #
    # Why it lives here: `predict_signal` has MULTIPLE return points (a
    # served-from-lock early return as well as the final one), and
    # `_lock_or_commit_projection` / the execution-surface merge can re-derive
    # `executable` after any inline step has run. Sanitisation is the last thing
    # every response passes through, so this is the only placement that cannot
    # be skipped.
    #
    # `tier` is resolved from the genuine confluence score ALONE
    # (resolve_tier(99.32) -> "T1"/"PREMIUM") and used to be OVERWRITTEN with
    # T5 whenever the gate withheld the call. That clamp was added to stop the
    # terminal rendering "T1 PREMIUM 99.32%" next to "SIGNAL: WAITING" — a real
    # contradiction — but it fixed the symptom by destroying data: a genuine T2
    # became T5, and because the tier is also the client's filter key, a
    # user-driven tier filter could never see or select the real band.
    #
    # FLEXIBLE-TIER ARCHITECTURE (2026-09-30): `tier` is the honest strength
    # label and is NEVER rewritten. Tradability is expressed by the orthogonal
    # `executable` / `scored_only` / `dispatchable` triple, so a UI can say
    # "T2 HIGH — scored only" honestly instead of mutating the label into a lie
    # about the maths. The original contradiction is still prevented: nothing
    # may claim executable without a real direction (see the reconciliation
    # above), and `scored_only` is set for exactly that non-actionable case.
    _exec = _is_truthy_flag(response.get("executable", False))
    _sig = response.get("signal")
    _has_dir = (
        isinstance(_sig, str) and _sig.strip().upper() in ("BUY", "SELL", "CALL", "PUT")
    )
    response["dispatchable"] = bool(_has_dir)
    response["scored_only"] = bool(_has_dir and not _exec)

    # If the response somehow still advertises a tier it never earned (e.g. a
    # handler that set it while emitting no direction), correct it to the honest
    # band derived from the real confidence rather than to a blanket T5.
    if not _has_dir and response.get("tier") not in (None, SUPPRESSED_TIER):
        response.setdefault("diagnostics", {})["tier_without_direction"] = {
            "reported_tier": response.get("tier"),
            "reason": "no directional signal was emitted for this verdict",
        }

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

        # ── AUTHORITATIVE EXPIRY LOCK (checked BEFORE any computation) ──
        # If a verdict is already committed for (symbol, class, horizon,
        # expiry), the engine returns THAT contract and skips the recompute
        # entirely. Checking first is what makes this a real lock: at a 1 Hz
        # cadence it also stops the inference budget being spent on a verdict
        # that would be discarded. The live price still updates below, so the
        # chart keeps moving under a frozen direction/target.
        horizon_minutes = resolve_horizon_minutes(data.get("horizon_minutes"))
        lock_identity = build_lock_identity(
            symbol=symbol,
            horizon_minutes=horizon_minutes,
            expiration_seconds=resolve_expiration_seconds(horizon_minutes),
        )
        held = await signal_lock.get(lock_identity)
        if held:
            # Reuse the already-validated array work we would do anyway for the
            # live price, then serve the locked contract.
            closes_arr = np.asarray(
                [float(x) for x in (prices if prices is not None else [c["close"] for c in candles])],
                dtype=np.float64,
            )
            locked_price = (
                float(tick)
                if tick is not None and np.isfinite(tick) and tick > 0
                else float(closes_arr[-1])
            )
            locked_response = {
                **held,
                # Live, never locked: the market keeps moving under the contract.
                "symbol": symbol,
                "timeframe": timeframe,
                "current_price": round(locked_price, symbol_price_digits(symbol)),
                "barCount": len(closes_arr),
                "proxyLatencyMs": 0.0,
                "signal_locked": True,
                "locked_at_ms": held.get("locked_at_ms"),
                "locked_expires_at_ms": held.get("expires_at_ms"),
            }
            # The lock payload only carries the VERDICT, so serving it bare left
            # every policy field absent (tier/status/executable/threshold_pct/
            # bar_source/asset_class/regime) and the client contract was simply
            # incomplete on every lock hit. Re-run the gate against the LOCKED
            # numbers instead of the discarded live inference, so the served
            # response is both complete and internally consistent.
            _rederive_surface_from_lock(
                locked_response,
                symbol=symbol,
                closes=[float(x) for x in closes_arr],
                bid=data.get("bid"),
                ask=data.get("ask"),
                current_price=locked_price,
                timeframe=timeframe,
                min_confidence=data.get("min_confidence"),
                min_tier=data.get("min_tier"),
            )
            logger.info(
                "TICK_SIGNAL_LOCK_SERVED",
                symbol=symbol,
                direction=held.get("signal"),
                confidence=held.get("confidence"),
                horizon_minutes=horizon_minutes,
                tier=locked_response.get("tier"),
                status=locked_response.get("status"),
            )
            return _validate_response_finite(locked_response)

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

        # ── ROUTED MARKET-STRATEGY EXECUTION SURFACE ──
        # /tick-signal used to bypass build_execution_surface entirely, so a
        # live tick produced an executable-looking signal that had never been
        # through the per-market-type strategy gate. The 1s cadence is exactly
        # where that matters most. Same wrapper as /predict: fail-soft, and
        # the surface never overwrites the tick's own signal/confidence.
        response.update(
            _strict_execution_surface(
                symbol=symbol,
                # Plain list, not the numpy view: the surface contract is
                # List[float] and the sanitizers truth-test the input.
                closes=[float(x) for x in closes_arr],
                direction=response["signal"],
                # LiveQuantVerdict.confidence is ALREADY 0..100 (documented
                # "genuine continuous [0, 100] strength"). Do NOT rescale here:
                # a *100 would hand the strict gate ~9932% and make every live
                # tick trivially executable, silently bypassing the 96.5% bar.
                confidence_pct=float(response["confidence"]),
                bid=data.get("bid"),
                ask=data.get("ask"),
                current_price=eval_price,
                timeframe=timeframe,
                min_confidence=data.get("min_confidence"),
                min_tier=data.get("min_tier"),
            )
        )
        # ── STABLE TARGET-EXPIRY HORIZON CONTRACT (Alpha.5 Pro) ──
        # The /tick-signal path runs at the 1-second tick cadence — exactly the
        # hyper-volatile surface the OutputStabilizer exists to tame. Build the
        # homogeneous horizon contract (smooth EWMA confidence + deadband
        # CALL/PUT deadband) on the SAME real price array the micro-quant
        # verdict examined. `horizon_minutes` was already resolved above for
        # the lock identity, so it is reused here.
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

        # ── COMMIT THE CONTRACT FOR THE SELECTED EXPIRY ──
        # Only the projection fields are committed. current_price / atr /
        # barCount / horizon stay OUT of the lock so the served lock response
        # can keep reporting live values. This is the write half of the
        # authoritative lock: the next tick for this identity is served from
        # here instead of being recomputed.
        await signal_lock.acquire(
            lock_identity,
            {
                **locked_projection_fields(response),
                "timeframe": timeframe,
                "horizon_minutes": int(horizon_minutes),
            },
        )
        # FLEXIBLE-TIER (2026-09-30): the old inline "coherence clamp" here
        # rewrote `tier` to T5 whenever executable was false, destroying the
        # honest band so a client tier-filter could never select it. Tradability
        # is now carried by `executable`/`scored_only` (set centrally in
        # _validate_response_finite, which this response flows through below), and
        # `tier` keeps the true confidence band for every computed tier. The
        # executable/signal reconciliation invariant is unchanged.
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


async def _lock_or_commit_projection(
    response: Dict[str, Any],
    *,
    symbol: str,
    horizon_minutes: int,
    source: str,
    closes: Optional[List[float]] = None,
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    current_price: Optional[float] = None,
    timeframe: Optional[str] = None,
    min_confidence: Optional[float] = None,
    min_tier: Optional[str] = None,
) -> Dict[str, Any]:
    """Serve-or-commit the expiry contract for one /predict response.

    Both /predict return points (the micro-quant FAST PATH and the full
    analysis) go through here, because a fast-path response is a real verdict
    the client renders — skipping the lock there let the low-data regime the
    client hits on first load repaint the contract the tick path was holding.

    /predict does NOT skip its analysis the way /tick-signal does: it is not a
    1 Hz path, and its richness (confluence, ML/RF, horizon pack) is why it
    exists. Instead the LOCKED PROJECTION FIELDS are overlaid on the live
    analysis, so the thing the operator acts on is stable while every
    diagnostic keeps updating.

    Tier/status are then RE-DERIVED from the locked confidence, because they
    are policy output rather than verdict: the response was gated against the
    FRESH inference above, so overwriting only the projection would leave a
    response whose ``confidence`` says 91% while its ``tier`` still reflects the
    discarded 100% (or vice versa). Re-running the gate against the locked
    numbers under the CURRENT request's threshold is what makes raising the
    confidence floor correctly demote a held contract instead of silently
    no-op'ing it. Fail-soft: a re-derivation error leaves the surface as-is.
    """
    lock_identity = build_lock_identity(
        symbol=symbol,
        horizon_minutes=horizon_minutes,
        expiration_seconds=resolve_expiration_seconds(horizon_minutes),
    )
    held = await signal_lock.get(lock_identity)
    if held:
        response.update(locked_projection_fields(held))
        response["signal_locked"] = True
        response["locked_at_ms"] = held.get("locked_at_ms")
        response["locked_expires_at_ms"] = held.get("expires_at_ms")
        _rederive_surface_from_lock(
            response,
            symbol=symbol,
            closes=closes,
            bid=bid,
            ask=ask,
            current_price=current_price,
            timeframe=timeframe,
            min_confidence=min_confidence,
            min_tier=min_tier,
        )
        logger.info(
            f"{source}_LOCK_SERVED",
            symbol=symbol,
            direction=held.get("signal"),
            confidence=held.get("confidence"),
            horizon_minutes=horizon_minutes,
            tier=response.get("tier"),
            status=response.get("status"),
        )
        return response

    await signal_lock.acquire(
        lock_identity,
        {
            **locked_projection_fields(response),
            "horizon_minutes": int(horizon_minutes),
        },
    )
    return response


#: The execution-surface fields that are POLICY OUTPUT, not verdict.
#:
#: A re-derivation must overwrite ONLY these. The surface also carries
#: ``signal`` and a FRACTIONAL ``confidence`` (0..1, per the gate's contract)
#: alongside ``confidence_pct`` (0..100) which is what the /predict and
#: /tick-signal responses expose. Blindly merging the whole surface back into
#: the response therefore rescaled a locked 98.4% verdict to 0.984 and
#: clobbered the frozen direction - i.e. it defeated the lock from the inside.
_LOCK_POLICY_FIELDS = (
    "executable",
    "regime_gate",
    "regime_status",
    "suppressed_reason",
    "status",
    "tier",
    "tier_label",
    "threshold_pct",
    "bar_source",
    "max_executable_tier",
    "class_gate",
    "metrics",
    "sanitization",
    "audit",
)


def _rederive_surface_from_lock(
    response: Dict[str, Any],
    *,
    symbol: str,
    closes: Optional[List[float]],
    bid: Optional[float],
    ask: Optional[float],
    current_price: Optional[float],
    timeframe: Optional[str],
    min_confidence: Optional[float],
    min_tier: Optional[str] = None,
) -> None:
    """Re-run the strict execution gate against the LOCKED verdict.

    Mutates ``response`` in place with the freshly classified POLICY fields, so
    the contract's tier/status/executable flag stay consistent with the
    confidence actually being reported and with the caller's CURRENT confidence
    floor. The verdict itself (``signal``/``confidence``/``target_*``) is never
    touched - see :data:`_LOCK_POLICY_FIELDS`.
    """
    if not closes:
        return
    try:
        surface = build_execution_surface(
            symbol=symbol,
            closes=closes,
            direction=response.get("signal"),
            confidence_pct=response.get("confidence"),
            bid=bid,
            ask=ask,
            live_price=current_price,
            timeframe=timeframe,
            min_confidence=min_confidence,
            min_tier=min_tier,
        )
    except Exception as e:  # noqa: BLE001 - fail-soft, never break a locked read
        logger.warning("LOCKED_SURFACE_REDERIVE_FAILED", symbol=symbol, error=str(e))
        return
    for field in _LOCK_POLICY_FIELDS:
        if field in surface:
            response[field] = surface[field]


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
            #
            # run_inference (not raw run_in_executor) so this structural step
            # runs on the INFERENCE pool with a bounded admission wait: an RF
            # training burst can no longer queue it for minutes.
            verdict = await run_inference(
                evaluate_live_tick_signal,
                [float(c["close"]) for c in candles_raw],
                live_price,
                [float(c["high"]) for c in candles_raw],
                [float(c["low"]) for c in candles_raw],
                timeframe,
                bid,
                ask,
            )
        except InferenceAdmissionTimeout as e:
            logger.error(
                "Micro-quant fast path starved",
                symbol=symbol, budget_s=e.budget_s,
            )
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "Inference capacity exhausted",
                    "symbol": symbol,
                    "message": (
                        "The inference pool could not admit this request "
                        f"within {e.budget_s:.1f}s. Refused rather than queued "
                        "behind background model training — retry shortly."
                    ),
                    "inference_fallback": "executor_saturated",
                },
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
        # ══ FLEXIBLE-TIER EMISSION (2026-09-30) ═══════════════════════
        # `verdict.market_waiting` used to null the direction outright, so a
        # T2/T3/T4 verdict the maths had genuinely produced never reached the
        # client — the engine had decided for the trader which bands are worth
        # seeing. The direction is now emitted whenever the confluence maths
        # actually produced one; tradability is decided by the user's `min_tier`
        # floor in the execution surface, not by nulling the signal here.
        #
        # Honesty is preserved by construction: a verdict with NO real direction
        # still ships `signal: null` + `market_waiting: true`, and the
        # reconciliation in _validate_response_finite forces `executable=false`
        # whenever no direction exists. A low-tier signal is reported honestly
        # ("T3 MEDIUM, scored only") rather than made invisible.
        _honest_direction = verdict.direction if verdict.direction in ("BUY", "SELL") else None
        # Sub-tier hold: a direction exists but the confluence gate did not
        # release it. Expressed as scored-only metadata, never as a null signal.
        _below_floor = bool(verdict.market_waiting) and _honest_direction is not None
        emitted_signal = _honest_direction
        market_waiting = bool(verdict.market_waiting) and not _below_floor
        fast_path_response = {
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
            # PART 22.1 — fast path never trains the RF: honest nulls + flag.
            "rf_probability": None,
            "rf_holdout_accuracy": None,
            "corroborator_unavailable": True,
            "ml_probability": None,
            "model_accuracy": None,
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
        "market_waiting": market_waiting,
        "waiting_reason": getattr(verdict, "waiting_reason", None) if market_waiting else None,
        "waiting_detail": getattr(verdict, "waiting_detail", None) if market_waiting else None,
            "regime": _surface_regime_gate([float(c["close"]) for c in candles_raw]).get("regime"),
            **_strict_execution_surface(
                symbol=symbol,
                closes=[float(c["close"]) for c in candles_raw],
                # The AUTHORITATIVE direction, never the market-waiting-nulled
                # `emitted_signal`: a null made build_execution_surface
                # short-circuit at execution_gate.py:115 into
                # class_gate.reason="no_directional_signal", which overwrote the
                # real CONFLUENCE_BELOW_THERMAL blocker in suppressed_reason and
                # diagnostics.tier_suppressed.reason and skipped the
                # per-market-type class gate entirely. Matches /tick-signal.
                direction=verdict.direction,
                confidence_pct=verdict.confidence,
                bid=bid,
                ask=ask,
                current_price=current_price,
                timeframe=timeframe,
                min_confidence=getattr(data, "min_confidence", None),
                min_tier=getattr(data, "min_tier", None),
            ),
        }
        # The fast path is a real verdict the client renders, so it participates
        # in the same expiry contract as the full path.
        return _validate_response_finite(
            await _lock_or_commit_projection(
                fast_path_response,
                symbol=symbol,
                horizon_minutes=resolve_horizon_minutes(
                    getattr(data, "horizon_minutes", None)
                ),
                source="PREDICT_FASTPATH",
                closes=[float(c["close"]) for c in candles_raw],
                bid=bid,
                ask=ask,
                current_price=current_price,
                timeframe=timeframe,
                min_confidence=getattr(data, "min_confidence", None),
            )
        )

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
        verdict = await run_inference(
            evaluate_quant_matrix,
            candles_raw,
            live_price,
            timeframe,
            None,   # order_book_imbalance (not forwarded)
            bid,
            ask,
        )
    except InferenceAdmissionTimeout as e:
        logger.error(
            "Quant matrix starved",
            symbol=symbol, budget_s=e.budget_s,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "error": "Inference capacity exhausted",
                "symbol": symbol,
                "message": (
                    "The inference pool could not admit this request within "
                    f"{e.budget_s:.1f}s. Refused rather than queued behind "
                    "background model training — retry shortly."
                ),
                "inference_fallback": "executor_saturated",
            },
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
    inference_fallback = None
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
        except InferenceBudgetExceeded as ibe:
            # ── NON-BLOCKING INFERENCE BUDGET (P1-2026-09-24) ──
            # The heavy RandomForest corroboration could not finish within the
            # interactive 150ms window. The authoritative confluence verdict was
            # ALREADY resolved — ship that fast structural payload (real data,
            # no fabricated signal) and let the background train warm the cache.
            # The UI terminal therefore always receives a verdict inside its 2s
            # AbortController budget instead of freezing on the ML spinner.
            logger.info(
                "Inference budget exceeded — shipping structural verdict, RF warming in background",
                symbol=symbol, budget_ms=ibe.budget_ms, elapsed_ms=round(ibe.elapsed_ms, 2),
            )
            ml_extras = None
            inference_fallback = "ml_budget_exceeded"
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

    # ══ FLEXIBLE-TIER EMISSION (2026-09-30) ═══════════════════════════
    # See the identical block on the fast path. A direction the maths actually
    # produced is emitted for EVERY tier; only a genuinely directionless
    # verdict ships `signal: null` + `market_waiting: true`. Tradability is
    # decided by the user's `min_tier` floor via the execution surface, not by
    # nulling the signal here.
    _honest_direction = verdict.direction if verdict.direction in ("BUY", "SELL") else None
    _below_floor = bool(verdict.market_waiting) and _honest_direction is not None
    emitted_signal = _honest_direction
    market_waiting = bool(verdict.market_waiting) and not _below_floor
    # ── 0.98 QUALITY WATERSHED (Part 2.3/2.4) ──
    # When a real multi-factor window arrives in the request the five-factor
    # ensemble is ENFORCED: even a confluence-definitive verdict is held back
    # from being tradable/alarmed if the ensemble cannot reach 0.98. The caller
    # (core-backend live dispatcher) supplies the timeframe/volume/order-flow
    # evidence; without it the ensemble is honestly reported as None.
    qq_signal = emitted_signal
    qq_confidence = verdict.confidence
    qq_active = False
    # Did the five-factor ensemble RELEASE the direction? The watershed is a
    # confidence hold, not a directionless verdict: it must gate tradability
    # and the high-confidence alert, but it must NOT erase a direction the
    # confluence maths actually produced. Nulling `signal` here would report a
    # genuine T2/T3/T4 call as directionless, which is the very suppression
    # this contract removed.
    _qq_released = True
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
        _qq_released = qq_signal is not None
        quality_fields = {
            "quality": qq.get("quality"),
            "quality_factors": qq.get("factors"),
            "quality_reason": qq.get("reason"),
            "quality_watershed_blocked": qq.get("market_waiting", False),
        }

    response = {
        "symbol": symbol,
        # HONEST DIRECTION — emitted for every tier. A watershed hold leaves it
        # intact and is reported as `executable: false` + `scored_only: true`
        # via the execution surface below.
        "signal": emitted_signal,
        "confidence": qq_confidence if qq_active else verdict.confidence,
        "high_confidence_alert": (
            verdict.high_confidence_alert
            and emitted_signal is not None
            and _qq_released
        ),
        "target_price": target_price,
        "current_price": round(current_price, digits),
        "atr": round(atr_now, 8),
        "target_distance": distance,
        "future_candles": future_candles,
        "volatility_pct": round((atr_now / current_price) * 100.0, 4),
        # PART 22.1 [150] — RF CORROBORATION SPLIT SCHEMA. The old
        # `ml_probability = confidence/100` and `model_accuracy = agreement`
        # fallbacks silently renamed confluence numbers under RF-labeled keys
        # (the silent swap PART 22 found). That dual meaning is REMOVED:
        # rf_probability / rf_holdout_accuracy are null unless the RandomForest
        # actually ran for this tape, and the legacy ml_probability /
        # model_accuracy keys are NEVER populated with confluence-derived
        # values (null here; set to the real RF numbers in the merge block
        # when the corroborator runs).
        "rf_probability": None,
        "rf_holdout_accuracy": None,
        "corroborator_unavailable": True,
        "ml_probability": None,
        "model_accuracy": None,
        "tier": verdict.diagnostics.get("tier"),
        "tier_label": verdict.diagnostics.get("tier_label"),
        "timeframe": timeframe,
        "proxyLatencyMs": round(total_ms, 2),
        # P1-2026-09-24 — non-blocking inference surface: null when the RF
        # corroborator ran; "ml_budget_exceeded" when a cold-cache train could
        # not finish within the interactive InferenceBudget and the response was
        # shipped as the fast structural verdict (RF numbers absent this round,
        # warming in the background — concatenate the next call ships them).
        "inference_fallback": inference_fallback,
        "inference_budget_ms": (
            ml_predictor.INFERENCE_BUDGET_MS
            if ml_predictor.INFERENCE_BUDGET_MS > 0 else None
        ),
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
        "market_waiting": market_waiting,
        "waiting_reason": verdict.waiting_reason if market_waiting else None,
        "waiting_detail": verdict.waiting_detail if market_waiting else None,
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
        "timestamp": datetime.now(UTC).isoformat(),
        "regime": _surface_regime_gate(closes).get("regime"),
        **_strict_execution_surface(
            symbol=symbol,
            closes=closes,
            direction=(qq_signal if qq_active else verdict.direction),
            confidence_pct=(qq_confidence if qq_active else verdict.confidence),
            bid=bid,
            ask=ask,
            current_price=current_price,
            timeframe=timeframe,
            min_confidence=getattr(data, "min_confidence", None),
            min_tier=getattr(data, "min_tier", None),
        ),
    }

    # NOTE: the honest-tier / dispatchable / scored_only surface is applied
    # centrally in `_validate_response_finite` (the function this handler's
    # return flows through), NOT here — both this block and the projection lock
    # can still re-derive `executable` after any inline step, so an inline one
    # would observe a truthy flag and be silently discarded.

    # Merge the ML corroboration numbers (kept separate from the authoritative
    # confluence confidence so the honesty law — confidence == confluence — is
    # never violated for the emitted signal).
    if ml_extras is not None:
        # PART 22.1 — RF corroborator RAN on this definitive tape: surface its
        # real numbers under the split rf_* names and flip the flag. Legacy
        # ml_probability / model_accuracy are kept only as EXACT aliases of
        # those RF numbers — never confluence-derived.
        if ml_extras.get("ml_probability") is not None:
            response["ml_probability"] = ml_extras["ml_probability"]
            response["rf_probability"] = ml_extras["ml_probability"]
        if ml_extras.get("model_accuracy") is not None:
            response["model_accuracy"] = ml_extras["model_accuracy"]
            response["rf_holdout_accuracy"] = ml_extras["model_accuracy"]
        response["corroborator_unavailable"] = False
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

    # ── EXPIRY LOCK: serve-or-commit ──
    # Same lock the /tick-signal seam uses, so the two paths can never disagree
    # about what the contract is. Without this, a REST /predict landing between
    # two ticks could repaint a verdict the tick path is holding.
    response = await _lock_or_commit_projection(
        response,
        symbol=symbol,
        horizon_minutes=horizon_minutes,
        source="PREDICT",
        closes=closes,
        bid=bid,
        ask=ask,
        current_price=current_price,
        timeframe=timeframe,
        min_confidence=getattr(data, "min_confidence", None),
        min_tier=getattr(data, "min_tier", None),
    )

    # Logged AFTER the lock so it reports what was actually RETURNED, not the
    # pre-lock candidate. `signal_locked` distinguishes a served contract from a
    # freshly committed one.
    logger.info(
        "Unbiased quant prediction dispatched",
        symbol=symbol,
        signal=response["signal"],
        confidence=response["confidence"],
        high_confidence_alert=response["high_confidence_alert"],
        direction_score=verdict.direction_score,
        confluence_gate=verdict.diagnostics.get("book", {}).get("confluence", {}).get("gate"),
        timeframe=timeframe,
        signal_locked=bool(response.get("signal_locked")),
        elapsed_ms=round(total_ms, 2),
    )

    # ── COHERENCE CLAMP: tier must never outrank what the gate released ──
    # `tier` is resolved from the raw confluence score ALONE
    # (resolve_tier(99.32) -> "T1"/"PREMIUM") and is NOT demoted when the risk
    # gate WITHHELD the actionable call. The engine therefore shipped a
    # "T1 PREMIUM" badge alongside executable=False / signal=None — the exact
    # contradiction the terminal rendered as "T1 PREMIUM 99.32%" next to
    # "SIGNAL: WAITING" (see SIGNAL_EVALUATION_AUDIT: confidence_pct=99.32
    # tier=T1 executable=False).
    #
    # PLACEMENT IS LOAD-BEARING: this must run AFTER
    # `_lock_or_commit_projection` (above) and AFTER the surface merge, because
    # both can re-derive `executable` / `tier` from a served contract. A clamp
    # placed earlier observes a still-truthy flag, never executes, and is
    # silently discarded — which is precisely how the direct-FastAPI path kept
    # returning T1/PREMIUM while the Node proxy path showed T5/WEAK.
    #
    # This is an HONESTY fix, not padding: a verdict the gate did not release is
    # SCORED-ONLY, so the exposed tier is demoted to the canonical suppressed
    # tier. The raw confluence is preserved in `confidence` /
    # `book_agreement` / diagnostics for audit — nothing is hidden or inflated,
    # we only stop advertising a PREMIUM (actionable-looking) tier for a call
    # the engine itself marked non-actionable.
    if not _is_truthy_flag(response.get("executable", False)):
        raw_tier = response.get("tier")
        if raw_tier is not None and raw_tier != SUPPRESSED_TIER:
            response["tier"] = SUPPRESSED_TIER
            response["tier_label"] = TIER_LABELS.get(SUPPRESSED_TIER, "WEAK")
            response.setdefault("diagnostics", {})["tier_suppressed"] = {
                "raw_tier_from_score": raw_tier,
                "reason": response.get("suppressed_reason")
                or response.get("waiting_reason")
                or "gate_withheld",
            }

    return _validate_response_finite(response)