from __future__ import annotations

import asyncio
import math
from typing import Any

import ccxt
import structlog

from app.broker.base import (
    BrokerCapabilities,
    PermanentBrokerError,
    TransientBrokerError,
    UnsupportedSymbolError,
)
from app.config import Settings
from app.domain import AccountSnapshot, BrokerOrder, OrderIntent, OrderStatus

logger = structlog.get_logger(__name__)

_TRANSIENT = (
    ccxt.NetworkError,
    ccxt.RequestTimeout,
    ccxt.ExchangeNotAvailable,
    ccxt.DDoSProtection,
    ccxt.RateLimitExceeded,
)
_PERMANENT = (
    ccxt.InsufficientFunds,
    ccxt.InvalidOrder,
    ccxt.BadSymbol,
    ccxt.NotSupported,
    ccxt.AuthenticationError,
    ccxt.PermissionDenied,
    ccxt.ExchangeError,
)


def _classify(exc: Exception) -> Exception:
    if isinstance(exc, _TRANSIENT):
        return TransientBrokerError(str(exc))
    if isinstance(exc, _PERMANENT):
        return PermanentBrokerError(str(exc))
    return PermanentBrokerError(str(exc))


def _map_status(status: str | None) -> OrderStatus:
    normalized = (status or "").lower()
    if normalized == "open":
        return OrderStatus.SUBMITTED
    if normalized == "closed":
        return OrderStatus.FILLED
    if normalized == "canceled":
        return OrderStatus.CANCELED
    if normalized == "rejected":
        return OrderStatus.REJECTED
    if normalized == "expired":
        return OrderStatus.EXPIRED
    return OrderStatus.UNKNOWN


