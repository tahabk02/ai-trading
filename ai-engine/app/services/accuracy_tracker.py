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

PART 33 [239] — PER-ASSET-TYPE RESOLVED-SIGNAL HISTORY
  The 100-outcome window above is a single shared deque: right for one
  house-wide precision number, wrong for learning a weight per market type,
  because OTC / REAL / CRYPTO would compete for the same 100 slots and none
  could reach the >= MIN_RESOLVED_SIGNALS (30, PART 19.2 [120]) evidence floor.
  Each recorded outcome is therefore ALSO appended to its asset type's own
  bounded ledger, which serves :meth:`calibration_curve` and the per-type
  weight learner in :mod:`app.services.asset_type_weights`. Nothing about the
  shared window changes — this is additional history, not a replacement.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any, Deque, Dict, Optional

from .asset_class import (
    ASSET_CLASS_CRYPTO,
    ASSET_CLASS_OTC,
    ASSET_CLASS_REAL,
    resolve_asset_class,
)
from .signal_gatekeeper import HARD_GATE

WINDOW_SIZE = 100
WIN_RATE_TARGET = HARD_GATE  # 0.98 — the shipped precision contract (what a healthy window must sustain)
WIN_RATE_TRIGGER = 0.96  # PART 5: watchdog auto-raises the gate below THIS win-rate, not below the contract
MAX_GATE = 0.995  # PART 5: auto-raise ceiling (was 0.999)
GATE_STEP = 0.005  # one bounded 50bp step per cooldown expiry
_RAISE_COOLDOWN_OUTCOMES = 10

# ═══════════════════════════════════════════════════════════════════════════
# PART 33 [239] — PER-ASSET-TYPE RESOLVED-SIGNAL HISTORY
# The rolling window above is a single 100-outcome deque shared by EVERY symbol.
# That is the correct shape for the global watchdog (one house-wide precision
# number), but it is the WRONG shape for per-asset-type learning: with three
# market types competing for 100 slots, no single type can ever accumulate the
# >= MIN_RESOLVED_SIGNALS evidence it needs before its weights are allowed to
# move (PART 19.2 [120]).
#
# So each resolved outcome is ALSO appended to a per-asset-class ledger with its
# OWN bound. The 100-window is left exactly as it was (the watchdog contract and
# its tests depend on it); this is additive history, not a replacement.
# ═══════════════════════════════════════════════════════════════════════════
CLASS_HISTORY_SIZE = 500

# PART 19.2 [120] — the minimum resolved-signal count before ANY per-asset-type
# figure (learned weight, calibration curve, per-type win rate) is treated as
# evidence rather than noise. Below this the type reports an explicit
# ``insufficient_data`` state and its profile keeps its structural priors.
MIN_RESOLVED_SIGNALS = 30

# PART 33 — calibration bins over the signal-time confidence (0-100). Same edges
# the client-side reliability table uses (client-app/src/lib/accuracyVerifier.ts)
# so the two surfaces cannot drift into disagreeing bin boundaries.
CALIBRATION_BINS = ((0.0, 60.0), (60.0, 80.0), (80.0, 90.0), (90.0, 95.0), (95.0, 100.01))

ASSET_CLASSES = (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO)


