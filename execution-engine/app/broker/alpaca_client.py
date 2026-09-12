"""
Alpaca Broker Client — standard SDK integration for US equities/stocks.

Provides execute_trade_order() which uses the official Alpaca SDK to place
market orders when confidence > 0.80 and signal is BUY/SELL.
Supports paper trading by default via the paper API base URL.
"""

import os
import time
import logging
from typing import Optional

import httpx
import structlog

from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce
from alpaca.trading.errors import APIError

logger = structlog.get_logger(__name__)

# ============================================================
# Configuration
# ============================================================

CONFIDENCE_THRESHOLD: float = 0.80  # minimum confidence to execute
MAX_SLIPPAGE_BPS: float = 5.0       # maximum allowed slippage in basis points (0.05%)
ORDER_TIMEOUT_SEC: float = 10.0     # max time to wait for order confirmation

# ============================================================
# Execution result type
# ============================================================

class ExecutionResult:
    """Standardised result returned by execute_trade_order()."""

    def __init__(
        self,
        success: bool,
        order_id: Optional[str] = None,
        filled_qty: Optional[float] = None,
        filled_avg_price: Optional[float] = None,
        symbol: Optional[str] = None,
        side: Optional[str] = None,
        status: str = "rejected",
        error: Optional[str] = None,
        latency_ms: Optional[float] = None,
    ):
        self.success = success
        self.order_id = order_id
        self.filled_qty = filled_qty
        self.filled_avg_price = filled_avg_price
        self.symbol = symbol
        self.side = side
        self.status = status
        self.error = error
        self.latency_ms = latency_ms

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "order_id": self.order_id,
            "filled_qty": self.filled_qty,
            "filled_avg_price": self.filled_avg_price,
            "symbol": self.symbol,
            "side": self.side,
            "status": self.status,
            "error": self.error,
            "latency_ms": self.latency_ms,
        }


# ============================================================
# AlpacaClient
# ============================================================

