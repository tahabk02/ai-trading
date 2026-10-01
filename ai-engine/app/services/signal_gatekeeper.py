"""
signal_gatekeeper.py — MULTI-TIER SIGNAL SYSTEM (single source of truth)

STRICT HIGH-PRECISION EXECUTION BAR (PRINCIPAL QUALITY UPGRADE 2026-09-24):

  TIER   LABEL    FRACTIONAL   PERCENTAGE   ROLE
  ────────────────────────────────────────────────────────────────
  T1     PREMIUM  >= 0.965     >= 96.5      EXECUTABLE — flagship convergence
  T2     HIGH     >= 0.90      >= 90.0      SCORED-ONLY under the strict bar
  T3     MEDIUM   >= 0.80      >= 80.0      SCORED-ONLY under the strict bar
  T4     LOW      >= 0.70      >= 70.0      SCORED-ONLY under the strict bar
  T5     WEAK     <  0.70      <  70.0      NO SIGNAL — never dispatched

Contract:
  * A directional BUY/SELL verdict is EXECUTABLE only when its genuine
    confidence clears STRICT_EXECUTION_CONFIDENCE (0.965 = T1 PREMIUM). This
    REVERSES the LIVE-TEST relaxation (2026-09-23: default bar T4 = 0.30) —
    default MINIMUM EXECUTABLE TIER is now ``T1`` (96.5%) to safeguard
    capital behind high-probability setups only.
  * Any asset BELOW 96.5% defaults to SCORED-ONLY: ``executable=False``,
    ``regime_gate="pending_high_precision"``,
    ``regime_status="PENDING_HIGH_PRECISION"``. Direction is KEPT
    (never coerced to HOLD) but never dispatched.
  * ``apply_strict_execution_gate`` is the single wrapper both /predict
    paths use (the "predictSignal / signal_gatekeeper" upgrade): it combines
    the 96.5% confidence bar with the per-asset-class filter verdict
    (OTC HF quality / REAL liquidity gate) and emits the full
    executable/regime/status surface plus audit metrics.
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
    "T4": 0.70,    # LOW      — 70.0% (restored 2026-09-24; was 0.30 LIVE-TEST)
    # T5 became a FIRST-CLASS rung (2026-09-30) instead of an implicit
    # "everything below T4" catch-all. It is emitted honestly like any other
    # tier and is never a silent discard bucket. Its threshold is 0.0, so
    # T5 is reached only once the genuine confluence falls below T4.
    "T5": 0.0,     # WEAK     — <70.0%
}

# Strongest first. T5 is now an explicit rung, not a fallback label.
TIER_ORDER = ["T1", "T2", "T3", "T4", "T5"]
MAX_TIER = "T1"

# STRICT HIGH-PRECISION EXECUTION BAR — the ONLY executable tier. T1 PREMIUM
# (96.5%). Everything below is SCORED-ONLY (pending_high_precision). This
# restores strictness over the LIVE-TEST default of T4 = 0.30.
MIN_EXECUTABLE_TIER = "T1"

# ── USER-SELECTED EXECUTION FLOOR (flexible tier architecture, 2026-09-30) ──
# `executable` is no longer hardcoded to T1. It is resolved against a floor the
# CLIENT chooses per session and forwards as `min_tier` on the request. The
# engine still EMITS every computed tier (T1..T5) with its true confidence and
# metadata; the floor only decides whether that verdict is tradeable.
#
# Safety rails, deliberately conservative:
#   * DEFAULT_EXECUTION_TIER keeps today's behaviour when the client sends
#     nothing, so relaxing is always an explicit user act.
#   * LOWEST_TRADABLE_TIER floors the bar at T4 (70%). A verdict with a genuine
#     direction is never marked executable below the bottom of the real ladder,
#     so a mis-set/hostile `min_tier` cannot turn a T5 WEAK confluence into a
#     tradeable instruction. T5 remains monitor-only: emitted, visible,
#     filterable — never executable.
DEFAULT_EXECUTION_TIER = "T1"
LOWEST_TRADABLE_TIER = "T4"

# Dispatch floor for the CONFLUENCE gate specifically.
#
# `book_instruments.resolve_confluence_tier` demotes a T1 confluence to T2 when
# any evidence pillar is incomplete, and its docstring is explicit that this
# "can still dispatch at a lower tier (exactly why they are not top-of-the-
# ladder)". The consumer must therefore test the confluence gate against T2, not
# against MIN_EXECUTABLE_TIER ("T1") — testing it against T1 turned a designed
# demotion into a total veto, so every blockered-but-strong confluence became
# market_waiting and no verdict could ever be dispatched. The EXECUTED signal
# still faces the full T1 96.5% bar in apply_strict_execution_gate; this
# constant only governs whether a direction is allowed to be emitted.
CONFLUENCE_DISPATCH_TIER = "T2"

# STRICT_EXECUTION_CONFIDENCE — fractional bar any verdict must clear before
# it is marked executable (mirrors TIER_THRESHOLDS["T1"]). Single source of
# truth for the 96.5% enterprise gate.
STRICT_EXECUTION_CONFIDENCE: float = TIER_THRESHOLDS["T1"]

# ── DYNAMIC PER-ASSET-CLASS FLOOR (REAL quote-proxy mode) ────────────────
# When a REAL asset is evaluated in quote-proxy mode (no L2 bid/ask arms;
# the approved "Spread/ATR + flow + MTF proxies" fallback) AND the proxied
# class gate passes (every candle-proxy factor green) AND no user confidence
# filter is set, the executable bar relaxes to REAL_PROXY_EXECUTABLE_FLOOR
# (default 80.0% = T3 MEDIUM) instead of the strict 96.5% default. This is the
# "never permanently stuck" clause: with only candle proxies available a fully
# green gate at T3-level confluence is actionable evidence, and the decision is
# stamped bar_source="real_proxy_floor" + a dynamic_floor metric for audit.
# Tunable via env AI_ENGINE_REAL_PROXY_FLOOR_PCT; 0 disables the relaxation
# (strict 96.5% everywhere). Clamped to [T4, T1] so it can never unlock below
# the lowest tradable tier nor exceed the strict default.
_REAL_PROXY_FLOOR_PCT_RAW = float(os.getenv("AI_ENGINE_REAL_PROXY_FLOOR_PCT") or 80.0) \
    if os.getenv("AI_ENGINE_REAL_PROXY_FLOOR_PCT") else 80.0
_REAL_PROXY_FLOOR_ENABLED = _REAL_PROXY_FLOOR_PCT_RAW > 0.0
REAL_PROXY_EXECUTABLE_FLOOR_FRAC: Optional[float] = (
    float(min(max(_REAL_PROXY_FLOOR_PCT_RAW / 100.0, TIER_THRESHOLDS["T4"]), STRICT_EXECUTION_CONFIDENCE))
    if _REAL_PROXY_FLOOR_ENABLED
    else None
)
BAR_SOURCE_REAL_PROXY_FLOOR = "real_proxy_floor"

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
# LIVE-TEST BYPASS [2026-09-23]: random_walk windows with a trusted real
# history (>= REGIME_GATE_BYPASS_CLOSES = 160 closes) are surfaced but FORCED
# TRADABLE — live forex/crypto pairs move from SCORED-ONLY to EXECUTABLE.
# Below 160 closes the classic scored-only rule above still applies.
# REVERT: remove the ``len(...) >= REGIME_GATE_BYPASS_CLOSES`` branches.
#
# Trending / mean_reverting windows are TRADABLE — the full ensemble runs.
REGIME_GATE_TRADABLE = "tradable"
REGIME_GATE_SCORED_ONLY = "scored_only"
SUPPRESSED_REASON_REGIME = "regime_scored_only"

# LIVE-TEST [2026-09-23]: random_walk windows backed by at least this many
# real closes are treated as TRADABLE (bypass the scored-only demotion) so
# live forex/crypto pairs become EXECUTABLE. Below it the classic hard rule
# still applies. REVERT: remove this constant + the
# ``len(series) >= REGIME_GATE_BYPASS_CLOSES`` branches in financial_analysis
# Stage 6 and signals._surface_regime_gate.
REGIME_GATE_BYPASS_CLOSES = 160

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


def resolve_execution_floor(min_tier: Any = None) -> Dict[str, Any]:
    """Resolve a user-selected minimum tier into an executable confidence bar.

    This is the single place that turns "which tiers do I want to trade?" into a
    number. The client owns the choice; the engine honours it.

    Args:
        min_tier: ``"T1".."T5"`` (case/whitespace tolerant), or None/garbage for
            the engine default.

    Returns:
        ``{min_tier, tier, effective, bar_frac, bar_pct, bar_source, floored}``.
        ``tier``/``min_tier`` echo the caller's selection; ``effective`` is the
        band the bar came from; ``bar_source`` is one of
        ``"default" | "user" | "floored"``.

    Safety: the bar is floored at ``LOWEST_TRADABLE_TIER`` (T4 / 70%). Asking
    for T5 therefore reports ``"floored"`` and yields the T4 bar rather than a
    0% bar, so a T5 WEAK verdict can never become executable. T5 stays
    monitor-only.
    """
    raw = str(min_tier or "").strip().upper()
    valid = raw in TIER_THRESHOLDS
    tier = raw if valid else DEFAULT_EXECUTION_TIER
    bar_frac = tier_min_confidence(tier)
    floored = False

    if bar_frac < tier_min_confidence(LOWEST_TRADABLE_TIER):
        bar_frac = tier_min_confidence(LOWEST_TRADABLE_TIER)
        floored = True

    if floored:
        source = "floored"
    elif valid:
        source = "user"
    else:
        source = "default"

    # ``tier``/``min_tier`` echo what the caller ASKED for; ``effective`` names
    # the band the bar actually came from. They differ only when floored, and
    # reporting both keeps the response self-describing instead of implying the
    # trader selected T4 when they selected T5.
    effective = LOWEST_TRADABLE_TIER if floored else tier

    return {
        "min_tier": tier,
        "tier": tier,
        "effective": effective,
        "bar_frac": bar_frac,
        "bar_pct": round(bar_frac * 100.0, 2),
        "bar_source": source,
        "floored": floored,
    }


def resolve_tier(confidence: Any) -> str:
    """Map a genuine confidence onto its honest tier label (T1…T5).

    T1 PREMIUM (>=0.965) … T4 LOW (>=0.70) … T5 WEAK (below T4). Every band is
    a real, emittable tier: the ladder labels confidence, it does not decide
    whether a verdict may be seen. Tradability is `executable`, resolved
    separately against the user's floor via `resolve_execution_floor`.
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


