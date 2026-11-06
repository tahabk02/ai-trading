from __future__ import annotations

import asyncio
import math
from datetime import datetime, timezone

import structlog

from app.config import Settings
from app.domain import AccountSnapshot, RiskDecision, SignalEnvelope
from app.state.store import DailyEquity, DailyStats

logger = structlog.get_logger(__name__)


class KillSwitch:
    def __init__(self, settings: Settings, redis_client=None) -> None:
        self._settings = settings
        self._redis = redis_client

    async def active(self) -> bool:
        path = self._settings.kill_switch_file
        if path is not None:
            if path.exists():
                try:
                    content = (
                        await asyncio.to_thread(path.read_text, encoding="utf-8")
                    ).strip().lower()
                except OSError as exc:
                    logger.error("KILL_SWITCH_FILE_READ_FAILED", error=str(exc))
                    return True
                if content not in {"0", "false", "off", "no"}:
                    return True
        if self._redis is not None:
            try:
                value = await self._redis.get(self._settings.KILL_SWITCH_KEY)
            except Exception as exc:
                logger.error("KILL_SWITCH_READ_FAILED", error=str(exc))
                return True
            if value is not None and str(value).strip().lower() in {
                "1",
                "true",
                "on",
                "yes",
            }:
                return True
        return False


class RiskGate:
    def __init__(self, settings: Settings, kill_switch: KillSwitch) -> None:
        self._settings = settings
        self._kill_switch = kill_switch

    async def kill_switch_active(self) -> bool:
        return await self._kill_switch.active()

    async def evaluate(
        self,
        signal: SignalEnvelope,
        account: AccountSnapshot,
        stats: DailyStats,
        dedupe_key: str,
        *,
        daily_equity: DailyEquity | None = None,
    ) -> RiskDecision:
        settings = self._settings

        if settings.TRADING_MODE == "disabled":
            return _deny("TRADING_DISABLED", "TRADING_MODE=disabled")
        if await self._kill_switch.active():
            return _deny("KILL_SWITCH_ACTIVE", "execution kill switch is engaged")
        if signal.confidence < settings.MIN_CONFIDENCE:
            return _deny(
                "LOW_CONFIDENCE",
                f"{signal.confidence:.2f} < MIN_CONFIDENCE {settings.MIN_CONFIDENCE:.2f}",
            )

        now = datetime.now(timezone.utc)
        age_ms = (now - signal.timestamp).total_seconds() * 1000.0
        if age_ms < -2_000:
            return _deny("SIGNAL_CLOCK_SKEW", f"signal timestamp is {-age_ms:.0f}ms in the future")
        if age_ms > settings.MAX_SIGNAL_AGE_MS:
            return _deny(
                "SIGNAL_STALE",
                f"signal age {age_ms:.0f}ms exceeds {settings.MAX_SIGNAL_AGE_MS}ms",
            )

        allowed = settings.allowed_symbols
        if not allowed:
            return _deny(
                "SYMBOL_NOT_ALLOWED",
                "ALLOWED_SYMBOLS is empty; no symbol can execute",
            )
        if "*" not in allowed and signal.symbol not in allowed:
            return _deny(
                "SYMBOL_NOT_ALLOWED",
                f"{signal.symbol} is not in ALLOWED_SYMBOLS",
            )
        if signal.side == "SELL" and not account.supports_short:
            return _deny(
                "SHORT_NOT_SUPPORTED",
                f"{account.venue} is spot-only; SELL cannot be executed",
            )
        if settings.MAX_TRADES_PER_DAY == 0:
            return _deny("MAX_TRADES_PER_DAY", "daily trade limit is zero")
        if stats.trades_today >= settings.MAX_TRADES_PER_DAY:
            return _deny(
                "MAX_TRADES_PER_DAY",
                f"{stats.trades_today} trades today >= {settings.MAX_TRADES_PER_DAY}",
            )
        # ── DAILY LOSS (restart-safe) ──
        # account.daily_pnl is broker-provided and can reset when the broker
        # connection restarts; some live venues report None. The persisted
        # daily_equity row supplies the same measure from real equity snapshots
        # and survives a process restart. Use the LARGER observed loss so the
        # gate cannot be reset by either source going quiet.
        observed_losses: list[float] = []
        if account.daily_pnl is not None and math.isfinite(account.daily_pnl):
            observed_losses.append(-account.daily_pnl)
        if daily_equity is not None and (
            math.isfinite(daily_equity.starting_equity)
            and math.isfinite(daily_equity.last_equity)
        ):
            observed_losses.append(daily_equity.loss)
        daily_loss = max(observed_losses) if observed_losses else None

        if settings.MAX_DAILY_LOSS > 0:
            if daily_loss is None:
                if settings.TRADING_MODE == "live":
                    return _deny(
                        "DAILY_LOSS_UNAVAILABLE",
                        "live mode requires a daily equity observation when "
                        "MAX_DAILY_LOSS is enabled",
                    )
            elif daily_loss >= settings.MAX_DAILY_LOSS:
                return _deny(
                    "MAX_DAILY_LOSS",
                    f"daily loss {daily_loss:.2f} breached "
                    f"MAX_DAILY_LOSS {settings.MAX_DAILY_LOSS:.2f}",
                )

        equity_ok = math.isfinite(account.equity) and account.equity > 0
        if not equity_ok and settings.TRADING_MODE == "live":
            return _deny(
                "ACCOUNT_EQUITY_UNAVAILABLE",
                "live broker reported no usable quote balance",
            )
        equity = account.equity if equity_ok else settings.DEFAULT_BALANCE
        risk_budget = min(settings.MAX_NOTIONAL_PER_TRADE, equity * settings.RISK_PER_TRADE)
        if not math.isfinite(risk_budget) or risk_budget <= 0:
            return _deny("RISK_BUDGET_INVALID", f"risk budget {risk_budget} is not positive")

        if signal.quantity is not None:
            quantity = signal.quantity
            notional = quantity * signal.price
            if notional > settings.MAX_NOTIONAL_PER_TRADE + 1e-9:
                return _deny(
                    "NOTIONAL_EXCEEDS_LIMIT",
                    f"requested notional {notional:.2f} exceeds "
                    f"{settings.MAX_NOTIONAL_PER_TRADE:.2f}",
                )
        else:
            notional = risk_budget
            quantity = notional / signal.price

        if not math.isfinite(quantity) or quantity <= 0 or not math.isfinite(notional):
            return _deny("QUANTITY_INVALID", "computed quantity/notional is not positive")

        if (
            settings.MAX_OPEN_NOTIONAL > 0
            and account.open_notional + notional > settings.MAX_OPEN_NOTIONAL + 1e-9
        ):
            return _deny(
                "MAX_OPEN_NOTIONAL",
                f"open {account.open_notional:.2f} + {notional:.2f} exceeds "
                f"{settings.MAX_OPEN_NOTIONAL:.2f}",
            )

        return RiskDecision(
            allowed=True,
            code="ALLOWED",
            detail=f"dedupe_key={dedupe_key}",
            quantity=round(quantity, 8),
            notional=round(notional, 8),
        )


def _deny(code: str, detail: str) -> RiskDecision:
    return RiskDecision(allowed=False, code=code, detail=detail)
