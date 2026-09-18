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

from typing import Any, Dict, Optional

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