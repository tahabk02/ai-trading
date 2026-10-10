"""
signal_lock.py — AUTHORITATIVE EXPIRY-SCOPED SIGNAL LOCK (Redis-backed)

WHY THIS EXISTS
---------------
Binary options are a COMMIT-AT-ENTRY product: the direction the operator acts on
must be the one evaluated for the horizon they selected. The engine recomputed
and re-dispatched a fresh verdict on every 1-second tick, so the contract the
operator was acting on was repainted mid-expiry (the reported TGT/ANC and
direction flickering).

The client already freezes the verdict for display, but a client lock is only
cosmetic: the engine kept recomputing, and any other writer (REST /predict, a
second browser tab, the WS fan-out) could still overwrite what is displayed.

This module makes the lock AUTHORITATIVE at the point of calculation, so
"stable for the selected expiry" is a property of the engine rather than of one
UI. While a verdict is locked for an expiry, the engine RETURNS THE LOCKED
VERDICT and SKIPS RECOMPUTATION — which also protects the inference budget
(AI_ENGINE_INFERENCE_BUDGET_MS) that a 1 Hz cadence would otherwise burn.

WHY REDIS AND NOT A DICT
------------------------
A module-level dict is per-process. The engine runs as a single uvicorn process
today, so an in-memory lock would appear to work and then SILENTLY BREAK the
first time anyone runs ``uvicorn --workers N``, deploys a second replica, or
adds a rolling update with two pods live. That is a correctness cliff of exactly
the kind this change exists to remove, so the lock is shared through Redis
(already a dependency: see app/messaging/publisher.py).

If Redis is unavailable the lock degrades to an in-process map so a local dev
environment still gets lock semantics rather than an exception. That fallback is
correct for a single process and is explicitly documented as such.

LOCK IDENTITY
-------------
Bound to (symbol, asset_class, horizon_minutes, expiration_seconds):
  * symbol        — a verdict graded for EUR/USD must never serve EUR/JPY.
  * asset_class   — OTC / REAL / CRYPTO have different strategies; a crypto
                    breakout verdict must not serve an FX symbol.
  * horizon       — 1m and 10m are different contracts.
  * expiration    — the selected expiry IS the lock duration.

Expiry is self-enforcing via the Redis TTL: there is no background sweeper, so
a crashed process cannot leak a lock. The stored payload also carries
``expires_at_ms`` and is re-checked on read, which protects against a Redis TTL
that outlives the contract (clock skew, a paused VM, an explicit longer TTL).
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

import structlog

from .asset_class import resolve_asset_class
from ..core.config import settings

logger = structlog.get_logger(__name__)

# Redis key namespace. Bumping the prefix invalidates every live lock, which is
# the intended lever when the verdict contract itself changes.
KEY_PREFIX = "siglock:v1"

# Extra seconds a lock survives past its contract expiry. Redis needs a TTL to
# avoid leaking, but the payload expiry is the real deadline, so the TTL is only
# a small grace for clock skew — never a way to extend the contract.
TTL_GRACE_SECONDS = 5

# Supported horizon (minutes) -> contract expiry (seconds).
# This is the exact inverse of the client's expirySecondsToHorizonMinutes()
# (60/120/180/300/600 -> 1/2/3/5/10), so the server's lock duration and the
# button the operator pressed are always the same contract. A test asserts the
# two tables agree rather than trusting this comment.
HORIZON_TO_EXPIRATION_SECONDS: Dict[int, int] = {
    1: 60,
    2: 120,
    3: 180,
    5: 300,
    10: 600,
}


def resolve_expiration_seconds(horizon_minutes: Any) -> int:
    """Expiry seconds for a horizon, snapped to a supported option.

    Unknown horizons fall back to the shortest supported expiry rather than to
    a long one: a lock that is too short costs a re-evaluation, while a lock
    that is too long would hold a stale contract past what the operator
    selected.
    """
    try:
        hz = int(horizon_minutes)
    except (TypeError, ValueError):
        hz = 0
    if hz in HORIZON_TO_EXPIRATION_SECONDS:
        return HORIZON_TO_EXPIRATION_SECONDS[hz]
    supported = sorted(HORIZON_TO_EXPIRATION_SECONDS)
    nearest = min(supported, key=lambda s: (abs(s - hz), s))
    return HORIZON_TO_EXPIRATION_SECONDS[nearest]


def _key(identity: Dict[str, Any]) -> str:
    return ":".join(
        [
            KEY_PREFIX,
            str(identity.get("symbol") or "").strip().upper(),
            str(identity.get("asset_class") or "").strip().upper(),
            str(int(identity.get("horizon_minutes") or 0)),
            str(int(identity.get("expiration_seconds") or 0)),
        ]
    )


def build_identity(
    symbol: Any,
    horizon_minutes: Any,
    expiration_seconds: Any,
) -> Dict[str, Any]:
    """Normalise a lock identity. Class resolution is delegated to the single
    source of truth in :mod:`app.services.asset_class` so the lock can never
    disagree with the router about what a symbol is."""
    try:
        hz = int(float(horizon_minutes))
    except (TypeError, ValueError):
        hz = 0
    try:
        exp = int(float(expiration_seconds))
    except (TypeError, ValueError):
        exp = 0
    return {
        "symbol": str(symbol or "").strip().upper(),
        "asset_class": resolve_asset_class(symbol),
        "horizon_minutes": hz,
        "expiration_seconds": exp,
    }


#: The only two values that constitute an actionable contract. Anything else
#: (None, "", "HOLD", "NEUTRAL", an error sentinel) is an honest "no position"
#: answer and must never be frozen for the whole expiry window.
DIRECTIONAL_SIGNALS = ("BUY", "SELL")


def is_committable_verdict(verdict: Dict[str, Any]) -> bool:
    """True when ``verdict`` is an actionable, lockable contract.

    A lock freezes a verdict for up to the full expiry window (1-10 minutes) and
    is served verbatim to every subsequent request in that window. Committing a
    NON-verdict is therefore actively harmful: a transient ``signal=None`` HOLD
    — a sub-thermal confluence, a missing book, a wrapper that failed open —
    would be pinned for minutes and suppress the first real CALL/PUT that
    appears after the market turns. The operator would watch a guaranteed-miss
    instead of a tradeable signal.

    Three conditions, all required:

    1. A DIRECTION — only BUY/SELL; None/HOLD/""/NEUTRAL are honest "no
       position" answers and must never be frozen.
    2. A POSITIVE TARGET — so a locked verdict is always actionable.
    3. A POSITIVE, GRADED confidence. A direction with ``confidence == 0`` is a
       PHANTOM: the gate never actually scored it. Observed live on a 3-bar flat
       tape, which returns ``signal="BUY"``, ``confidence=0.0``,
       ``suppressed_reason="insufficient_history"``, ``executable=False`` — and
       the direction+target checks alone let it be committed, freezing a fake
       CALL for 5 minutes and reporting ``status="active"`` the whole time.

    Note this does NOT require the verdict to clear the execution bar: a graded
    directional call below the operator's confidence floor is still a real
    verdict worth freezing. The floor is per-request POLICY, applied on read,
    not a condition for committing.
    """
    signal = str(verdict.get("signal") or verdict.get("direction") or "").strip().upper()
    if signal not in DIRECTIONAL_SIGNALS:
        return False
    target = verdict.get("target_price")
    if target is None:
        return False
    try:
        if float(target) <= 0.0:
            return False
    except (TypeError, ValueError):
        return False
    confidence = verdict.get("confidence")
    if confidence is None:
        confidence = verdict.get("confidence_pct")
    try:
        return float(confidence) > 0.0
    except (TypeError, ValueError):
        return False


class SignalLock:
    """Async Redis-backed expiry lock with an in-process fallback.

    All public methods are fail-SAFE: a lock backend problem returns "no lock"
    and lets the caller compute normally. A broken lock must never be able to
    suppress trading.
    """

    def __init__(self) -> None:
        self._redis: Any = None
        self._local: Dict[str, tuple[Dict[str, Any], float]] = {}
        self._connected = False

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        if self._connected:
            return
        try:
            import redis.asyncio as redis  # imported lazily: keeps the
            # fallback path dependency-free for local dev

            client = redis.from_url(
                settings.redis_connection_url,
                encoding="utf-8",
                decode_responses=True,
            )
            await client.ping()
            self._redis = client
            logger.info("SIGNAL_LOCK_REDIS_CONNECTED", url=settings.redis_connection_url)
        except Exception as e:
            self._redis = None
            # Single-process semantics only. Loud, because this is a real
            # limitation and not a detail.
            logger.warning(
                "SIGNAL_LOCK_REDIS_UNAVAILABLE_PROCESS_LOCAL_FALLBACK",
                error=str(e),
                note="in-process lock is correct for 1 worker only; do not scale out",
            )
        self._connected = True

    async def close(self) -> None:
        if self._redis is not None:
            try:
                await self._redis.close()
            except Exception:
                pass
            self._redis = None
        self._local.clear()
        self._connected = False

    # ── read / write ─────────────────────────────────────────────────────────

    async def get(
        self, identity: Dict[str, Any], now_ms: Optional[float] = None
    ) -> Optional[Dict[str, Any]]:
        """The active locked verdict for this identity, or None.

        A payload whose own ``expires_at_ms`` has passed is treated as absent
        and dropped, so the contract deadline — not the Redis TTL — is
        authoritative. ``now_ms`` is injectable so a caller that already has a
        single notion of "now" (see :meth:`acquire`) cannot end up evaluating
        the same lock against two different clocks.
        """
        key = _key(identity)
        now = now_ms if now_ms is not None else time.time() * 1000.0

        if self._redis is not None:
            try:
                raw = await self._redis.get(key)
                if raw is None:
                    return None
                payload = json.loads(raw)
                if float(payload.get("expires_at_ms") or 0) <= now:
                    await self._redis.delete(key)
                    return None
                return payload
            except Exception as e:
                logger.warning("SIGNAL_LOCK_GET_FAILED", error=str(e))
                return None

        entry = self._local.get(key)
        if entry is None:
            return None
        payload, expires_at_ms = entry
        if expires_at_ms <= now:
            self._local.pop(key, None)
            return None
        return payload

    async def acquire(
        self,
        identity: Dict[str, Any],
        verdict: Dict[str, Any],
        now_ms: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """Try to commit ``verdict`` for this identity.

        Returns the ACTIVE lock after the call: the existing one when a contract
        is already in force (an in-window request must never overwrite it), or
        the newly committed one. Returns None when nothing is held and nothing
        was committed.

        The write is atomic (Redis ``SET NX``), so two concurrent workers
        racing on the same expiry cannot both believe they hold the contract.

        A NON-actionable verdict (no direction, or no target) is never
        committed — see :func:`is_committable_verdict`. In that case this
        returns the ACTIVE lock when one exists, else None, so the caller
        still learns that a contract is in force without a HOLD being
        pinned for the remainder of the window.
        """
        now = now_ms if now_ms is not None else time.time() * 1000.0

        # Evaluate any existing contract against the SAME clock as the write
        # below. Reading the wall clock here while the write used `now_ms` made
        # an expired lock still look live.
        existing = await self.get(identity, now_ms=now)
        if existing is not None:
            return existing

        if not is_committable_verdict(verdict):
            signal = str(verdict.get("signal") or verdict.get("direction") or "").strip().upper()
            target = verdict.get("target_price")
            confidence = verdict.get("confidence")
            if confidence is None:
                confidence = verdict.get("confidence_pct")
            if signal not in DIRECTIONAL_SIGNALS:
                reason = "no_direction"
            elif confidence is None or float(confidence) <= 0.0:
                reason = "zero_confidence"
            else:
                reason = "no_target_price"
            logger.info(
                "SIGNAL_LOCK_SKIPPED_NON_ACTIONABLE",
                symbol=identity["symbol"],
                asset_class=identity["asset_class"],
                horizon_minutes=identity["horizon_minutes"],
                signal=signal or None,
                confidence=confidence,
                reason=reason,
            )
            return None

        duration_ms = max(1, int(identity.get("expiration_seconds") or 0)) * 1000
        payload = dict(verdict)
        # Normalise the ``direction`` alias onto the canonical ``signal`` key.
        # Without this a committable ``{"direction": "SELL"}`` would be stored
        # without ``signal``, so ``locked_projection_fields`` (which reads
        # ``signal``) would project an EMPTY verdict and every later request
        # would be served a lock carrying no direction at all.
        if not payload.get("signal") and payload.get("direction"):
            payload["signal"] = str(payload["direction"]).strip().upper()
        payload["symbol"] = identity["symbol"]
        payload["asset_class"] = identity["asset_class"]
        payload["horizon_minutes"] = identity["horizon_minutes"]
        payload["expiration_seconds"] = identity["expiration_seconds"]
        payload["locked_at_ms"] = int(now)
        payload["expires_at_ms"] = int(now + duration_ms)

        key = _key(identity)
        ttl = max(1, int(identity.get("expiration_seconds") or 0)) + TTL_GRACE_SECONDS

        if self._redis is not None:
            try:
                encoded = json.dumps(payload)
                won = await self._redis.set(key, encoded, ex=ttl, nx=True)
                if not won:
                    # Another worker won the race — return THEIR contract.
                    return await self.get(identity, now_ms=now)
                logger.info(
                    "SIGNAL_LOCK_ACQUIRED",
                    symbol=identity["symbol"],
                    asset_class=identity["asset_class"],
                    horizon_minutes=identity["horizon_minutes"],
                    expiration_seconds=identity["expiration_seconds"],
                    direction=payload.get("signal") or payload.get("direction"),
                )
                return payload
            except Exception as e:
                logger.warning("SIGNAL_LOCK_ACQUIRE_FAILED", error=str(e))
                return None

        self._local[key] = (payload, payload["expires_at_ms"])
        logger.info(
            "SIGNAL_LOCK_ACQUIRED_LOCAL",
            symbol=identity["symbol"],
            direction=payload.get("signal") or payload.get("direction"),
        )
        return payload

    async def release(self, identity: Dict[str, Any]) -> None:
        """Explicit release (symbol switch / hard error). The TTL remains the
        backstop, so a missed release cannot outlive the contract."""
        key = _key(identity)
        if self._redis is not None:
            try:
                await self._redis.delete(key)
            except Exception as e:
                logger.warning("SIGNAL_LOCK_RELEASE_FAILED", error=str(e))
            return
        self._local.pop(key, None)


# Process-wide singleton, mirroring data_cache / RedisPublisher.
signal_lock = SignalLock()


def locked_projection_fields(payload: Dict[str, Any]) -> Dict[str, Any]:
    """The contract fields that must NOT drift while a verdict is locked.

    This is the VERDICT the operator acts on and nothing else:
      * ``signal``          — the direction committed at entry
      * ``confidence``      — the strength graded for that direction
      * ``target_price`` / ``target_distance`` — the target and its distance

    Deliberately EXCLUDED:
      * live values (current_price, atr, barCount, timestamps, latency) — the
        market keeps moving under the frozen verdict.
      * per-request POLICY (``threshold_pct``, ``min_confidence``,
        ``bar_source``) — the operator may change their confidence floor, and it
        must take effect immediately. Locking the threshold would make a
        raised floor silently no-op and keep reporting the old one.
      * DERIVED policy output (``tier``, ``tier_label``, ``status``) — these
        are re-derived by the strict gate from the locked verdict under the
        CURRENT threshold, so raising the floor correctly demotes the tier
        instead of freezing it at the pre-change classification.
    """
    return {
        k: payload[k]
        for k in (
            "signal",
            "confidence",
            "confidence_pct",
            "target_price",
            "target_distance",
        )
        if k in payload
    }
