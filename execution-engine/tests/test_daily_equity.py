from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.config import Settings
from app.domain import AccountSnapshot, SignalEnvelope
from app.risk.gate import KillSwitch, RiskGate
from app.state.store import DailyEquity, DailyStats, OrderStore


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
        "MAX_DAILY_LOSS": 50.0,
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
        "daily_pnl": None,
        "supports_short": True,
    }
    data.update(overrides)
    return AccountSnapshot(**data)


def evaluate(cfg: Settings, sig, acct, daily_equity: DailyEquity | None):
    gate = RiskGate(cfg, KillSwitch(cfg))
    return asyncio.run(
        gate.evaluate(
            sig,
            acct,
            DailyStats(trades_today=0, notional_today=0.0),
            sig.dedupe_key(cfg.DEDUPE_WINDOW_SECONDS),
            daily_equity=daily_equity,
        )
    )


def test_starting_equity_survives_restart(tmp_path: Path) -> None:
    async def scenario() -> None:
        path = tmp_path / "orders.db"
        day = datetime(2026, 11, 6, 8, 0, tzinfo=timezone.utc)

        store = OrderStore(path)
        await store.init()
        first = await store.observe_equity(day, 1_000.0)
        assert first is not None
        assert first.starting_equity == 1_000.0
        assert first.last_equity == 1_000.0

        await store.observe_equity(day, 940.0)
        await store.close()

        reopened = OrderStore(path)
        await reopened.init()
        restored = await reopened.observe_equity(day, 930.0)
        assert restored is not None
        # The restart must NOT reset the opening baseline to 930.
        assert restored.starting_equity == 1_000.0
        assert restored.last_equity == 930.0
        assert restored.loss == 70.0
        await reopened.close()

    asyncio.run(scenario())


def test_new_utc_day_starts_a_fresh_equity_baseline(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = OrderStore(tmp_path / "orders.db")
        await store.init()
        day = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)
        next_day = day + timedelta(days=1)

        await store.observe_equity(day, 1_000.0)
        await store.observe_equity(day, 900.0)
        reset_row = await store.observe_equity(next_day, 900.0)

        assert reset_row is not None
        assert reset_row.starting_equity == 900.0
        assert reset_row.last_equity == 900.0
        assert reset_row.loss == 0.0
        await store.close()

    asyncio.run(scenario())


def test_gate_denies_persisted_daily_loss_even_without_broker_daily_pnl() -> None:
    cfg = settings()
    day = datetime(2026, 11, 6, tzinfo=timezone.utc).isoformat()
    equity = DailyEquity(
        day=day,
        starting_equity=1_000.0,
        last_equity=949.0,
        updated_at=day,
    )

    decision = evaluate(cfg, signal(), account(daily_pnl=None), equity)
    assert not decision.allowed
    assert decision.code == "MAX_DAILY_LOSS"


def test_gate_allows_loss_below_limit() -> None:
    cfg = settings()
    day = datetime(2026, 11, 6, tzinfo=timezone.utc).isoformat()
    equity = DailyEquity(
        day=day,
        starting_equity=1_000.0,
        last_equity=960.0,
        updated_at=day,
    )

    decision = evaluate(cfg, signal(), account(daily_pnl=None), equity)
    assert decision.allowed


def test_live_gate_fails_closed_when_daily_loss_unavailable() -> None:
    cfg = settings(TRADING_MODE="live", API_KEY="k", API_SECRET="s")
    decision = evaluate(cfg, signal(), account(daily_pnl=None), None)
    assert not decision.allowed
    assert decision.code == "DAILY_LOSS_UNAVAILABLE"


def test_broker_daily_pnl_still_blocks_when_larger_than_persisted_loss() -> None:
    cfg = settings()
    day = datetime(2026, 11, 6, tzinfo=timezone.utc).isoformat()
    equity = DailyEquity(
        day=day,
        starting_equity=1_000.0,
        last_equity=980.0,
        updated_at=day,
    )

    decision = evaluate(cfg, signal(), account(daily_pnl=-75.0), equity)
    assert not decision.allowed
    assert decision.code == "MAX_DAILY_LOSS"
