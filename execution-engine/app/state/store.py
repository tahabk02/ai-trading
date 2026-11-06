from __future__ import annotations

import asyncio
import json
import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.domain import OrderIntent, OrderStatus


@dataclass(frozen=True)
class OrderRecord:
    event_id: str
    dedupe_key: str
    signal_id: str | None
    symbol: str
    side: str
    quantity: float
    notional: float
    reference_price: float
    confidence: float
    signal_ts: str
    client_order_id: str
    broker_order_id: str | None
    status: str
    reason: str | None
    attempts: int
    filled_quantity: float
    average_price: float | None


@dataclass(frozen=True)
class DailyStats:
    trades_today: int
    notional_today: float


@dataclass(frozen=True)
class DailyEquity:
    """Restart-safe opening equity for one UTC day.

    ``starting_equity`` is written exactly once per day (the first observed
    snapshot). Every later snapshot only advances ``last_equity``, so a
    mid-day process restart cannot reset the loss budget to zero.
    """

    day: str
    starting_equity: float
    last_equity: float
    updated_at: str

    @property
    def loss(self) -> float:
        """Positive number means the account is down on the day."""
        return self.starting_equity - self.last_equity


_SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
    event_id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL,
    signal_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity REAL NOT NULL,
    notional REAL NOT NULL,
    reference_price REAL NOT NULL,
    confidence REAL NOT NULL,
    signal_ts TEXT NOT NULL,
    client_order_id TEXT NOT NULL,
    broker_order_id TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    filled_quantity REAL NOT NULL DEFAULT 0,
    average_price REAL,
    raw_signal TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
