"""
signal_gatekeeper.py — MULTI-TIER SIGNAL SYSTEM (single source of truth)

Replaces the single 98% hard gate with an honest five-tier quality ladder so the
engine emits MORE signals while keeping every dispatch tier-honest:

  TIER   LABEL    FRACTIONAL   PERCENTAGE   ROLE
  ────────────────────────────────────────────────────────────────
  T1     PREMIUM  >= 0.965     >= 96.5      flagship — near-total convergence
  T2     HIGH     >= 0.90      >= 90.0      strong multi-book convergence
  T3     MEDIUM   >= 0.80      >= 80.0      solid but not unanimous
  T4     LOW      >= 0.70      >= 70.0      minimum executable bar
  T5     WEAK     <  0.70      <  70.0      NO SIGNAL — never dispatched

Contract:
  * A directional BUY/SELL verdict is EXECUTABLE when its genuine dynamic
    confidence clears the caller-selected MINIMUM TIER (default ``T4`` = 0.70).
    T1 is the strongest tier; T5 is inert (below the minimum bar, never
    emitted, never fabricated into a signal).
  * Below the minimum tier the direction is KEPT (no fabrication, never
    coerced to HOLD) but the verdict is flagged ``market_waiting=True`` with
    ``gate`` naming the tier that was actually reached.
  * Confidence is cross-scale normalized defensively (1.0..100 → 0.01..1.0).
  * Every failure path (missing/invalid inputs) returns a deterministic
    safe-gated result — no fabricated executable signal, ever.
  * LEGACY ALIASES: ``HARD_GATE = 0.98`` / ``DEFINITIVE_CONFIDENCE_MIN = 98.0``
    are retained purely so old imports keep working; nothing in the tiered
    dispatch path consults them.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from collections import deque
from typing import Any, Dict, Iterable, Optional

import structlog

_logger = structlog.get_logger(__name__)

# ── THE MULTI-TIER LADDER — one canonical value, one source of truth ──
TIER_THRESHOLDS: Dict[str, float] = {
    "T1": 0.965,   # PREMIUM  — 96.5%
    "T2": 0.90,    # HIGH     — 90.0%
    "T3": 0.80,    # MEDIUM   — 80.0%
    "T4": 0.70,    # LOW      — 70.0%
}

# Strongest first. T5 = everything below T4 (never dispatched).
TIER_ORDER = ["T1", "T2", "T3", "T4"]
MAX_TIER = "T1"
MIN_EXECUTABLE_TIER = "T4"

# Startup invariant — thresholds must be strictly monotonic (strongest first)
# and in (0, 1]. If this ever fails, the whole ladder is invalid.
for _i in range(1, len(TIER_ORDER)):
    assert TIER_THRESHOLDS[TIER_ORDER[_i - 1]] > TIER_THRESHOLDS[TIER_ORDER[_i]], (
        f"TIER_THRESHOLDS must be strictly decreasing, got "
        f"{TIER_ORDER[_i - 1]}={TIER_THRESHOLDS[TIER_ORDER[_i - 1]]} "
        f"<= {TIER_ORDER[_i]}={TIER_THRESHOLDS[TIER_ORDER[_i]]}"
    )
assert 0.0 < TIER_THRESHOLDS["T4"] <= 1.0

# Tier rank map — higher rank = stronger tier. T1 rank 4 … T5 rank 0.
TIER_RANK: Dict[str, int] = {"T1": 4, "T2": 3, "T3": 2, "T4": 1, "T5": 0}

# ── LEGACY aliases (deprecated — retained for old imports only) ──
HARD_GATE = 0.98
DEFINITIVE_CONFIDENCE_MIN = round(HARD_GATE * 100.0, 2)

GATE_REASON = "TIER_GATE"          # canonical gate name for sub-tier verdicts
LEGACY_GATE_REASON = "HARD_GATE"   # the old single-gate name, for diagnostics

# ═══════════════════════════════════════════════════════════════════════════
# PART 14 [44] — REGIME GATE (random_walk → SCORED-ONLY, never tradable)
# ═══════════════════════════════════════════════════════════════════════════
# classify_regime (regime_detector.py) labels the price window as
# "trending" / "mean_reverting" / "random_walk". HARD RULE (PART 14): a
# random_walk symbol MUST NOT emit a tradable tier — the ensemble may still
# *score* it, but the executable verdict is demoted to T5 (scored-only)
# regardless of confidence, and the demotion is stamped
# `suppressed_reason="regime_scored_only"` riding the payload (the same
# suppressedReason UI pattern the client already renders for "too_late").
#
# Trending / mean_reverting windows are TRADABLE — the full ensemble runs.
REGIME_GATE_TRADABLE = "tradable"
REGIME_GATE_SCORED_ONLY = "scored_only"
SUPPRESSED_REASON_REGIME = "regime_scored_only"

def apply_regime_gate(
    result: Dict[str, Any],
    regime_gate: Any,
) -> Dict[str, Any]:
    """Apply the PART 14 regime override to an already-tiered gateway result.

    ``regime_gate`` is "tradable"|"scored_only" from financial_analysis.
    A "scored_only" (random_walk) window is demoted to T5 and NEVER
    dispatched — confidence does not matter. "tradable" passes through
    untouched (the full ensemble keeps its authority).
    """
    out = dict(result or {})
    gate = str(regime_gate or "").strip().lower()
    if gate == REGIME_GATE_SCORED_ONLY:
        out["regime_gate"] = REGIME_GATE_SCORED_ONLY
        out["suppressed_reason"] = SUPPRESSED_REASON_REGIME
        out["tier"] = SUPPRESSED_TIER
        out["executable"] = False
        out["market_waiting"] = direction_is_kept(out)
        out["gate"] = SUPPRESSED_TIER
        out["suppressed"] = True
        _logger.warning(
            "SIGNAL_REGIME_SCORED_ONLY",
            signal=out.get("signal"),
            confidence=out.get("confidence"),
            reason=SUPPRESSED_REASON_REGIME,
        )
    else:
        out["regime_gate"] = REGIME_GATE_TRADABLE
        out.setdefault("suppressed_reason", None)
        out.setdefault("suppressed", False)
    return out


def direction_is_kept(payload: Dict[str, Any]) -> bool:
    """True when the payload still carries a real BUY/SELL direction
    (kept directional, merely marked waiting — never coerced to HOLD)."""
    signal = _as_signal(payload.get("signal"))
    return signal in ("BUY", "SELL")

# UI-facing labels for the five tiers (colors applied client-side).
TIER_LABELS: Dict[str, str] = {
    "T1": "PREMIUM",
    "T2": "HIGH",
    "T3": "MEDIUM",
    "T4": "LOW",
    "T5": "WEAK",
}


def scale_for(confidence: Any) -> str:
    """Classify a raw confidence number onto its scale.

    Returns "frac" for 0..1, "pct" for >1 (up to 1000), else "invalid".
    """
    c = _as_float(confidence)
    if c is None:
        return "invalid"
    if 0.0 <= c <= 1.0:
        return "frac"
    if 1.0 < c <= 1000.0:
        return "pct"
    return "invalid"


def normalize_confidence(confidence: Any) -> float:
    """Map any genuine confidence onto the fractional 0..1 scale.

    - < 0 or invalid     → 0.0
    - 0..1               → unchanged
    - > 1 (percentage)   → /100
    """
    c = _as_float(confidence)
    if c is None:
        return 0.0
    if c < 0.0:
        return 0.0
    if c <= 1.0:
        return c
    return c / 100.0


def tier_min_confidence(tier: str) -> float:
    """Fractional threshold for a tier label; T5 returns 0.0."""
    t = str(tier or "").strip().upper()
    if t in TIER_THRESHOLDS:
        return float(TIER_THRESHOLDS[t])
    return 0.0


def tier_rank(tier: str) -> int:
    """Rank of a tier (T1=4 … T5=0). Unknown labels rank 0 (safe)."""
    return int(TIER_RANK.get(str(tier or "").strip().upper(), 0))


def is_dispatchable_tier(tier: str, min_tier: str = MIN_EXECUTABLE_TIER) -> bool:
    """True when ``tier`` is at least as strong as ``min_tier``.

    T1 is the strongest tier; a verdict must reach the caller's minimum bar.
    """
    return tier_rank(tier) >= tier_rank(min_tier)


def resolve_tier(confidence: Any) -> str:
    """Map a genuine confidence onto its honest tier label (T1…T5).

    T1 PREMIUM (>=0.965) … T4 LOW (>=0.70); everything below is T5 WEAK and
    never dispatched.
    """
    frac = normalize_confidence(confidence)
    for tier in TIER_ORDER:
        if frac >= TIER_THRESHOLDS[tier]:
            return tier
    return "T5"


def is_executable(
    signal: Any,
    confidence: Any,
    min_tier: str = MIN_EXECUTABLE_TIER,
) -> bool:
    """True only when a real directional signal clears the minimum tier.

    Non-directional signals (None, "HOLD", "" …) are never executable.
    """
    direction = _as_signal(signal)
    if direction not in ("BUY", "SELL"):
        return False
    return is_dispatchable_tier(resolve_tier(confidence), min_tier)


def apply_gate(
    signal: Any,
    confidence: Any,
    min_tier: str = MIN_EXECUTABLE_TIER,
) -> Dict[str, Any]:
    """Resolve a verdict against the multi-tier gate (backend parity payload).

    Returns:
      {
        "tier": "T1" | … | "T5",
        "signal": "BUY" | "SELL" | None,
        "confidence": float (fractional 0..1),
        "confidence_pct": float (0..100),
        "executable": bool,
        "market_waiting": bool,
        "gate": tier string | None,
        "threshold_pct": float (the min-tier emission bar),
      }
    Direction is ALWAYS kept when present — a sub-tier verdict is flagged
    market_waiting, never coerced to HOLD.
    """
    direction = _as_signal(signal)
    frac = normalize_confidence(confidence)
    pct = round(frac * 100.0, 2)
    tier = resolve_tier(frac)
    rank_bar = TIER_RANK.get(str(min_tier or "").strip().upper(), TIER_RANK[MIN_EXECUTABLE_TIER])
    threshold_frac = tier_min_confidence(min_tier) or TIER_THRESHOLDS[MIN_EXECUTABLE_TIER]
    executable = direction in ("BUY", "SELL") and tier_rank(tier) >= rank_bar

    return {
        "tier": tier,
        "signal": direction,
        "confidence": round(frac, 6),
        "confidence_pct": pct,
        "executable": executable,
        "market_waiting": direction in ("BUY", "SELL") and not executable,
        "gate": tier if not executable and direction in ("BUY", "SELL") else None,
        "threshold_pct": round(threshold_frac * 100.0, 2),
    }


def apply_tier_gate(
    signal: Any,
    confidence: Any,
    min_tier: str = MIN_EXECUTABLE_TIER,
) -> Dict[str, Any]:
    """Alias of :func:`apply_gate` — the tiered dispatch resolver."""
    return apply_gate(signal, confidence, min_tier=min_tier)


def _as_float(value: Any) -> Optional[float]:
    try:
        c = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return None
    if c != c or c in (float("inf"), float("-inf")):  # NaN / ±inf
        return None
    return c


def _as_signal(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        s = value.strip().upper()
        return s if s in ("BUY", "SELL") else None
    return None


# ═══════════════════════════════════════════════════════════════════════════
# PART 9 — EXECUTION-LATENCY-AWARE TIME-GATED EMISSION
# ═══════════════════════════════════════════════════════════════════════════
# A verdict the engine REACHES at the right tier can still be USELESS if it
# arrives while the bucket is about to close: by the time order placement +
# fill latency passes, the candle has already expired. We therefore measure
# the REAL per-execution latency of the last executed trades and refuse to
# dispatch any signal whose remaining time-to-bucket-close is below
# `MIN_ACTIONABLE_WINDOW_MS = p95(measured_latency) * 1.5`.
#
# The window is DERIVED — never guessed. `ExecutionLatencyTracker` reads the
# `latency_ms` the execution-engine logs on every successful order
# ("Market order placed successfully" / "Order executed successfully") from
# the last 100 executed trades and computes the p95. `MIN_ACTIONABLE_WINDOW_MS`
# is the module-level bootstrap default that `refresh_execution_latency()` sets
# to the measured value once enough real samples exist.
#
# Contract:
#   * A suppressed verdict is demoted to tier "T5" (never dispatched) BUT is
#     NEVER dropped silently: `suppressed_reason="too_late"` rides the payload
#     and the demotion is logged with the exact remaining/window numbers.
#   * Expirations are aligned UP to the NEXT full bucket boundary that sits at
#     least `MIN_ACTIONABLE_WINDOW_MS` after the signal instant, so an
#     expiration can never land inside the currently-forming bucket.
#   * This gate ONLY removes signals that cannot be acted on in time — it does
#     NOT measure win rate. Accuracy is tracked separately by accuracy_tracker.

DEFAULT_MIN_ACTIONABLE_WINDOW_MS = 1500.0  # bootstrap only; replaced by p95×1.5
LATENCY_WINDOW_SIZE = 100                  # last 100 executed trades
LATENCY_P95_MULTIPLIER = 1.5               # safety margin on the real p95
MIN_MEASURED_SAMPLES = 10                  # below this → window is unmeasured
SUPPRESSED_TIER = "T5"
SUPPRESSED_REASON_TOO_LATE = "too_late"
MIN_ACTIONABLE_WINDOW_MS = DEFAULT_MIN_ACTIONABLE_WINDOW_MS

# Where the execution-engine writes its structured order logs. Overridable via
# EXECUTION_LOG_PATH so tests point at a fixture; defaults to the live path.
EXECUTION_LOG_PATH = os.environ.get(
    "EXECUTION_LOG_PATH",
    os.path.normpath(
        os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "..", "..",
            "execution-engine", "execution.log",
        )
    ),
)


def percentile(values: Iterable[Any], p: float) -> Optional[float]:
    """Nearest-rank percentile of the finite, non-negative samples."""
    finite = sorted(
        v
        for v in values
        if isinstance(v, (int, float)) and math.isfinite(v) and v >= 0.0
    )
    if not finite:
        return None
    rank = max(1, min(len(finite), int(math.ceil((float(p) / 100.0) * len(finite)))))
    return finite[rank - 1]


def parse_execution_log_latencies(text: str) -> list:
    """Extract REAL per-execution `latency_ms` values from execution-engine
    log text (structlog JSON lines `{"latency_ms": 12.5}` and key=value lines
    `latency_ms=12.5`). Only finite, >= 0 samples survive; NaN/negative/garbage
    are rejected so a single malformed record can never poison the window."""
    samples: list = []
    if not text:
        return samples
    kv_re = re.compile(
        r"latency_ms\s*=\s*([0-9]+(?:\.[0-9]+)?)"
        r"|\blatency_ms\s*:\s*([0-9]+(?:\.[0-9]+)?)"
    )
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        value: Optional[float] = None
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                raw = obj.get("latency_ms")
                if isinstance(raw, (int, float)):
                    value = float(raw)
        except (ValueError, TypeError):
            m = kv_re.search(line)
            if m:
                value = float(m.group(1) if m.group(1) else m.group(2))
        if (
            value is not None
            and math.isfinite(value)
            and value >= 0.0
        ):
            samples.append(value)
    return samples


def compute_min_actionable_window_ms(
    latencies: Iterable[Any],
    multiplier: float = LATENCY_P95_MULTIPLIER,
) -> float:
    """``MIN_ACTIONABLE_WINDOW_MS = p95(measured_latency) * 1.5``.

    Honest bootstrap: with NO genuine measurement the documented default is
    returned (the gate is conservative before real data exists, never zero)."""
    p95 = percentile(latencies, 95.0)
    if p95 is None:
        return float(DEFAULT_MIN_ACTIONABLE_WINDOW_MS)
    return round(p95 * float(multiplier), 2)


class ExecutionLatencyTracker:
    """Rolling window of the last ``window_size`` EXECUTED-trade latencies,
    measured from the execution-engine's own logs — never assumed or seeded."""

    def __init__(
        self,
        window_size: int = LATENCY_WINDOW_SIZE,
        min_samples: int = MIN_MEASURED_SAMPLES,
        log_path: Optional[str] = None,
    ) -> None:
        self._window: deque = deque(maxlen=max(1, int(window_size)))
        self._min_samples = max(1, int(min_samples))
        self._log_path = log_path
        self._lock = threading.RLock()

    def add_sample(self, latency_ms: Any) -> bool:
        value = _as_float(latency_ms)
        if value is None or value < 0.0:
            return False
        with self._lock:
            self._window.append(value)
        return True

    def samples(self) -> list:
        with self._lock:
            return list(self._window)

    def is_measured(self) -> bool:
        """True once enough REAL samples exist to trust the p95."""
        return len(self.samples()) >= self._min_samples

    def p95_ms(self) -> Optional[float]:
        return percentile(self.samples(), 95.0)

    def window_ms(self) -> float:
        return compute_min_actionable_window_ms(self.samples())

    def read_log(self, path: Optional[str] = None) -> int:
        """Ingest `latency_ms` records from an execution-engine log file.
        Returns the number of samples actually added."""
        target = path or self._log_path or EXECUTION_LOG_PATH
        try:
            with open(target, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            return 0
        added = 0
        for sample in parse_execution_log_latencies(text):
            if self.add_sample(sample):
                added += 1
        return added

    def refresh(self) -> int:
        """Read the real log and sync the module-level ``MIN_ACTIONABLE_WINDOW_MS``
        to the measured p95×1.5 once enough samples exist."""
        global MIN_ACTIONABLE_WINDOW_MS
        added = self.read_log()
        if self.is_measured():
            MIN_ACTIONABLE_WINDOW_MS = self.window_ms()
        return added


_execution_latency_tracker: Optional[ExecutionLatencyTracker] = None
_execution_latency_lock = threading.Lock()


def get_execution_latency_tracker() -> ExecutionLatencyTracker:
    """Process-wide singleton tracker (thread-safe)."""
    global _execution_latency_tracker
    if _execution_latency_tracker is None:
        with _execution_latency_lock:
            if _execution_latency_tracker is None:
                _execution_latency_tracker = ExecutionLatencyTracker()
    return _execution_latency_tracker


def refresh_execution_latency() -> int:
    """Re-measure ``MIN_ACTIONABLE_WINDOW_MS`` from the REAL execution-engine
    log. Returns the number of latency samples ingested this call."""
    return get_execution_latency_tracker().refresh()


def min_actionable_window_ms() -> float:
    """The ACTIVE actionable window: the measured p95×1.5 once real samples
    exist, otherwise the honest bootstrap default."""
    tracker = get_execution_latency_tracker()
    if tracker.is_measured():
        return tracker.window_ms()
    return float(MIN_ACTIONABLE_WINDOW_MS)


def suppress_if_too_late(
    remaining_to_bucket_close_ms: Any,
    window_ms: Optional[float] = None,
    suppress_unknown: bool = True,
) -> bool:
    """True ⇔ the signal is too close to bucket-close to be actionable.

    ``remaining < window`` suppresses. An UNKNOWN remaining is treated as
    un-actionable (cannot confirm, so conservatively suppressed) unless the
    caller explicitly opts out via ``suppress_unknown=False``."""
    remaining = _as_float(remaining_to_bucket_close_ms)
    window = _as_float(window_ms)
    if window is None:
        window = min_actionable_window_ms()
    if remaining is None:
        return bool(suppress_unknown)
    return remaining < window


def align_expiration_to_bucket(
    expiration_seconds: Any,
    timeframe_seconds: Any,
    elapsed_in_bucket_ms: Any,
    min_actionable_window_ms: Any,
) -> int:
    """Round an expiration UP to the next full bucket boundary that sits at
    least ``min_actionable_window_ms`` after the signal instant.

    Property contract (tested partially + property-based over random bucket
    positions):
      1. aligned_seconds % timeframe_seconds == 0      (bucket-aligned)
      2. aligned_seconds >= timeframe_seconds          (never inside the
                                                        forming bucket)
      3. aligned_ms >= elapsed_ms + min_window         (actionable)
    """
    timeframe = _as_float(timeframe_seconds)
    exp = _as_float(expiration_seconds)
    if timeframe is None or timeframe <= 0:
        base = _as_float(expiration_seconds)
        return int(round(base)) if base is not None else 60
    timeframe_ms = timeframe * 1000.0
    window = _as_float(min_actionable_window_ms)
    window_f = max(0.0, window if window is not None else 0.0)
    elapsed_f = _as_float(elapsed_in_bucket_ms)
    elapsed = max(0.0, elapsed_f if elapsed_f is not None else 0.0)
    base_exp = exp if exp is not None and exp > 0 else float(timeframe)
    k = max(1, int(math.ceil((base_exp * 1000.0) / timeframe_ms)))
    while k * timeframe_ms < elapsed + window_f:
        k += 1
    return int(k * timeframe)


def apply_time_gate(
    signal: Any,
    confidence: Any,
    remaining_to_bucket_close_ms: Any,
    min_tier: str = MIN_EXECUTABLE_TIER,
    window_ms: Optional[float] = None,
    expiration_seconds: Any = None,
    timeframe_seconds: Any = None,
) -> Dict[str, Any]:
    """Emission resolver with the execution-latency time gate (PART 9).

    Baseline contract == :func:`apply_gate` PLUS:
      * ``suppressed`` — bool
      * ``suppressed_reason`` — None | "too_late"
      * ``remaining_to_bucket_close_ms`` — float | None
      * ``min_actionable_window_ms`` — float
      * ``aligned_expiration_seconds`` — int | None (when exp + tf supplied)

    A too-late verdict is demoted to ``SUPPRESSED_TIER`` ("T5") and never
    dispatched — BUT never dropped silently: the direction is kept
    (``market_waiting=True``), the reason is attached to the payload, and the
    demotion is logged with the exact numbers for the audit trail."""
    result = apply_gate(signal, confidence, min_tier=min_tier)
    window = _as_float(window_ms)
    if window is None:
        window = min_actionable_window_ms()
    remaining = _as_float(remaining_to_bucket_close_ms)
    suppressed = suppress_if_too_late(remaining, window)
    result["suppressed"] = suppressed
    result["suppressed_reason"] = (
        SUPPRESSED_REASON_TOO_LATE if suppressed else None
    )
    result["remaining_to_bucket_close_ms"] = remaining
    result["min_actionable_window_ms"] = round(window, 2)
    if suppressed:
        result["tier"] = SUPPRESSED_TIER
        result["executable"] = False
        result["market_waiting"] = True
        result["gate"] = SUPPRESSED_TIER
        _logger.warning(
            "SIGNAL_SUPPRESSED_TOO_LATE",
            signal=result["signal"],
            confidence=result["confidence"],
            remaining_ms=remaining,
            min_actionable_window_ms=round(window, 2),
            reason=SUPPRESSED_REASON_TOO_LATE,
        )
    if expiration_seconds is not None and timeframe_seconds is not None:
        timeframe = _as_float(timeframe_seconds)
        exp = _as_float(expiration_seconds)
        if timeframe is not None and timeframe > 0 and exp is not None and exp > 0:
            elapsed = max(
                0.0,
                timeframe * 1000.0 - (remaining if remaining is not None else 0.0),
            )
            result["aligned_expiration_seconds"] = align_expiration_to_bucket(
                exp, timeframe, elapsed, window
            )
        else:
            result["aligned_expiration_seconds"] = None
    else:
        result["aligned_expiration_seconds"] = None
    return result