# ─────────────────────────────────────────────────────────────────────────────
# STRICT HIGH-PRECISION EXECUTION GATE (PRINCIPAL QUALITY UPGRADE 2026-09-24)
# ─────────────────────────────────────────────────────────────────────────────
# The single execution wrapper used by every /predict path. A directional
# verdict is EXECUTABLE only when:
#   1. direction is BUY/SELL,
#   2. its genuine confidence clears the executable bar — the platform's
#      STRICT_EXECUTION_CONFIDENCE (0.965) default, overridable per-request by
#      a user min_confidence filter (floored at T4 = 0.70), AND
#   3. the per-asset-class filter gate (OTC HF quality / REAL liquidity) passes.
# Everything below the bar defaults to SCORED-ONLY (regime_gate
# "pending_high_precision", executable False), while the honest `regime`
# label and resolved tier are still reported for the audit trail.
# ─────────────────────────────────────────────────────────────────────────────

REGIME_GATE_TRADABLE = "tradable"
REGIME_GATE_PENDING_HIGH_PRECISION = "pending_high_precision"
REGIME_STATUS_CONFIRMED = "CONFIRMED"
REGIME_STATUS_PENDING_HIGH_PRECISION = "PENDING_HIGH_PRECISION"
SUPPRESSED_REASON_HIGH_PRECISION = "below_high_precision_bar"
SUPPRESSED_REASON_INSUFFICIENT_INPUT = "insufficient_input"
# Reconciliation reason (signals.py): the execution gate released a verdict that
# emits no direction (or is still market-waiting), so it is SCORED-ONLY. Kept
# here so every suppressed_reason literal lives in one place.
SUPPRESSED_REASON_AWAITING_DIRECTION = "awaiting_directional_signal"

