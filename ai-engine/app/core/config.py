from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator
from typing import Optional

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
    # STRICT 96.5% THERMAL FLOOR — ALIGNED WITH quant_matrix.py
    # ══════════════════════════════════════════════════════════════════
    # Confidence is the engine's real raw-strength percentage (0-100).
    # This floor mirrors DEFINITIVE_CONFIDENCE_MIN (96.5): the signal ghost
    # belt-and-suspenders gate coerce every directional BUY/SELL verdict
    # below 96.5% to an honest market-waiting signal (direction kept,
    # market_waiting=True, no dispatch) — it is never dispatched. Override via
    # CONFIDENCE_THRESHOLD env, but any value below 96.5 downgrades the
    # shipped floor and is therefore clamped to 96.5 at boot.
    CONFIDENCE_THRESHOLD: float = 96.5

    @field_validator("CONFIDENCE_THRESHOLD")
    @classmethod
    def floor_never_below_definitive(cls, v: float) -> float:
        floor = 96.5
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