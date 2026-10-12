"""Confidence anti-saturation: confidence must reflect real market dispersion.

Regression guard for a production defect found by live probing: radically
different synthetic tapes (linear ramp, chop, random walk, and a PERFECTLY FLAT
series) all returned the same 99.32% / T1 PREMIUM, because the strength term in
``compute_multiplicative_confluence`` was SATURATED:

    strength_component = clip(magnitude / 0.30, 0, 1)

That expression is monotone only up to 0.30 and then FLAT, so every aligned
book from |0.30| to |1.00| bought EXACTLY ZERO additional confidence. The
composed index therefore had a hard mathematical ceiling it reached on
ordinary input, and any unanimous tape pinned it at conv = 1.0, which the
logistic maps to 99.32%.

MEASURED over 400 randomised real-shaped tapes before the fix: 387/400
collapsed onto 13 distinct scores and 27.25% sat exactly on the 99.32%
ceiling, with zero variation anywhere in the top decile.

Two lessons are baked into this file, because the first version of it PASSED
while the defect was still live:

  1. Four hand-picked degenerate tapes at n=40 do not cover the production
     domain. The defect only became visible at realistic window lengths with
     real OHLC — so the tape builders here sweep the window length too.
  2. Asserting the *absence* of one bad value (a ramp tape != 99.32) is far
     weaker than asserting the *property* that was violated. The tests below
     therefore assert monotonicity and distributional spread, which no
     saturating implementation can satisfy.
"""
import numpy as np

from app.services.book_instruments import (
    CONFLUENCE_ALIGNMENT_FULL_AT,
    CONFLUENCE_CLUSTERS,
    CONFLUENCE_GATE_CONV,
    compute_multiplicative_confluence,
    evaluate_book_confluence,
)
from app.services.signal_gatekeeper import DEFINITIVE_CONFIDENCE_MIN

# The logistic asymptote. A correct composition can approach it but must never
# reach the region where every tape is indistinguishable.
SATURATION_CEILING = 99.0


def _tape(kind: str, n: int = 40) -> np.ndarray:
    p = 1.1000
    out = []
    for i in range(n):
        if kind == "flat":
            pass
        elif kind == "ramp":
            p += 0.0007
        elif kind == "chop":
            p += 0.00002 * (1 if i % 2 else -1)
        elif kind == "noisy":
            p += 0.00004 * ((i % 7) / 7.0 - 0.5)
        out.append(p)
    return np.asarray(out, dtype=np.float64)


def _ohlc(c: np.ndarray):
    o = np.concatenate([[c[0]], c[:-1]])
    h = np.maximum(o, c) + 0.0001
    l = np.minimum(o, c) - 0.0001
    return o, h, l


def _confluence_for(kind: str, n: int = 40) -> dict:
    c = _tape(kind, n)
    o, h, l = _ohlc(c)
    return evaluate_book_confluence(
        c, opens=o, highs=h, lows=l, live_price=float(c[-1]),
        bid=float(c[-1]) - 1e-4, ask=float(c[-1]) + 1e-4, direction_sign=1,
    ).confluence


def _random_tape_factors(seed: int, n: int = 60, skew_book: bool = True) -> dict:
    """One randomised REAL-SHAPED tape + book, as a raw factor dict."""
    rng = np.random.default_rng(seed)
    drift = float(rng.normal(0, 0.0008))
    vol = float(abs(rng.normal(0, 0.0004))) + 1e-6
    c = 1.1 + np.cumsum(rng.normal(drift, vol, n))
    o, h, l = _ohlc(c)
    sign = 1 if drift >= 0 else -1
    return evaluate_book_confluence(
        c, opens=o, highs=h, lows=l, live_price=float(c[-1]),
        bid=float(c[-1]) - 1e-4, ask=float(c[-1]) + 1e-4,
        bid_depth=float(rng.uniform(150, 1000)) if skew_book else None,
        ask_depth=float(rng.uniform(150, 1000)) if skew_book else None,
        direction_sign=sign,
    ).factors


def test_flat_tape_does_not_manufacture_confidence():
    """A perfectly flat series has no range, so nothing can genuinely align."""
    cf = _confluence_for("flat")
    assert cf["active_count"] == 0, "flat tape should leave every book inactive"
    assert cf["score"] == 0.0
    assert cf["gate"] != "T1"


