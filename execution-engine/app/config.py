from __future__ import annotations

import os
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENGINE_ROOT = Path(__file__).resolve().parents[1]


def _env_files() -> tuple[Path, ...]:
    environment = os.environ.get("ENVIRONMENT") or os.environ.get("NODE_ENV") or "development"
    # pydantic-settings applies later files last, so order low -> high priority.
    # Deliberately service-local only: the repo-root .env belongs to the whole
    # stack and must not leak MIN_CONFIDENCE / broker keys into this engine.
    candidates = (
        ENGINE_ROOT / ".env",
        ENGINE_ROOT / f".env.{environment}",
        ENGINE_ROOT / ".env.local",
    )
    return tuple(path for path in candidates if path.is_file())


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_env_files(),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    TRADING_MODE: Literal["disabled", "paper", "live"] = "disabled"

    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_PASSWORD: str = ""
    REDIS_DB: int = 0
    REDIS_URL: str = ""

    SIGNAL_STREAM: str = Field(default="trading_signals:stream", min_length=1)
    SIGNAL_GROUP: str = Field(default="execution-gateway", min_length=1)
    SIGNAL_CONSUMER: str = Field(default_factory=lambda: f"execution-{os.getpid()}")
    SIGNAL_BATCH: int = Field(default=32, ge=1, le=512)
    SIGNAL_BLOCK_MS: int = Field(default=5_000, ge=1_000)
    RECLAIM_MIN_IDLE_MS: int = Field(default=30_000, ge=1_000)
    RECLAIM_COUNT: int = Field(default=50, ge=1, le=512)
    DEAD_LETTER_STREAM: str = "execution:dead_letter"

    EXCHANGE_ID: str = "binance"
    API_KEY: str = ""
    API_SECRET: str = ""
    QUOTE_CURRENCY: str = "USDT"
    # Only enable when the venue guarantees idempotent client order ids.
    # Re-submitting an ambiguous order without that guarantee can duplicate it.
    ASSUME_CLIENT_ORDER_IDEMPOTENCY: bool = False

    MIN_CONFIDENCE: float = Field(default=96.5, ge=0.0, le=100.0)
    MAX_SIGNAL_AGE_MS: int = Field(default=5_000, ge=100)
    MAX_NOTIONAL_PER_TRADE: float = Field(default=50.0, gt=0.0)
    MAX_OPEN_NOTIONAL: float = Field(default=0.0, ge=0.0)
    MAX_TRADES_PER_DAY: int = Field(default=20, ge=0)
    MAX_DAILY_LOSS: float = Field(default=0.0, ge=0.0)
    RISK_PER_TRADE: float = Field(default=0.01, gt=0.0, le=1.0)
    DEFAULT_BALANCE: float = Field(default=1_000.0, gt=0.0)
    ALLOWED_SYMBOLS: str = ""
    ALLOW_SHORT: bool = True
    DEDUPE_WINDOW_SECONDS: int = Field(default=60, ge=1, le=86_400)

    KILL_SWITCH_KEY: str = "execution:kill_switch"
    KILL_SWITCH_FILE: str = ""

    SQLITE_PATH: str = "data/execution.db"
    ORDER_POLL_INTERVAL_MS: int = Field(default=2_000, ge=250)
    ORDER_POLL_TIMEOUT_MS: int = Field(default=60_000, ge=1_000)
    MAX_SUBMIT_ATTEMPTS: int = Field(default=3, ge=1, le=10)
    # A pending INTENT/UNKNOWN is never re-submitted after this age. This
    # stops a crash-recovered gateway from executing an old signal.
    MAX_RECONCILE_AGE_MS: int = Field(default=60_000, ge=1_000)

    HEALTH_HOST: str = "0.0.0.0"
    HEALTH_PORT: int = Field(default=8081, ge=1, le=65_535)
    LOG_LEVEL: str = "INFO"

    @field_validator("SIGNAL_CONSUMER", mode="before")
    @classmethod
    def _default_consumer(cls, value: object) -> str:
        return str(value) if value else f"execution-{os.getpid()}"

    @model_validator(mode="after")
    def _validate_mode(self) -> "Settings":
        if 0.0 < self.MIN_CONFIDENCE < 1.0:
            raise ValueError(
                "MIN_CONFIDENCE looks like a 0..1 fraction; the contract is 0..100 "
                "(for example 96.5)"
            )
        if self.TRADING_MODE == "live":
            if not self.API_KEY or not self.API_SECRET:
                raise ValueError(
                    "TRADING_MODE=live requires API_KEY and API_SECRET; "
                    "use TRADING_MODE=paper for simulation"
                )
            if self.allowed_symbols == {"*"}:
                raise ValueError(
                    "TRADING_MODE=live forbids ALLOWED_SYMBOLS='*'; "
                    "list the executable symbols explicitly"
                )
        if self.SQLITE_PATH.strip() == "":
            raise ValueError("SQLITE_PATH must not be empty")
        return self

    @property
    def redis_url(self) -> str:
        if self.REDIS_URL:
            return self.REDIS_URL
        auth = f":{quote(self.REDIS_PASSWORD, safe='')}@" if self.REDIS_PASSWORD else ""
        return f"redis://{auth}{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"

    @property
    def allowed_symbols(self) -> set[str]:
        raw = self.ALLOWED_SYMBOLS.replace(";", ",")
        return {item.strip().upper() for item in raw.split(",") if item.strip()}

    @property
    def resolved_sqlite_path(self) -> Path:
        path = Path(self.SQLITE_PATH)
        return path if path.is_absolute() else ENGINE_ROOT / path

    @property
    def kill_switch_file(self) -> Path | None:
        if not self.KILL_SWITCH_FILE:
            return None
        path = Path(self.KILL_SWITCH_FILE)
        return path if path.is_absolute() else ENGINE_ROOT / path
