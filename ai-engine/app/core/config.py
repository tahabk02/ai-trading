import logging
import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator
from typing import Optional

from app.services.signal_gatekeeper import (
    TIER_THRESHOLDS,
    TIER_LABELS,
    MIN_EXECUTABLE_TIER,
)

logger = logging.getLogger(__name__)

# ── Environment file isolation ───────────────────────────────────────────────
# `<repo>/ai-engine`, derived from THIS file's location
# (`<service>/app/core/config.py`) so it is identical under uvicorn, pytest, and
# a container image, regardless of the working directory.
#
# Only files inside ai-engine/ are read. The repository-root `.env` belongs to
# the dev-tooling layer and must never be inherited by this service: it carries
# a SQLite `DATABASE_URL` and its own `AI_ENGINE_API_KEY`/`JWT_SECRET`, and
# loading it here silently reconfigured the engine with another service's
# credentials.
AI_ENGINE_ROOT = Path(__file__).resolve().parents[2]

def _ai_engine_env_files() -> tuple[Path, ...]:
    """
    ai-engine-local env files in PRECEDENCE ORDER (highest first).

    1. `.env.local`      gitignored developer override
    2. `.env.<ENVIRONMENT>`  per-environment, only when it exists
    3. `.env`            the base file

    pydantic-settings merges the tuple left-to-right with LATER entries losing,
    so the highest-priority file is placed first. A real environment variable
    always beats every file, which is what makes Docker/compose/CI injection
    authoritative.
    """
    environment = os.environ.get("ENVIRONMENT") or os.environ.get("NODE_ENV") or "development"
    candidates = [AI_ENGINE_ROOT / ".env.local", AI_ENGINE_ROOT / f".env.{environment}", AI_ENGINE_ROOT / ".env"]
    return tuple(p for p in candidates if p.is_file())

AI_ENGINE_ROOT_ENV = _ai_engine_env_files()

_PARENT_DOTENV = AI_ENGINE_ROOT.parent / ".env"
if _PARENT_DOTENV.is_file() and os.environ.get("AI_ENGINE_ALLOW_PARENT_DOTENV") != "true":
    logger.warning(
        "ai-engine: ignoring parent %s — it is another service's configuration. "
        "Set values in %s or the real environment.",
        _PARENT_DOTENV, AI_ENGINE_ROOT / ".env",
    )

# Multi-tier dispatch floors — single source of truth (signal_gatekeeper).
# STRICT HIGH-PRECISION BAR (2026-09-24): the executable floor is now the
# PREMIUM T1 bar (96.5%) and the weakest tier T4 is restored to 70.0. The
# validator never lets a configured value drop below MIN_EXECUTABLE_CONFIDENCE_PCT,
# and since MIN_EXECUTABLE_TIER == "T1", the effective floor is 96.5.
DEFAULT_CONFIDENCE_PCT = round(TIER_THRESHOLDS["T1"] * 100.0, 2)          # 96.5
MIN_EXECUTABLE_CONFIDENCE_PCT = round(TIER_THRESHOLDS["T4"] * 100.0, 2)   # 70.0 (was 30.0 LIVE-TEST)