def test_synthetic_tapes_do_not_saturate_at_the_logistic_ceiling():
    """The defect: every tape returned 99.32. They must now differ from each other."""
    scores = {}
    for kind in ("flat", "ramp", "chop", "noisy"):
        for n in (40, 60, 90, 140):
            scores[f"{kind}@{n}"] = _confluence_for(kind, n)["score"]
    hot = {k: v for k, v in scores.items() if v >= SATURATION_CEILING}
    assert not hot, f"tapes saturated at the logistic ceiling: {hot}"
    assert all(v < DEFINITIVE_CONFIDENCE_MIN for v in scores.values()), scores
    assert len(set(scores.values())) > 1, f"tapes still collapse to one value: {scores}"


def test_score_is_strictly_increasing_in_aligned_magnitude():
    """THE DIRECT REGRESSION GUARD for the saturated strength term.

    Under `clip(m / 0.30, 0, 1)` every magnitude from 0.30 to 1.00 produced an
    IDENTICAL score — 40% of the composition was a constant. A correct curve is
    strictly increasing across that whole range, so extra real conviction must
    always buy strictly more confidence.
    """
    books = [k for p in CONFLUENCE_CLUSTERS.values() for k in p]
    for count in (3, 5, len(books)):
        subset = books[:count]
        scores = [
            compute_multiplicative_confluence({k: m for k in subset}, 1)["score"]
            for m in (0.10, 0.20, 0.30, 0.45, 0.60, 0.80, 1.00)
        ]
        assert all(b > a for a, b in zip(scores, scores[1:])), (
            f"{count}-book set is not monotone in magnitude — the strength term "
            f"is saturated somewhere: {scores}"
        )
        assert len(set(scores)) == len(scores), (
            f"{count}-book set produces duplicate scores across magnitudes "
            f"(saturation): {scores}"
        )


def test_thin_unanimous_book_set_cannot_buy_top_tier():
    """Three books agreeing is not nine-book unanimity, however aligned they are."""
    thin = {"bollinger_bands": 1.0, "atr_volatility": 1.0, "macd_rsi_stack": 1.0}
    r = compute_multiplicative_confluence(thin, 1)
    assert r["active_count"] == 3
    assert r["alignment"] == 1.0, "raw alignment IS unanimous here"
    assert r["evidence_breadth"] < 1.0, "breadth must discount a 3-book set"
    assert r["alignment_effective"] < 1.0
    assert r["score"] < DEFINITIVE_CONFIDENCE_MIN, "thin book set reached DEFINITIVE"


def test_full_evidence_set_is_unaffected_by_the_breadth_discount():
    """Every cluster member live = 8 books, above the floor: contract preserved."""
    all_aligned = {k: 1.0 for p in CONFLUENCE_CLUSTERS.values() for k in p}
    r = compute_multiplicative_confluence(all_aligned, 1)
    assert r["active_count"] >= CONFLUENCE_ALIGNMENT_FULL_AT
    assert r["evidence_breadth"] == 1.0
    assert r["alignment_effective"] == 1.0
    assert r["score"] >= DEFINITIVE_CONFIDENCE_MIN, "complete evidence stopped qualifying"


def test_dissent_and_majority_still_honest():
    """A breadth fix must not mask genuine dissent or a bare majority."""
    all_aligned = {k: 1.0 for p in CONFLUENCE_CLUSTERS.values() for k in p}
    dissent = dict(all_aligned)
    dissent["candlestick"] = -0.4
    assert compute_multiplicative_confluence(dissent, 1)["score"] < DEFINITIVE_CONFIDENCE_MIN

    majority = {
        "bollinger_bands": 1.0, "atr_volatility": 1.0, "macd_rsi_stack": 1.0,
        "donchian_breakout": 1.0, "candlestick": 1.0,
        "microstructure_queue": -0.6, "volume_price": -0.6, "evidence_persistence": -0.6,
    }
    assert compute_multiplicative_confluence(majority, 1)["score"] < 70.0


def test_neutral_direction_stays_neutral():
    """Sign 0 must never produce a score, with or without the breadth term."""
    thin = {"bollinger_bands": 1.0, "atr_volatility": 1.0, "macd_rsi_stack": 1.0}
    r = compute_multiplicative_confluence(thin, 0)
    assert r["gate"] == "NEUTRAL"
    assert r["score"] == 0.0


