from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import Settings


def test_defaults_are_quarantined() -> None:
    settings = Settings(_env_file=None)
    assert settings.TRADING_MODE == "disabled"
    assert settings.MIN_CONFIDENCE == pytest.approx(96.5)
    assert settings.SQLITE_PATH == "data/execution.db"


def test_fractional_confidence_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, MIN_CONFIDENCE=0.965)


def test_live_requires_credentials() -> None:
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            TRADING_MODE="live",
            ALLOWED_SYMBOLS="EUR/USD",
            API_KEY="",
            API_SECRET="",
        )


def test_live_forbids_wildcard_allowlist() -> None:
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            TRADING_MODE="live",
            ALLOWED_SYMBOLS="*",
            API_KEY="k",
            API_SECRET="s",
        )


def test_empty_consumer_name_gets_a_pid_suffix() -> None:
    settings = Settings(_env_file=None, SIGNAL_CONSUMER="")
    assert settings.SIGNAL_CONSUMER.startswith("execution-")


def test_allowed_symbols_parsing() -> None:
    settings = Settings(_env_file=None, ALLOWED_SYMBOLS="eur/usd, gbp/usd;xau/usd")
    assert settings.allowed_symbols == {"EUR/USD", "GBP/USD", "XAU/USD"}


def test_redis_url_encodes_password() -> None:
    settings = Settings(
        _env_file=None,
        REDIS_HOST="redis",
        REDIS_PORT=6380,
        REDIS_DB=2,
        REDIS_PASSWORD="p@ss/word",
        REDIS_URL="",
    )
    assert settings.redis_url == "redis://:p%40ss%2Fword@redis:6380/2"
