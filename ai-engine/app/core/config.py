from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator
from typing import Optional

from app.services.signal_gatekeeper import (
    TIER_THRESHOLDS,
    TIER_LABELS,
    MIN_EXECUTABLE_TIER,
)

# Multi-tier dispatch floors — single source of truth (signal_gatekeeper).
# The default CONFIDENCE_THRESHOLD (a percentage, 0-100) is the PREMIUM T1
# bar (96.5); the validator never lets a configured value drop below the
# weakest executable tier T4 (70.0), so an env override can only tighten
# the shipped floor between 70 and 100.
DEFAULT_CONFIDENCE_PCT = round(TIER_THRESHOLDS["T1"] * 100.0, 2)          # 96.5
MIN_EXECUTABLE_CONFIDENCE_PCT = round(TIER_THRESHOLDS["T4"] * 100.0, 2)   # 70.0

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
    # Confidence is the engine's real raw-strength percentage (0-100).
    # The default floor is the PREMIUM T1 bar (96.5%); a BUY/SELL verdict is
    # dispatched when it clears the caller's minimum executable tier (T4=70
    # by default, TIER_LABELS[T4]="LOW"). Tiers: T1 PREMIUM >= 96.5,
    # T2 HIGH >= 90, T3 MEDIUM >= 80, T4 LOW >= 70, below = T5 WEAK (never
    # dispatched). Direction is always KEPT: a sub-tier verdict is flagged an
    # honest market-waiting signal (market_waiting=True, no dispatch). Values
    # configured below the weakest tier (70) are clamped to 70 at boot; the
    # floor can never weaken past the minimum-executable bar.
    CONFIDENCE_THRESHOLD: float = DEFAULT_CONFIDENCE_PCT

    @field_validator("CONFIDENCE_THRESHOLD")
    @classmethod
    def floor_never_below_min_executable(cls, v: float) -> float:
        floor = MIN_EXECUTABLE_CONFIDENCE_PCT
        if v < floor:
            return float(floor)
        return float(v)
    
    # Alpaca Live / Paper Configuration
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
    
    # تم تغيير localhost إلى اسم الخدمة في Docker Network لتجنب مشاكل الاتصال في السيرفر
    BACKEND_API_URL: str = "http://core-backend:4000/api/v1"

    model_config = SettingsConfigDict(
        env_file=".env",
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