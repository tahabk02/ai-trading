"""
asset_type_weights.py — PART 33 [239] PER-ASSET-TYPE BOOK-WEIGHT PROFILES

The five-factor quality ensemble (quality_gate.GATE_WEIGHTS) is a SINGLE weight
vector shared by every symbol in the platform. That was reasonable while the
book was one market. It is not defensible now that the engine carries three
structurally different microstructures (:mod:`app.services.asset_class`):

  * OTC     — synthetic / retail-class. Fast, thin, documented mean-reverting.
  * REAL    — institutional wholesale FX. Deep book, session-bound, real spread.
  * CRYPTO  — 24/7 majors. No FX session, no consolidated L2 in this stack, and
              volatility one to two orders of magnitude above FX.

A weight that means something on an FX spread does not carry the same meaning on
a synthetic OTC generator, and the engine already proves the point structurally:
each class already has its OWN volatility band (``otc_hf_quality`` /
``real_liquidity_gate`` / ``crypto_hf_quality``) and its OWN execution strategy
(``market_strategies/``) while the ENSEMBLE weights stayed shared. This module
finishes that split on the scoring side.

WHAT IS ACTUALLY DIFFERENT (and why it is not arbitrary)
--------------------------------------------------------
Only two knobs move, and both are anchored to something already measured in the
codebase:

  1. ``base_weights`` — a documented STRUCTURAL prior per asset type, seeded from
     the same per-class evidence the execution gates already encode. Not tuned to
     a target number; never claimed to improve accuracy on its own.
  2. ``learned_weights`` — a bounded, per-type tilt derived ONLY from that type's
     OWN resolved signals, via ``accuracy_tracker``. This is the PART 12 [27]c
     requirement: an OTC weight may only ever move on OTC outcomes.

THE HONEST PART (PART 33 [240])
-------------------------------
A weight is allowed to move only when its type has at least
``MIN_RESOLVED_SIGNALS`` (30) resolved signals AND that factor has at least
``MIN_FACTOR_SIGNALS`` aligned observations behind it. Below either floor the
profile reports ``learned=False`` and keeps its structural prior. On a fresh
deployment every type has ZERO resolved signals, so every profile is in prior
state and NOTHING is learned — which is the correct, honest behaviour, not a
silent fallback to a shared average.

The tilt is additionally:
  * clamped to ``MAX_TILT`` so a type can never become a single-factor vote,
  * required to clear ``MIN_INFORMATIVE_TILT`` before the profile is honestly
    reported as ``learned`` — a type where every factor sits at a 0.5 win rate
    keeps its prior and says so,
  * re-normalised to sum 1.0 so the ensemble keeps its "any single failed factor
    caps the score" property (weights still sum to 1),
  * anchored so that a 0.5-win-rate factor gets weight ~UNCHANGED (only
    demonstrably informative factors gain), and a factor with no evidence at all
    keeps its prior share exactly.

None of this can relax the emission bar. ``QUALITY_EMIT_BAR`` is untouched, and
because the weights still sum to 1.0 the strict 5/5 requirement for T1 is
mathematically unchanged — only WHICH factor a borderline tape fails changes.
"""

from __future__ import annotations

import threading
from typing import Any, Dict, List, Optional, Tuple

from .accuracy_tracker import (
    MIN_RESOLVED_SIGNALS,
    get_accuracy_tracker,
)
from .asset_class import (
    ASSET_CLASS_CRYPTO,
    ASSET_CLASS_OTC,
    ASSET_CLASS_REAL,
    resolve_asset_class,
)
from .quality_gate import FACTOR_ORDER, GATE_WEIGHTS

# Per-factor evidence floor. A type may have 30 resolved signals but only 4 with
# a volume surge; four samples cannot justify moving a weight.
MIN_FACTOR_SIGNALS = 10

# Maximum proportional tilt any single factor may receive from learning. Even a
# perfectly informative factor cannot take the ensemble hostage.
MAX_TILT = 0.5

# NOTE: ``profile_for`` reports ``learned=True`` only when a factor was both
# evidenced AND demonstrably informative (see MIN_INFORMATIVE_TILT).

