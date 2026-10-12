"""Regression net for the tier-coherence clamp.

The clamp demotes ``tier`` to the canonical suppressed tier whenever the risk
gate did not release an actionable call. It originally guarded with::

    if response.get("executable", False) is False:

which silently fails open for numpy booleans::

    numpy.bool_(False) is False   ->  False

Because ``executable`` reaches the response dict from numpy/pandas
computations, the clamp was SKIPPED and the engine shipped
``tier="T1" / tier_label="PREMIUM"`` next to ``executable=false`` on the direct
FastAPI path, while the Node proxy path (which coerces the flag to a real bool
at its own boundary) returned the corrected T5 / WEAK. Same engine, two
different verdicts for the same call.

These tests pin the flag normalisation so the contradiction cannot come back.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.api.v1.signals import _is_truthy_flag


class TestTruthyFlag:
    def test_real_bools(self):
        assert _is_truthy_flag(True) is True
        assert _is_truthy_flag(False) is False

    def test_numpy_bools_are_not_compared_by_identity(self):
        # The exact bug: identity checks fail across numpy scalars.
        assert (np.bool_(False) is False) is False
        assert (np.bool_(True) is True) is False

        assert _is_truthy_flag(np.bool_(True)) is True
        assert _is_truthy_flag(np.bool_(False)) is False

    def test_numpy_integer_scalars(self):
        assert _is_truthy_flag(np.int64(1)) is True
        assert _is_truthy_flag(np.int64(0)) is False
        assert _is_truthy_flag(np.float64(0.0)) is False

    def test_fails_closed_on_missing_and_ambiguous_values(self):
        # None / "" / garbage must never read as "released", or a malformed
        # field could advertise an actionable tier.
        assert _is_truthy_flag(None) is False
        assert _is_truthy_flag("") is False
        assert _is_truthy_flag("garbage") is False
        assert _is_truthy_flag([]) is False

    def test_string_flag_forms(self):
        assert _is_truthy_flag("true") is True
        assert _is_truthy_flag("YES") is True
        assert _is_truthy_flag("1") is True
        assert _is_truthy_flag("false") is False
        assert _is_truthy_flag("0") is False


class TestCoherenceClampContract:
    """The clamp is a truthiness gate; document that directly."""

    @pytest.mark.parametrize(
        "executable_value, expect_clamped",
        [
            (False, True),
            (np.bool_(False), True),
            (0, True),
            (None, True),
            ("false", True),
            (True, False),
            (np.bool_(True), False),
            (1, False),
        ],
    )
    def test_clamp_fires_exactly_when_not_released(self, executable_value, expect_clamped):
        should_clamp = not _is_truthy_flag(executable_value)
        assert should_clamp is expect_clamped
