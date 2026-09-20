"""
financial_analysis.py — UNIFIED REAL-TIME FINANCIAL ANALYSIS PIPELINE

Single entry-point that folds the AI engine's analysis tiers into one
deterministic report. Every value is REAL observed data — there is no RNG,
no synthetic anchor and no "demo" fallback anywhere in this pipeline.

Pipeline stages (each stage contributes its genuine verdict):

  1. TECHNICAL  — TechnicalAnalysisService ADX(14)/ATR(14) + market regime
                  (TRENDING vs SIDEWAYS/CHOP). Context, never a direction vote.
  2. QUANT      — evaluate_quant_matrix: 12-factor micro-momentum confluence,
                  ZERO-TIE policy — ALWAYS resolves BUY/SELL, never HOLD.
  3. BOOKS      — evaluate_book_confluence: 10-book multiplicative confluence
                  gate (Bollinger / Turtle / Murphy / Nison / Chan / Carter /
                  Aronson / Aldridge / Faith).
  4. QUALITY    — apply_quality_gate: five-factor ensemble watershed at the
                  T4 bar (QUALITY_EMIT_BAR = 0.70) when a real multi-factor
                  window is supplied; otherwise honestly reported as None.
  5. TIER       — resolve_tier from signal_gatekeeper (T1 PREMIUM … T5 WEAK);
                  a verdict is executable only when it clears the dispatched
                  minimum tier (default T4 = 0.70).
   6. REGIME     — PART 14 [46]: a bias-corrected Hurst classification of the
                  real close tape (>= MIN_CLOSES = 100 candles). A RANDOM_WALK
                  symbol is demoted to scored-only (tier T5, never executable)
                  even at T1 confidence, stamped
                  `suppressed_reason="regime_scored_only"`. Fewer than 100
                  closes, or regime classification failure, means the regime
                  gate is NOT asserted (``regime_gate`` stays None) — the
                  existing multi-tier gate keeps its authority.

Direction is ALWAYS kept when a real verdict is resolved — a sub-tier result
is flagged ``market_waiting`` with the honest tier reached, never coerced to
HOLD and never procedurally fabricated into an executable signal.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import structlog
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .technical_analysis import TechnicalAnalysisService
from .quant_matrix import evaluate_quant_matrix, QuantVerdict
from .book_instruments import (
    book_agreement_detail,
    evaluate_book_confluence,
    microstructure_queue,
)
from .quality_gate import (
    apply_quality_gate,
    build_factor_inputs_from_candles,
    _rsi as _quality_rsi,
)
from .math_engine import ewma_volatility, garch11_forecast
from .regime_detector import classify_regime, MIN_CLOSES
from ..knowledge.book_chan import half_life_ou
from .signal_gatekeeper import (
    TIER_LABELS,
    MIN_EXECUTABLE_TIER,
    REGIME_GATE_TRADABLE,
    REGIME_GATE_SCORED_ONLY,
    SUPPRESSED_REASON_REGIME,
    SUPPRESSED_TIER,
    is_dispatchable_tier,
    resolve_tier,
    tier_min_confidence,
)

logger = structlog.get_logger(__name__)

VALID_DIRECTIONS = ("BUY", "SELL")

# ═══════════════════════════════════════════════════════════════════════════
# PART 19 [107] — NAMED 50-CANDLE ROLLING FEATURE WINDOW
# A fixed, documented trailing window whose REAL sub-model inputs (ATR(14),
# RSI(14), EWMA/GARCH(1,1) volatility, OU half-life, microstructure queue)
# are computed over the window and fed into the existing regime-gated
# ensemble factor surface. This is a FEATURE-INPUT window only — it never
# relaxes the regime classification gate (classify_regime still runs on the
# full >= MIN_CLOSES historical tape in Stage 6).
# ═══════════════════════════════════════════════════════════════════════════
ROLLING_WINDOW = 50

# RiskMetrics GARCH(1,1) parametrization: alpha = 1 − lambda, beta = lambda,
# omega = 0 — the same EWMA model family horizon_engine relies on.
_GARCH_ALPHA = 0.06
_GARCH_BETA = 0.93


def compute_rolling_window_features(
    closes: List[float],
    opens: Optional[List[float]] = None,
    highs: Optional[List[float]] = None,
    lows: Optional[List[float]] = None,
    volumes: Optional[List[float]] = None,
    *,
    live_price: Optional[float] = None,
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    window: int = ROLLING_WINDOW,
) -> Dict[str, Any]:
    """Compute REAL sub-model inputs over the trailing `window` candles.

    Every feature is derived strictly from the supplied candle history — no
    fabricated values. Non-finite or unavailable inputs are reported as None
    together with the count of real candidates, never invented.

    Returns:
      - window_len / candles_total       transparency
      - atr14                            Wilder ATR(14) on the window
      - rsi14                            Wilder RSI(14) via quality-gate helper
      - ewma_volatility                  RiskMetrics EWMA vol (lambda=0.94)
      - garch11_forecast_vol             1-step GARCH(1,1) RiskMetrics vol
      - garch11_persistence              alpha+beta of the parametrization
      - ou_half_life                     OU mean-reversion half-life (Chan)
      - microstructure_queue             PART 3 queue position (real quotes)
      - volume_surge                     last bar vs prior-20 mean (None flat)
    """
    closes_clean = [float(c) for c in closes if math.isfinite(float(c))]
    win = min(window, len(closes_clean))
    if win < 2:
        return {"window_len": 0, "candles_total": len(closes_clean)}
    w_closes = closes_clean[-win:]

    def _finite(v):
        if v is None or not math.isfinite(float(v)):
            return None
        return round(float(v), 6)

    atr14 = None
    try:
        w_opens = [float(o) for o in (opens or closes)][-win:]
        w_highs = [float(h) for h in (highs or closes)][-win:]
        w_lows = [float(l) for l in (lows or closes)][-win:]
        ta = TechnicalAnalysisService()
        enriched = ta.calculate_indicators(
            pd.DataFrame({"open": w_opens, "high": w_highs, "low": w_lows, "close": w_closes})
        )
        atr14 = _finite(float(enriched["atr"].iloc[-1]))
    except Exception:
        atr14 = None

    rsi14 = None
    try:
        rsi_series = _quality_rsi(w_closes, 14)
        if rsi_series and rsi_series[-1] is not None:
            rsi14 = _finite(rsi_series[-1])
    except Exception:
        rsi14 = None

    ewma_vol = None
    garch_forecast_vol = None
    garch_persistence = _GARCH_ALPHA + _GARCH_BETA
    try:
        returns = [
            w_closes[i] / w_closes[i - 1] - 1.0
            for i in range(1, len(w_closes))
            if w_closes[i - 1] > 0
        ]
        if len(returns) >= 2:
            ewma_raw = ewma_volatility(returns, lambda_=0.94)
            ewma_vol = _finite(ewma_raw)
            garch_forecast_vol = _finite(
                garch11_forecast(
                    omega=0.0,
                    alpha=_GARCH_ALPHA,
                    beta=_GARCH_BETA,
                    last_variance=ewma_raw * ewma_raw,
                    last_return=returns[-1],
                    horizon=1,
                )
            )
    except Exception:
        ewma_vol = None
        garch_forecast_vol = None

    ou_half_life = None
    try:
        hl = half_life_ou(w_closes)
        # Only a POSITIVE half-life is mean-reversion evidence. A non-positive
        # or infinite value means the window shows no reversion — reported as
        # None, never a fabricated number.
        if math.isfinite(float(hl)) and float(hl) > 0:
            ou_half_life = _finite(hl)
    except Exception:
        ou_half_life = None

    micro_queue = 0.0
    if live_price is not None and math.isfinite(float(live_price)):
        micro_queue = microstructure_queue(float(live_price), bid, ask)

    volume_surge = None
    if volumes:
        vols = [float(v) for v in volumes if math.isfinite(float(v))]
        if len(vols) >= 21:
            prior = vols[-21:-1]
            mean_prior = sum(prior) / len(prior)
            if mean_prior > 0:
                volume_surge = _finite(vols[-1] / mean_prior)

    return {
        "window_len": win,
        "candles_total": len(closes_clean),
        "atr14": atr14,
        "rsi14": rsi14,
        "ewma_volatility": ewma_vol,
        "garch11_forecast_vol": garch_forecast_vol,
        "garch11_persistence": _finite(garch_persistence),
        "ou_half_life": ou_half_life,
        "microstructure_queue": round(micro_queue, 6),
        "volume_surge": volume_surge,
    }


@dataclass
class FinancialAnalysisReport:
    """Complete unified analysis of a single symbol at a point in time."""

    symbol: str
    direction: str                      # "BUY" | "SELL" — ALWAYS directional
    confidence: float                   # genuine unclipped [0, 100+] strength
    tier: str                           # T1 … T5 (resolved from confidence)
    tier_label: str                     # PREMIUM / HIGH / MEDIUM / LOW / WEAK
    executable: bool                    # cleared the dispatched minimum tier
    market_waiting: bool = False        # below-bar: kept directional, not sent
    waiting_reason: Optional[str] = None
    waiting_detail: Optional[str] = None
    regime: str = "SIDEWAYS/CHOP"       # ADX-derived market regime
    adx: float = 0.0
    atr: float = 0.0
    book_score: float = 0.0             # multiplicative 10-book confluence 0-100
    book_gate: str = "INSUFFICIENT"     # gate label from the books compositor
    quality: Optional[float] = None     # five-factor ensemble 0..1 (None honest)
    quality_reason: Optional[str] = None
    quality_field: Dict[str, Any] = field(default_factory=dict)
    regime_gate: Optional[str] = None   # PART 14 [46] — "scored_only"|"tradable"|None
    suppressed_reason: Optional[str] = None  # "regime_scored_only" rides the payload
    regime_classification: Dict[str, Any] = field(default_factory=dict)  # PART 19 [108]
    factors: Dict[str, Any] = field(default_factory=dict)
    diagnostics: Dict[str, Any] = field(default_factory=dict)
    timestamp: str = ""


class FinancialAnalysisService:
    """Unified financial analysis — one call, all four engine tiers.

    Usage::

        report = FinancialAnalysisService().analyze(
            symbol="BTC/USD",
            candles=[{"open":…, "high":…, "low":…, "close":…}, …],
            live_price=…,
            timeframe="1h",
        )
    """

    def __init__(self) -> None:
        self.ta_service = TechnicalAnalysisService()
        self.min_tier = MIN_EXECUTABLE_TIER

    def analyze(
        self,
        symbol: str,
        candles: List[Dict[str, Any]],
        live_price: Optional[float] = None,
        timeframe: str = "1d",
        order_book_imbalance: Optional[float] = None,
        bid: Optional[float] = None,
        ask: Optional[float] = None,
        bid_depth: Optional[float] = None,
        ask_depth: Optional[float] = None,
        factor_inputs: Optional[Dict[str, Any]] = None,
        direction_sign: Optional[int] = 0,
        min_tier: str = MIN_EXECUTABLE_TIER,
        direction: Optional[str] = None,
        confidence: Optional[float] = None,
    ) -> FinancialAnalysisReport:
        """Run the whole pipeline on a real symbol and candle tape.

        ``direction``/``confidence`` may be passed in from a caller that has
        already resolved the quant verdict (e.g. ``signal_generator``) so the
        analysis is never run twice on the same tape. When both are None the
        quant matrix is run inside the pipeline.

        Raises:
            ValueError: on invalid/missing inputs — the pipeline never
                fabricates an executable report in place of an error.
        """
        if not symbol:
            raise ValueError("analyze requires a non-empty symbol")
        if not candles or len(candles) < 2:
            raise ValueError(
                f"analyze requires >= 2 real candles for {symbol}; "
                f"got {len(candles) if candles else 0}. Zero-fabrication "
                "policy refuses to emit a report without market data."
            )

        # ── Stage 1: TECHNICAL regime context (ADX/ATR) ──
        try:
            df = pd.DataFrame(candles)
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"Failed to convert candles for {symbol}: {e}")

        required_cols = {"open", "high", "low", "close"}
        missing = required_cols - set(df.columns)
        if missing:
            raise ValueError(
                f"Candle payload for {symbol} is missing OHLC columns: "
                f"{sorted(missing)}"
            )
        enriched = self.ta_service.calculate_indicators(df)
        last = enriched.iloc[-1]
        adx = float(last.get("adx", np.nan))
        atr = float(last.get("atr", np.nan))
        last_close = float(last.get("close", np.nan))
        if not (np.isfinite(adx) and np.isfinite(atr) and np.isfinite(last_close)):
            raise ValueError(
                f"Non-finite indicators computed for {symbol} "
                "(adx/atr/close). Refusing to emit a fabricated report."
            )
        regime = self.ta_service.get_market_regime(adx)

        # ── Stage 2: QUANT matrix — ALWAYS resolves BUY/SELL ──
        if direction is None or confidence is None:
            resolved: QuantVerdict = evaluate_quant_matrix(
                candles=candles,
                live_price=live_price,
                timeframe=timeframe,
                order_book_imbalance=order_book_imbalance,
                bid=bid,
                ask=ask,
            )
            resolved_direction = resolved.direction
            resolved_confidence = float(resolved.confidence)
            verdict_factors = dict(resolved.factors or {})
            verdict_diag = dict(resolved.diagnostics or {})
        else:
            resolved_direction = str(direction).upper()
            resolved_confidence = float(confidence)
            verdict_factors: Dict[str, float] = {}
            verdict_diag: Dict[str, Any] = {}
        direction = resolved_direction
        confidence = resolved_confidence
        diagnostics: Dict[str, Any] = dict(verdict_diag or {})
        market_waiting = bool(diagnostics.get("market_waiting", False))
        waiting_reason = diagnostics.get("waiting_reason")
        waiting_detail = diagnostics.get("waiting_detail")

        # ── Stage 3: BOOKS — 10-book multiplicative confluence ──
        closes = np.array([float(c["close"]) for c in candles], dtype=np.float64)
        opens = np.array(
            [float(c.get("open", c.get("close", 0.0)) or 0.0) for c in candles],
            dtype=np.float64,
        )
        highs = np.array([float(c["high"]) for c in candles], dtype=np.float64)
        lows = np.array([float(c["low"]) for c in candles], dtype=np.float64)
        volumes = np.array(
            [float(c.get("volume", 0.0) or 0.0) for c in candles], dtype=np.float64
        )

        # ── PART 19 [107] — rolling 50-candle feature window ──
        # Computed over the trailing ROLLING_WINDOW candles and fed into the
        # Stage 4 factor surface below. Pure feature input: it never alters the
        # candles handed to the books/quant stages or the regime gate.
        window_features = compute_rolling_window_features(
            closes.tolist(),
            opens=opens.tolist(),
            highs=highs.tolist(),
            lows=lows.tolist(),
            volumes=volumes.tolist(),
            live_price=live_price,
            bid=bid,
            ask=ask,
            window=ROLLING_WINDOW,
        )
        diagnostics["rolling_window"] = window_features
        _book_confluence_raw = {}
        try:
            book = evaluate_book_confluence(
                closes=closes,
                opens=opens,
                highs=highs,
                lows=lows,
                volumes=volumes if np.any(volumes != 0.0) else None,
                live_price=live_price,
                bid=bid,
                ask=ask,
                bid_depth=bid_depth,
                ask_depth=ask_depth,
                direction_sign=direction_sign,
            )
            book_gate = str((book.confluence or {}).get("gate", "INSUFFICIENT"))
            book_score = float((book.confluence or {}).get("score", 0.0))
            _book_confluence_raw = dict(book.confluence or {})
        except Exception:  # noqa: BLE001 — book tier is additive, never fatal
            book_gate = "INSUFFICIENT"
            book_score = 0.0
            _book_confluence_raw = {}
        diagnostics["book_confluence"] = {
            "gate": book_gate,
            "score": round(book_score, 4),
            # PART 19.2 [118] — the full confluence internals (convergence_index
            # / alignment / magnitude / aligned_count / active_count) used to
            # render the honest "n/n books aligned" label next to the score.
            # The QUANT-stage book detail is authoritative (it produced the
            # dispatched score); the Stage-3 re-evaluation above is only a
            # fallback for callers that supplied direction/confidence directly.
            "confluence": dict(
                (diagnostics.get("book") or {}).get("confluence", {})
                or _book_confluence_raw
            ),
        }

        # ── Stage 4: QUALITY — five-factor ensemble watershed ──
        quality = None
        quality_reason = None
        quality_field: Dict[str, Any] = {}
        if factor_inputs:
            # PART 19 [107] — the rolling-window features ride into the
            # five-factor ensemble's input surface (additive key; unknown keys
            # are ignored by compute_factor_scores, None path untouched).
            enriched_inputs = dict(factor_inputs)
            enriched_inputs["rolling_window"] = window_features
            qq = apply_quality_gate(direction, confidence, enriched_inputs)
            quality = qq.get("quality")
            quality_reason = qq.get("reason")
            quality_field = qq
            if qq.get("signal") is None:
                market_waiting = True
                waiting_reason = "QUALITY_BELOW_GATE"
                waiting_detail = (
                    f"NO SIGNAL — quality {quality:.4f} < watershed "
                    f"{qq.get('gate', 0.70):.4f} ({quality_reason})"
                )

        # ── Stage 5: TIER — honest multi-tier gate ──
        resolved_tier = resolve_tier(confidence)
        exec_bar = tier_min_confidence(min_tier) or tier_min_confidence(
            MIN_EXECUTABLE_TIER
        )
        executable = bool(
            direction in VALID_DIRECTIONS
            and is_dispatchable_tier(resolved_tier, min_tier)
            and not market_waiting
        )
        if not executable and market_waiting is False and waiting_reason is None:
            market_waiting = True
            waiting_reason = "LOW_CONFIDENCE"
            waiting_detail = (
                f"NO SIGNAL — confidence {confidence:.2f}% < "
                f"minimum tier bar {exec_bar * 100.0:.2f}% (T{resolved_tier})"
            )

        # ── Stage 6: REGIME — PART 14 [46] random_walk → scored-only ──
        # A bias-corrected Hurst classification of the real tape. RANDOM_WALK
        # symbols are NEVER tradable (demoted to T5 even at T1 confidence).
        # The gate is only asserted when >= MIN_CLOSES real closes make a
        # classification honest; shorter/failed windows leave regime_gate=None
        # so the existing multi-tier gate keeps full authority.
        regime_gate: Optional[str] = None
        suppressed_reason: Optional[str] = None
        # PART 19 [108] — the classification itself is surfaced (never relaxed)
        # so downstream consumers/tables can show the REAL regime evidence.
        regime_classification: Dict[str, Any] = {}
        if len(closes) >= MIN_CLOSES:
            try:
                regime_result = classify_regime(closes.tolist())
                regime_classification = {
                    "regime": regime_result.regime,
                    "hurst": regime_result.hurst,
                    "adf_pvalue": regime_result.adf_pvalue,
                    "confidence": regime_result.confidence,
                    "closes": int(len(closes)),
                    "window": ROLLING_WINDOW,
                }
                if regime_result.regime == "random_walk":
                    regime_gate = REGIME_GATE_SCORED_ONLY
                    suppressed_reason = SUPPRESSED_REASON_REGIME
                else:
                    regime_gate = REGIME_GATE_TRADABLE
            except Exception:  # noqa: BLE001 — never fails the pipeline
                regime_gate = None
                suppressed_reason = None
        if regime_gate == REGIME_GATE_SCORED_ONLY:
            resolved_tier = SUPPRESSED_TIER
            executable = False
            market_waiting = True
            waiting_reason = "REGIME_RANDOM_WALK"
            waiting_detail = (
                "SCORED-ONLY — random_walk regime gate: this symbol is never "
                "tradable regardless of confidence (PART 14 scored_only)"
            )
            logger.warning(
                "REGIME_SCORED_ONLY_DEMOTED",
                symbol=symbol,
                direction=direction,
                confidence=round(confidence, 2),
            )

        report = FinancialAnalysisReport(
            symbol=symbol,
            direction=direction,
            confidence=confidence,
            tier=resolved_tier,
            tier_label=TIER_LABELS.get(resolved_tier, "WEAK"),
            executable=executable and direction in VALID_DIRECTIONS,
            market_waiting=market_waiting,
            waiting_reason=waiting_reason,
            waiting_detail=waiting_detail,
            regime=regime,
            adx=adx,
            atr=atr,
            book_score=book_score,
            book_gate=book_gate,
            quality=quality,
            quality_reason=quality_reason,
            quality_field=quality_field,
            regime_gate=regime_gate,
            suppressed_reason=suppressed_reason,
            regime_classification=regime_classification,
            factors=dict(
                verdict_factors or {},
                rolling_window=window_features,
            ),
            diagnostics=diagnostics,
            timestamp=pd.Timestamp.utcnow().isoformat(),
        )
        logger.info(
            "FINANCIAL_ANALYSIS",
            symbol=symbol,
            direction=direction,
            confidence=round(confidence, 2),
            tier=resolved_tier,
            executable=report.executable,
            regime=regime,
        )
        return report

    def to_dict(self, report: FinancialAnalysisReport) -> Dict[str, Any]:
        """Serialize a report to the shared API payload contract.

        PART 19.2 [117] — the 0-100 number is honestly named BOOK AGREEMENT
        (a confluence score), never a calibrated probability. The internal
        numeric field on the report keeps the ``confidence`` identifier for
        pipeline compatibility; the exposed schema uses ``book_agreement``.
        """
        return {
            "symbol": report.symbol,
            "direction": report.direction,
            "book_agreement": round(report.confidence, 4),
            "book_agreement_detail": book_agreement_detail(
                (report.diagnostics or {})
                .get("book_confluence", {})
                .get("confluence", {})
            ),
            "tier": report.tier,
            "tier_label": report.tier_label,
            "executable": report.executable,
            "market_waiting": report.market_waiting,
            "waiting_reason": report.waiting_reason,
            "waiting_detail": report.waiting_detail,
            "regime": report.regime,
            "indicators": {"adx": round(report.adx, 5), "atr": round(report.atr, 8)},
            "book_confluence": {
                "gate": report.book_gate,
                "score": round(report.book_score, 4),
            },
            "quality": report.quality,
            "quality_reason": report.quality_reason,
            "regime_gate": report.regime_gate,
            "suppressed_reason": report.suppressed_reason,
            "regime_classification": report.regime_classification,
            "factors": report.factors,
            "diagnostics": report.diagnostics,
            "timestamp": report.timestamp,
        }