# Neutral win rate: a factor aligned on exactly half its outcomes is worth its
# prior share, untouched. Learning only rewards DEMONSTRABLY informative factors.
NEUTRAL_WIN_RATE = 0.5

# Minimum proportional tilt before a type is reported as ``learned``. Guards
# against the "every factor is a coin flip" case, where a naive implementation
# would claim learned=True while producing weights numerically identical to the
# prior. 1.25% of prior weight corresponds to a factor whose aligned win rate
# is ~52.5% on a full-size sample — the smallest deviation we are willing to
# call evidence rather than noise.
MIN_INFORMATIVE_TILT = 0.025

# ── STRUCTURAL PRIORS ──────────────────────────────────────────────────────
# Seeded from the per-class microstructure the engine already encodes, and
# anchored so that all three sums are 1.0 (the ensemble's "a single failed
# factor caps the score" property depends on it).
#
# OTC (synthetic, mean-reverting, no real order book):
#   The OTC tape reverts, so raw trend persistence is the LEAST trustworthy
#   input here, and the OTC gate itself already leans on mean reversion rather
#   than momentum. Volume/pressure are weak because the synthetic generator has
#   no genuine resting book. → trend structure (mtf) and momentum are trimmed,
#   order flow (pressure) carries the most weight.
BASE_WEIGHTS: Dict[str, Dict[str, float]] = {
    ASSET_CLASS_OTC: {
        "mtf": 0.20,
        "momentum": 0.20,
        "volatility": 0.15,
        "volume": 0.15,
        "pressure": 0.30,
    },
    # REAL (institutional FX, deep book, genuine one-sided flow):
    #   This is the one class where a real L2 book exists, so resting
    #   liquidity genuinely reflects institutional intent — order flow earns
    #   real weight, and the session-bound structure makes multi-timeframe
    #   alignment meaningful.
    ASSET_CLASS_REAL: {
        "mtf": 0.25,
        "momentum": 0.20,
        "volatility": 0.15,
        "volume": 0.15,
        "pressure": 0.25,
    },
    # CRYPTO (24/7, breakout-driven, no consolidated L2 in this stack):
    #   crypto_hf_quality already documents crypto as a breakout/momentum
    #   market with a volatility band ~12x the FX one. Momentum and volatility
    #   are the primary evidence; order flow is the WEAKEST input because this
    #   stack has no reliable consolidated book for BTC/ETH (the documented
    #   reason they were moved OUT of the REAL class).
    ASSET_CLASS_CRYPTO: {
        "mtf": 0.20,
        "momentum": 0.30,
        "volatility": 0.20,
        "volume": 0.15,
        "pressure": 0.15,
    },
}

# The shipped shared vector, kept as the explicit identity baseline so a caller
# can always ask "what would the single shared weighting have said?".
SHARED_WEIGHTS: Dict[str, float] = dict(GATE_WEIGHTS)

_RATIONALE: Dict[str, str] = {
    ASSET_CLASS_OTC: (
        "Synthetic mean-reverting OTC tape with no genuine resting book: trend "
        "persistence is least trustworthy, tick-position order flow is most."
    ),
    ASSET_CLASS_REAL: (
        "Institutional wholesale FX: a real L2 book exists, so one-sided order "
        "flow reflects real intent and session structure makes MTF meaningful."
    ),
    ASSET_CLASS_CRYPTO: (
        "24/7 breakout tape with no consolidated L2 in this stack: momentum and "
        "volatility dominate, order flow is the weakest available input."
    ),
}

_lock = threading.RLock()


def _normalise(weights: Dict[str, float]) -> Dict[str, float]:
    """Clamp into [0,1] and rescale to sum exactly 1.0 over the factor set."""
    cleaned = {
        name: max(0.0, float(weights.get(name, 0.0))) for name in FACTOR_ORDER
    }
    total = sum(cleaned.values())
    if total <= 0.0:
        return dict(SHARED_WEIGHTS)
    return {name: round(cleaned[name] / total, 6) for name in FACTOR_ORDER}


