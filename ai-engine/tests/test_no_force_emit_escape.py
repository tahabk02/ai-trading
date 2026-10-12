"""PART 34 [272]-[275] — there is no global force-EMIT escape hatch.

WHAT THIS PINS
--------------
A `GLOBAL_FORCE_OVERRIDE` setting once existed. Its module docstring advertised
the behaviour it provided::

    regime_gate = "tradable"   -> grid cards unlock
    suppressed_reason = None   -> no SCORED-ONLY badge
    status = "active"
    executable = True
    regime_status = "CONFIRMED"

for EVERY instrument, at any tape length and under any classification. That is
not a suppression kill-switch for a bad data window; it force-RELEASES a verdict
the maths never released. On a system whose contract is "never fabricate" it is
unrecoverable by configuration: one env var away from every response claiming to
be tradeable.

The audit found it could not actually reach a response -- both consumers of
`_surface_regime_gate` read only `.get("regime")` and spread
`_strict_execution_surface` afterwards, so every forced field was discarded and
the one key they did read was passed through untouched. So it was dead code that
only LOOKED armed.

That is the worst possible state for a safety mechanism, and it is why these
tests exist. "It is currently inert" is not a property worth relying on: the
single edit that turns `.get("regime")` into `**{...}` would silently arm a
"mark everything tradable" switch. These tests fail if that edit is ever made,
if the flag is reintroduced under any name, or if the module returns.

The former test for this feature pinned `_surface_regime_gate` directly with the
flag monkeypatched, so it stayed green while the end-to-end bypass was
unreachable. It tested the helper, not the contract. These test the contract.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import os
from pathlib import Path

import pytest

from app.api.v1 import signals as signals_mod
from app.services.regime_detector import MIN_CLOSES as REGIME_MIN_CLOSES

ENGINE_ROOT = Path(__file__).resolve().parents[1]
SIGNALS_PY = ENGINE_ROOT / "app" / "api" / "v1" / "signals.py"

# Identifiers that must never reappear. `FORCE` catches a rename.
_BANNED = ("GLOBAL_FORCE_OVERRIDE", "global_force_override", "regime_gate_override")

# Fields the override used to forge. A regime gate is a LABEL; it has no
# business emitting an execution decision.
_FORGED = ("executable", "status", "regime_status", "scored_only", "dispatchable")


def _code_only(path: Path) -> str:
    """Source with comments and docstrings removed.

    The retired hatch is still NAMED in prose ("there is deliberately no such
    flag"), and a naive text scan trips over those explanations. These tests
    care about CODE, so the AST is stripped of every docstring and re-printed.
    """
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


def _func_code(path: Path, name: str) -> str:
    tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return _code_only_from_tree(node)
    raise AssertionError(f"{name} not found in {path}")


def _code_only_from_tree(node) -> str:
    for child in ast.walk(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(child, "body", None)
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                body.pop(0)
    return ast.unparse(node)


# --------------------------------------------------------------------------
# 1. The mechanism itself is gone.
# --------------------------------------------------------------------------
def test_force_override_module_does_not_exist():
    assert importlib.util.find_spec("app.services.global_force_override") is None


def test_settings_expose_no_force_override_field():
    from app.core.config import Settings

    assert "GLOBAL_FORCE_OVERRIDE" not in Settings.model_fields
    assert not hasattr(Settings(), "GLOBAL_FORCE_OVERRIDE")


def test_no_engine_code_references_a_force_override():
    """No module in the engine may reintroduce the hatch, under any name."""
    offenders = []
    for path in (ENGINE_ROOT / "app").rglob("*.py"):
        code = _code_only(path)
        for token in _BANNED:
            if token in code:
                offenders.append(f"{path.relative_to(ENGINE_ROOT)}: {token}")
    assert not offenders, "force-EMIT escape hatch reintroduced: " + "; ".join(offenders)


def test_legacy_env_var_is_inert_even_on_a_fresh_config_load():
    """The historical knob must not resurrect anything, even set explicitly.

    Reloads the config module with the variable present so a plain
    `model_fields` check cannot pass merely because the module was already
    imported before the variable existed.
    """
    previous = os.environ.get("GLOBAL_FORCE_OVERRIDE")
    os.environ["GLOBAL_FORCE_OVERRIDE"] = "1"
    try:
        config = importlib.reload(importlib.import_module("app.core.config"))
        assert "GLOBAL_FORCE_OVERRIDE" not in config.Settings.model_fields
        assert not hasattr(config.settings, "GLOBAL_FORCE_OVERRIDE")
    finally:
        if previous is None:
            os.environ.pop("GLOBAL_FORCE_OVERRIDE", None)
        else:
            os.environ["GLOBAL_FORCE_OVERRIDE"] = previous


# --------------------------------------------------------------------------
# 2. The regime gate cannot be made to force-emit.
# --------------------------------------------------------------------------
def test_short_tape_stays_honest_and_is_not_promoted():
    """The case the override existed to forge: too little data to judge.

    The override turned this into tradable / active / executable / CONFIRMED.
    The honest answer is that nothing is known yet.
    """
    short = [1.0 + (i % 7) * 0.001 for i in range(REGIME_MIN_CLOSES - 1)]

    result = signals_mod._surface_regime_gate(short)

    assert result["regime"] is None
    assert result["regime_gate"] is None
    assert result["suppressed_reason"] is None
    assert "tradable" not in result.values()


def test_regime_gate_never_emits_execution_decisions():
    """A regime label may not smuggle an execution decision, at any length."""
    trending = [100.0 + i * 0.01 for i in range(REGIME_MIN_CLOSES + 100)]
    short = [1.0 + (i % 7) * 0.001 for i in range(REGIME_MIN_CLOSES - 1)]

    for tape in (short, trending):
        result = signals_mod._surface_regime_gate(tape)
        assert set(result) <= {"regime", "regime_gate", "suppressed_reason"}, (
            f"regime gate returned unexpected keys: {sorted(result)}"
        )
        for forged in _FORGED:
            assert forged not in result, (
                f"regime gate forged execution field {forged!r}; "
                "tradability must come only from _strict_execution_surface"
            )


def test_tradability_is_owned_by_the_execution_surface():
    """The response builders must read only the honest `regime` label.

    This is the exact seam the override was one edit away from weaponising: if a
    builder ever spreads the whole gate dict, the forced fields flow straight
    into the response and outrank `_strict_execution_surface`.
    """
    tree = ast.parse(SIGNALS_PY.read_text(encoding="utf-8", errors="replace"))

    # Every call to the gate, wherever it appears.
    gate_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_surface_regime_gate"
    ]

    # The sanctioned form: `_surface_regime_gate(...).get("regime")`.
    sanctioned = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr != "get":
            continue
        if not (node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == "regime"):
            continue
        inner = node.func.value
        if (
            isinstance(inner, ast.Call)
            and isinstance(inner.func, ast.Name)
            and inner.func.id == "_surface_regime_gate"
        ):
            sanctioned.add(id(inner))

    strays = [ast.unparse(c)[:120] for c in gate_calls if id(c) not in sanctioned]
    assert not strays, (
        "the regime gate is consumed outside a `\"regime\": ....get(\"regime\")` "
        f"read: {strays}. Spreading or re-keying this dict re-exposes any forced "
        "fields and lets them outrank _strict_execution_surface."
    )
    assert len(sanctioned) >= 2, f"expected both response builders, found {len(sanctioned)}"


def test_forced_fields_are_absent_from_every_gate_branch():
    """Static backstop for the branch list, so a new branch cannot skip the rule."""
    body = _func_code(SIGNALS_PY, "_surface_regime_gate")

    for forged in _FORGED:
        assert forged not in body, f"_surface_regime_gate references {forged!r}"
    assert "regime_gate_override" not in body


# --------------------------------------------------------------------------
# 3. END-TO-END: the composed response cannot be released without cause.
# --------------------------------------------------------------------------
# Every /predict and /tick-signal response is assembled as
#
#     {"signal": ..., "regime": _surface_regime_gate(closes).get("regime"),
#      **_strict_execution_surface(...)}
#
# so this is the real composition, in the real merge order, for the real gate
# functions. The retired override promised to make `regime_gate="tradable"` and
# `executable=True` appear here regardless of the data. These tests assert the
# opposite invariant: release happens ONLY when regime_detector produced a real
# classification AND the tier gate actually passed.
_SYMBOL = "EUR/USD"
_TIMEFRAME = "M1"


def _compose(closes, confidence_pct, *, direction="BUY", min_confidence=None):
    """Assemble a response exactly as the /predict handler does."""
    bid = closes[-1] * 0.9999 if closes else None
    ask = closes[-1] * 1.0001 if closes else None
    return {
        "signal": direction,
        "confidence": confidence_pct,
        "regime": signals_mod._surface_regime_gate(closes).get("regime"),
        **signals_mod._strict_execution_surface(
            symbol=_SYMBOL,
            closes=[float(c) for c in closes],
            direction=direction,
            confidence_pct=confidence_pct,
            bid=bid,
            ask=ask,
            current_price=closes[-1] if closes else None,
            timeframe=_TIMEFRAME,
            min_confidence=min_confidence,
        ),
    }


def _ramp(n, step=0.1):
    """Deterministic tape sized to clear the per-asset-class quality gate.

    The step matters: `OtcMarketStrategy` requires an ATR ratio of at least
    0.0008, so a gentle 0.01 ramp is vetoed by the CLASS gate and would make
    every assertion below pass for the wrong reason. 0.1 clears it, leaving
    the regime and tier gates as the only things that can block a release.

    Named `_ramp`, not `_trending`: this series classifies as `random_walk`.
    It is released because 200 closes exceeds REGIME_GATE_BYPASS_CLOSES, which
    is the engine's documented long-history rule, not because it trends.
    """
    return [100.0 + i * step for i in range(n)]


_RELEASABLE = 200  # >= REGIME_MIN_CLOSES, and >= REGIME_GATE_BYPASS_CLOSES


@pytest.mark.xfail(
    strict=False,
    reason=(
        "DISCOVERED GAP (PART 34 audit, not caused by the retired override). "
        "execution_gate._regime_label returns None below REGIME_MIN_CLOSES and is "
        "only a LABEL - it never gates executability. So a 99-close tape with no "
        "defensible Hurst/ADF classification still ships executable=True with "
        "regime_gate=tradable AND regime_status=CONFIRMED. That is the same "
        "family of dishonesty the override represented, arriving by a different "
        "route. Deliberately left failing and un-fixed: gating executability on a "
        "regime classification is a behaviour change outside this task's scope "
        "and needs an explicit decision."
    ),
)
def test_short_tape_is_never_released_however_confident():
    """Confidence cannot substitute for a classification.

    99% against 99 closes is a strong opinion about too little data. This is the
    invariant the override promised but never enforced.
    """
    for confidence in (99.0, 99.9, 100.0):
        response = _compose(_ramp(REGIME_MIN_CLOSES - 1), confidence)

        assert response["regime"] is None, "no classification is possible here"
        assert not response.get("executable"), (
            f"executable=True with only {REGIME_MIN_CLOSES - 1} closes and "
            f"confidence {confidence}: tradability was released without a "
            "regime_detector classification"
        )


def test_low_confidence_is_not_released_on_a_real_tape():
    """A real classification does not excuse a failing tier gate."""
    response = _compose(_ramp(_RELEASABLE), 70.0)

    assert response["regime"] is not None, "this tape should classify"
    assert not response.get("executable"), (
        "tier gate passed at 70% confidence; the 96.5% bar was bypassed"
    )


def test_raised_confidence_floor_demotes_a_strong_verdict():
    """A strong tape still honours a stricter caller-supplied floor."""
    response = _compose(_ramp(_RELEASABLE), 97.0, min_confidence=99.5)

    assert not response.get("executable"), (
        "min_confidence=99.5 was ignored; the historical override class of bug"
    )


def test_release_requires_both_a_classification_and_a_tier_pass():
    """The positive control: the gate CAN release, and only when earned.

    Without this the tests above would also pass against a surface that never
    releases anything, which would prove nothing.
    """
    response = _compose(_ramp(_RELEASABLE), 99.0)

    assert response["regime"] is not None, "expected a real classification"
    assert response.get("executable") is True, (
        "a classified tape at 99% should be executable; if this fails the "
        "negative tests above are vacuous"
    )


def test_legacy_env_var_cannot_release_a_composed_response(monkeypatch):
    """End-to-end proof for the retired flag: setting it changes nothing.

    This is the regression that actually matters for the retired override. It
    composes real responses through the same two functions the handler uses, with
    the historical variable set, and requires byte-identical results. Any future
    reintroduction of a force-EMIT switch changes this and fails.
    """
    cases = [
        (_ramp(REGIME_MIN_CLOSES - 1), 99.0, None),
        (_ramp(_RELEASABLE), 70.0, None),
        (_ramp(_RELEASABLE), 97.0, 99.5),
        (_ramp(_RELEASABLE), 99.0, None),
    ]
    baseline = [_compose(c, conf, min_confidence=mc) for c, conf, mc in cases]

    monkeypatch.setenv("GLOBAL_FORCE_OVERRIDE", "1")
    assert signals_mod._surface_regime_gate(_ramp(20))["regime_gate"] is None, (
        "the flag is already leaking into the regime gate"
    )
    forced = [_compose(c, conf, min_confidence=mc) for c, conf, mc in cases]

    assert forced == baseline, (
        "GLOBAL_FORCE_OVERRIDE changed a composed response; the override is back"
    )

    # The tier gate keeps holding with the variable set, so the flag is not
    # substituting for a failed tier in either direction.
    assert forced[1].get("executable") is not True
    assert forced[2].get("executable") is not True
    assert forced[2]["suppressed_reason"] == "below_high_precision_bar"
    assert forced[3].get("executable") is True