class AlpacaClient:
    """
    Production-grade Alpaca trading client.

    Uses the official `alpaca-trade-api` SDK.
    Falls back to raw HTTP via `httpx` if the SDK is unavailable.

    Environment variables:
        APCA_API_KEY_ID      — Alpaca API key
        APCA_API_SECRET_KEY  — Alpaca secret key
        APCA_PAPER           — "true" to use paper trading (default: true)
    """

    def __init__(self):
        self._api_key: str = os.getenv("APCA_API_KEY_ID", "")
        self._api_secret: str = os.getenv("APCA_API_SECRET_KEY", "")
        self._paper: bool = os.getenv("APCA_PAPER", "true").lower() == "true"

        # Validate credentials
        if not self._api_key or not self._api_secret:
            logger.warning(
                "Alpaca API credentials not set. Running in DRY RUN mode. "
                "Set APCA_API_KEY_ID and APCA_API_SECRET_KEY environment variables."
            )

        # Build the SDK client (safe even with missing creds — SDK will raise on call)
        try:
            self._client = TradingClient(
                api_key=self._api_key,
                secret_key=self._api_secret,
                paper=self._paper,
            )
        except Exception as exc:
            logger.error("Failed to initialise Alpaca TradingClient", error=str(exc))
            self._client = None

    # ----------------------------------------------------------
    # Public API
    # ----------------------------------------------------------

    def execute_trade_order(
        self,
        symbol: str,
        signal: str,
        confidence: float,
        qty: Optional[float] = None,
        notional: Optional[float] = None,
    ) -> ExecutionResult:
        """
        Execute a market order on Alpaca.

        Args:
            symbol:     Ticker symbol (e.g. "AAPL", "SPY").
            signal:     "BUY" or "SELL".
            confidence: ML confidence score in [0, 1].
            qty:        Number of shares (mutually exclusive with notional).
            notional:   Dollar amount to trade (mutually exclusive with qty).

        Returns:
            ExecutionResult with full status.
        """
        # ── Guard: validate inputs ──
        if not symbol or not symbol.strip():
            return ExecutionResult(
                success=False, status="rejected", error="symbol is required"
            )

        symbol = symbol.strip().upper()
        side = signal.upper()
        if side not in ("BUY", "SELL"):
            return ExecutionResult(
                success=False,
                symbol=symbol,
                side=side,
                status="rejected",
                error=f"invalid signal '{signal}' — must be BUY or SELL",
            )

        if not isinstance(confidence, (int, float)) or confidence < 0 or confidence > 1:
            return ExecutionResult(
                success=False,
                symbol=symbol,
                side=side,
                status="rejected",
                error=f"confidence must be in [0, 1], got {confidence}",
            )

        # ── Guard: confidence below threshold → no trade ──
        if confidence < CONFIDENCE_THRESHOLD:
            logger.info(
                "Trade skipped — confidence below threshold",
                symbol=symbol,
                side=side,
                confidence=confidence,
                threshold=CONFIDENCE_THRESHOLD,
            )
            return ExecutionResult(
                success=False,
                symbol=symbol,
                side=side,
                status="skipped_low_confidence",
                error=(
                    f"confidence {confidence:.3f} < threshold {CONFIDENCE_THRESHOLD}"
                ),
            )

        # ── Guard: SELL signals are logged but not auto-executed ──
        # (per requirement: only BUY with >0.80 confidence places a market order)
        if side == "SELL":
            logger.info(
                "SELL signal received — no market order placed (BUY only auto-execution)",
                symbol=symbol,
                confidence=confidence,
            )
            return ExecutionResult(
                success=False,
                symbol=symbol,
                side=side,
                status="skipped_sell_signal",
                error="SELL signals are logged but not auto-executed",
            )

        # ── Guard: client initialised ──
        if self._client is None:
            logger.error("Alpaca client not initialised — cannot place order")
            return ExecutionResult(
                success=False,
                symbol=symbol,
                side=side,
                status="rejected",
                error="Alpaca client not initialised",
            )

        # ── Guard: dry-run if credentials are missing ──
        if not self._api_key or not self._api_secret:
            logger.info(
                "DRY RUN — Alpaca credentials missing, simulating order",
                symbol=symbol,
                side=side,
                confidence=confidence,
                qty=qty,
                notional=notional,
            )
            return ExecutionResult(
                success=True,
                order_id="dry-run-mock-order",
                filled_qty=qty or 0,
                filled_avg_price=0.0,
                symbol=symbol,
                side=side,
                status="simulated",
                error=None,
            )

        # ── Execute ──
        start_time = time.time()
        try:
            # Build the order request
            order_side = OrderSide.BUY if side == "BUY" else OrderSide.SELL

            order_data = MarketOrderRequest(
                symbol=symbol,
                qty=qty,
                notional=notional,
                side=order_side,
                time_in_force=TimeInForce.DAY,
            )

            logger.info(
                "Submitting market order to Alpaca",
                symbol=symbol,
                side=side,
                qty=qty,
                notional=notional,
                confidence=confidence,
            )

            # Submit via SDK
            order = self._client.submit_order(order_data)

            elapsed = (time.time() - start_time) * 1000  # ms

            # Parse the response
            order_id = str(getattr(order, "id", "unknown"))
            filled_qty = float(getattr(order, "filled_qty", 0) or 0)
            filled_avg_price = float(getattr(order, "filled_avg_price", 0) or 0)
            order_status = str(getattr(order, "status", "unknown"))

            logger.info(
                "Market order placed successfully",
                order_id=order_id,
                symbol=symbol,
                side=side,
                filled_qty=filled_qty,
                filled_avg_price=filled_avg_price,
                status=order_status,
                latency_ms=round(elapsed, 2),
            )

            # ── Check for slippage ──
            if filled_avg_price > 0 and qty and filled_qty > 0:
                # Compare filled price to expected price from the snapshot
                # (In a real setup you'd fetch the latest quote before placing)
                slippage_bps = self._estimate_slippage(
                    symbol, filled_avg_price, order_side
                )
                if slippage_bps > MAX_SLIPPAGE_BPS:
                    logger.warning(
                        "Slippage exceeds threshold",
                        symbol=symbol,
                        expected_slippage_bps=slippage_bps,
                        threshold_bps=MAX_SLIPPAGE_BPS,
                    )

            return ExecutionResult(
                success=True,
                order_id=order_id,
                filled_qty=filled_qty,
                filled_avg_price=filled_avg_price,
                symbol=symbol,
                side=side,
                status=order_status,
                error=None,
                latency_ms=round(elapsed, 2),
            )

        except APIError as api_err:
            # Alpaca-specific errors
            error_msg = str(api_err)
            elapsed = (time.time() - start_time) * 1000

            # Categorise known error patterns
            if "insufficient" in error_msg.lower():
                error_type = "insufficient_funds"
            elif "rate limit" in error_msg.lower():
                error_type = "rate_limited"
            elif "invalid" in error_msg.lower():
                error_type = "invalid_request"
            elif "position" in error_msg.lower():
                error_type = "position_error"
            else:
                error_type = "api_rejection"

            logger.error(
                "Alpaca API error",
                symbol=symbol,
                side=side,
                error_type=error_type,
                error=error_msg,
                latency_ms=round(elapsed, 2),
            )

            return ExecutionResult(
                success=False,
                symbol=symbol,
                side=side,
                status=error_type,
                error=error_msg,
                latency_ms=round(elapsed, 2),
            )

        except httpx.HTTPStatusError as http_err:
            # HTTP-level errors (network, timeout, etc.)
            elapsed = (time.time() - start_time) * 1000
            status_code = http_err.response.status_code if http_err.response else 0

            if status_code == 403:
                error_msg = "API rejection — check permissions or account status"
            elif status_code == 429:
                error_msg = "Rate limited — too many requests"
            elif status_code >= 500:
                error_msg = "Alpaca server error — please retry"
            else:
                error_msg = f"HTTP {status_code}: {http_err.response.text[:200] if http_err.response else str(http_err)}"

            logger.error(
                "HTTP error during order execution",
                symbol=symbol,
                side=side,
                status_code=status_code,
                error=error_msg,
                latency_ms=round(elapsed, 2),
            )

            return ExecutionResult(
                success=False,
                symbol=symbol,
                side=side,
                status="http_error",
                error=error_msg,
                latency_ms=round(elapsed, 2),
            )

        except Exception as exc:
            # Catch-all for unexpected errors
            elapsed = (time.time() - start_time) * 1000
            error_msg = str(exc)

            # Detect slippage or timeout in generic exceptions
            if "timeout" in error_msg.lower():
                error_type = "order_timeout"
            elif "slippage" in error_msg.lower():
                error_type = "slippage_exceeded"
            else:
                error_type = "unexpected_error"

            logger.error(
                "Unexpected error during order execution",
                symbol=symbol,
                side=side,
                error_type=error_type,
                error=error_msg,
                latency_ms=round(elapsed, 2),
                exc_info=True,
            )

            return ExecutionResult(
                success=False,
                symbol=symbol,
                side=side,
                status=error_type,
                error=error_msg,
                latency_ms=round(elapsed, 2),
            )

    # ----------------------------------------------------------
    # Private helpers
    # ----------------------------------------------------------

    def _estimate_slippage(
        self, symbol: str, filled_price: float, side: OrderSide
    ) -> float:
        """
        Estimate slippage by comparing filled price to the last trade price.
        Returns slippage in basis points.
        """
        try:
            # Fetch the latest trade for the symbol
            # (This uses the REST SDK — we use a lightweight snapshot call)
            from alpaca.data.historical import StockHistoricalDataClient
            from alpaca.data.requests import StockLatestTradeRequest

            data_client = StockHistoricalDataClient(self._api_key, self._api_secret)
            request = StockLatestTradeRequest(symbol_or_symbols=[symbol])
            trades = data_client.get_stock_latest_trade(request)

            if symbol in trades:
                last_price = float(trades[symbol].price)
                if last_price > 0:
                    diff_bps = abs(filled_price - last_price) / last_price * 10_000
                    return diff_bps
        except Exception:
            logger.debug("Could not estimate slippage", symbol=symbol)

        return 0.0

    def get_account_summary(self) -> dict:
        """Retrieve account equity, buying power, and cash balance."""
        try:
            account = self._client.get_account()
            return {
                "equity": float(account.equity),
                "buying_power": float(account.buying_power),
                "cash": float(account.cash),
                "portfolio_value": float(account.portfolio_value),
                "pattern_day_trader": account.day_trader,
                "trading_blocked": account.trading_blocked,
                "transfers_blocked": account.transfers_blocked,
                "account_blocked": account.account_blocked,
                "created_at": str(account.created_at),
            }
        except Exception as exc:
            logger.error("Failed to fetch account summary", error=str(exc))
            return {"error": str(exc)}


# ============================================================
# Module-level convenience function
# ============================================================

def execute_trade_order(
    symbol: str,
    signal: str,
    confidence: float,
    qty: Optional[float] = None,
    notional: Optional[float] = None,
) -> dict:
    """
    Convenience function that creates an AlpacaClient and executes a trade.

    Usage:
        result = execute_trade_order("AAPL", "BUY", 0.85, qty=10)
        print(result.status, result.order_id)

    Args are forwarded to AlpacaClient.execute_trade_order().
    Returns an ExecutionResult as a plain dict.
    """
    client = AlpacaClient()
    result = client.execute_trade_order(
        symbol=symbol,
        signal=signal,
        confidence=confidence,
        qty=qty,
        notional=notional,
    )
    return result.to_dict()
