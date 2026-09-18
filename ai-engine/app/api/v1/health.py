from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter

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
)
from app.services.accuracy_tracker import accuracy_report, get_accuracy_tracker

from fastapi import APIRouter
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
        "timestamp": datetime.utcnow().isoformat(),
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


def gate_report() -> Dict[str, Any]:
    """Single source of truth for the AI Engine's multi-tier gate payload.

    Exposes the canonical TIER_THRESHOLDS ladder (T1 PREMIUM 96.5% → T4 LOW
    70%, T5 WEAK below) plus the LEGACY 98% hard-gate parity values so the
    client can verify the tiers it renders (gatePct = min tier) match the
    engine's dispatch rule. ``resolve_tier`` gives the engine-side tier for a
    given percentage.
    """
    configured = float(settings.CONFIDENCE_THRESHOLD)
    if configured <= 1:
        configured_pct = configured * 100.0
    else:
        configured_pct = configured
    min_exec_pct = round(TIER_THRESHOLDS[MIN_EXECUTABLE_TIER] * 100.0, 2)
    return {
        "gate": GATE_REASON,
        "min_executable_tier": MIN_EXECUTABLE_TIER,
        "min_executable_pct": min_exec_pct,
        "tiers": {
            tier: {
                "label": TIER_LABELS.get(tier, "WEAK"),
                "min_pct": round(float(TIER_THRESHOLDS.get(tier, 0.0)) * 100.0, 2),
                "min_frac": float(TIER_THRESHOLDS.get(tier, 0.0)),
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
        "timestamp": datetime.utcnow().isoformat(),
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
    return tracker.report()