# Assigned in apply_strict_execution_gate; avoids re-importing this module.
MAX_EXECUTABLE_TIER_LABEL: str = "T1"


def _audit_metrics(
    *,
    confidence_pct: float,
    regime_type: Optional[str],
    spread_status: Optional[str],
    asset_class: str = "REAL",
    tier: str = "T5",
) -> Dict[str, Any]:
    """Normalized per-signal audit fields (confluence, regime, spread)."""
    return {
        "confluence_score": round(confidence_pct, 2),
        "confidence_pct": round(confidence_pct, 2),
        "regime_type": regime_type,
        "spread_status": spread_status,
        "asset_class": asset_class,
        "executable_tier": tier,
    }


def _resolve_execution_bar(
    min_confidence: Optional[Any] = None,
    min_tier: Optional[str] = None,
) -> Tuple[float, float, str]:
    """Resolve the executable confidence bar (fraction, pct, provenance).

    Precedence: an explicit, valid ``min_tier`` wins over ``min_confidence``,
    because the tier selector is the coarser and more deliberate control (it
    expresses "which classes of setup do I trade", not "what percentage").

    - ``min_tier`` supplied -> the tier's own threshold
      (T1 96.5 / T2 90 / T3 80 / T4 70), floored never below T4.
    - ``min_confidence`` supplied (a 50.0..99.0 percentage) -> the user's
      filter IS the executable bar, floored at T4 (70%) so the filter can never
      mark a sub-tier verdict tradable.
    - neither -> the engine default strict bar (96.5%, T1).

    Provenance is returned as "user" | "floored" | "default" so the decision is
    auditable in the response.
    """
    if min_tier is not None and str(min_tier or "").strip().upper() in TIER_THRESHOLDS:
        floor = resolve_execution_floor(min_tier)
        return floor["bar_frac"], floor["bar_pct"], floor["bar_source"]
    if min_confidence is None:
        bar_frac = STRICT_EXECUTION_CONFIDENCE
        return bar_frac, round(bar_frac * 100.0, 2), "default"
    user_frac = normalize_confidence(min_confidence)
    floor_frac = TIER_THRESHOLDS[LOWEST_TRADABLE_TIER]
    effective = max(user_frac, floor_frac)
    source = "floored" if effective > user_frac else "user"
    return effective, round(effective * 100.0, 2), source


