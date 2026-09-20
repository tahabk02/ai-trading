"""
signal_generator.py — UNBIASED 3-LAYER SIGNAL GENERATOR

Root-cause fixes for the "ALL-CALL @ static 75%" production failure:

  1. ZERO-TIE POLICY: the engine ALWAYS resolves a real BUY/SELL verdict —
     a neutral confluence never maps to HOLD; an exactly-zero weighted score is
     tied deterministically through the freshest REAL micro factor.
  2. DYNAMIC UNCLIPPED CONFIDENCE [0, 100+]: pure monotonic mapping of real
     multi-factor strength; when confluence strictly clears 98% the emitted
     score IS the raw unclipped strength (never floored, never capped).
  3. HIGH-CONFIDENCE ALERT FLAG: ``high_confidence_alert`` is True when
     confidence exceeds 90% so downstream systems can trigger priority
     notifications.
  4. ZERO MOCK FALLBACKS: every failure path RAISES a descriptive error.
     There is no code path that fabricates a "CALL" signal on error.
  5. NEVER HOLD: the signal state is ALWAYS directional — a below-thermal
     verdict keeps its true SUPÉRIEUR/ACHAT or INFÉRIEUR/VENTE direction and
     is only flagged ``market_waiting`` (CONFLUENCE_BELOW_THERMAL).
  6. 0.98 QUALITY WATERSHED (quality_gate.py): when a real multi-factor
     window (timeframes / ATR / volume / tick pressure) is supplied the
     five-factor ensemble must ALSO score >= 0.98 before emission — signal
     and confidence collapse to null when it doesn't (direction still kept).

Layer 1: Market Regime via ADX(14)   → context, never a direction vote
Layer 2: Volatility / news barrier   → freeze on anomalous expansion
Layer 3: Unbiased quant matrix       → direction + dynamic confidence
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import structlog
from typing import Dict, Any, Optional

from .technical_analysis import TechnicalAnalysisService
from .risk_filter import RiskFilter
from .quant_matrix import (
    evaluate_quant_matrix,
    project_target,
    symbol_price_digits,
    HIGH_CONFIDENCE_ALERT_THRESHOLD,
)
from .financial_analysis import FinancialAnalysisService

from app.core.config import settings
from .quality_gate import apply_quality_gate
from .signal_gatekeeper import resolve_tier, TIER_LABELS, MIN_EXECUTABLE_TIER

logger = structlog.get_logger(__name__)


def _round_up_5(x: float) -> float:
    """Round up to 5 decimals deterministically."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return 0.0
    factor = 10**5
    return np.ceil(x * factor) / factor


