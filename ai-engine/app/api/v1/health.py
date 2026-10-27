from datetime import UTC, datetime
from typing import Any, Dict

from fastapi import APIRouter, Response, status

from app.core.runtime_state import (
    last_health_error,
    warmup_is_running,
    warmup_progress,
)
from app.core.config import settings
from app.services.ml_predictor import _model_cache
from app.services.signal_gatekeeper import (
    HARD_GATE,
    DEFINITIVE_CONFIDENCE_MIN,
    GATE_REASON,
    TIER_THRESHOLDS,
    TIER_LABELS,
    TIER_ORDER,
    MIN_EXECUTABLE_TIER,
    resolve_tier,
    tier_min_confidence,
)
from app.services.accuracy_tracker import accuracy_report, get_accuracy_tracker
from app.services.asset_class import resolve_asset_class
from app.services.bayesian_ensemble import get_ensemble

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, Field
from typing import Optional

router = APIRouter(tags=["health"])


def health_report() -> Dict[str, Any]:
    """Single source of truth for the AI Engine's health payload.

    `status` is "degraded" while the model cache is still warming up (or is
    completely cold) — the engine is up and serving requests, but predicts may
    pay a one-time training cost. It becomes "healthy" once the cache is hot
    and no warmup task is running.
    """
    warmup = warmup_is_running()
    cache_size = _model_cache.size
    degraded = warmup or cache_size == 0
    return {
        "status": "degraded" if degraded else "healthy",
        "healthy": not degraded,
        "service": "ai-engine",
        "version": "1.0.0",
        "model_cache_size": int(cache_size),
        "warmup_running": bool(warmup),
        "warmup_progress": warmup_progress(),
        "last_error": last_health_error(),
        "timestamp": datetime.now(UTC).isoformat(),
    }


def health_live_report() -> Dict[str, Any]:
    """Liveness — the process is up and serving.

    Deliberately INDEPENDENT of warmup/cache state: a warming engine is alive
    and must not be killed by an orchestrator liveness probe. Readiness, which
    DOES depend on warmup, is ``health_report``.
    """
    return {
        "status": "alive",
        "healthy": True,
        "service": "ai-engine",
        "version": "1.0.0",
        "timestamp": datetime.now(UTC).isoformat(),
    }


# The core-backend probes ${AI_ENGINE_URL}/api/v1/health — this router is
# mounted at the api_router root (no prefix), so these become
# /api/v1/health (+ /api/v1/health/ai and /api/v1/health/health aliases).
@router.get("/health")
async def health_check() -> Dict[str, Any]:
    return health_report()


@router.get("/health/ai")
async def health_check_ai() -> Dict[str, Any]:
    return health_report()


@router.get("/health/health")
async def health_check_legacy() -> Dict[str, Any]:
    return health_report()


@router.get("/health/live")
async def health_check_live() -> Dict[str, Any]:
    """Liveness probe — 200 whenever the process is serving (warmup-agnostic)."""
    return health_live_report()


@router.get("/health/ready")
async def health_check_ready(response: Response) -> Dict[str, Any]:
    """Readiness probe — 200 only when the model cache is hot and no warmup is
    running; 503 while cold/warming so routing waits for a warm engine.

    The body is the full ``health_report`` in both cases, so a 503 still carries
    ``status``/``model_cache_size``/``warmup_progress`` instead of a bare error.
    """
    report = health_report()
    if not report["healthy"]:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return report


def gate_report() -> Dict[str, Any]:
    """Single source of truth for the AI Engine's multi-tier gate payload.

    Exposes the canonical TIER_THRESHOLDS ladder (T1 PREMIUM 95.0% → T4 LOW
    80%, T5 WEAK 75%) plus the LEGACY 98% hard-gate parity values so the
    client can verify the tiers it renders (gatePct = min tier) match the
    engine's dispatch rule. ``resolve_tier`` gives the engine-side tier for a
    given percentage.
    """
    configured = float(settings.CONFIDENCE_THRESHOLD)
    if configured <= 1:
        configured_pct = configured * 100.0
    else:
        configured_pct = configured
    min_exec_pct = round(TIER_THRESHOLDS[MIN_EXECUTABLE_TIER], 2)
    return {
        "gate": GATE_REASON,
        "min_executable_tier": MIN_EXECUTABLE_TIER,
        "min_executable_pct": min_exec_pct,
        "tiers": {
            tier: {
                "label": TIER_LABELS.get(tier, "WEAK"),
                "min_pct": round(float(TIER_THRESHOLDS.get(tier, 0.0)), 2),
                "min_frac": round(tier_min_confidence(tier), 6),
            }
            for tier in [*TIER_ORDER, "T5"]
        },
        "tier_for_96_5_pct": resolve_tier(96.5),
        "tier_for_90_pct": resolve_tier(90.0),
        "tier_for_80_pct": resolve_tier(80.0),
        "tier_for_70_pct": resolve_tier(70.0),
        "tier_for_69_pct": resolve_tier(69.0),
        "legacy_hard_gate_pct": float(DEFINITIVE_CONFIDENCE_MIN),
        "legacy_hard_gate_frac": float(HARD_GATE),
        "configured_threshold_pct": round(float(configured_pct), 2),
        "signal_gatekeeper_loaded": True,
        "timestamp": datetime.now(UTC).isoformat(),
    }


