"""PART 44 [501] — the HF/MTF quality gate can only VETO, never RELEASE.

WHAT THIS PINS
--------------
Every /predict and /tick-signal response marks tradability through
``signal_gatekeeper.apply_strict_execution_gate``::

    class_verified = class_passes if gate_provided else True
    executable     = directional and bar_cleared and class_verified

``class_passes`` is the verdict of the per-asset-class HF/MTF quality filter —
OTC high-frequency quality (``otc_hf_quality.evaluate_otc_hf_quality``) or the
REAL institutional liquidity / M1-M5-H1 alignment gate
(``real_liquidity_gate.evaluate_real_liquidity_gate``).

The safety property this file proves is that those filters are a CONJUNCTIVE
VETO. They sit in the ``executable`` AND, so a failing gate can only turn
``executable`` True -> False. There is no branch anywhere in which a passing
gate writes ``executable = True``, ``regime_gate = "tradable"``,
``regime_status = "CONFIRMED"`` or promotes a ``tier``. The regime hold-back
(PART 14: a ``random_walk`` window, ``apply_regime_gate`` / ``_surface_regime_gate``)
is applied through a SEPARATE field and a SEPARATE composition step that never
consults the class-gate verdict. So a green HF/MTF gate cannot resurrect a
symbol the regime detector holds back, and a red one cannot be talked out of
its veto by confidence or direction.

This is the same audit shape as ``test_no_force_emit_escape.py`` (PART 34): a
static assertion that the seam is the one documented above, plus behavioural
monotonicity over the real functions, plus a positive control so the negative
assertions are not vacuous.

Run:  python -m pytest tests/test_hf_mtf_gate_cannot_override_regime.py -q
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.otc_hf_quality import (  # noqa: E402
    OTC_HF_PASS_BAR,
    REQUIRED_FACTORS,
    WEIGHTS,
    evaluate_otc_hf_quality,
)
from app.services.real_liquidity_gate import (  # noqa: E402
    MTF_MIN_ALIGNED,
    SPREAD_WIDE_PCT,
    evaluate_real_liquidity_gate,
)
from app.services.signal_gatekeeper import (  # noqa: E402
    REGIME_GATE_PENDING_HIGH_PRECISION,
    REGIME_GATE_SCORED_ONLY,
    REGIME_GATE_TRADABLE,
    SUPPRESSED_REASON_REGIME,
    SUPPRESSED_TIER,
    apply_regime_gate,
    apply_strict_execution_gate,
)

ENGINE_ROOT = Path(__file__).resolve().parents[1]
GATEKEEPER_PY = ENGINE_ROOT / "app" / "services" / "signal_gatekeeper.py"
OTC_GATE_PY = ENGINE_ROOT / "app" / "services" / "otc_hf_quality.py"
REAL_GATE_PY = ENGINE_ROOT / "app" / "services" / "real_liquidity_gate.py"

# Fields that constitute an execution RELEASE. A class-quality filter has no
# business producing any of them: it is a veto, not a verdict. ("status" is
# deliberately excluded — the filters legitimately carry a spread *status*.)
_RELEASE_FIELDS = ("executable", "regime_gate", "regime_status", "tier")


# ── helpers ─────────────────────────────────────────────────────────────────

def _function_node(path: Path, name: str) -> ast.FunctionDef:
    tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} not found in {path}")


def _code_only(path: Path) -> str:
    """Source with comments and docstrings removed (prose mentions of fields
    must not trip a text scan — we care about CODE)."""
    tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", None)
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                body.pop(0)
    return ast.unparse(tree)


def _assignments(fn: ast.FunctionDef) -> dict:
    out: dict = {}
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    out.setdefault(target.id, []).append(node.value)
    return out


def _otc_clean_trend(n: int = 60, step: float = 0.001, start: float = 1.10) -> list:
    """The documented OTC shape that clears the HF filter for BUY."""
    return [start + step * i for i in range(n)]


def _real_clean_tape(n: int = 240, step: float = 0.001) -> list:
    """REAL M1 tape: >= 160 clean closes, steady uptrend, M1/M5/H1 aligned."""
    return _otc_clean_trend(n=n, step=step, start=1.10)


def _tight_quotes(price: float):
    return price * 0.9999, price * 1.0001


def _green_otc_gate() -> dict:
    gate = evaluate_otc_hf_quality(_otc_clean_trend(), "BUY")
    assert gate["passes"] is True, gate
    return gate


def _red_otc_gate() -> dict:
    gate = evaluate_otc_hf_quality([1.0, 1.01, 1.02], "BUY")
    assert gate["passes"] is False, gate
    return gate


def _red_real_gate() -> dict:
    series = _real_clean_tape()
    price = series[-1]
    gate = evaluate_real_liquidity_gate(
        series, "BUY", bid=price * 0.995, ask=price * 1.005, live_price=price
    )
    assert gate["passes"] is False, gate
    return gate


def _surface(*, confidence_pct: float, class_gate: dict, asset_class: str = "OTC") -> dict:
    return apply_strict_execution_gate(
        signal="BUY",
        confidence=confidence_pct,
        asset_class=asset_class,
        class_gate=class_gate,
    )


# ═══════════════════════════════════════════════════════════════════════════
# 1. STATIC — the seam is the documented conjunction, nothing else.
# ═══════════════════════════════════════════════════════════════════════════

def test_executable_is_the_conjunction_of_three_necessary_conditions():
    """`executable` has exactly one definition: directional AND bar AND class.

    If a future edit removes an operand (or ANDs in something forgeable) this
    fails. The class gate may only ever be the ``class_verified`` operand.
    """
    fn = _function_node(GATEKEEPER_PY, "apply_strict_execution_gate")
    assigns = _assignments(fn)

    assert len(assigns["executable"]) == 1, "executable must be defined once"
    value = assigns["executable"][0]
    assert isinstance(value, ast.BoolOp) and isinstance(value.op, ast.And), ast.unparse(value)
    operands = {ast.unparse(v) for v in value.values}
    assert operands == {"directional", "bar_cleared", "class_verified"}, operands

    # class_verified is the provided-gate conditional, never a bypass.
    assert len(assigns["class_verified"]) == 1
    cv = assigns["class_verified"][0]
    assert isinstance(cv, ast.IfExp), ast.unparse(cv)
    assert ast.unparse(cv.test) == "gate_provided", ast.unparse(cv)


def test_regime_gate_and_status_never_derive_from_the_class_gate():
    """A class-quality filter is a veto; it may not author regime fields."""
    fn = _function_node(GATEKEEPER_PY, "apply_strict_execution_gate")
    for node in ast.walk(fn):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id in ("regime_gate", "regime_status"):
                rendered = ast.unparse(node.value)
                assert "class" not in rendered, (
                    f"{target.id} derived from the class gate: {rendered}"
                )


def test_class_gate_verdict_is_never_spread_into_the_surface():
    """`**class_gate` would let any key it carries (executable, tier, …)
    outrank the honest fields. The surface may only NEST it under class_gate."""
    rendered = ast.unparse(_function_node(GATEKEEPER_PY, "apply_strict_execution_gate"))
    for spread in ("**class_gate", "**class_metrics"):
        assert spread not in rendered, f"{spread} leaks class-gate keys into the surface"


def test_class_filters_never_write_a_release_field():
    """Neither HF/MTF filter module may set executable / regime_gate / tier."""
    offenders = []
    for path in (OTC_GATE_PY, REAL_GATE_PY):
        code = _code_only(path)
        for field in _RELEASE_FIELDS:
            if f'"{field}"' in code or f"'{field}'" in code:
                offenders.append(f"{path.name}: {field}")
    assert not offenders, (
        "an HF/MTF quality filter produced an execution-release field: "
        + "; ".join(offenders)
    )


# ═══════════════════════════════════════════════════════════════════════════
# 2. THRESHOLDS — the documented numbers.
# ═══════════════════════════════════════════════════════════════════════════

def test_otc_hf_pass_bar_and_weights_are_the_documented_values():
    assert OTC_HF_PASS_BAR == 0.65
    assert REQUIRED_FACTORS == ["micro_momentum", "volatility", "mean_reversion"]
    assert WEIGHTS == {
        "micro_momentum": 0.40,
        "order_flow": 0.30,
        "volatility": 0.20,
        "mean_reversion": 0.10,
    }
    assert sum(WEIGHTS.values()) == pytest.approx(1.0)


def test_otc_hf_required_factor_zero_fails_even_with_a_high_weighted_score():
    """A zero REQUIRED factor cannot be offset by the other weights."""
    # Flat tape → micro_momentum 0 (required) → otc_hf_fail regardless.
    flat = [1.10] * 60
    verdict = evaluate_otc_hf_quality(flat, "BUY")
    assert verdict["passes"] is False
    assert verdict["reason"] == "otc_hf_fail"
    assert verdict["factors"]["micro_momentum"] == 0


def test_mtf_alignment_numeric_meaning():
    """`mtf_misaligned` = >= 2 timeframes have a definite trend but fewer than
    MTF_MIN_ALIGNED (2) agree with the signal. One aligned leg is not enough."""
    assert MTF_MIN_ALIGNED == 2
    # Flat base + a single final pop: M1 aligns up, M5/H1 stay flat.
    series = [1.10] * 130 + [1.10 * (1 + 2.5e-4 * i) for i in range(5)]
    series += [series[-1]] * 110
    price = series[-1]
    bid, ask = _tight_quotes(price)
    verdict = evaluate_real_liquidity_gate(series, "BUY", bid=bid, ask=ask, live_price=price)
    assert verdict["passes"] is False
    assert verdict["reason"] == "mtf_misaligned"
    ta = verdict["metrics"]["mtf_alignment"]
    assert ta["aligned"] < MTF_MIN_ALIGNED
    assert ta["available"] >= MTF_MIN_ALIGNED, "misaligned needs >= 2 definite legs"


def test_real_spread_wide_threshold_is_50bps():
    assert SPREAD_WIDE_PCT == 0.005


# ═══════════════════════════════════════════════════════════════════════════
# 3. BEHAVIOURAL — veto-only and monotone.
# ═══════════════════════════════════════════════════════════════════════════

def test_a_failing_class_gate_always_vetoes_at_any_confidence():
    """A red HF/MTF gate forces executable=False across the whole bar range,
    and the suppression reason is the gate's own reason."""
    for confidence in (50.0, 90.0, 96.5, 99.0, 99.9, 100.0):
        surface = _surface(confidence_pct=confidence, class_gate=_red_otc_gate())
        assert surface["executable"] is False, f"released despite red gate at {confidence}"
        assert surface["suppressed_reason"] == "insufficient_history"
        assert surface["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION


def test_a_passing_class_gate_is_necessary_but_not_sufficient():
    """Green gate + below-bar confidence is still not executable: the gate
    cannot substitute for the independent high-precision bar."""
    surface = _surface(confidence_pct=94.9, class_gate=_green_otc_gate())
    assert surface["class_gate"]["passes"] is True
    assert surface["executable"] is False
    assert surface["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION


def test_gate_flip_is_monotone_and_never_gratuitously_releases():
    """Holding the tape/confidence fixed, flipping the class gate red can only
    remove tradability. Green is a necessary condition, never a grant."""
    green = _green_otc_gate()
    red = _red_otc_gate()
    for confidence in (96.4, 96.5, 97.0, 99.0, 100.0):
        released_green = _surface(confidence_pct=confidence, class_gate=green)["executable"]
        released_red = _surface(confidence_pct=confidence, class_gate=red)["executable"]
        assert not (released_red and not released_green), "red gate released a signal"
        assert released_red is False


def test_positive_control_a_fully_earned_verdict_is_released():
    """Without this the negative tests would also pass against a surface that
    never releases anything, which would prove nothing."""
    surface = _surface(confidence_pct=97.0, class_gate=_green_otc_gate())
    assert surface["executable"] is True
    assert surface["regime_gate"] == REGIME_GATE_TRADABLE
    assert surface["suppressed_reason"] is None


# ═══════════════════════════════════════════════════════════════════════════
# 4. KEYSTONE — a green HF/MTF gate cannot resurrect a regime hold-back.
# ═══════════════════════════════════════════════════════════════════════════

def test_green_hf_mtf_gate_does_not_release_a_scored_only_regime():
    """Start from a fully released strict surface, then apply the PART 14
    regime hold-back. The demotion wins regardless of the green class gate,
    and the class-gate verdict is preserved untouched for audit."""
    released = _surface(confidence_pct=99.0, class_gate=_green_otc_gate())
    assert released["executable"] is True

    held = apply_regime_gate(released, REGIME_GATE_SCORED_ONLY)

    assert held["executable"] is False, "a green HF/MTF gate overrode the regime hold-back"
    assert held["regime_gate"] == REGIME_GATE_SCORED_ONLY
    assert held["suppressed_reason"] == SUPPRESSED_REASON_REGIME
    assert held["tier"] == SUPPRESSED_TIER
    assert held["class_gate"]["passes"] is True, "audit surface was mutated"


def test_regime_hold_back_is_independent_of_the_class_gate_verdict():
    """Red and green class gates compose with the SAME regime demotion: the
    hold-back neither depends on nor is relaxed by the HF/MTF verdict."""
    red = apply_regime_gate(
        _surface(confidence_pct=99.0, class_gate=_red_otc_gate()), REGIME_GATE_SCORED_ONLY
    )
    green = apply_regime_gate(
        _surface(confidence_pct=99.0, class_gate=_green_otc_gate()), REGIME_GATE_SCORED_ONLY
    )
    for held in (red, green):
        assert held["executable"] is False
        assert held["regime_gate"] == REGIME_GATE_SCORED_ONLY
        assert held["suppressed_reason"] == SUPPRESSED_REASON_REGIME


def test_tradable_regime_does_not_override_a_red_class_gate():
    """The other direction: a tradable regime label cannot arm a vetoed signal
    (the class gate still wins). Release requires BOTH gates to be green."""
    surface = _surface(confidence_pct=99.0, class_gate=_red_otc_gate())
    out = apply_regime_gate(surface, REGIME_GATE_TRADABLE)
    assert out["regime_gate"] == REGIME_GATE_TRADABLE
    assert out["executable"] is False, "tradable regime released a class-vetoed signal"


def test_real_gate_is_the_same_conjunctive_veto():
    """The REAL liquidity / MTF gate obeys the identical contract."""
    red_real = _surface(confidence_pct=99.0, class_gate=_red_real_gate(), asset_class="REAL")
    assert red_real["executable"] is False
    assert red_real["suppressed_reason"] == "spread_too_wide"

    series = _real_clean_tape()
    price = series[-1]
    bid, ask = _tight_quotes(price)
    green_real = evaluate_real_liquidity_gate(series, "BUY", bid=bid, ask=ask, live_price=price)
    assert green_real["passes"] is True, green_real
    surface = _surface(confidence_pct=99.0, class_gate=green_real, asset_class="REAL")
    assert surface["executable"] is True


# ═══════════════════════════════════════════════════════════════════════════
# 5. [506] MUTATION CHECK — the regime check is load-bearing, not decorative.
# ═══════════════════════════════════════════════════════════════════════════
# The keystone above only means something if the test would FAIL when the
# regime hold-back is removed. These tests force the HF/MTF gate to always PASS
# and use a tape regime_detector genuinely classifies as random_walk, then show
# that (a) the composed verdict is still non-tradable, and (b) it is the regime
# demotion ALONE that blocks it — remove that step and the same setup releases.

def _always_pass_gate() -> dict:
    """A forced-green HF/MTF class-gate verdict (the gate can ask for no more)."""
    return {
        "passes": True,
        "reason": None,
        "score": 1.0,
        "factors": {f: 1 for f in ("micro_momentum", "order_flow", "volatility", "mean_reversion")},
        "metrics": {},
    }


def _random_walk_tape(n: int = 120, seed: int = 0) -> list:
    """Deterministic tape classify_regime labels `random_walk`.

    Geometry matters: `n` is sized to clear REGIME_MIN_CLOSES (100) so a real
    classification exists, and stay BELOW REGIME_GATE_BYPASS_CLOSES (160) so the
    LIVE-TEST long-history bypass does NOT apply — the window is genuinely
    scored-only. seed=0 is pinned so the classification is stable across runs.
    """
    import random

    rng = random.Random(seed)
    price = 1.10
    out = []
    for _ in range(n):
        price *= 1.0 + rng.gauss(0.0, 0.0009)
        out.append(price)
    return out


def test_forced_green_hf_mtf_gate_cannot_release_a_random_walk_symbol():
    """Force the gate green; a random_walk symbol is STILL non-tradable."""
    from app.api.v1 import signals as signals_mod

    tape = _random_walk_tape()
    gate = signals_mod._surface_regime_gate(tape)
    assert gate["regime"] == "random_walk", gate
    assert gate["regime_gate"] == REGIME_GATE_SCORED_ONLY, gate

    # Gate forced green AND confidence far above the strict bar.
    released = _surface(confidence_pct=99.9, class_gate=_always_pass_gate())
    assert released["executable"] is True, "the forced-green gate alone does release"

    held = apply_regime_gate(released, gate["regime_gate"])
    assert held["executable"] is False, "random_walk was released despite the hold-back"
    assert held["regime_gate"] == REGIME_GATE_SCORED_ONLY
    assert held["tier"] == SUPPRESSED_TIER


def test_the_regime_demotion_is_load_bearing_mutation_check(monkeypatch):
    """MUTATION: neuter `apply_regime_gate` (the regime check) and watch the
    invariant break. If this test did NOT show the release, the keystone test
    would be passing for reasons unrelated to the regime check (vacuous)."""
    import app.services.signal_gatekeeper as gk
    from app.api.v1 import signals as signals_mod

    tape = _random_walk_tape()
    assert signals_mod._surface_regime_gate(tape)["regime"] == "random_walk"

    # Sanity: with the real regime gate the forced-green surface is held back.
    surface = _surface(confidence_pct=99.9, class_gate=_always_pass_gate())
    assert gk.apply_regime_gate(surface, REGIME_GATE_SCORED_ONLY)["executable"] is False

    # Mutate: remove the demotion. The SAME inputs now release — proving the
    # regime check (not the HF/MTF gate) is what enforces the invariant.
    monkeypatch.setattr(
        gk,
        "apply_regime_gate",
        lambda result, regime_gate: dict(result),
    )
    mutated = gk.apply_regime_gate(surface, REGIME_GATE_SCORED_ONLY)
    assert mutated["executable"] is True, (
        "removing the regime demotion did not flip the verdict — the invariant "
        "test above proves nothing about the regime check"
    )
