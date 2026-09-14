"""
signal_gatekeeper.py — STRICT 96.5% HARD GATE (backend parity)

Backend mirror of the client gate (client-app SIGNAL_CONFIDENCE_THRESHOLD =
0.965) and the quant-matrix thermal floor (DEFINITIVE_CONFIDENCE_MIN = 96.5).

Contract:
  * A directional BUY/SELL verdict is EXECUTABLE only when its genuine
    dynamic confidence strictly clears the hard gate on EITHER scale:
      - 0..1  : confidence >= 0.965
      - 0..100: confidence >= 96.5
  * Below the gate the direction is KEPT (no fabrication, never HOLD) but the
    verdict is flagged market_waiting=True with gate="HARD_GATE" so no host
    dispatches it.
  * Confidence is cross-scale normalized defensively (1.0..100 → 0.01..1.0).
  * Every failure path (missing/invalid inputs) returns a deterministic
    safe-gated result — no fabricated executable signal, ever.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

# ── THE HARD GATE — one canonical value, one source of truth ──
HARD_GATE = 0.965              # fractional scale (client parity, 0..1)
DEFINITIVE_CONFIDENCE_MIN = 96.5  # percentage scale (quant-matrix parity)

GATE_REASON = "HARD_GATE"


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


def is_executable(
    signal: Any,
    confidence: Any,
    threshold: float = HARD_GATE,
) -> bool:
    """True only when a real directional signal clears the hard gate.

    Non-directional signals (None, "HOLD", "" …) are never executable.
    """
    direction = _as_signal(signal)
    if direction not in ("BUY", "SELL"):
        return False
    gate = _as_float(threshold)
    if gate is None:
        gate = HARD_GATE
    frac = normalize_confidence(confidence)
    return frac >= gate


def apply_gate(
    signal: Any,
    confidence: Any,
    threshold: float = HARD_GATE,
) -> Dict[str, Any]:
    """Resolve a verdict against the hard gate (backend parity payload).

    Returns:
      {
        "signal": "BUY" | "SELL" | None,
        "confidence": float (fractional 0..1),
        "confidence_pct": float (0..100),
        "executable": bool,
        "market_waiting": bool,
        "gate": "HARD_GATE" | None,
        "threshold_pct": float,
      }
    Direction is ALWAYS kept when present — a sub-gate verdict is flagged
    market_waiting, never coerced to HOLD.
    """
    direction = _as_signal(signal)
    frac = normalize_confidence(confidence)
    pct = round(frac * 100.0, 2)
    gate = _as_float(threshold)
    if gate is None:
        gate = HARD_GATE
    threshold_pct = round(gate * 100.0, 2)

    executable = direction in ("BUY", "SELL") and frac >= gate

    return {
        "signal": direction,
        "confidence": round(frac, 6),
        "confidence_pct": pct,
        "executable": executable,
        "market_waiting": direction in ("BUY", "SELL") and not executable,
        "gate": GATE_REASON if not executable and direction in ("BUY", "SELL") else None,
        "threshold_pct": threshold_pct,
    }


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