DROP INDEX IF EXISTS idx_orders_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_dedupe ON orders(dedupe_key) WHERE status != 'REJECTED';
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_id ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS daily_equity (
    day TEXT PRIMARY KEY,
    starting_equity REAL NOT NULL,
    last_equity REAL NOT NULL,
    updated_at TEXT NOT NULL
);
"""


class OrderStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._connection: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()

    async def init(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(self._init_sync)

    def _init_sync(self) -> None:
        connection = sqlite3.connect(self._path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.executescript(_SCHEMA)
        connection.commit()
        self._connection = connection

    async def close(self) -> None:
        if self._connection is not None:
            connection = self._connection
            self._connection = None
            await asyncio.to_thread(connection.close)

    def _require(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("order store is not initialised")
        return self._connection

    async def _call(self, fn, *args):
        async with self._lock:
            return await asyncio.to_thread(fn, *args)

    async def get_by_event(self, event_id: str) -> OrderRecord | None:
        return await self._call(self._get_by_event, event_id)

    def _get_by_event(self, event_id: str) -> OrderRecord | None:
        row = self._require().execute(
            "SELECT * FROM orders WHERE event_id = ?", (event_id,)
        ).fetchone()
        return _row_to_record(row) if row else None

    async def get_by_dedupe(self, dedupe_key: str) -> OrderRecord | None:
        return await self._call(self._get_by_dedupe, dedupe_key)

    def _get_by_dedupe(self, dedupe_key: str) -> OrderRecord | None:
        row = self._require().execute(
            "SELECT * FROM orders WHERE dedupe_key = ? AND status != 'REJECTED'", (dedupe_key,)
        ).fetchone()
        return _row_to_record(row) if row else None

    async def insert_intent(self, intent: OrderIntent) -> tuple[OrderRecord, bool]:
        return await self._call(self._insert_intent, intent)

    def _insert_intent(self, intent: OrderIntent) -> tuple[OrderRecord, bool]:
        connection = self._require()
        now = datetime.now(timezone.utc).isoformat()
        cursor = connection.execute(
            """
            INSERT OR IGNORE INTO orders (
                event_id, dedupe_key, signal_id, symbol, side, quantity, notional,
                reference_price, confidence, signal_ts, client_order_id, status,
                attempts, raw_signal, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                intent.event_id,
                intent.dedupe_key,
                intent.signal_id,
                intent.symbol,
                intent.side,
                intent.quantity,
                intent.notional,
                intent.reference_price,
                intent.confidence,
                intent.signal_timestamp.isoformat(),
                intent.client_order_id,
                OrderStatus.INTENT.value,
                json.dumps(intent.raw_signal, default=str),
                now,
                now,
            ),
        )
        connection.commit()
        created = cursor.rowcount > 0
        record = self._get_by_event(intent.event_id) or self._get_by_dedupe(
            intent.dedupe_key
        )
        if record is None:
            raise RuntimeError("insert_intent did not persist a record")
        return record, created

    async def record_rejection(
        self,
        *,
        event_id: str,
        dedupe_key: str,
        signal_id: str | None,
        symbol: str,
        side: str,
        confidence: float,
        signal_ts: str,
        reason: str,
        raw_signal: dict,
    ) -> OrderRecord:
        return await self._call(
            self._record_rejection,
            event_id,
            dedupe_key,
            signal_id,
            symbol,
            side,
            confidence,
            signal_ts,
            reason,
            raw_signal,
        )

    def _record_rejection(
        self,
        event_id: str,
        dedupe_key: str,
        signal_id: str | None,
        symbol: str,
        side: str,
        confidence: float,
        signal_ts: str,
        reason: str,
        raw_signal: dict,
    ) -> OrderRecord:
        connection = self._require()
        now = datetime.now(timezone.utc).isoformat()
        connection.execute(
            """
            INSERT OR IGNORE INTO orders (
                event_id, dedupe_key, signal_id, symbol, side, quantity, notional,
                reference_price, confidence, signal_ts, client_order_id, status,
                reason, attempts, raw_signal, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                event_id,
                dedupe_key,
                signal_id,
                symbol,
                side,
                confidence,
                signal_ts,
                f"rejected-{event_id}",
                OrderStatus.REJECTED.value,
                reason,
                json.dumps(raw_signal, default=str),
                now,
                now,
            ),
        )
        connection.commit()
        record = self._get_by_event(event_id)
        if record is None:
            raise RuntimeError("rejection was not persisted")
        return record

    async def mark_status(
        self,
        event_id: str,
        status: OrderStatus,
        *,
        broker_order_id: str | None = None,
        reason: str | None = None,
        filled_quantity: float | None = None,
        average_price: float | None = None,
    ) -> None:
        await self._call(
            self._mark_status,
            event_id,
            status,
            broker_order_id,
            reason,
            filled_quantity,
            average_price,
        )

    def _mark_status(
        self,
        event_id: str,
        status: OrderStatus,
        broker_order_id: str | None,
        reason: str | None,
        filled_quantity: float | None,
        average_price: float | None,
    ) -> None:
        connection = self._require()
        connection.execute(
            """
            UPDATE orders SET
                status = ?,
                broker_order_id = COALESCE(?, broker_order_id),
                reason = COALESCE(?, reason),
                filled_quantity = COALESCE(?, filled_quantity),
                average_price = COALESCE(?, average_price),
                updated_at = ?
            WHERE event_id = ?
            """,
            (
                status.value,
                broker_order_id,
                reason,
                filled_quantity,
                average_price,
                datetime.now(timezone.utc).isoformat(),
                event_id,
            ),
        )
        connection.commit()

    async def mark_attempt(self, event_id: str, reason: str) -> int:
        return await self._call(self._mark_attempt, event_id, reason)

    def _mark_attempt(self, event_id: str, reason: str) -> int:
        connection = self._require()
        connection.execute(
            """
            UPDATE orders SET attempts = attempts + 1, reason = ?, updated_at = ?
            WHERE event_id = ?
            """,
            (reason, datetime.now(timezone.utc).isoformat(), event_id),
        )
        connection.commit()
        row = connection.execute(
            "SELECT attempts FROM orders WHERE event_id = ?", (event_id,)
        ).fetchone()
        return int(row["attempts"]) if row else 0

    async def daily_stats(self, day_start: datetime) -> DailyStats:
        return await self._call(self._daily_stats, day_start.isoformat())

    def _daily_stats(self, day_start: str) -> DailyStats:
        row = self._require().execute(
            """
            SELECT
                SUM(CASE WHEN status IN ('FILLED', 'PARTIALLY_FILLED') THEN 1 ELSE 0 END) AS trades,
                SUM(CASE WHEN status IN ('FILLED', 'PARTIALLY_FILLED') THEN notional ELSE 0 END) AS notional
            FROM orders
            WHERE created_at >= ?
            """,
            (day_start,),
        ).fetchone()
        return DailyStats(
            trades_today=int(row["trades"] or 0),
            notional_today=float(row["notional"] or 0.0),
        )

    async def observe_equity(
        self, day_start: datetime, equity: float
    ) -> DailyEquity | None:
        """Record a real account snapshot for the UTC day.

        Returns ``None`` for a non-finite / non-positive equity instead of
        persisting garbage: the risk gate treats a missing observation as
        fail-closed when a live daily-loss limit is configured.
        """
        return await self._call(self._observe_equity, day_start.isoformat(), equity)

    def _observe_equity(self, day_start: str, equity: float) -> DailyEquity | None:
        if not math.isfinite(equity) or equity <= 0.0:
            return None
        day = day_start[:10]
        now = datetime.now(timezone.utc).isoformat()
        connection = self._require()
        connection.execute(
            """
            INSERT OR IGNORE INTO daily_equity (
                day, starting_equity, last_equity, updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            (day, equity, equity, now),
        )
        connection.execute(
            """
            UPDATE daily_equity
            SET last_equity = ?, updated_at = ?
            WHERE day = ?
            """,
            (equity, now, day),
        )
        connection.commit()
        row = connection.execute(
            "SELECT * FROM daily_equity WHERE day = ?", (day,)
        ).fetchone()
        return _row_to_daily_equity(row) if row else None

    async def daily_equity(self, day_start: datetime) -> DailyEquity | None:
        return await self._call(self._daily_equity, day_start.isoformat())

    def _daily_equity(self, day_start: str) -> DailyEquity | None:
        row = self._require().execute(
            "SELECT * FROM daily_equity WHERE day = ?", (day_start[:10],)
        ).fetchone()
        return _row_to_daily_equity(row) if row else None

    async def open_exposure(self) -> float:
        return await self._call(self._open_exposure)

    def _open_exposure(self) -> float:
        row = self._require().execute(
            """
            SELECT COALESCE(SUM(notional), 0) AS exposure
            FROM orders
            WHERE status IN ('INTENT', 'UNKNOWN', 'SUBMITTED', 'PARTIALLY_FILLED')
            """
        ).fetchone()
        return float(row["exposure"] or 0.0)

    async def pending_orders(self) -> list[OrderRecord]:
        return await self._call(self._pending_orders)

    def _pending_orders(self) -> list[OrderRecord]:
        rows = self._require().execute(
            """
            SELECT * FROM orders
            WHERE status IN ('INTENT', 'UNKNOWN', 'SUBMITTED', 'PARTIALLY_FILLED')
            ORDER BY created_at ASC
            """
        ).fetchall()
        return [_row_to_record(row) for row in rows]


def _row_to_daily_equity(row: sqlite3.Row) -> DailyEquity:
    return DailyEquity(
        day=str(row["day"]),
        starting_equity=float(row["starting_equity"]),
        last_equity=float(row["last_equity"]),
        updated_at=str(row["updated_at"]),
    )


def _row_to_record(row: sqlite3.Row) -> OrderRecord:
    return OrderRecord(
        event_id=row["event_id"],
        dedupe_key=row["dedupe_key"],
        signal_id=row["signal_id"],
        symbol=row["symbol"],
        side=row["side"],
        quantity=float(row["quantity"]),
        notional=float(row["notional"]),
        reference_price=float(row["reference_price"]),
        confidence=float(row["confidence"]),
        signal_ts=row["signal_ts"],
        client_order_id=row["client_order_id"],
        broker_order_id=row["broker_order_id"],
        status=row["status"],
        reason=row["reason"],
        attempts=int(row["attempts"]),
        filled_quantity=float(row["filled_quantity"]),
        average_price=float(row["average_price"]) if row["average_price"] is not None else None,
    )
