from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from app.config import Settings
from app.domain import AccountSnapshot, SignalEnvelope
from app.risk.gate import KillSwitch, RiskGate
from app.state.store import DailyStats


def settings(**overrides) -> Settings:
    base = {
        "TRADING_MODE": "paper",
        "ALLOWED_SYMBOLS": "EUR/USD",
        "MIN_CONFIDENCE": 90.0,
        "MAX_SIGNAL_AGE_MS": 60_000,
        "MAX_TRADES_PER_DAY": 100,
        "MAX_NOTIONAL_PER_TRADE": 100.0,
        "RISK_PER_TRADE": 0.01,
        "DEFAULT_BALANCE": 1_000.0,
        "MAX_OPEN_NOTIONAL": 0.0,
        "MAX_DAILY_LOSS": 0.0,
        "ALLOW_SHORT": True,
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)


def signal(**overrides) -> SignalEnvelope:
    data = {
        "schema_version": "1.0.0",
        "confidence_unit": "percent",
        "symbol": "EUR/USD",
        "signal_type": "BUY",
        "confidence": 97.0,
        "price": 1.1,
        "target_price": 1.1005,
        "executable": True,
        "dispatchable": True,
        "market_waiting": False,
        "horizon_minutes": 1,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    data.update(overrides)
    return SignalEnvelope.from_stream_entry("1-0", {"payload": json.dumps(data)})


def account(**overrides) -> AccountSnapshot:
    data = {
        "venue": "paper",
        "balance": 1_000.0,
        "equity": 1_000.0,
        "starting_equity": 1_000.0,
        "open_notional": 0.0,
        "open_positions": 0,
        "daily_pnl": 0.0,
        "supports_short": True,
    }
    data.update(overrides)
    return AccountSnapshot(**data)


def evaluate(sig, cfg, acct=None, stats=None, tmp_path: Path | None = None):
    kill = KillSwitch(cfg)
    gate = RiskGate(cfg, kill)
    return asyncio.run(
        gate.evaluate(
            sig,
            acct or account(),
            stats or DailyStats(trades_today=0, notional_today=0.0),
            sig.dedupe_key(cfg.DEDUPE_WINDOW_SECONDS),
        )
    )


def test_allows_valid_signal() -> None:
    decision = evaluate(signal(), settings())
    assert decision.allowed
    assert decision.quantity > 0
    assert decision.notional <= 100.0


def test_denies_when_disabled() -> None:
    decision = evaluate(signal(), settings(TRADING_MODE="disabled"))
    assert not decision.allowed
    assert decision.code == "TRADING_DISABLED"


def test_denies_stale_signal() -> None:
    old = datetime.now(timezone.utc).replace(year=2020)
    decision = evaluate(signal(timestamp=old.isoformat()), settings())
    assert not decision.allowed
    assert decision.code == "SIGNAL_STALE"


def test_denies_low_confidence() -> None:
    decision = evaluate(signal(confidence=80.0), settings())
    assert not decision.allowed
    assert decision.code == "LOW_CONFIDENCE"


def test_denies_symbol_not_allowed() -> None:
    decision = evaluate(signal(symbol="GBP/USD"), settings())
    assert not decision.allowed
    assert decision.code == "SYMBOL_NOT_ALLOWED"


def test_denies_empty_allowlist() -> None:
    decision = evaluate(signal(), settings(ALLOWED_SYMBOLS=""))
    assert not decision.allowed
    assert decision.code == "SYMBOL_NOT_ALLOWED"


def test_denies_max_trades() -> None:
    decision = evaluate(
        signal(),
        settings(MAX_TRADES_PER_DAY=2),
        stats=DailyStats(trades_today=2, notional_today=20.0),
    )
    assert not decision.allowed
    assert decision.code == "MAX_TRADES_PER_DAY"


def test_denies_oversized_quantity() -> None:
    decision = evaluate(signal(quantity=1000.0), settings())
    assert not decision.allowed
    assert decision.code == "NOTIONAL_EXCEEDS_LIMIT"


def test_denies_short_when_unsupported() -> None:
    decision = evaluate(
        signal(signal_type="SELL", target_price=1.0995),
        settings(),
        acct=account(supports_short=False),
    )
    assert not decision.allowed
    assert decision.code == "SHORT_NOT_SUPPORTED"


def test_kill_switch_file(tmp_path: Path) -> None:
    flag = tmp_path / "kill"
    flag.write_text("1", encoding="utf-8")
    decision = evaluate(signal(), settings(KILL_SWITCH_FILE=str(flag)))
    assert not decision.allowed
    assert decision.code == "KILL_SWITCH_ACTIVE"


def test_denies_live_without_usable_equity() -> None:
    cfg = settings(TRADING_MODE="live", API_KEY="k", API_SECRET="s")
    decision = evaluate(signal(), cfg, acct=account(equity=0.0))
    assert not decision.allowed
    assert decision.code == "ACCOUNT_EQUITY_UNAVAILABLE"