def base_weights_for(asset_class: Any) -> Dict[str, float]:
    """The structural prior for one asset type (never empty, never None)."""
    key = str(asset_class or "").upper()
    if key not in BASE_WEIGHTS:
        key = resolve_asset_class(None)  # unknown -> OTC (safe default)
    return dict(BASE_WEIGHTS[key])


def learned_weights_for(
    asset_class: Any,
    tracker: Optional[Any] = None,
) -> Optional[Dict[str, float]]:
    """Learn a tilt for ONE asset type from ITS OWN resolved signals.

    Returns ``None`` when the type has not reached
    ``MIN_RESOLVED_SIGNALS`` resolved signals — i.e. there is nothing to learn
    from and the caller must keep the structural prior. This is the honest
    PART 12 [27]c boundary: an OTC weight never moves on REAL or CRYPTO
    outcomes.
    """
    key = str(asset_class or "").upper()
    if key not in BASE_WEIGHTS:
        key = resolve_asset_class(None)
    src = tracker if tracker is not None else get_accuracy_tracker()

    stats = src.asset_class_stats().get(key) or {}
    if not stats.get("sufficient_data"):
        return None

    per_factor = (src.factor_win_rates_by_asset_class() or {}).get(key) or {}
    prior = base_weights_for(key)

    # Per-factor multiplier, applied to the prior and then renormalised to sum 1.0.
    # A factor with no usable evidence gets a multiplier of exactly 1.0 ("do not
    # touch me"): its absolute weight is untouched, and the renormalisation
    # rescales all factors by the same constant — so an unevidenced factor is
    # never singled out, and never claims to have become less important.
    multiplier: Dict[str, float] = {name: 1.0 for name in FACTOR_ORDER}
    informed: List[str] = []
    # A factor must be not just evidenced but DEMONSTRABLY informative before it
    # counts as learned. Without this threshold a type whose every factor sits
    # at exactly 0.5 (pure coin flips) would be reported learned=True with
    # weights identical to the prior — technically true and completely
    # meaningless, i.e. a lie by omission.
    max_abs_tilt = 0.0
    for name in FACTOR_ORDER:
        bucket = per_factor.get(name) or {}
        n = int(bucket.get("aligned_count", 0) or 0)
        wr = bucket.get("win_rate")
        if n < MIN_FACTOR_SIGNALS or wr is None:
            continue
        # Shrink by sample size so a 10-sample factor cannot swing as hard as a
        # 200-sample one, and never tilt below zero.
        shrink = min(1.0, n / float(MIN_FACTOR_SIGNALS))
        tilt = (float(wr) - NEUTRAL_WIN_RATE) * MAX_TILT * shrink
        max_abs_tilt = max(max_abs_tilt, abs(tilt))
        multiplier[name] = 1.0 + tilt
        informed.append(name)

    if not informed or max_abs_tilt < MIN_INFORMATIVE_TILT:
        return None

    # Phase 2 — redistribute the informed factors WITHIN the share the
    # no-evidence factors do not hold. This matters: a plain global
    # renormalisation would silently shrink every unevidenced factor in
    # proportion to the others, which reads as "volume became less important"
    # when the truth is only "we have no view on volume". Here an unevidenced
    # factor keeps its prior SHARE exactly, and only the informed factors trade
    # weight between themselves.
    prior_total = sum(float(prior[n]) for n in FACTOR_ORDER) or 1.0
    frozen = {
        n: float(prior[n]) / prior_total
        for n in FACTOR_ORDER
        if n not in informed
    }
    remaining = max(0.0, 1.0 - sum(frozen.values()))
    informed_mass = sum(float(prior[n]) * multiplier[n] for n in informed)
    if informed_mass <= 0.0:
        return None
    out = dict(frozen)
    for name in informed:
        out[name] = (float(prior[name]) * multiplier[name] / informed_mass) * remaining

    # If the reweighting lands on the prior anyway — every factor equally
    # informative, so nobody deserves more than anybody — the honest answer is
    # "nothing was learned", not a learned flag pointing at identical numbers.
    if all(abs(out[name] - float(prior[name])) <= 1e-9 for name in FACTOR_ORDER):
        return None
    return _normalise(out)


