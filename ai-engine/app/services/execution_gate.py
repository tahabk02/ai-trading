"""
execution_gate.py — UNIFIED STRICT EXECUTION SURFACE (PRINCIPAL QUALITY UPGRADE)

Single wrapper consumed by every /predict path (the "predictSignal /
signal_gatekeeper" upgrade). ``build_execution_surface`` orchestrates the full
multi-market stack:

  1. instrument classification → OTC (synthetic), REAL (institutional
     wholesale FX) or CRYPTO (24/7 majors);
  2. rolling-window sanitization (NaN/inf dropped; >=160 REAL closes / >=30
     optimized OTC ticks / >=60 crypto closes);
  3. regime classification for the audit trail (same Hurst/ADF window);
  4. the ROUTED per-market-type filter gate. Dispatch is delegated to
     ``market_strategies.resolve_strategy`` -- this module does NOT branch on
     market type to choose a filter, and every class implements the same
     ``MarketStrategy`` verdict contract:
        OTC    -> OtcMarketStrategy   (otc_hf_quality: HF price-action +
                  volatility clustering + synthetic mean-reversion boundaries)
        REAL   -> RealMarketStrategy  (real_liquidity_gate: spread-to-ATR
                  safety margin + order-flow imbalance + M1/M5/H1 alignment
                  resampled from the single forwarded tape)
        CRYPTO -> CryptoMarketStrategy (crypto_hf_quality: Donchian breakout +
                  momentum + crypto-sized volatility band + trend structure)
  5. apply_strict_execution_gate — the STRICT 96.5% executable bar: below it
     every asset defaults SCORED-ONLY (executable=False,
     regime_gate="pending_high_precision"),
  6. per-signal audit record (confluence score, regime type, spread status).

The FX quote-proxy relaxation (``allow_real_quote_proxy``) is opt-in per
strategy via ``MarketStrategy.accepts_quote_proxy`` and is True only for
``RealMarketStrategy``: the relaxation models institutional FX order-book
depth, so OTC and CRYPTO must never inherit it.

The returned dict is the additive execution surface merged into the /predict
response — it owns regime_gate / suppressed_reason / executable /
regime_status / status / tier (+ threshold_pct) / asset_class / class_gate and
never mutates the authoritative verdict.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .asset_class import resolve_asset_class
from .data_sanitization import sanitize_price_series, spread_metrics, sufficient_history
from .execution_audit import log_signal_evaluation
from .market_strategies import resolve_strategy
from .regime_detector import MIN_CLOSES as REGIME_MIN_CLOSES
from .regime_detector import classify_regime
from .signal_gatekeeper import REGIME_STATUS_CONFIRMED, apply_strict_execution_gate


def _regime_label(closes: List[float]) -> Optional[str]:
    """Honest Hurst/ADF regime classification when the window is deep enough."""
    if len(closes) >= REGIME_MIN_CLOSES:
        try:
            return classify_regime(closes).regime
        except Exception:
            return None
    return None


def build_execution_surface(
    *,
    symbol: Any,
    closes: List[Any],
    direction: Optional[str],
    confidence_pct: Any,
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    live_price: Optional[float] = None,
    timeframe: Optional[str] = None,
    min_confidence: Optional[float] = None,
    min_tier: Optional[str] = None,
    allow_real_quote_proxy: bool = False,
) -> Dict[str, Any]:
    """Full strict execution surface for one /predict evaluation (merged form).

    ``min_confidence`` (optional user-set 50.0..99.0% bar) and ``min_tier``
    (optional user-selected "T1".."T5" floor) are threaded to the strict
    execution gate, which floors the bar at T4 (70%) and overrides the engine's
    default 96.5% bar when either is provided. A valid ``min_tier`` wins over
    ``min_confidence``.

    NOTE: the floor governs ``executable`` only. The ``tier`` returned here is
    always the honest resolved band (T1..T5) for the real confluence, so a
    client-driven tier filter can select on it.

    ``allow_real_quote_proxy`` (default False) enables the approved
    quote-proxy fallback for REAL assets — when no L2 bid/ask arms exist the
    spread factor is validated against the realized ATR-relative margin
    (spread/ATR + flow + MTF candle proxies) instead of a hard
    ``no_bid_ask_quotes`` veto. The production /predict seam enables it; the
    default preserves the strict veto for direct callers.

    Always returns every key the client contract expects:
      executable, regime_gate, regime_status, suppressed_reason, status, tier,
      tier_label, threshold_pct, bar_source, max_executable_tier, asset_class,
      class_gate, metrics, sanitization, regime, audit.
    """
    asset_class = resolve_asset_class(symbol)
    # The ROUTER owns market-type dispatch. This module no longer branches on
    # asset class to pick a filter — adding a market type is a registry entry
    # in market_strategies/, not an edit to the gate.
    strategy = resolve_strategy(symbol)
    direction_upper = str(direction or "").upper()
    direction_norm = direction_upper if direction_upper in ("BUY", "SELL") else None

    cleaned = sanitize_price_series(closes)
    history = sufficient_history(cleaned["closes"], asset_class)
    regime_type = _regime_label(cleaned["closes"])
    price = live_price if live_price and float(live_price) > 0 else (
        cleaned["closes"][-1] if cleaned["closes"] else None
    )
    # The strategy decides whether the FX quote-proxy relaxation applies to it,
    # so the gate carries no market-type knowledge here.
    proxy_allowed = bool(allow_real_quote_proxy) and strategy.accepts_quote_proxy

    sp = spread_metrics(bid, ask, price)

    # ── per-asset-class filter gate (vetoes even a >= 96.5% confluence) ──
    if direction_norm is None:
        class_gate = {"passes": False, "reason": "no_directional_signal", "score": 0.0}
    elif not history["sufficient"]:
        # Dicey input → honest insufficient-history veto (auditable, visible).
        class_gate = {
            "passes": False,
            "reason": "insufficient_history",
            "score": 0.0,
            "metrics": {
                "cleaned": history["available"],
                "dropped": cleaned["dropped"],
                "minimum": history["minimum"],
                "spread_status": sp["status"],
            },
        }
    else:
        # ── ROUTED per-market-type strategy gate ──
        # Vetoes even a >= 96.5% confluence. The strategy is resolved from the
        # symbol's asset class by the router; this module no longer branches on
        # market type. The quote-proxy relaxation is an FX-institutional concept,
        # so it is only threaded through for classes whose strategy accepts it
        # (RealMarketStrategy). OTC and CRYPTO ignore it by contract.
        class_gate = strategy.evaluate(
            closes=cleaned["closes"],
            direction=direction_norm,
            bid=bid,
            ask=ask,
            live_price=price,
            allow_quote_proxy=proxy_allowed,
        )

    spread_status = class_gate.get("metrics", {}).get("spread_status", sp["status"])

    surface = apply_strict_execution_gate(
        signal=direction_norm,
        confidence=confidence_pct,
        asset_class=asset_class,
        class_gate=class_gate,
        regime_type=regime_type,
        spread_status=spread_status,
        min_confidence=min_confidence,
        min_tier=min_tier,
    )
    # Real quote-proxy mode rides the audit so operators can SEE how the
    # spread factor was resolved (real quotes vs synthetic proxy). Only
    # strategies that opt in (REAL) are ever eligible.
    if proxy_allowed:
        surface["quote_proxy_enabled"] = True

    surface["regime"] = regime_type
    surface["sanitization"] = {
        "original": cleaned["original"],
        "dropped": cleaned["dropped"],
        "available": len(cleaned["closes"]),
        "minimum_required": history["minimum"],
        "sufficient": history["sufficient"],
    }
    # class_filter comes from the routed strategy so the audit always names the
    # gate that actually ran, including for a newly added market type.
    surface["class_filter"] = strategy.filter_name

    # ── stable audit record for this evaluation (grep: SIGNAL_EVALUATION_AUDIT) ──
    surface["audit"] = log_signal_evaluation(
        symbol=symbol,
        asset_class=asset_class,
        direction=surface["signal"],
        confidence_pct=surface["confidence_pct"],
        regime_type=regime_type,
        spread_status=spread_status,
        executable=surface["executable"],
        tier=surface["tier"],
        regime_gate=surface["regime_gate"],
        suppressed_reason=surface["suppressed_reason"],
        class_filter=surface["class_filter"],
        extra={
            "timeframe": timeframe,
            "regime_status": surface.get("regime_status") or REGIME_STATUS_CONFIRMED,
            "class_gate_passes": bool(class_gate.get("passes")),
            "sanitization": surface["sanitization"],
        },
    )
    return surface