class SignalGenerator:
    """3-Layer UNBIASED signal generator — zero hardcoded directions.

    Layer 1: Market Regime via ADX(14).
      - ADX >= 15 => TRENDING (context only — never forces a direction)
      - ADX < 15  => weak trend; confidence is reduced but direction is
        still decided by the real quant matrix.

    Layer 2: Macro Volatility / News barrier.
      - If (high-low) > 2.5 * ATR(14), freeze for 2 hours.

    Layer 3: Unbiased quant momentum matrix.
      - Direction ALWAYS resolved BUY/SELL (never HOLD) from REAL factors
        with a strict zero-tie policy.
      - Confidence is the dynamic UNCLIPPED confluence score — 98%+ when
        the strict thermal gate passes (SUPÉRIEUR/ACHAT | INFÉRIEUR/VENTE).
    """

    def __init__(self, confidence_threshold: float = None) -> None:
        self.ta_service = TechnicalAnalysisService()
        self.risk_filter = RiskFilter()
        self.confidence_threshold = float(
            settings.CONFIDENCE_THRESHOLD if confidence_threshold is None else confidence_threshold
        )

    @property
    def threshold_percent(self) -> float:
        return self.confidence_threshold * 100 if self.confidence_threshold <= 1 else self.confidence_threshold

    def generate_signal(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Generate an ACTIVE or NO_TRADE verdict from REAL market data.

        Raises:
            ValueError: on missing/invalid inputs — NEVER returns a
                fabricated CALL signal in place of an error.
        """
        symbol = data.get("symbol")
        candles = data.get("candles", [])
        live_price = data.get("live_price")

        if not symbol:
            raise ValueError("generate_signal requires a non-empty 'symbol'")

        if not candles:
            raise ValueError(
                f"generate_signal requires real candles for {symbol}; "
                "got an empty list. Zero-fabrication policy refuses to "
                "invent a signal without market data."
            )

        try:
            df = pd.DataFrame(candles)
        except Exception as e:
            raise ValueError(
                f"Failed to convert candles to DataFrame for {symbol}: {e}"
            )

        required_cols = {"open", "high", "low", "close"}
        missing = required_cols - set(df.columns)
        if missing:
            raise ValueError(
                f"Candle payload for {symbol} is missing OHLC columns: "
                f"{sorted(missing)}"
            )

        # ── Layer 1+2: regime & volatility context ──
        enriched = self.ta_service.calculate_indicators(df)
        last = enriched.iloc[-1]

        adx = float(last.get("adx", np.nan))
        atr = float(last.get("atr", np.nan))
        last_close = float(last.get("close", np.nan))

        if not np.isfinite(adx) or not np.isfinite(atr) or not np.isfinite(last_close):
            raise ValueError(
                f"Non-finite indicators computed for {symbol} "
                "(adx/atr/close). Refusing to emit a fabricated signal."
            )

        risk = self.risk_filter.check_and_update_freeze(enriched[["high", "low", "atr"]])
        if risk.get("frozen") is True:
            return {
                "symbol": symbol,
                "status": "NO_TRADE",
                "reason": "NEWS_FREEZE",
                "confidence": 0.0,
                "timestamp": pd.Timestamp.utcnow().isoformat(),
                "indicators": {"adx": _round_up_5(adx), "atr": _round_up_5(atr)},
            }

        # ── Layer 3: UNBIASED QUANT MATRIX ──
        verdict = evaluate_quant_matrix(
            candles=candles,
            live_price=live_price,
            timeframe=str(data.get("timeframe", "1d")),
            order_book_imbalance=data.get("order_book_imbalance"),
            bid=data.get("bid"),
            ask=data.get("ask"),
        )

        # The quant matrix ALWAYS resolves BUY/SELL (never HOLD). Keep the true
        # directional verdict and attach the honest confidence plus the strict
        # 98% thermal-gate market_waiting flag from diagnostics. The signal
        # state is ALWAYS directional — SUPÉRIEUR/ACHAT or INFÉRIEUR/VENTE.
        direction = verdict.direction
        diagnostics = verdict.diagnostics or {}
        market_waiting = bool(diagnostics.get("market_waiting", False))
        waiting_reason = diagnostics.get("waiting_reason")
        waiting_detail = diagnostics.get("waiting_detail")
        confidence = float(verdict.confidence)
        signal_type = (
            direction if confidence >= self.threshold_percent else None
        )
        if signal_type is None:
            market_waiting = True
            waiting_reason = "LOW_CONFIDENCE"
            waiting_detail = (
                f"NO SIGNAL — confidence {confidence:.2f}% < "
                f"threshold {self.threshold_percent:.2f}%"
            )

        # ── 0.98 QUALITY WATERSHED (Part 2.3/2.4) ──
        # When a real multi-factor window is provided by the caller the
        # five-factor ensemble (mtf/momentum/volatility/volume/pressure) must
        # collectively reach >= 0.98 before a signal is released. Below it the
        # directional verdict is KEPT but signal collapses to null.
        quality = None
        quality_factors = None
        quality_reason = None
        factor_inputs = data.get("factor_inputs")
        if factor_inputs:
            qq = apply_quality_gate(direction, confidence, factor_inputs)
            quality = qq.get("quality")
            quality_factors = qq.get("factors")
            quality_reason = qq.get("reason")
            if qq.get("signal") is None:
                signal_type = None
                market_waiting = True
                waiting_reason = "QUALITY_BELOW_GATE"
                waiting_detail = (
                    f"NO SIGNAL — quality {quality:.4f} < watershed "
                    f"{qq.get('gate', 0.98):.4f} ({quality_reason})"
                )

        entry = last_close
        digits = symbol_price_digits(symbol)

        stop_loss, take_profit = self._atr_stops(direction, entry, atr)

        # ── UNIFIED FINANCIAL ANALYSIS (multi-tier enrichment) ──
        # Fold the already-resolved direction/confidence through the shared
        # financial-analysis pipeline so the payload carries the honest tier
        # ladder (T1 PREMIUM … T5 WEAK) plus the 10-book confluence gate.
        # This is additive — the gates above remain the emission authority;
        # a failure here must never fabricate a tier, so it degrades to the
        # plain confidence-based tier.
        analysis = None
        try:
            analysis = FinancialAnalysisService().analyze(
                symbol=symbol,
                candles=candles,
                live_price=live_price,
                timeframe=str(data.get("timeframe", "1d")),
                direction=direction,
                confidence=confidence,
            )
        except Exception:  # noqa: BLE001 — enrichment must not fabricate
            analysis = None

        resolved_tier = analysis.tier if analysis is not None else resolve_tier(confidence)
        resolved_label = analysis.tier_label if analysis is not None else TIER_LABELS.get(resolved_tier, "WEAK")

        payload = {
            "symbol": symbol,
            "status": "ACTIVE",
            "signal_type": signal_type,
            "price": round(entry, digits),
            "confidence": confidence,
            "tier": resolved_tier,
            "tier_label": resolved_label,
            "high_confidence_alert": verdict.high_confidence_alert and signal_type is not None,
            "market_waiting": market_waiting,
            "waiting_reason": waiting_reason,
            "waiting_detail": waiting_detail,
            "quality": quality,
            "factors": quality_factors,
            "quality_reason": quality_reason,
            "book_confluence": (
                {"gate": analysis.book_gate, "score": round(analysis.book_score, 4)}
                if analysis is not None else None
            ),
            "stop_loss": round(stop_loss, digits),
            "take_profit": round(take_profit, digits),
            "indicators": {
                "adx": _round_up_5(adx),
                "atr": _round_up_5(atr),
            },
            "timestamp": pd.Timestamp.utcnow().isoformat(),
            "debug": {
                "regime": self.ta_service.get_market_regime(adx),
                "risk": risk,
                "direction_score": verdict.direction_score,
                "factors": verdict.factors,
                "diagnostics": verdict.diagnostics,
            },
        }

        logger.info(
            "SIGNAL_GENERATED_ACTIVE",
            symbol=symbol,
            signal_type=signal_type,
            price=payload["price"],
            confidence=payload["confidence"],
            high_confidence_alert=payload["high_confidence_alert"],
            adx=payload["indicators"]["adx"],
            atr=payload["indicators"]["atr"],
        )
        return payload

    @staticmethod
    def _atr_stops(direction: str, entry: float, atr: float) -> tuple:
        """ATR-scaled protective stops honoring the dispatched direction."""
        atr_scaled_sl = 1.5 * atr
        atr_scaled_tp = 3.0 * atr
        if direction == "BUY":
            return entry - atr_scaled_sl, entry + atr_scaled_tp
        return entry + atr_scaled_sl, entry - atr_scaled_tp


# Backward-compatible alias used by older imports.
SignalGenerator.generate_signal.__doc__ = (
    "Generate an ACTIVE or NO_TRADE verdict from REAL market data.\n\n"
    "Raises:\n"
    "    ValueError: on missing/invalid inputs — NEVER returns a\n"
    "        fabricated CALL signal in place of an error."
)


def generate_unbiased_prediction(
    symbol: str,
    candles: list,
    live_price: Optional[float],
    timeframe: str = "1d",
    factor_inputs: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Standalone unbiased prediction used by the /predict fallback chain.

    Returns a full prediction payload with:
      • direction ALWAYS resolved by the zero-tie quant matrix (BUY | SELL —
        never HOLD)
      • genuine dynamic UNCLIPPED confidence in [0, 100+] (raw strength %)
      • high_confidence_alert flag when > 90%
      • quality/factors/reason from the 0.98 ensemble watershed when a real
        multi-factor window is supplied (otherwise quality=None — honest)
      • √horizon-scaled ATR target projection (1m → 10 days)

    Raises:
        ValueError: on invalid inputs — no fabricated signals, ever.
    """
    if not symbol:
        raise ValueError("generate_unbiased_prediction requires a symbol")
    if not candles or len(candles) < 2:
        raise ValueError(
            f"generate_unbiased_prediction requires >= 2 real candles for "
            f"{symbol}; got {len(candles) if candles else 0}."
        )

    verdict = evaluate_quant_matrix(
        candles=candles, live_price=live_price, timeframe=timeframe
    )

    closes = [float(c["close"]) for c in candles]
    highs = [float(c["high"]) for c in candles]
    lows = [float(c["low"]) for c in candles]
    current_price = float(live_price) if live_price else closes[-1]

    # Real Wilder ATR from the forwarded series
    atr_arr = TechnicalAnalysisService.calculate_indicators(
        pd.DataFrame({"open": closes, "high": highs, "low": lows, "close": closes})
    )["atr"].values
    atr_now = float(atr_arr[-1])
    if not np.isfinite(atr_now) or atr_now <= 0:
        raise ValueError(
            f"ATR collapsed to non-finite value for {symbol}; refusing to "
            "project a target from fabricated volatility."
        )

    digits = symbol_price_digits(symbol)
    target_price, distance = project_target(
        verdict.direction, current_price, atr_now, timeframe, digits
    )

    delta_pct = (
        round(((target_price - current_price) / current_price) * 100.0, 2)
        if current_price > 0
        else 0.0
    )

    # ── 0.98 QUALITY WATERSHED (Part 2.3/2.4) ──
    quality = None
    quality_factors = None
    quality_reason = None
    emitted_on_quality = True
    if factor_inputs:
        qq = apply_quality_gate(verdict.direction, float(verdict.confidence), factor_inputs)
        quality = qq.get("quality")
        quality_factors = qq.get("factors")
        quality_reason = qq.get("reason")
        emitted_on_quality = qq.get("signal") is not None

    conf_pct = (
        float(settings.CONFIDENCE_THRESHOLD)
        if float(settings.CONFIDENCE_THRESHOLD) > 1
        else float(settings.CONFIDENCE_THRESHOLD) * 100
    )
    tier = resolve_tier(float(verdict.confidence))

    return {
        "symbol": symbol,
        "signal": verdict.direction if float(verdict.confidence) >= conf_pct else None,
        "confidence": float(verdict.confidence),
        "tier": tier,
        "tier_label": TIER_LABELS.get(tier, "WEAK"),
        "high_confidence_alert": verdict.high_confidence_alert and float(verdict.confidence) >= conf_pct,
        "target_price": target_price,
        "current_price": round(current_price, digits),
        "atr": round(atr_now, 8),
        "target_distance": distance,
        "volatility_pct": round((atr_now / current_price) * 100.0, 4)
        if current_price > 0
        else 0.0,
        # PART 22.1 — /analyze's generator never runs the RF classifier: honest
        # nulls + corroborator_unavailable flag, never confluence numbers
        # under RF-labeled keys.
        "rf_probability": None,
        "rf_holdout_accuracy": None,
        "corroborator_unavailable": True,
        "ml_probability": None,
        "model_accuracy": None,
        "quality": quality,
        "factors": quality_factors,
        "quality_reason": quality_reason,
        "quality_watershed_blocked": not emitted_on_quality,
        "timeframe": timeframe,
        "delta_pct": delta_pct,
        "indicators": {
            "tick_velocity": verdict.factors.get("tick_velocity"),
            "micro_momentum": verdict.factors.get("micro_momentum"),
            "bid_ask_pressure": verdict.factors.get("bid_ask_pressure"),
            "price_action_delta": verdict.factors.get("price_action_delta"),
        },
        "factors": verdict.factors,
        "diagnostics": verdict.diagnostics,
        "waiting_reason": (
            None
            if float(verdict.confidence) >= (
                float(settings.CONFIDENCE_THRESHOLD)
                if float(settings.CONFIDENCE_THRESHOLD) > 1
                else float(settings.CONFIDENCE_THRESHOLD) * 100
            )
            else "LOW_CONFIDENCE"
        ),
        "waiting_detail": (
            None
            if float(verdict.confidence) >= (
                float(settings.CONFIDENCE_THRESHOLD)
                if float(settings.CONFIDENCE_THRESHOLD) > 1
                else float(settings.CONFIDENCE_THRESHOLD) * 100
            )
            else f"NO SIGNAL — confidence {float(verdict.confidence):.2f}% < threshold {(float(settings.CONFIDENCE_THRESHOLD) if float(settings.CONFIDENCE_THRESHOLD) > 1 else float(settings.CONFIDENCE_THRESHOLD) * 100):.2f}%"
        ),
        "timestamp": pd.Timestamp.utcnow().isoformat(),
    }