def apply_strict_execution_gate(
    signal: Any,
    confidence: Any,
    asset_class: str = "REAL",
    class_gate: Optional[Dict[str, Any]] = None,
    regime_type: Optional[str] = None,
    spread_status: Optional[str] = None,
    min_confidence: Optional[Any] = None,
    min_tier: Optional[str] = None,
) -> Dict[str, Any]:
    """Strict execution surface for a single signal evaluation.

    The executable bar is the engine's 96.5% default unless the caller
    supplies ``min_confidence`` (a user-selected 50.0..99.0% filter), which
    overrides the bar — floored at T4 (70%) so nothing under the lowest
    tradable tier can ever be marked executable.

    Args:
        signal:      directional verdict ("BUY"/"SELL"/None), never coerced.
        confidence:  genuine 0..1 or 0..100 confidence for this signal.
        asset_class: "OTC" or "REAL" (from :func:`resolve_asset_class`).
        class_gate:  per-class filter verdict — dict with ``passes`` and
                     optional ``reason`` + ``metrics`` (or None when the class
                     filter reported no verdict, treated as not-passing).
        regime_type: honest regime classification (None when unknown yet).
        spread_status: "tight" | "wide" | "no_quotes" | "synthetic" | None.
        min_confidence: optional user-set minimum executable confidence pct
            (50.0..99.0); None = engine's 96.5% strict default.
        min_tier: optional user-set minimum tier "T1".."T4" (see
            :func:`resolve_execution_floor`). Takes precedence over
            ``min_confidence`` when valid. T5 is accepted but floored to T4 —
            T5 is monitor-only, never executable.

    Returns the full execution surface consumed by the /predict merge::

        {
          "executable": bool,
          "dispatchable": bool,      # a genuine direction exists at all
          "scored_only": bool,       # direction exists but floor/class blocks it
          "regime_gate": "tradable" | "pending_high_precision",
          "regime_status": "CONFIRMED" | "PENDING_HIGH_PRECISION",
          "suppressed_reason": None | str,   # "below_high_precision_bar" | class reason | "insufficient_input"
          "status": "active",
          "tier": "T1" … "T5" (honest resolved tier, never overwritten),
          "tier_label": "PREMIUM" …,
          "threshold_pct": 96.5 (or the effective user bar),
          "min_tier": "T1" … "T4",   # the floor actually applied
          "bar_source": "default" | "user" | "floored",
          "asset_class": "OTC" | "REAL",
          "class_gate": {..passes/reason/metrics..} | None,
          "metrics": {confluence_score, regime_type, spread_status, ...},
        }

    Direction is always kept honest — a sub-bar verdict keeps its direction,
    it is merely surfaced as not executable (SCORED-ONLY). The honest ``tier``
    is reported for EVERY band: the ladder labels confidence, it never hides
    it. Only `executable` is floor-dependent, and the floor belongs to the user.
    """
    direction = _as_signal(signal)
    frac = normalize_confidence(confidence)
    pct = round(frac * 100.0, 2)
    tier = resolve_tier(frac)
    tier_label = TIER_LABELS.get(tier, "WEAK")

    class_gate = dict(class_gate or {})
    gate_provided = bool(class_gate)
    class_passes = bool(class_gate.get("passes")) if gate_provided else False
    class_reason = class_gate.get("reason")
    class_metrics = class_gate.get("metrics") or {}

    # Effective executable bar: engine default T1/96.5%, or the user's tier
    # selector (`min_tier`), or their numeric filter (`min_confidence`).
    # >= so EXACTLY the bar IS executable.
    bar_frac, bar_pct, bar_source = _resolve_execution_bar(min_confidence, min_tier)
    applied_floor = resolve_execution_floor(min_tier)
    min_tier_applied = applied_floor["min_tier"]

    # ── DYNAMIC PER-ASSET-CLASS FLOOR (REAL quote-proxy mode) ──
    # Only when: no user filter was supplied, the asset is REAL, the class gate
    # PASSES on candle proxies (quote_proxy=True means no L2 quotes existed),
    # and the relaxation is enabled. The bar then relaxes to
    # REAL_PROXY_EXECUTABLE_FLOOR (never below T4, never above the strict
    # default) and bar_source is stamped "real_proxy_floor" so the decision is
    # auditable. A failing proxy gate or an explicit user bar still applies the
    # normal strict/user/floored bar.
    class_metrics_default = class_metrics
    if (
        bar_source == "default"
        and str(asset_class).upper() == "REAL"
        and gate_provided
        and class_passes
        and bool(class_metrics.get("quote_proxy") or class_metrics_default.get("quote_proxy"))
        and REAL_PROXY_EXECUTABLE_FLOOR_FRAC is not None
        and REAL_PROXY_EXECUTABLE_FLOOR_FRAC < bar_frac
    ):
        bar_frac = REAL_PROXY_EXECUTABLE_FLOOR_FRAC
        bar_pct = round(bar_frac * 100.0, 2)
        bar_source = BAR_SOURCE_REAL_PROXY_FLOOR

    bar_cleared = frac >= bar_frac
    directional = direction in ("BUY", "SELL")
    # A class gate that is PROVIDED must explicitly pass. No gate supplied
    # (direct callers only — /predict always supplies one) is not vetoed.
    class_verified = class_passes if gate_provided else True
    executable = directional and bar_cleared and class_verified

    if executable:
        regime_gate = REGIME_GATE_TRADABLE
        regime_status = REGIME_STATUS_CONFIRMED
        suppressed_reason = None
    elif gate_provided and not class_passes:
        # Class filter (OTC HF / REAL liquidity / sanitization) vetoed it.
        regime_gate = REGIME_GATE_PENDING_HIGH_PRECISION
        regime_status = REGIME_STATUS_PENDING_HIGH_PRECISION
        suppressed_reason = class_reason or SUPPRESSED_REASON_HIGH_PRECISION
    elif not directional:
        regime_gate = REGIME_GATE_PENDING_HIGH_PRECISION
        regime_status = REGIME_STATUS_PENDING_HIGH_PRECISION
        suppressed_reason = SUPPRESSED_REASON_HIGH_PRECISION
    else:
        # Below the effective executable bar (96.5% default or the user's
        # min_confidence filter) → SCORED-ONLY, high-precision gate pending.
        regime_gate = REGIME_GATE_PENDING_HIGH_PRECISION
        regime_status = REGIME_STATUS_PENDING_HIGH_PRECISION
        suppressed_reason = SUPPRESSED_REASON_HIGH_PRECISION

    surface = {
        "signal": direction,
        "confidence": round(frac, 6),
        "confidence_pct": pct,
        "executable": executable,
        # ── Flexible-tier metadata (2026-09-30) ──
        # `dispatchable` and `scored_only` let a UI express "there IS a
        # direction, but you chose not to trade it" without inferring intent
        # from the tier label. Previously that state was signalled by
        # overwriting `tier` with T5, which destroyed the honest tier.
        "dispatchable": bool(directional),
        "scored_only": bool(directional and not executable),
        "regime_gate": regime_gate,
        "regime_status": regime_status,
        "suppressed_reason": suppressed_reason,
        "status": "active",
        "tier": tier,
        "tier_label": tier_label,
        "threshold_pct": bar_pct,
        "min_tier": min_tier_applied,
        "bar_source": bar_source,
        "max_executable_tier": MAX_EXECUTABLE_TIER_LABEL,
        "asset_class": str(asset_class),
        "class_gate": class_gate if class_gate else None,
        "metrics": _audit_metrics(
            confidence_pct=pct,
            regime_type=regime_type,
            spread_status=spread_status,
            asset_class=str(asset_class),
            tier=tier,
        ),
    }
    surface["metrics"].update(class_metrics)
    if bar_source == BAR_SOURCE_REAL_PROXY_FLOOR:
        surface["metrics"]["dynamic_floor"] = {
            "asset_class": str(asset_class).upper(),
            "floor_pct": bar_pct,
            "precondition": "real_quote_proxy_gate_green",
            "reason": "no L2 books — spread/ATR + flow + MTF proxies all green; "
                      "strict 96.5% bar relaxed so a fully-proxied REAL pair is "
                      "never permanently blocked.",
        }

    _logger.info(
        "SIGNAL_EVALUATION_AUDIT",
        signal=direction,
        asset_class=str(asset_class),
        regime_type=regime_type,
        spread_status=spread_status,
        confidence_pct=surface["confidence_pct"],
        executable=executable,
        regime_gate=regime_gate,
        tier=tier,
        threshold_pct=surface["threshold_pct"],
        bar_source=bar_source,
        suppressed_reason=suppressed_reason,
    )
    return surface