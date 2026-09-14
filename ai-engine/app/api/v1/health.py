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
)

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
    """Single source of truth for the AI Engine's hard-gate payload.

    Exposes the STRICT 96.5% thermal floor (DEFINITIVE_CONFIDENCE_MIN) and the
    fractional HARD_GATE (0.965) front-end parity value so the client can verify
    the gate it renders (gatePct = 96.5) matches the engine's dispatch rule.
    """
    configured = float(settings.CONFIDENCE_THRESHOLD)
    if configured <= 1:
        configured_pct = configured * 100.0
    else:
        configured_pct = configured
    return {
        "gate": GATE_REASON,
        "hard_gate_pct": float(DEFINITIVE_CONFIDENCE_MIN),
        "hard_gate_frac": float(HARD_GATE),
        "configured_threshold_pct": round(float(configured_pct), 2),
        "signal_gatekeeper_loaded": True,
        "timestamp": datetime.utcnow().isoformat(),
    }


@router.get("/health/gate")
async def health_check_gate() -> Dict[str, Any]:
    return gate_report()