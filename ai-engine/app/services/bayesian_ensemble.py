"""Adaptive Bayesian weighted ensemble for predictive confidence.

The authoritative trading verdict still comes from the multiplicative
confluence gate. This ensemble provides a second, transparent view: it fuses
independent microstructure/momentum/flow/volatility/regime evidence with
weights learned per market regime.

Weights are Beta-Bernoulli posterior means over an expanding record of
directional outcomes:

    precision_c = E[Beta(alpha_c, beta_c)] = alpha_c / (alpha_c + beta_c)

After every closed horizon the caller can invoke ``record_outcome`` with the
realised direction. Components that were right gain alpha, wrong components
gain beta. No synthetic outcome is ever recorded by the engine itself.

Confidence is a documented blend of directional magnitude, component
agreement and expected precision. It is NOT claimed to be a calibrated
probability; the field names say exactly what they are. The release threshold
defaults to 85% and can only ANNOTATE a verdict - it never loosens the 98%
thermal gate or the execution gatekeeper.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from threading import Lock, RLock
from typing import Any, Dict, Iterable, Mapping, Optional

import numpy as np

DEFAULT_THRESHOLD = 85.0
DEFAULT_MIN_CONVICTION = 0.35
MAX_POSTERIOR_OBSERVATIONS = 4000.0

COMPONENTS = (
    "momentum",
    "microstructure",
    "order_flow",
    "volatility",
    "regime",
)
ASSET_CLASSES = ("OTC", "REAL", "CRYPTO")
STATE_SEPARATOR = "::"

DEFAULT_PRIORS: Dict[str, tuple[float, float]] = {
    "momentum": (6.0, 2.0),
    "microstructure": (7.0, 2.0),
    "order_flow": (6.0, 3.0),
    "volatility": (5.0, 5.0),
    "regime": (6.0, 3.0),
}


@dataclass
class BetaPosterior:
    """Beta-Bernoulli posterior for one component in one regime."""

    alpha: float = 1.0
    beta: float = 1.0

    @property
    def mean(self) -> float:
        total = self.alpha + self.beta
        return float(self.alpha / total) if total > 0 else 0.5

    @property
    def observations(self) -> float:
        return max(0.0, self.alpha + self.beta - 2.0)

    def record(self, correct: bool, weight: float = 1.0) -> None:
        amount = max(0.0, float(weight))
        if amount <= 0.0:
            return
        if correct:
            self.alpha += amount
        else:
            self.beta += amount
        total = self.alpha + self.beta
        if total > MAX_POSTERIOR_OBSERVATIONS:
            scale = MAX_POSTERIOR_OBSERVATIONS / total
            self.alpha = max(1.0, self.alpha * scale)
            self.beta = max(1.0, self.beta * scale)

    def snapshot(self) -> Dict[str, Any]:
        return {
            "alpha": round(self.alpha, 4),
            "beta": round(self.beta, 4),
            "precision": round(self.mean, 4),
            "observations": round(self.observations, 2),
        }


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    if not np.isfinite(value):
        return 0.0
    return float(np.clip(value, low, high))


def _round(value: Optional[float], digits: int = 4) -> Optional[float]:
    if value is None:
        return None
    fvalue = float(value)
    if not np.isfinite(fvalue):
        return None
    return round(fvalue, digits)


class AdaptiveBayesianEnsemble:
    """Thread-safe, per-regime adaptive ensemble."""

    def __init__(
        self,
        *,
        threshold: float = DEFAULT_THRESHOLD,
        min_conviction: float = DEFAULT_MIN_CONVICTION,
    ) -> None:
        if not 50.0 <= float(threshold) <= 99.0:
            raise ValueError("ensemble threshold must be in [50, 99]")
        if not 0.0 <= float(min_conviction) <= 1.0:
            raise ValueError("min_conviction must be in [0, 1]")
        self.threshold = float(threshold)
        self.min_conviction = float(min_conviction)
        self._lock = RLock()
        self._states: Dict[str, Dict[str, BetaPosterior]] = {}

    # -- state ------------------------------------------------------------
    @staticmethod
    def _normalize_asset_class(asset_class: Optional[str]) -> str:
        value = str(asset_class or "OTC").strip().upper()
        return value if value in ASSET_CLASSES else "OTC"

    @staticmethod
    def _normalize_regime(regime: Optional[str]) -> str:
        return (regime or "unknown").strip().lower()

    def _state_key(self, asset_class: str, regime: str) -> str:
        return (
            f"{self._normalize_asset_class(asset_class)}"
            f"{STATE_SEPARATOR}{self._normalize_regime(regime)}"
        )

    def _regime_states(
        self, regime: str, asset_class: str = "OTC"
    ) -> Dict[str, BetaPosterior]:
        key = self._state_key(asset_class, regime)
        states = self._states.get(key)
        if states is None:
            states = {
                component: BetaPosterior(*DEFAULT_PRIORS[component])
                for component in COMPONENTS
            }
            self._states[key] = states
        return states

    def _multipliers(self, asset_class: str, regime: str) -> Dict[str, float]:
        asset_class = self._normalize_asset_class(asset_class)
        regime = self._normalize_regime(regime)
        base = {component: 1.0 for component in COMPONENTS}
        if asset_class == "OTC":
            base.update({"microstructure": 1.25, "order_flow": 1.10, "volatility": 0.85})
        elif asset_class == "REAL":
            base.update({"order_flow": 1.25, "microstructure": 1.10, "momentum": 0.95})
        elif asset_class == "CRYPTO":
            base.update({"momentum": 1.20, "volatility": 1.15, "microstructure": 0.85})
        if regime == "trend":
            base["momentum"] *= 1.15
        elif regime == "range":
            base["microstructure"] *= 1.10
            base["momentum"] *= 0.90
        elif regime == "reversal":
            base["microstructure"] *= 1.20
            base["momentum"] *= 0.85
        elif regime == "expansion":
            base["volatility"] *= 1.20
            base["momentum"] *= 1.10
        elif regime == "compression":
            base["volatility"] *= 0.75
            base["order_flow"] *= 1.10
        return base

    def weights(self, regime: str, asset_class: str = "OTC") -> Dict[str, float]:
        """Posterior-mean precision weights, normalized to sum to 1.

        States are scoped by BOTH market type and regime: OTC trend, REAL trend
        and CRYPTO trend learn independent posteriors instead of contaminating
        one another's evidence.
        """
        with self._lock:
            states = self._regime_states(regime, asset_class)
            multipliers = self._multipliers(asset_class, regime)
            raw = {
                component: max(states[component].mean, 1e-6) * multipliers[component]
                for component in COMPONENTS
            }
            total = float(sum(raw.values()))
            if total <= 0.0:
                return {component: 1.0 / len(COMPONENTS) for component in COMPONENTS}
            return {component: value / total for component, value in raw.items()}

    # -- fusion -----------------------------------------------------------
    def combine(
        self,
        scores: Mapping[str, float],
        *,
        regime: str,
        asset_class: str = "OTC",
        suppressed: bool = False,
        suppression_reasons: Optional[Iterable[str]] = None,
        low_volatility: bool = False,
        news_active: bool = False,
    ) -> Dict[str, Any]:
        """Fuse signed component scores in [-1, +1] into an ensemble view."""
        regime = self._normalize_regime(regime)
        asset_class = self._normalize_asset_class(asset_class)
        clean: Dict[str, float] = {}
        for component in COMPONENTS:
            if component not in scores:
                continue
            raw = scores[component]
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if not np.isfinite(value):
                continue
            clean[component] = _clamp(value)

        reasons = list(suppression_reasons or [])
        if low_volatility and "low_volatility_flat_zone" not in reasons:
            reasons.append("low_volatility_flat_zone")
        if news_active and "event_blackout" not in reasons:
            reasons.append("event_blackout")
        blocked = bool(suppressed or low_volatility or news_active)

        if not clean:
            return {
                "available": False,
                "regime": regime,
                "asset_class": asset_class,
                "threshold": self.threshold,
                "confidence": 0.0,
                "combined_score": 0.0,
                "agreement": 0.0,
                "expected_precision": 0.0,
                "release": False,
                "suppressed": blocked,
                "suppression_reasons": reasons,
                "weights": {},
                "components": {},
                "reason": "no_component_scores",
            }

        with self._lock:
            all_weights = self.weights(regime, asset_class)
            states = self._regime_states(regime, asset_class)
            precision = {component: states[component].mean for component in COMPONENTS}
            observations = {
                component: states[component].observations for component in COMPONENTS
            }
        weight_total = float(sum(all_weights[c] for c in clean))
        weights = {c: all_weights[c] / weight_total for c in clean}

        combined = float(sum(weights[c] * clean[c] for c in clean))
        direction = 1 if combined > 0 else (-1 if combined < 0 else 0)
        agreement_mass = float(
            sum(weights[c] for c in clean if direction != 0 and np.sign(clean[c]) == direction)
        )
        active_mass = float(sum(weights[c] for c in clean if clean[c] != 0.0))
        agreement = agreement_mass / active_mass if active_mass > 0 else 0.0

        expected_precision = float(sum(weights[c] * precision[c] for c in clean))
        confidence = 100.0 * _clamp(
            0.50 * abs(combined) + 0.30 * agreement + 0.20 * expected_precision,
            0.0,
            1.0,
        )
        release = bool(
            not blocked
            and confidence >= self.threshold
            and abs(combined) >= self.min_conviction
        )

        components = {
            component: {
                "score": _round(clean[component]),
                "weight": _round(weights[component]),
                "posterior_precision": _round(precision[component]),
                "observations": round(observations[component], 2),
            }
            for component in clean
        }
        return {
            "available": True,
            "regime": regime,
            "asset_class": asset_class,
            "threshold": self.threshold,
            "confidence": round(confidence, 2),
            "combined_score": _round(combined),
            "agreement": _round(agreement),
            "expected_precision": _round(expected_precision),
            "release": release,
            "suppressed": blocked,
            "suppression_reasons": reasons,
            "weights": {c: _round(w) for c, w in weights.items()},
            "components": components,
            "reason": (
                "suppressed_by_risk_overlay"
                if blocked
                else ("released" if release else "below_ensemble_threshold")
            ),
        }

    # -- learning loop ----------------------------------------------------
    def record_outcome(
        self,
        *,
        regime: str,
        component_scores: Mapping[str, float],
        realized_direction: str,
        asset_class: str = "OTC",
        weight: float = 1.0,
    ) -> Dict[str, Any]:
        """Update posteriors from a REAL settled outcome.

        ``realized_direction`` must be "BUY" or "SELL". A flat/unknown outcome
        is rejected rather than treated as a loss for every component.
        """
        direction = str(realized_direction).strip().upper()
        if direction not in ("BUY", "SELL"):
            raise ValueError("realized_direction must be BUY or SELL")
        try:
            weight_amount = float(weight)
        except (TypeError, ValueError):
            raise ValueError("weight must be finite and positive") from None
        if not np.isfinite(weight_amount) or weight_amount <= 0.0:
            raise ValueError("weight must be finite and positive")
        realized_sign = 1 if direction == "BUY" else -1
        regime = self._normalize_regime(regime)
        asset_class = self._normalize_asset_class(asset_class)
        with self._lock:
            states = self._regime_states(regime, asset_class)
            updated: Dict[str, bool] = {}
            for component in COMPONENTS:
                if component not in component_scores:
                    continue
                try:
                    score = float(component_scores[component])
                except (TypeError, ValueError):
                    continue
                if not np.isfinite(score) or score == 0.0:
                    continue
                correct = (score > 0) == (realized_sign > 0)
                states[component].record(correct, weight=weight_amount)
                updated[component] = correct
        return {
            "regime": regime,
            "asset_class": asset_class,
            "realized_direction": direction,
            "updated": updated,
            "components": len(updated),
        }

    def snapshot(
        self,
        regime: Optional[str] = None,
        asset_class: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Return learned posteriors grouped by market type, then regime."""
        wanted_regime = self._normalize_regime(regime) if regime else None
        wanted_asset = self._normalize_asset_class(asset_class) if asset_class else None
        with self._lock:
            data: Dict[str, Dict[str, Any]] = {}
            for key, states in sorted(self._states.items()):
                market, _, state_regime = key.partition(STATE_SEPARATOR)
                if wanted_asset and market != wanted_asset:
                    continue
                if wanted_regime and state_regime != wanted_regime:
                    continue
                data.setdefault(market, {})[state_regime] = {
                    component: states[component].snapshot()
                    for component in COMPONENTS
                }
            return {
                "threshold": self.threshold,
                "min_conviction": self.min_conviction,
                "markets": data,
            }

    def reset(self) -> None:
        with self._lock:
            self._states.clear()


_GLOBAL_ENSEMBLE = AdaptiveBayesianEnsemble()
_GLOBAL_LOCK = Lock()


def get_ensemble() -> AdaptiveBayesianEnsemble:
    """Process-global ensemble so learning survives across requests."""
    return _GLOBAL_ENSEMBLE


def reset_ensemble() -> None:
    """Test hook: clear every learned posterior."""
    with _GLOBAL_LOCK:
        _GLOBAL_ENSEMBLE.reset()