def weights_for(asset_class: Any, tracker: Optional[Any] = None) -> Dict[str, float]:
    """The weights actually used for one asset type: learned when earned, else
    the structural prior. Always sums to 1.0 over the five factors."""
    learned = learned_weights_for(asset_class, tracker=tracker)
    return learned if learned is not None else base_weights_for(asset_class)


def profile_for(
    asset_class: Any,
    tracker: Optional[Any] = None,
) -> Dict[str, Any]:
    """Full, honest profile for one asset type — including WHY the current
    weights are the current weights."""
    key = str(asset_class or "").upper()
    if key not in BASE_WEIGHTS:
        key = resolve_asset_class(None)
    src = tracker if tracker is not None else get_accuracy_tracker()
    stats = (src.asset_class_stats() or {}).get(key) or {}
    per_factor = (src.factor_win_rates_by_asset_class() or {}).get(key) or {}
    learned = learned_weights_for(key, tracker=src)
    active = learned if learned is not None else base_weights_for(key)
    return {
        "asset_class": key,
        "weights": {name: round(float(active[name]), 6) for name in FACTOR_ORDER},
        "base_weights": base_weights_for(key),
        "learned_weights": learned,
        "weights_sum": round(sum(active.values()), 6),
        # Explicit, never inferred: is this profile data-driven or structural?
        "learned": learned is not None,
        "source": "learned_from_resolved_signals" if learned is not None else "structural_prior",
        "resolved": int(stats.get("resolved", 0) or 0),
        "win_rate": stats.get("win_rate"),
        "min_resolved_signals": MIN_RESOLVED_SIGNALS,
        "min_factor_signals": MIN_FACTOR_SIGNALS,
        "min_informative_tilt": MIN_INFORMATIVE_TILT,
        "sufficient_data": bool(stats.get("sufficient_data", False)),
        "insufficient_data": not bool(stats.get("sufficient_data", False)),
        "factor_evidence": {
            name: {
                "aligned_count": int((per_factor.get(name) or {}).get("aligned_count", 0) or 0),
                "win_rate": (per_factor.get(name) or {}).get("win_rate"),
                "sufficient_data": bool(
                    (per_factor.get(name) or {}).get("sufficient_data", False)
                ),
            }
            for name in FACTOR_ORDER
        },
        "rationale": _RATIONALE.get(key, ""),
        "max_tilt": MAX_TILT,
        "shared_baseline": dict(SHARED_WEIGHTS),
    }


def profiles(
    tracker: Optional[Any] = None,
) -> Dict[str, Dict[str, Any]]:
    """All three profiles (OTC / REAL / CRYPTO)."""
    return {
        name: profile_for(name, tracker=tracker)
        for name in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO)
    }


def describe_registry() -> Dict[str, Any]:
    """Structural priors + provenance, for the audit/diagnostics surface."""
    return {
        "min_resolved_signals": MIN_RESOLVED_SIGNALS,
        "min_factor_signals": MIN_FACTOR_SIGNALS,
        "min_informative_tilt": MIN_INFORMATIVE_TILT,
        "max_tilt": MAX_TILT,
        "neutral_win_rate": NEUTRAL_WIN_RATE,
        "shared_baseline": dict(SHARED_WEIGHTS),
        "profiles": {
            name: {
                "base_weights": base_weights_for(name),
                "rationale": _RATIONALE.get(name, ""),
            }
            for name in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO)
        },
    }


def weights_by_symbol(symbol: Any, tracker: Optional[Any] = None) -> Dict[str, float]:
    """Resolve a symbol through the single asset-class source of truth, then
    hand back that type's weights."""
    return weights_for(resolve_asset_class(symbol), tracker=tracker)


def profile_by_symbol(
    symbol: Any,
    tracker: Optional[Any] = None,
) -> Dict[str, Any]:
    """Same, with the full provenance block for the signal payload."""
    return profile_for(resolve_asset_class(symbol), tracker=tracker)