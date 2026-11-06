from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

import structlog

from app.broker.base import (
    Broker,
    PermanentBrokerError,
    TransientBrokerError,
)
from app.config import Settings
from app.domain import (
    OrderIntent,
    OrderStatus,
    ProcessOutcome,
    SignalEnvelope,
    SignalRejected,
)
from app.observability import Metrics
from app.risk.gate import RiskGate
from app.state.store import OrderRecord, OrderStore

logger = structlog.get_logger(__name__)


class ExecutionGateway:
    def __init__(
        self,
        settings: Settings,
        broker: Broker,
        store: OrderStore,
        gate: RiskGate,
        metrics: Metrics,
    ) -> None:
        self._settings = settings
        self._broker = broker
        self._store = store
        self._gate = gate
        self._metrics = metrics

    async def process(self, entry_id: str, fields: dict) -> ProcessOutcome:
        self._metrics.mark_signal()
        self._metrics.inc("signals_received")

        try:
            signal = SignalEnvelope.from_stream_entry(entry_id, fields)
        except SignalRejected as exc:
            # Normal riders are skipped; executable=true with dispatchable=false
            # is an internal contradiction and is dead-lettered for audit.
            skip_codes = {"NOT_EXECUTABLE", "MARKET_WAITING"}
            if exc.code in skip_codes or (
                exc.code == "DIRECTION_MISSING" and _payload_market_waiting(fields)
            ):
                self._metrics.inc(f"skipped.{exc.code}")
                return ProcessOutcome(
                    ack=True,
                    status="SKIPPED",
                    reason=exc.code,
                    detail=exc.detail,
                )
            await self._record_invalid(entry_id, fields, exc.code, exc.detail)
            self._metrics.inc(f"rejected.{exc.code}")
            logger.warning(
                "SIGNAL_REJECTED",
                event_id=entry_id,
                code=exc.code,
                detail=exc.detail,
            )
            return ProcessOutcome(
                ack=True,
                status="REJECTED",
                reason=exc.code,
                detail=exc.detail,
                dead_letter=True,
            )

        dedupe_key = signal.dedupe_key(self._settings.DEDUPE_WINDOW_SECONDS)
        if self._settings.TRADING_MODE == "disabled":
            await self._record_rejection(
                signal, dedupe_key, "TRADING_DISABLED", "TRADING_MODE=disabled"
            )
            self._metrics.inc("rejected.TRADING_DISABLED")
            return ProcessOutcome(
                ack=True,
                status="REJECTED",
                reason="TRADING_DISABLED",
            )

        # `signal.event_id` prefers the publisher's stable contract id; only
        # legacy entries without one fall back to the Redis stream id.
        existing = await self._store.get_by_event(signal.event_id)
        if existing is not None:
            self._metrics.inc("signals_replayed")
            return await self._handle_existing(existing)

        duplicate = await self._store.get_by_dedupe(dedupe_key)
        if duplicate is not None:
            self._metrics.inc("rejected.DUPLICATE_SIGNAL")
            return ProcessOutcome(
                ack=True,
                status="DUPLICATE",
                reason="DUPLICATE_SIGNAL",
                detail=f"dedupe key already processed as {duplicate.status}",
            )

        try:
            account = await self._broker.account_snapshot()
        except (TransientBrokerError, PermanentBrokerError) as exc:
            self._metrics.error(f"account_snapshot: {exc}")
            return ProcessOutcome(ack=False, status="RETRY", reason="BROKER_UNAVAILABLE")

        day_start = _day_start()
        daily_equity = await self._store.observe_equity(day_start, account.equity)
        stats = await self._store.daily_stats(day_start)
        local_exposure = await self._store.open_exposure()
        if local_exposure > account.open_notional:
            account = account.model_copy(update={"open_notional": local_exposure})
        decision = await self._gate.evaluate(
            signal, account, stats, dedupe_key, daily_equity=daily_equity
        )
        if not decision.allowed:
            await self._record_rejection(signal, dedupe_key, decision.code, decision.detail)
            self._metrics.inc(f"rejected.{decision.code}")
            logger.info(
                "SIGNAL_DENIED",
                event_id=signal.event_id,
                symbol=signal.symbol,
                side=signal.side,
                code=decision.code,
                detail=decision.detail,
            )
            return ProcessOutcome(
                ack=True,
                status="REJECTED",
                reason=decision.code,
                detail=decision.detail,
            )

        intent = OrderIntent.build(
            signal,
            quantity=decision.quantity,
            notional=decision.notional,
            dedupe_key=dedupe_key,
        )
        record, created = await self._store.insert_intent(intent)
        if not created:
            self._metrics.inc("signals_replayed")
            return await self._handle_existing(record)
        return await self._submit(record, intent)

    async def _submit(self, record: OrderRecord, intent: OrderIntent) -> ProcessOutcome:
        try:
            order = await self._broker.place_order(intent)
        except TransientBrokerError as exc:
            attempts = await self._store.mark_attempt(record.event_id, f"transient: {exc}")
            self._metrics.error(f"place_order transient: {exc}")
            if attempts >= self._settings.MAX_SUBMIT_ATTEMPTS:
                await self._store.mark_status(
                    record.event_id,
                    OrderStatus.MANUAL_REVIEW,
                    reason=f"max submit attempts reached: {exc}",
                )
                self._metrics.inc("manual_review")
                return ProcessOutcome(
                    ack=True,
                    status="MANUAL_REVIEW",
                    reason="MAX_SUBMIT_ATTEMPTS",
                    detail=str(exc),
                )
            await self._store.mark_status(
                record.event_id, OrderStatus.UNKNOWN, reason=f"transient: {exc}"
            )
            return ProcessOutcome(ack=False, status="RETRY", reason="TRANSIENT_BROKER_ERROR")
        except PermanentBrokerError as exc:
            await self._store.mark_status(
                record.event_id, OrderStatus.REJECTED, reason=str(exc)
            )
            self._metrics.inc("rejected.BROKER_REJECTED")
            logger.error("ORDER_REJECTED", event_id=record.event_id, error=str(exc))
            return ProcessOutcome(
                ack=True, status="REJECTED", reason="BROKER_REJECTED", detail=str(exc)
            )

        await self._store.mark_status(
            record.event_id,
            order.status,
            broker_order_id=order.broker_order_id,
            reason=order.reason,
            filled_quantity=order.filled_quantity,
            average_price=order.average_price,
        )
        self._metrics.inc(f"orders.{order.status.value}")
        logger.info(
            "ORDER_UPDATED",
            event_id=record.event_id,
            client_order_id=intent.client_order_id,
            broker_order_id=order.broker_order_id,
            status=order.status.value,
            symbol=intent.symbol,
            side=intent.side,
            quantity=intent.quantity,
            notional=intent.notional,
        )
        if order.status == OrderStatus.FILLED:
            outcome_status = "EXECUTED"
        elif order.status.terminal:
            outcome_status = "CLOSED"
        else:
            outcome_status = "SUBMITTED"
        return ProcessOutcome(
            ack=True,
            status=outcome_status,
            reason=order.status.value,
        )

    async def _handle_existing(self, record: OrderRecord) -> ProcessOutcome:
        status = _as_status(record.status)
        if status.terminal:
            return ProcessOutcome(
                ack=True,
                status="REPLAY",
                reason=record.status,
                detail=record.reason,
            )
        if self._settings.TRADING_MODE == "disabled":
            return ProcessOutcome(
                ack=True,
                status="REPLAY",
                reason="TRADING_DISABLED",
                detail="pending order left untouched while execution is disabled",
            )
        intent = _intent_from_record(record)
        try:
            reconciled = await self._broker.fetch_order(intent, record.broker_order_id)
        except TransientBrokerError as exc:
            self._metrics.error(f"fetch_order transient: {exc}")
            return ProcessOutcome(ack=False, status="RETRY", reason="BROKER_UNAVAILABLE")
        except PermanentBrokerError as exc:
            await self._store.mark_status(
                record.event_id, OrderStatus.MANUAL_REVIEW, reason=str(exc)
            )
            return ProcessOutcome(
                ack=True, status="MANUAL_REVIEW", reason="RECONCILE_FAILED", detail=str(exc)
            )

        if reconciled is not None:
            await self._store.mark_status(
                record.event_id,
                reconciled.status,
                broker_order_id=reconciled.broker_order_id,
                reason=reconciled.reason,
                filled_quantity=reconciled.filled_quantity,
                average_price=reconciled.average_price,
            )
            return ProcessOutcome(
                ack=True,
                status="REPLAY",
                reason=reconciled.status.value,
            )

        if status in {OrderStatus.SUBMITTED, OrderStatus.PARTIALLY_FILLED}:
            if _signal_age_ms(record) > self._settings.ORDER_POLL_TIMEOUT_MS:
                await self._store.mark_status(
                    record.event_id,
                    OrderStatus.MANUAL_REVIEW,
                    reason="broker order unresolved beyond ORDER_POLL_TIMEOUT_MS",
                )
                self._metrics.inc("manual_review")
                return ProcessOutcome(
                    ack=True,
                    status="MANUAL_REVIEW",
                    reason="ORDER_NOT_VISIBLE",
                )
            return ProcessOutcome(
                ack=False,
                status="RETRY",
                reason="ORDER_NOT_VISIBLE_YET",
            )

        capabilities = self._broker.capabilities()
        can_retry = (
            capabilities.supports_client_order_id
            and record.attempts < self._settings.MAX_SUBMIT_ATTEMPTS
        )
        if can_retry:
            if _signal_age_ms(record) > self._settings.MAX_RECONCILE_AGE_MS:
                await self._store.mark_status(
                    record.event_id,
                    OrderStatus.MANUAL_REVIEW,
                    reason="pending order exceeded MAX_RECONCILE_AGE_MS",
                )
                self._metrics.inc("manual_review")
                return ProcessOutcome(
                    ack=True,
                    status="MANUAL_REVIEW",
                    reason="PENDING_TOO_OLD",
                )
            if await self._gate.kill_switch_active():
                await self._store.mark_status(
                    record.event_id,
                    OrderStatus.MANUAL_REVIEW,
                    reason="kill switch engaged before pending order retry",
                )
                return ProcessOutcome(
                    ack=True,
                    status="MANUAL_REVIEW",
                    reason="KILL_SWITCH_ACTIVE",
                )
            return await self._submit(record, intent)

        attempts = await self._store.mark_attempt(record.event_id, "unresolved order")
        if attempts >= self._settings.MAX_SUBMIT_ATTEMPTS:
            await self._store.mark_status(
                record.event_id,
                OrderStatus.MANUAL_REVIEW,
                reason="order could not be reconciled with the broker",
            )
            self._metrics.inc("manual_review")
            return ProcessOutcome(
                ack=True,
                status="MANUAL_REVIEW",
                reason="UNRECONCILED_ORDER",
            )
        return ProcessOutcome(ack=False, status="RETRY", reason="UNRECONCILED_ORDER")

    async def reconcile_pending(self) -> None:
        for record in await self._store.pending_orders():
            try:
                await self._handle_existing(record)
            except Exception as exc:
                self._metrics.error(f"reconcile_pending: {exc}")
                logger.error(
                    "RECONCILE_PENDING_FAILED",
                    event_id=record.event_id,
                    error=str(exc),
                )

    async def _record_rejection(
        self, signal: SignalEnvelope, dedupe_key: str, code: str, detail: str
    ) -> None:
        await self._store.record_rejection(
            event_id=signal.event_id,
            dedupe_key=dedupe_key,
            signal_id=signal.signal_id,
            symbol=signal.symbol,
            side=signal.side,
            confidence=signal.confidence,
            signal_ts=signal.timestamp.isoformat(),
            reason=f"{code}: {detail}",
            raw_signal=signal.raw,
        )

    async def _record_invalid(
        self, entry_id: str, fields: dict, code: str, detail: str
    ) -> None:
        payload = fields.get("payload") if isinstance(fields, dict) else None
        raw: dict = {}
        if isinstance(payload, str):
            try:
                parsed = json.loads(payload)
                if isinstance(parsed, dict):
                    raw = parsed
            except Exception:
                raw = {"payload": payload}
        elif isinstance(payload, dict):
            raw = payload
        else:
            raw = dict(fields) if isinstance(fields, dict) else {}

        symbol = str(raw.get("symbol") or "UNKNOWN").upper()
        side = str(raw.get("signal_type") or raw.get("signalType") or raw.get("signal") or "UNKNOWN").upper()
        try:
            confidence = float(raw.get("confidence") or 0.0)
        except (TypeError, ValueError):
            confidence = 0.0
        dedupe_key = f"invalid-{hashlib.sha256(entry_id.encode()).hexdigest()[:24]}"
        try:
            await self._store.record_rejection(
                event_id=entry_id,
                dedupe_key=dedupe_key,
                signal_id=str(raw.get("signal_id")) if raw.get("signal_id") else None,
                symbol=symbol,
                side=side,
                confidence=confidence,
                signal_ts=datetime.now(timezone.utc).isoformat(),
                reason=f"{code}: {detail}",
                raw_signal=raw,
            )
        except Exception as exc:
            self._metrics.error(f"record_invalid: {exc}")


def _payload_market_waiting(fields: dict) -> bool:
    if not isinstance(fields, dict):
        return False
    payload = fields.get("payload")
    if payload is None:
        payload = fields
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            return False
    return isinstance(payload, dict) and payload.get("market_waiting") is True


def _day_start() -> datetime:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def _as_status(value: str) -> OrderStatus:
    try:
        return OrderStatus(value)
    except ValueError:
        return OrderStatus.UNKNOWN


def _signal_age_ms(record: OrderRecord) -> float:
    try:
        return (
            datetime.now(timezone.utc) - datetime.fromisoformat(record.signal_ts)
        ).total_seconds() * 1000.0
    except ValueError:
        return float("inf")


def _intent_from_record(record: OrderRecord) -> OrderIntent:
    return OrderIntent(
        event_id=record.event_id,
        client_order_id=record.client_order_id,
        signal_id=record.signal_id,
        symbol=record.symbol,
        side=record.side,
        quantity=record.quantity,
        notional=record.notional,
        reference_price=record.reference_price,
        confidence=record.confidence,
        signal_timestamp=datetime.fromisoformat(record.signal_ts),
        dedupe_key=record.dedupe_key,
        raw_signal={},
    )