class CcxtBroker:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._exchange: Any = None
        self._markets: dict[str, Any] = {}

    async def start(self) -> None:
        exchange_class = getattr(ccxt, self.settings.EXCHANGE_ID, None)
        if exchange_class is None:
            raise PermanentBrokerError(
                f"ccxt exchange '{self.settings.EXCHANGE_ID}' is not available"
            )
        self._exchange = exchange_class(
            {
                "apiKey": self.settings.API_KEY,
                "secret": self.settings.API_SECRET,
                "enableRateLimit": True,
            }
        )
        try:
            self._markets = await asyncio.to_thread(self._exchange.load_markets)
        except Exception as exc:
            raise _classify(exc) from exc
        logger.info(
            "BROKER_READY",
            venue=self.settings.EXCHANGE_ID,
            markets=len(self._markets),
        )

    async def close(self) -> None:
        if self._exchange is not None and hasattr(self._exchange, "close"):
            try:
                await asyncio.to_thread(self._exchange.close)
            except Exception:
                pass

    def capabilities(self) -> BrokerCapabilities:
        default_type = ""
        if self._exchange is not None:
            default_type = str(self._exchange.options.get("defaultType") or "")
        derivative = default_type in {"future", "swap"}
        return BrokerCapabilities(
            venue=self.settings.EXCHANGE_ID,
            supports_short=derivative,
            supports_client_order_id=self.settings.ASSUME_CLIENT_ORDER_IDEMPOTENCY,
            supports_order_status=True,
        )

    async def validate_symbol(self, symbol: str) -> None:
        market = self._markets.get(symbol)
        if market is None:
            raise UnsupportedSymbolError(symbol, self.settings.EXCHANGE_ID)
        if market.get("active") is False:
            raise UnsupportedSymbolError(symbol, self.settings.EXCHANGE_ID)

    async def account_snapshot(self) -> AccountSnapshot:
        if self._exchange is None:
            raise TransientBrokerError("broker not started")
        try:
            balance = await asyncio.to_thread(self._exchange.fetch_balance)
            positions: list[Any] = []
            if self.capabilities().supports_short and self._exchange.has.get("fetchPositions"):
                # Derivative exposure must be real; a failed read is not zero.
                positions = await asyncio.to_thread(self._exchange.fetch_positions)
        except Exception as exc:
            raise _classify(exc) from exc

        quote = self.settings.QUOTE_CURRENCY.upper()
        total = balance.get("total") or {}
        free = balance.get("free") or {}
        equity_raw = total.get(quote, free.get(quote, 0.0))
        try:
            equity = float(equity_raw or 0.0)
        except (TypeError, ValueError):
            equity = 0.0

        open_notional = 0.0
        open_positions = 0
        for position in positions:
            contracts = position.get("contracts")
            notional = position.get("notional")
            if notional is not None:
                try:
                    open_notional += abs(float(notional))
                except (TypeError, ValueError):
                    pass
            if contracts:
                open_positions += 1

        if not math.isfinite(equity) or equity < 0:
            raise PermanentBrokerError(f"unexpected account equity {equity}")

        return AccountSnapshot(
            venue=self.settings.EXCHANGE_ID,
            balance=equity,
            equity=equity,
            starting_equity=equity,
            open_notional=open_notional,
            open_positions=open_positions,
            daily_pnl=None,
            supports_short=self.capabilities().supports_short,
        )

    async def place_order(self, intent: OrderIntent) -> BrokerOrder:
        if self._exchange is None:
            raise TransientBrokerError("broker not started")
        await self.validate_symbol(intent.symbol)
        market = self._markets[intent.symbol]
        limits = market.get("limits") or {}
        min_amount = (limits.get("amount") or {}).get("min")
        min_cost = (limits.get("cost") or {}).get("min")
        if min_amount is not None and intent.quantity < float(min_amount):
            raise PermanentBrokerError(
                f"{intent.symbol} minimum amount {min_amount} exceeds {intent.quantity}"
            )
        if min_cost is not None and intent.quantity * intent.reference_price < float(min_cost):
            raise PermanentBrokerError(
                f"{intent.symbol} minimum cost {min_cost} exceeds "
                f"{intent.quantity * intent.reference_price}"
            )

        params = (
            {"clientOrderId": intent.client_order_id}
            if self.settings.ASSUME_CLIENT_ORDER_IDEMPOTENCY
            else {}
        )
        try:
            order = await asyncio.to_thread(
                self._exchange.create_order,
                intent.symbol,
                "market",
                intent.side.lower(),
                intent.quantity,
                None,
                params,
            )
        except Exception as exc:
            raise _classify(exc) from exc

        return BrokerOrder(
            client_order_id=intent.client_order_id,
            broker_order_id=str(order.get("id")) if order.get("id") else None,
            status=_map_status(order.get("status")),
            filled_quantity=float(order.get("filled") or 0.0),
            average_price=float(order["average"]) if order.get("average") else None,
            reason=order.get("info", {}).get("msg") if isinstance(order.get("info"), dict) else None,
        )

    async def fetch_order(self, intent: OrderIntent, broker_order_id: str | None = None) -> BrokerOrder | None:
        if self._exchange is None:
            raise TransientBrokerError("broker not started")
        if not broker_order_id:
            return None
        try:
            order = await asyncio.to_thread(
                self._exchange.fetch_order, broker_order_id, intent.symbol
            )
        except ccxt.OrderNotFound:
            return None
        except Exception as exc:
            raise _classify(exc) from exc
        return BrokerOrder(
            client_order_id=intent.client_order_id,
            broker_order_id=str(order.get("id")) if order.get("id") else broker_order_id,
            status=_map_status(order.get("status")),
            filled_quantity=float(order.get("filled") or 0.0),
            average_price=float(order["average"]) if order.get("average") else None,
        )

    async def cancel(self, intent: OrderIntent, broker_order_id: str | None = None) -> BrokerOrder | None:
        if self._exchange is None:
            raise TransientBrokerError("broker not started")
        if not broker_order_id:
            return None
        try:
            await asyncio.to_thread(
                self._exchange.cancel_order, broker_order_id, intent.symbol
            )
        except Exception as exc:
            raise _classify(exc) from exc
        return BrokerOrder(
            client_order_id=intent.client_order_id,
            broker_order_id=broker_order_id,
            status=OrderStatus.CANCELED,
        )