class Settings(BaseSettings):
    """
    Application settings using Pydantic for validation and environment management.
    """
    PROJECT_NAME: str = "Trading AI Engine"
    API_V1_STR: str = "/api/v1"
    
    # Redis Configuration
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_PASSWORD: Optional[str] = None
    REDIS_URL: Optional[str] = None

    # Trading Configuration
    # ══════════════════════════════════════════════════════════════════
    # MULTI-TIER DISPATCH FLOOR — SINGLE SOURCE OF TRUTH (signal_gatekeeper)
    # ══════════════════════════════════════════════════════════════════
    # STRICT HIGH-PRECISION BAR (2026-09-24): the engine is gated to the
    # PREMIUM T1 floor (96.5%) — the only dispatchable tier. A BUY/SELL
    # verdict below 96.5% is surfaced SCORED-ONLY (executable=False,
    # regime_gate="pending_high_precision"). Direction is ALWAYS KEPT --
    # a sub-bar verdict is honest, merely never dispatched. The weakest
    # tier T4 is restored to 70.0 (was 30.0 during LIVE-TEST).
    # Values configured below MIN_EXECUTABLE_CONFIDENCE_PCT are clamped to
    # that floor at boot; the floor can never weaken past the strict bar.
    CONFIDENCE_THRESHOLD: float = DEFAULT_CONFIDENCE_PCT

    @field_validator("CONFIDENCE_THRESHOLD")
    @classmethod
    def floor_never_below_min_executable(cls, v: float) -> float:
        floor = MIN_EXECUTABLE_CONFIDENCE_PCT
        if v < floor:
            return float(floor)
        return float(v)
    
    # Alpaca Live / Paper Configuration
    # NOTE: there is deliberately no GLOBAL_FORCE_OVERRIDE setting here. It
    # returned tradable/executable for every instrument regardless of the data,
    # which can only fabricate tradability; it was removed outright rather than
    # defaulted off so no environment can re-arm it.

    ALPACA_API_KEY_ID: Optional[str] = None
    ALPACA_API_SECRET_KEY: Optional[str] = None
    ALPACA_BASE_URL: str = "https://api.alpaca.markets"
    ALPACA_PAPER: bool = False
    
    APCA_API_KEY_ID: Optional[str] = None
    APCA_API_SECRET_KEY: Optional[str] = None
    APCA_API_BASE_URL: str = "https://api.alpaca.markets"
    APCA_PAPER: bool = False
    ALPACA_USE_SANDBOX: bool = False

    # Infrastructure
    LOG_FORMAT: str = "CONSOLE"  # "JSON" for production
    ENVIRONMENT: str = "development"
    # Shared secret for core-backend -> ai-engine service-to-service calls.
    # MUST match core-backend's AI_ENGINE_API_KEY. Empty by default (never a
    # hardcoded constant) so an unconfigured engine FAILS CLOSED in production
    # instead of accepting a public, repository-known key.
    AI_ENGINE_API_KEY: Optional[str] = None
    
    # تم تغيير localhost إلى اسم الخدمة في Docker Network لتجنب مشاكل الاتصال في السيرفر
    BACKEND_API_URL: str = "http://core-backend:4000/api/v1"

    # ── CORS ──
    # Comma-separated allowlist of browser origins permitted to call the engine
    # with credentials. NEVER use "*" together with credentials: per the Fetch
    # spec a browser rejects `Access-Control-Allow-Origin: *` on a credentialed
    # request, and Starlette silently "resolves" that illegal pair by REFLECTING
    # whatever origin asked — which is an unauthenticated wildcard, not a fix.
    # The dev defaults cover localhost/127.0.0.1 on the Next.js ports plus any
    # https Dev Tunnel; add real hostnames explicitly in .env.
    CORS_ORIGINS: str = (
        "http://localhost:3000,http://127.0.0.1:3000,"
        "http://localhost:3001,http://127.0.0.1:3001"
    )
    # When true, any https://*.devtunnels.ms / *.tunnels.api.visualstudio.com
    # origin is reflected, so a reissued tunnel never needs a config edit.
    CORS_ALLOW_DEV_TUNNELS: bool = True

    @property
    def cors_origin_list(self) -> list:
        return [o.strip() for o in (self.CORS_ORIGINS or "").split(",") if o.strip()]

    model_config = SettingsConfigDict(
        # Absolute path resolved from THIS FILE, not from the process working
        # directory. `env_file=".env"` is relative to cwd, so running pytest or
        # uvicorn from the repo root silently loaded the root `.env` — a
        # different service's configuration — instead of ai-engine's own, and
        # the same image behaved differently depending on where it was started.
        # Only files inside ai-engine/ are read; the loader never walks up.
        env_file=AI_ENGINE_ROOT_ENV,
        case_sensitive=True,
        extra='ignore'
    )

    @property
    def redis_connection_url(self) -> str:
        if self.REDIS_URL:
            return self.REDIS_URL
        password = f":{self.REDIS_PASSWORD}@" if self.REDIS_PASSWORD else ""
        return f"redis://{password}{self.REDIS_HOST}:{self.REDIS_PORT}/0"

settings = Settings()