def test_diagnostics_present_on_every_return_path():
    """Consumers read these unconditionally; a neutral tape has no evidence."""
    thin = {"bollinger_bands": 1.0, "atr_volatility": 1.0, "macd_rsi_stack": 1.0}
    for factors, sign in ((thin, 0), (thin, 1), ({}, 1)):
        r = compute_multiplicative_confluence(factors, sign)
        for key in ("alignment", "alignment_effective", "evidence_breadth", "magnitude"):
            assert key in r, f"{key} missing on sign={sign} path"
            assert isinstance(r[key], float)


# ══════════════════════════════════════════════════════════════════════
# DISTRIBUTIONAL GUARDS — the properties the saturating version violated
# ══════════════════════════════════════════════════════════════════════

def test_real_shaped_tapes_do_not_collapse_onto_one_score():
    """387/400 collapsing onto 13 values is the signature of a saturated term.

    Asserted on raw factor dicts so the guarantee is a property of the
    COMPOSITOR, not of any particular tape generator. Tapes that aligned no
    book at all legitimately share the honest 0.0 verdict, so distinctness is
    measured over the tapes that actually produced a score — that is where the
    saturating version had nothing left to say.
    """
    scores = [
        compute_multiplicative_confluence(_random_tape_factors(s), 1)["score"]
        for s in range(400)
    ]
    assert len(set(scores)) >= 100, (
        f"only {len(set(scores))}/400 distinct scores — the convergence index "
        f"is saturating again"
    )
    scored = [s for s in scores if s > 0.0]
    assert len(scored) >= 100, f"only {len(scored)}/400 tapes produced a score"
    distinct = len(set(scored))
    assert distinct >= 0.6 * len(scored), (
        f"only {distinct} distinct values across {len(scored)} scored tapes "
        f"({len(scored) - distinct} share a score) — magnitude is not resolving"
    )
    top = sorted(scored)[-20:]
    span = top[-1] - top[0]
    assert span >= 0.20, (
        f"the top 20 scores span only {span:.2f} points — the upper range is "
        f"pinned: {top}"
    )
    assert max(top.count(v) for v in set(top)) <= 4, (
        f"one value dominates the top of the scale — it is saturating: {top}"
    )


def test_no_real_shaped_tape_reaches_the_logistic_ceiling():
    """Nothing saturates at the top of the scale any more."""
    scores = [
        compute_multiplicative_confluence(_random_tape_factors(s), 1)["score"]
        for s in range(400)
    ]
    hot = [s for s in scores if s >= SATURATION_CEILING]
    assert not hot, (
        f"{len(hot)}/400 tapes read >= {SATURATION_CEILING}% "
        f"(top: {sorted(hot)[-5:]})"
    )


def test_a_fully_diversified_book_set_never_lands_exactly_on_the_gate():
    """The depth lift may approach the bar, never pin onto it.

    An unbounded lift, or a hard `min(gate, ...)` cap, both relocate the
    saturation defect — the first to ~99.9%, the second to exactly 98.00%.
    """
    books = [k for p in CONFLUENCE_CLUSTERS.values() for k in p]
    pinned = []
    for s in range(200):
        factors = _random_tape_factors(s)
        r = compute_multiplicative_confluence(factors, 1)
        if r["verified_lift"] > 0.0:
            assert r["convergence_index"] < CONFLUENCE_GATE_CONV, (
                f"depth lift reached the gate exactly: conv="
                f"{r['convergence_index']} gate={CONFLUENCE_GATE_CONV}"
            )
        if abs(r["score"] - DEFINITIVE_CONFIDENCE_MIN) < 1e-9:
            pinned.append(s)
    assert not pinned, (
        f"{len(pinned)}/200 tapes pinned at exactly {DEFINITIVE_CONFIDENCE_MIN}%"
    )


def test_more_live_books_never_reduce_confidence():
    """Breadth is a discount on thin evidence, so it must be monotone in count."""
    books = [k for p in CONFLUENCE_CLUSTERS.values() for k in p]
    scores = [
        compute_multiplicative_confluence({k: 0.6 for k in books[:n]}, 1)["score"]
        for n in range(1, len(books) + 1)
    ]
    assert all(b >= a for a, b in zip(scores, scores[1:])), (
        f"adding a live aligned book LOWERED the score: {scores}"
    )