class AccuracyTracker:
    """Rolling accuracy store + watchdog recommend/auto-raise logic."""

    def __init__(
        self,
        window_size: int = WINDOW_SIZE,
        class_history_size: int = CLASS_HISTORY_SIZE,
    ) -> None:
        self._lock = threading.RLock()
        self._window_size = int(window_size)
        self._outcomes: Deque[Dict[str, Any]] = deque(maxlen=self._window_size)
        self._gate_override: Optional[float] = None
        self._outcomes_since_raise: int = 0
        # PART 33 [239] — per-asset-type ledgers. Each keeps its OWN bounded
        # history so OTC/REAL/CRYPTO never starve one another out of the shared
        # 100-window. Empty until real outcomes are recorded.
        self._class_history_size = int(class_history_size)
        self._class_outcomes: Dict[str, Deque[Dict[str, Any]]] = {
            name: deque(maxlen=self._class_history_size) for name in ASSET_CLASSES
        }

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
        asset_class: Optional[str] = None,
    ) -> None:
        """Record ONE real closed outcome (``outcome`` in {"WIN", "LOSS"}).

        ``tier`` is the signal-time tier (T1…T5) resolved by the engine.

        PART 33 [239]: the outcome is mirrored into its asset type's own ledger
        (``asset_class``, resolved from ``symbol`` via the single source of truth
        in :mod:`app.services.asset_class` when not supplied explicitly) so a
        weight profile can be learned from ITS OWN type's resolved signals
        instead of borrowing a house-wide average across type boundaries.
        """
        resolved_class = str(asset_class).upper() if asset_class else resolve_asset_class(symbol)
        if resolved_class not in self._class_outcomes:
            resolved_class = resolve_asset_class(None)  # unknown -> OTC (safe default)
        record = {
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
        with self._lock:
            self._outcomes.appendleft(dict(record))
            self._class_outcomes[resolved_class].appendleft(dict(record))
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

    # ── PART 33 [239]: per-asset-type resolved-signal views ──
    def asset_class_history(self, asset_class: Any) -> list:
        """A snapshot copy of one asset type's own resolved-signal ledger."""
        key = str(asset_class or "").upper()
        with self._lock:
            return list(self._class_outcomes.get(key) or ())

    def asset_class_stats(self) -> Dict[str, Dict[str, Any]]:
        """Per-type resolved count / win rate over that type's OWN history.

        ``insufficient_data`` is True until a type has
        ``MIN_RESOLVED_SIGNALS`` (30, PART 19.2 [120]) resolved signals. Below
        that the win rate is reported but is explicitly marked as NOT yet
        evidence — nothing downstream may learn from it.
        """
        out: Dict[str, Dict[str, Any]] = {}
        with self._lock:
            snapshots = {k: list(v) for k, v in self._class_outcomes.items()}
        for name, rows in snapshots.items():
            total = len(rows)
            wins = sum(1 for o in rows if o["outcome"] == "WIN")
            out[name] = {
                "resolved": total,
                "wins": wins,
                "losses": total - wins,
                "win_rate": round(wins / total, 4) if total else None,
                "sufficient_data": total >= MIN_RESOLVED_SIGNALS,
                "insufficient_data": total < MIN_RESOLVED_SIGNALS,
                "min_required": MIN_RESOLVED_SIGNALS,
            }
        return out

    def factor_win_rates_by_asset_class(self) -> Dict[str, Dict[str, Dict[str, Any]]]:
        """Per-type × per-factor win-rates, each from ITS OWN resolved signals.

        A factor's win rate is measured only over the outcomes where it was
        ALIGNED (>= 0.5), matching :meth:`factor_win_rates`. Each bucket also
        carries ``sufficient_data`` against ``MIN_RESOLVED_SIGNALS`` so a
        weight learner can refuse to move a weight on two lucky samples.
        """
        out: Dict[str, Dict[str, Dict[str, Any]]] = {}
        for name in ASSET_CLASSES:
            buckets: Dict[str, Dict[str, int]] = {}
            for o in self.asset_class_history(name):
                factors = o.get("factors") or {}
                for fname, aligned in factors.items():
                    b = buckets.setdefault(fname, {"aligned": 0, "wins": 0})
                    if float(aligned) >= 0.5:
                        b["aligned"] += 1
                        if o["outcome"] == "WIN":
                            b["wins"] += 1
            per_factor: Dict[str, Dict[str, Any]] = {}
            for fname, b in buckets.items():
                n = b["aligned"]
                per_factor[fname] = {
                    "aligned_count": n,
                    "wins": b["wins"],
                    "win_rate": round(b["wins"] / n, 4) if n else None,
                    "sufficient_data": n >= MIN_RESOLVED_SIGNALS,
                }
            out[name] = per_factor
        return out

    def calibration_curve(self, asset_class: Any) -> Dict[str, Any]:
        """Reliability curve over ONE asset type's resolved signals.

        ``bins`` maps a signal-time confidence band to the observed win rate of
        the resolved signals that landed in it — the honest answer to "does a 96%
        book-agreement number on THIS asset type mean 96%?". Until the type has
        ``MIN_RESOLVED_SIGNALS`` resolved signals the curve is reported as
        ``insufficient_data`` with empty bins rather than a number derived from
        a handful of samples.
        """
        rows = self.asset_class_history(asset_class)
        total = len(rows)
        bins: list = []
        for lo, hi in CALIBRATION_BINS:
            in_band = [
                o for o in rows
                if lo <= float(o["confidence"]) < hi
            ]
            wins = sum(1 for o in in_band if o["outcome"] == "WIN")
            bins.append({
                "lo": lo,
                "hi": hi,
                "count": len(in_band),
                "wins": wins,
                "observed_win_rate": (
                    round(wins / len(in_band), 4) if in_band else None
                ),
                # A bin is only evidence once it holds >= MIN_RESOLVED_SIGNALS
                # of its OWN resolved signals.
                "sufficient_data": len(in_band) >= MIN_RESOLVED_SIGNALS,
            })
        wins = sum(1 for o in rows if o["outcome"] == "WIN")
        return {
            "asset_class": str(asset_class or "").upper(),
            "resolved": total,
            "wins": wins,
            "win_rate": round(wins / total, 4) if total else None,
            "bins": bins,
            "min_required": MIN_RESOLVED_SIGNALS,
            "sufficient_data": total >= MIN_RESOLVED_SIGNALS,
            "insufficient_data": total < MIN_RESOLVED_SIGNALS,
        }

    def calibration_by_asset_class(self) -> Dict[str, Dict[str, Any]]:
        """All three per-type reliability curves (OTC / REAL / CRYPTO)."""
        return {name: self.calibration_curve(name) for name in ASSET_CLASSES}

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
            # PART 33 [239] — per-asset-type resolved-signal history. Additive:
            # the house-wide figures above keep their exact existing shape.
            "by_asset_class": self.asset_class_stats(),
            "factor_win_rates_by_asset_class": self.factor_win_rates_by_asset_class(),
            "min_resolved_signals": MIN_RESOLVED_SIGNALS,
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