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

import numpy as np
import pandas as pd
import structlog
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .technical_analysis import TechnicalAnalysisService
from .quant_matrix import evaluate_quant_matrix, QuantVerdict
from .book_instruments import evaluate_book_confluence
from .quality_gate import apply_quality_gate, build_factor_inputs_from_candles
from .regime_detector import classify_regime, MIN_CLOSES
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
    factors: Dict[str, float] = field(default_factory=dict)
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
        except Exception:  # noqa: BLE001 — book tier is additive, never fatal
            book_gate = "INSUFFICIENT"
            book_score = 0.0
        diagnostics.setdefault("book_confluence", {})
        diagnostics["book_confluence"].setdefault("gate", book_gate)
        diagnostics["book_confluence"].setdefault("score", round(book_score, 4))

        # ── Stage 4: QUALITY — five-factor ensemble watershed ──
        quality = None
        quality_reason = None
        quality_field: Dict[str, Any] = {}
        if factor_inputs:
            qq = apply_quality_gate(direction, confidence, factor_inputs)
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
        if len(closes) >= MIN_CLOSES:
            try:
                regime_result = classify_regime(closes.tolist())
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
            factors=dict(verdict_factors or {}),
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
        """Serialize a report to the shared API payload contract."""
        return {
            "symbol": report.symbol,
            "direction": report.direction,
            "confidence": round(report.confidence, 4),
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
            "factors": report.factors,
            "diagnostics": report.diagnostics,
            "timestamp": report.timestamp,
        }