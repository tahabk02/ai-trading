from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from app.broker.base import (
    BrokerCapabilities,
    PermanentBrokerError,
    UnsupportedSymbolError,
)
from app.config import Settings
from app.domain import AccountSnapshot, BrokerOrder, OrderIntent, OrderStatus


@dataclass
class _PaperPosition:
    quantity: float = 0.0
    average_price: float = 0.0

    def apply(self, side: str, quantity: float, price: float) -> None:
        signed = quantity if side == "BUY" else -quantity
        new_quantity = self.quantity + signed
        same_direction = self.quantity == 0 or (self.quantity > 0) == (signed > 0)
        flipped = self.quantity != 0 and not same_direction and abs(signed) > abs(self.quantity)
        if same_direction:
            total = abs(self.quantity) + abs(signed)
            self.average_price = (
                (abs(self.quantity) * self.average_price + abs(signed) * price) / total
                if total
                else price
            )
        elif flipped:
            self.average_price = price
        self.quantity = new_quantity
        if abs(self.quantity) < 1e-12:
            self.quantity = 0.0
            self.average_price = 0.0


@dataclass
class PaperBroker:
    settings: Settings
    _orders: dict[str, BrokerOrder] = field(default_factory=dict)
    _positions: dict[str, _PaperPosition] = field(default_factory=dict)
    _marks: dict[str, float] = field(default_factory=dict)
    _cash: float = field(init=False)
    _starting_equity: float = field(init=False)
    _day: date = field(init=False)

    def __post_init__(self) -> None:
        self._cash = float(self.settings.DEFAULT_BALANCE)
        self._starting_equity = float(self.settings.DEFAULT_BALANCE)
        self._day = datetime.now(timezone.utc).date()

    async def start(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def capabilities(self) -> BrokerCapabilities:
        return BrokerCapabilities(
            venue="paper",
            supports_short=self.settings.ALLOW_SHORT,
            supports_client_order_id=True,
            supports_order_status=True,
        )

    async def validate_symbol(self, symbol: str) -> None:
        if not symbol or "/" not in symbol:
            raise UnsupportedSymbolError(symbol, "paper")
        allowed = self.settings.allowed_symbols
        if allowed and "*" not in allowed and symbol.upper() not in allowed:
            raise UnsupportedSymbolError(symbol, "paper")

    def _roll_day(self) -> None:
        today = datetime.now(timezone.utc).date()
        if today != self._day:
            self._day = today
            self._starting_equity = self._equity()

    def _equity(self) -> float:
        return self._cash + sum(
            position.quantity * self._marks.get(symbol, position.average_price)
            for symbol, position in self._positions.items()
            if position.quantity != 0
        )

    async def account_snapshot(self) -> AccountSnapshot:
        self._roll_day()
        open_notional = 0.0
        open_positions = 0
        for symbol, position in self._positions.items():
            if position.quantity == 0:
                continue
            mark = self._marks.get(symbol, position.average_price)
            if not math.isfinite(mark) or mark <= 0:
                mark = position.average_price
            open_notional += abs(position.quantity) * mark
            open_positions += 1
        equity = self._equity()
        return AccountSnapshot(
            venue="paper",
            balance=round(self._cash, 8),
            equity=round(equity, 8),
            starting_equity=self._starting_equity,
            open_notional=round(open_notional, 8),
            open_positions=open_positions,
            daily_pnl=round(equity - self._starting_equity, 8),
            supports_short=self.settings.ALLOW_SHORT,
        )

    async def place_order(self, intent: OrderIntent) -> BrokerOrder:
        existing = self._orders.get(intent.client_order_id)
        if existing is not None:
            return existing

        if not math.isfinite(intent.quantity) or intent.quantity <= 0:
            raise PermanentBrokerError(f"invalid quantity {intent.quantity}")
        if not math.isfinite(intent.reference_price) or intent.reference_price <= 0:
            raise PermanentBrokerError(
                f"invalid reference price {intent.reference_price}"
            )
        if intent.side == "SELL" and not self.settings.ALLOW_SHORT:
            raise PermanentBrokerError("short selling is disabled for paper mode")
        try:
            await self.validate_symbol(intent.symbol)
        except UnsupportedSymbolError:
            raise

        price = intent.reference_price
        notional = intent.quantity * price
        if intent.side == "BUY" and notional > self._cash + 1e-9:
            raise PermanentBrokerError(
                f"paper balance insufficient: need {notional}, have {self._cash}"
            )

        self._marks[intent.symbol] = price
        position = self._positions.setdefault(intent.symbol, _PaperPosition())
        if intent.side == "BUY":
            self._cash -= notional
        else:
            self._cash += notional
        position.apply(intent.side, intent.quantity, price)

        order = BrokerOrder(
            client_order_id=intent.client_order_id,
            broker_order_id=f"paper-{intent.client_order_id}",
            status=OrderStatus.FILLED,
            filled_quantity=intent.quantity,
            average_price=price,
        )
        self._orders[intent.client_order_id] = order
        return order

    async def fetch_order(self, intent: OrderIntent, broker_order_id: str | None = None) -> BrokerOrder | None:
        return self._orders.get(intent.client_order_id)

    async def cancel(self, intent: OrderIntent, broker_order_id: str | None = None) -> BrokerOrder | None:
        existing = self._orders.get(intent.client_order_id)
        if existing is None or existing.status.terminal:
            return existing
        canceled = existing.model_copy(
            update={"status": OrderStatus.CANCELED, "reason": "canceled_by_gateway"}
        )
        self._orders[intent.client_order_id] = canceled
        return canceled
