from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from app.domain import AccountSnapshot, BrokerOrder, OrderIntent


class BrokerError(Exception):
    pass


class TransientBrokerError(BrokerError):
    pass


class PermanentBrokerError(BrokerError):
    pass


class UnsupportedSymbolError(PermanentBrokerError):
    def __init__(self, symbol: str, venue: str) -> None:
        super().__init__(f"{venue} does not support {symbol}")
        self.symbol = symbol
        self.venue = venue


@dataclass(frozen=True)
class BrokerCapabilities:
    venue: str
    supports_short: bool
    supports_client_order_id: bool
    supports_order_status: bool


@runtime_checkable
class Broker(Protocol):
    async def start(self) -> None: ...

    async def close(self) -> None: ...

    def capabilities(self) -> BrokerCapabilities: ...

    async def validate_symbol(self, symbol: str) -> None: ...

    async def account_snapshot(self) -> AccountSnapshot: ...

    async def place_order(self, intent: OrderIntent) -> BrokerOrder: ...

    async def fetch_order(self, intent: OrderIntent, broker_order_id: str | None = None) -> BrokerOrder | None: ...

    async def cancel(self, intent: OrderIntent, broker_order_id: str | None = None) -> BrokerOrder | None: ...
