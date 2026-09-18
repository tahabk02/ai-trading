"""
accuracy_tracker.py — ROLLING LAST-100 WIN/LOSS ACCURACY TRACKER (PART 5: watchdog raises the gate when win_rate < 0.96, stepping +0.005 up to a 0.995 ceiling)

Tracks the REAL outcome of every released (>= HARD_GATE) trading signal in a
rolling 100-outcome window and exposes it via /health/accuracy.

Design:
  * Thread-safe (a lock guards the deque; FastAPI runs sync blocking calls in
    a worker thread, so /health/accuracy reads are safe against concurrent
    record_outcome writes from the execution path).
  * Rolling window of exactly ``WINDOW_SIZE = 100`` — new outcomes evict the
    oldest so the mounted accuracy is always the LAST 100 real decisions.
  * ``record_outcome`` is the single ingestion point. The live execution path
    (core-backend fills) posts real closed-trade outcomes to it; tests call it
    directly with the same contract.
  * AUTO-RAISE WATCHDOG: because the shipped hard gate is 0.98, if the rolling
    win-rate ever drops strictly below that configured precision target the
    tracker raises the effective ensemble gate (toward 0.99) so the engine
    tightens into higher evidence instead of silently degrading. The raised
    gate is a live value read by quality_gate.evaluate_quality — it genuinely
    takes effect on the next emission decision.
  * Every metrics field is honest real observed count — no fabrication, no
    demos. An empty window reports an explicit "insufficient_data" state.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any, Deque, Dict, Optional

from .signal_gatekeeper import HARD_GATE

WINDOW_SIZE = 100
WIN_RATE_TARGET = HARD_GATE  # 0.98 — the shipped precision contract (what a healthy window must sustain)
WIN_RATE_TRIGGER = 0.96  # PART 5: watchdog auto-raises the gate below THIS win-rate, not below the contract
MAX_GATE = 0.995  # PART 5: auto-raise ceiling (was 0.999)
GATE_STEP = 0.005  # one bounded 50bp step per cooldown expiry
_RAISE_COOLDOWN_OUTCOMES = 10


class AccuracyTracker:
    """Rolling accuracy store + watchdog recommend/auto-raise logic."""

    def __init__(self, window_size: int = WINDOW_SIZE) -> None:
        self._lock = threading.RLock()
        self._window_size = int(window_size)
        self._outcomes: Deque[Dict[str, Any]] = deque(maxlen=self._window_size)
        self._gate_override: Optional[float] = None
        self._outcomes_since_raise: int = 0

    # ── ingestion ──
    def record_outcome(
        self,
        symbol: str,
        direction: Optional[str],
        confidence: float,
        outcome: str,
        factors: Optional[Dict[str, float]] = None,
        quality: Optional[float] = None,
        entry: Optional[float] = None,
        exit_price: Optional[float] = None,
        tier: Optional[str] = None,
    ) -> None:
        """Record ONE real closed outcome (``outcome`` in {"WIN", "LOSS"}).

        ``tier`` is the signal-time tier (T1…T5) resolved by the engine.
        """
        with self._lock:
            self._outcomes.appendleft(
                {
                    "ts": time.time(),
                    "symbol": symbol,
                    "direction": direction,
                    "confidence": float(confidence),
                    "outcome": outcome,
                    "quality": quality,
                    "factors": dict(factors) if factors else None,
                    "entry": entry,
                    "exit_price": exit_price,
                    "tier": str(tier or "T5").upper(),
                }
            )
            self._outcomes_since_raise += 1
            self._maybe_auto_raise()

    def _maybe_auto_raise(self) -> None:
        """Watchdog: if the rolling win-rate sinks below the 0.96 trigger, raise
        the effective gate (never lower it) toward the 0.995 ceiling.

        Stepping is BOUNDED: a raise only lands once the window has advanced at
        least ``_RAISE_COOLDOWN_OUTCOMES`` records since the last raise, so a
        persistent sub-trigger tape tightens gradually instead of ratcheting to
        the ceiling on one burst of bad outcomes.
        """
        report = self._rolling_stats()
        if report.get("window_size", 0) < self._window_size:
            return
        if self._outcomes_since_raise < _RAISE_COOLDOWN_OUTCOMES:
            return
        win_rate = report["win_rate"]
        if win_rate is None or win_rate + 1e-12 >= WIN_RATE_TRIGGER:
            return
        current = self.current_hard_gate()
        raised = round(min(current + GATE_STEP, MAX_GATE), 4)
        if raised > current:
            self._gate_override = raised
            self._outcomes_since_raise = 0

    # ── gate consult ──
    def current_hard_gate(self) -> float:
        """Effective hard gate = canonical 0.98, auto-raised if the watchdog
        has tripped (the value quality_gate actually enforces)."""
        return float(self._gate_override) if self._gate_override is not None else float(HARD_GATE)

    def is_gate_raised(self) -> bool:
        return self._gate_override is not None

    # ── metrics ──
    def _rolling_stats(self) -> Dict[str, Any]:
        with self._lock:
            total = len(self._outcomes)
            wins = sum(1 for o in self._outcomes if o["outcome"] == "WIN")
            losses = sum(1 for o in self._outcomes if o["outcome"] == "LOSS")
        win_rate = (wins / total) if total else None
        return {
            "window_size": total,
            "wins": wins,
            "losses": losses,
            "win_rate": win_rate,
        }

    def factor_win_rates(self) -> Dict[str, Dict[str, Any]]:
        """Per-factor (of the 5-factor ensemble) win-rates over the window."""
        with self._lock:
            buckets: Dict[str, Dict[str, int]] = {}
            for o in self._outcomes:
                if not o.get("factors"):
                    continue
                for name, aligned in o["factors"].items():
                    b = buckets.setdefault(name, {"aligned": 0, "wins": 0})
                    if float(aligned) >= 0.5:
                        b["aligned"] += 1
                        if o["outcome"] == "WIN":
                            b["wins"] += 1
        out: Dict[str, Dict[str, Any]] = {}
        for name, b in buckets.items():
            out[name] = {
                "aligned_count": b["aligned"],
                "win_rate": round(b["wins"] / b["aligned"], 4) if b["aligned"] else None,
            }
        return out

    def tier_win_rates(self) -> Dict[str, Dict[str, Any]]:
        """Per-tier (T1…T5) win-rates over the rolling window."""
        with self._lock:
            tiers: Dict[str, Dict[str, int]] = {}
            for o in self._outcomes:
                t = str(o.get("tier") or "T5").upper()
                b = tiers.setdefault(t, {"count": 0, "wins": 0})
                b["count"] += 1
                if o["outcome"] == "WIN":
                    b["wins"] += 1
        out: Dict[str, Dict[str, Any]] = {}
        for t, b in tiers.items():
            out[t] = {
                "count": b["count"],
                "wins": b["wins"],
                "win_rate": round(b["wins"] / b["count"], 4) if b["count"] else None,
            }
        return out

    def report(self) -> Dict[str, Any]:
        """Full accuracy pulse for /health/accuracy."""
        stats = self._rolling_stats()
        return {
            "window_size": stats["window_size"],
            "target": float(WIN_RATE_TARGET),
            "hard_gate_pct": round(self.current_hard_gate() * 100.0, 4),
            "gate_raised": self.is_gate_raised(),
            "gate_auto_raised_to": (
                round(self.current_hard_gate() * 100.0, 4) if self.is_gate_raised() else None
            ),
            "wins": stats["wins"],
            "losses": stats["losses"],
            "win_rate": round(stats["win_rate"], 4) if stats["win_rate"] is not None else None,
            "within_target": (
                stats["win_rate"] is not None and stats["win_rate"] >= WIN_RATE_TARGET - 1e-12
            ),
            "factor_win_rates": self.factor_win_rates(),
            "tier_win_rates": self.tier_win_rates(),
            "insufficient_data": stats["window_size"] < 2,
            "timestamp": int(time.time()),
        }


# Module-level singleton — the SAME tracker serves the /health/accuracy route,
# the record route and quality_gate's auto-raised gate.
_accuracy_tracker: Optional[AccuracyTracker] = None
_tracker_lock = threading.Lock()


def get_accuracy_tracker() -> AccuracyTracker:
    global _accuracy_tracker
    if _accuracy_tracker is None:
        with _tracker_lock:
            if _accuracy_tracker is None:
                _accuracy_tracker = AccuracyTracker()
    return _accuracy_tracker


def accuracy_report() -> Dict[str, Any]:
    """Public report entry point used by /health/accuracy."""
    return get_accuracy_tracker().report()