@router.get("/health/gate")
async def health_check_gate() -> Dict[str, Any]:
    return gate_report()


class AccuracyRecordIn(BaseModel):
    """Real closed-outcome intake for the rolling 100-window accuracy tracker.

    ``outcome`` is "WIN" | "LOSS"; ``direction``/``confidence``/``quality``/
    ``factors`` are the signal-time snapshot so per-factor win-rates can be
    attributed. ``tier`` is the signal-time tier (T1…T5). This is the ONLY
    ingestion path — figures are real observed fills, never fabricated.
    """
    symbol: str = Field(..., min_length=1)
    direction: Optional[str] = None
    confidence: Optional[float] = None
    outcome: str = Field(..., pattern="^(WIN|LOSS)$")
    quality: Optional[float] = None
    factors: Optional[Dict[str, float]] = None
    entry: Optional[float] = None
    exit_price: Optional[float] = None
    tier: Optional[str] = None
    regime: Optional[str] = None
    component_scores: Optional[Dict[str, float]] = None


def _realized_direction(direction: Optional[str], outcome: str) -> Optional[str]:
    side = (direction or "").strip().upper()
    if side in ("CALL", "LONG"):
        side = "BUY"
    elif side in ("PUT", "SHORT"):
        side = "SELL"
    if side not in ("BUY", "SELL"):
        return None
    if outcome == "WIN":
        return side
    return "SELL" if side == "BUY" else "BUY"


def _component_scores(record: AccuracyRecordIn) -> Dict[str, float]:
    """Map the recorded factor snapshot onto the Bayesian ensemble's components.

    Quality factors are direction-relative 0/1 booleans; quant-matrix factors
    are already signed. We only emit components whose meaning is unambiguous.
    """
    if record.component_scores:
        return {
            str(k): float(v)
            for k, v in record.component_scores.items()
            if float(v) != 0.0
        }

    factors = record.factors or {}
    side = (record.direction or "").strip().upper()
    sign = 1.0 if side in ("BUY", "CALL", "LONG") else -1.0
    if side not in ("BUY", "SELL", "CALL", "PUT", "LONG", "SHORT"):
        return {}

    def value(name: str) -> Optional[float]:
        raw = factors.get(name)
        if raw is None:
            return None
        try:
            v = float(raw)
        except (TypeError, ValueError):
            return None
        return v if v == v and abs(v) != float("inf") else None

    binary_mode = (
        record.quality is not None
        and bool(factors)
        and all(v in (0.0, 1.0) for v in factors.values())
    )

    scores: Dict[str, float] = {}
    if binary_mode:
        momentum_parts = [value(n) for n in ("mtf", "momentum")]
        momentum_parts = [v for v in momentum_parts if v is not None]
        if momentum_parts:
            scores["momentum"] = sign * (sum(momentum_parts) / len(momentum_parts))
        pressure = value("pressure")
        if pressure is not None:
            scores["order_flow"] = sign * pressure
            scores["microstructure"] = sign * pressure
    else:
        momentum_parts = [value(n) for n in ("micro_momentum", "macd_momentum", "momentum")]
        momentum_parts = [v for v in momentum_parts if v is not None]
        if momentum_parts:
            scores["momentum"] = sum(momentum_parts) / len(momentum_parts)
        micro_parts = [
            value(n) for n in ("tick_velocity", "bid_ask_pressure", "price_action_delta")
        ]
        micro_parts = [v for v in micro_parts if v is not None]
        if micro_parts:
            scores["microstructure"] = sum(micro_parts) / len(micro_parts)
        flow = value("bid_ask_pressure")
        if flow is not None:
            scores["order_flow"] = flow

    return {
        name: max(-1.0, min(1.0, float(score)))
        for name, score in scores.items()
        if abs(score) > 1e-12
    }


@router.get("/health/accuracy")
async def health_check_accuracy() -> Dict[str, Any]:
    """Rolling last-100 WIN/LOSS accuracy + the 0.98 watchdog state."""
    return accuracy_report()


@router.post("/accuracy/record")
async def accuracy_record(record: AccuracyRecordIn) -> Dict[str, Any]:
    """Record one real closed outcome and return the updated accuracy pulse."""
    tracker = get_accuracy_tracker()
    tracker.record_outcome(
        symbol=record.symbol,
        direction=record.direction,
        confidence=record.confidence or 0.0,
        outcome=record.outcome,
        factors=record.factors,
        quality=record.quality,
        entry=record.entry,
        exit_price=record.exit_price,
        tier=record.tier,
    )

    # Feed the same real settled outcome into the adaptive Bayesian ensemble.
    # This is best-effort: the accuracy ledger must still return if a component
    # mapping is absent or the ensemble rejects an ambiguous record.
    bayesian: Dict[str, Any] = {"updated": False, "reason": "no_component_scores"}
    realized = _realized_direction(record.direction, record.outcome)
    scores = _component_scores(record)
    if realized and scores:
        try:
            bayesian = {
                "updated": True,
                **get_ensemble().record_outcome(
                    regime=record.regime or "unknown",
                    component_scores=scores,
                    realized_direction=realized,
                    asset_class=resolve_asset_class(record.symbol),
                ),
            }
        except (TypeError, ValueError) as exc:
            bayesian = {"updated": False, "reason": type(exc).__name__}

    report = tracker.report()
    report["bayesian_outcome"] = bayesian
    return report