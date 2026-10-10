"""
test_strict_execution_gate.py — STRICT 96.5% HIGH-PRECISION EXECUTION BAR
(PRINCIPAL QUALITY UPGRADE 2026-09-24)

Proves the enterprise contract end-to-end through the unified surface:

  * A directional verdict at EXACTLY 96.5% (and above) IS executable; any
    value below the bar is demoted to SCORED-ONLY
    (regime_gate="pending_high_precision", executable=False).
  * The per-asset-class filter VETOES even a >= 96.5% confluence when the
    micro-market is weak: OTC HF quality (price-action/flow/vol/m-r) and the
    REAL institutional liquidity gate (spread-to-ATR margin, order flow,
    M1/M5/H1 alignment, vol stress).
  * NaN/inf/<=0 prices are sanitized before any decision; a shallow window
    (REAL < 160, OTC < 30) is an auditable insufficient-history veto.
  * Every evaluation carries the full audit surface (confluence, regime,
    spread, tier, executable, sanitization, class filter).

Run:  python -m pytest tests/test_strict_execution_gate.py -q
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.services.asset_class import (
    ASSET_CLASS_CRYPTO,
    ASSET_CLASS_OTC,
    ASSET_CLASS_REAL,
    REAL_ASSET_CLASS_SYMBOLS,
    is_crypto_asset,
    is_otc_asset,
    is_real_asset,
    resolve_asset_class,
)
from app.services.data_sanitization import (
    MIN_OTC_TICKS,
    MIN_REAL_CLOSES,
    sanitize_candles,
    sanitize_price_series,
    sufficient_history,
)
from app.services.execution_gate import build_execution_surface
from app.services.otc_hf_quality import evaluate_otc_hf_quality
from app.services.real_liquidity_gate import evaluate_real_liquidity_gate
from app.services.signal_gatekeeper import (
    REGIME_GATE_PENDING_HIGH_PRECISION,
    REGIME_GATE_TRADABLE,
    STRICT_EXECUTION_CONFIDENCE,
    SUPPRESSED_REASON_HIGH_PRECISION,
    apply_strict_execution_gate,
)


# ── fixtures ────────────────────────────────────────────────────────────────

def _otc_clean_trend(n: int = 60, step: float = 0.001, start: float = 1.10) -> list:
    """Monotonic accelerating micro-ramp: velocity +1, accel 0, per-tick move
    ~0.0009 (inside the tradeable ATR band), z_last ~1.73 (no m-r veto). This
    is exactly the shape that clears the OTC HF filter for BUY."""
    return [start + step * i for i in range(n)]


def _real_clean_tape(n: int = 240, step: float = 0.001) -> list:
    """REAL-shaped M1 tape: >= 160 clean closes, steady uptrend (M1/M5/H1 all
    aligned up), tight spread window, no volatility stress."""
    return _otc_clean_trend(n=n, step=step, start=1.10)


def _tight_quotes(price: float):
    bid = round(price * (1 - 0.0001), 8)
    ask = round(price * (1 + 0.0001), 8)
    return bid, ask


def _with_glitches(series: list, n_nan: int = 3, n_inf: int = 2, n_neg: int = 1) -> list:
    out = list(series)
    for i in range(n_nan):
        out.insert(5 + i * 17, float("nan"))
    for i in range(n_inf):
        out.insert(30 + i * 23, float("inf"))
    for i in range(n_neg):
        out.insert(60 + i * 11, -1.0)
    return out


# ── 1 ── the strict confidence bar (EXACT 96.5% boundary) ──────────────────

def test_apply_gate_exactly_at_the_bar_is_executable():
    assert STRICT_EXECUTION_CONFIDENCE == pytest.approx(0.965)
    for confidence in (96.5, 0.965, 97.0, 99.9, 100.0):
        out = apply_strict_execution_gate("BUY", confidence)
        assert out["executable"] is True, confidence
        assert out["regime_gate"] == REGIME_GATE_TRADABLE
        assert out["regime_status"] == "CONFIRMED"
        assert out["suppressed_reason"] is None
        assert out["threshold_pct"] == pytest.approx(96.5)


def test_apply_gate_below_the_bar_is_pending_high_precision_scored_only():
    for confidence in (96.4, 0.964, 95.0, 0.95, 70.0, 30.0, 0.0):
        out = apply_strict_execution_gate("BUY", confidence)
        assert out["executable"] is False, confidence
        assert out["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION
        assert out["regime_status"] == "PENDING_HIGH_PRECISION"
        assert out["suppressed_reason"] == SUPPRESSED_REASON_HIGH_PRECISION
        assert out["signal"] == "BUY"  # direction ALWAYS kept, never coerced


def test_apply_gate_keeps_direction_and_honest_tier_below_bar():
    out = apply_strict_execution_gate("SELL", 90.0)
    assert out["signal"] == "SELL"
    assert out["tier"] == "T2"  # honest resolved tier, reported for the audit
    assert out["tier_label"] == "HIGH"
    assert out["executable"] is False


def test_apply_gate_non_directional_never_executable():
    for sig in (None, "HOLD", "", "bogus"):
        out = apply_strict_execution_gate(sig, 99.0)
        assert out["executable"] is False
        assert out["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION


# ── 2 ── class-gate interaction ─────────────────────────────────────────────

def test_apply_gate_provided_class_gate_passing_keeps_executable():
    out = apply_strict_execution_gate(
        "BUY", 97.0, asset_class="OTC",
        class_gate={"passes": True, "reason": None, "score": 0.9},
        regime_type="trending", spread_status="synthetic",
    )
    assert out["executable"] is True
    assert out["suppressed_reason"] is None


def test_apply_gate_provided_class_gate_failing_vetoes_even_at_97():
    out = apply_strict_execution_gate(
        "BUY", 97.0, asset_class="REAL",
        class_gate={"passes": False, "reason": "spread_too_wide", "score": 0.4},
        regime_type="trending", spread_status="wide",
    )
    assert out["executable"] is False
    assert out["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION
    assert out["suppressed_reason"] == "spread_too_wide"
    assert out["metrics"]["spread_status"] == "wide"


def test_apply_gate_no_class_gate_supplied_is_not_vetoed():
    out = apply_strict_execution_gate("BUY", 97.0, asset_class="OTC")
    assert out["executable"] is True  # /predict always supplies one; direct OK


# ── 3 ── asset-class resolution ─────────────────────────────────────────────

def test_asset_class_resolution():
    assert resolve_asset_class("EUR/SEK") == ASSET_CLASS_REAL
    assert resolve_asset_class("eur/nok") == ASSET_CLASS_REAL
    assert resolve_asset_class("EUR/USD") == ASSET_CLASS_OTC
    assert resolve_asset_class("EUR/JPY") == ASSET_CLASS_OTC
    assert resolve_asset_class("UNKNOWN/XX") == ASSET_CLASS_OTC  # safe default
    assert resolve_asset_class(None) == ASSET_CLASS_OTC
    assert is_real_asset("USD/SEK") is True
    assert is_real_asset("USD/JPY") is False
    assert is_otc_asset("USD/JPY") is True
    assert is_otc_asset("USD/SEK") is False


def test_crypto_majors_are_their_own_class_not_real_fx():
    """BTC/ETH must NOT be graded by the institutional FX liquidity gate.

    Behaviour change: these two lines previously asserted
    ``resolve_asset_class("BTC/USD") == ASSET_CLASS_REAL``, which routed 24/7
    crypto through a gate built for session-bound wholesale FX (spread-to-ATR
    margin, 160 closes, M1/M5/H1 session alignment). They now resolve CRYPTO
    and are gated by the crypto momentum/breakout strategy instead.
    """
    assert resolve_asset_class("BTC/USD") == ASSET_CLASS_CRYPTO
    assert resolve_asset_class("ETH/USD") == ASSET_CLASS_CRYPTO
    # Vendor quote variants must not silently demote into the OTC class.
    assert resolve_asset_class("btc/usd") == ASSET_CLASS_CRYPTO
    assert resolve_asset_class("ETH/USDT") == ASSET_CLASS_CRYPTO
    assert is_crypto_asset("BTC/USD") is True
    assert is_crypto_asset("EUR/SEK") is False
    # A crypto major is NOT institutional FX, and not OTC either.
    assert is_real_asset("BTC/USD") is False
    assert is_otc_asset("BTC/USD") is False
    # Wholesale FX is unaffected by the crypto split.
    assert is_real_asset("EUR/SEK") is True
    assert len(REAL_ASSET_CLASS_SYMBOLS) == 10


# ── 4 ── sanitization (NaN/inf/<=0 dropped; per-class minimum windows) ──────

def test_sanitize_price_series_drops_non_finite_and_non_positive():
    series = _with_glitches([10.0] * 20, n_nan=2, n_inf=1, n_neg=1)
    out = sanitize_price_series(series)
    assert out["original"] == len(series) == 24
    assert out["dropped"] == 4
    assert len(out["closes"]) == 20
    assert out["sufficient"] is False  # 20 < MIN_REAL_CLOSES default


def test_sanitize_candles_drops_rows_with_any_bad_ohlc():
    good = {"open": 10, "high": 10.5, "low": 9.5, "close": 10.2}
    bad_nan = {**good, "close": float("nan")}
    bad_inf = {**good, "high": float("inf")}
    bad_neg = {**good, "low": -3}
    stars = sanitize_candles([good, bad_nan, bad_inf, bad_neg], ohlc_keys=("open", "high", "low", "close"))
    assert stars["original"] == 4
    assert stars["dropped"] == 3
    assert len(stars["candles"]) == 1


def test_per_class_minimum_windows():
    assert MIN_REAL_CLOSES == 160
    assert MIN_OTC_TICKS == 30
    otc = sufficient_history([1.0] * 40, "OTC")
    assert otc["sufficient"] is True
    assert otc["minimum"] == MIN_OTC_TICKS
    real = sufficient_history([1.0] * 159, "REAL")
    assert real["sufficient"] is False
    assert real["minimum"] == MIN_REAL_CLOSES
    assert real["reason"] == "insufficient_history"


# ── 5 ── dual-regime class filters (unit) ───────────────────────────────────

def test_otc_hf_filter_passes_clean_accelerating_uptrend():
    series = _otc_clean_trend()
    verdict = evaluate_otc_hf_quality(series, "BUY")
    assert verdict["passes"] is True, verdict
    assert verdict["reason"] is None
    assert verdict["score"] == pytest.approx(1.0)


def test_otc_hf_filter_vetoes_sub_30_tick_tape():
    verdict = evaluate_otc_hf_quality([1.0, 1.01, 1.02], "BUY")
    assert verdict["passes"] is False
    assert verdict["reason"] == "insufficient_history"


def test_real_gate_passes_tight_aligned_tape():
    series = _real_clean_tape()
    price = series[-1]
    bid, ask = _tight_quotes(price)
    verdict = evaluate_real_liquidity_gate(series, "BUY", bid=bid, ask=ask, live_price=price)
    assert verdict["passes"] is True, verdict
    assert verdict["reason"] is None
    assert all(v == 1 for v in verdict["factors"].values())


def test_real_gate_wide_spread_veto():
    series = _real_clean_tape()
    price = series[-1]
    bid, ask = price * 0.995, price * 1.005  # 1% spread >= 50bps
    verdict = evaluate_real_liquidity_gate(series, "BUY", bid=bid, ask=ask, live_price=price)
    assert verdict["passes"] is False
    assert verdict["reason"] == "spread_too_wide"


def test_real_gate_missing_quotes_veto():
    series = _real_clean_tape()
    verdict = evaluate_real_liquidity_gate(series, "BUY", bid=None, ask=None, live_price=series[-1])
    assert verdict["passes"] is False
    assert verdict["reason"] == "no_bid_ask_quotes"


def test_real_gate_spread_exceeds_atr_margin_veto():
    # Tiny per-tick move → tiny ATR; a (still < 50bps) spread that is >= the
    # ATR move fails the spread-to-ATR safety margin.
    series = _otc_clean_trend(n=240, step=1e-5)
    price = series[-1]
    bid, ask = price * (1 - 1e-4), price * (1 + 1e-4)  # 2 bps, but > per-bar move
    verdict = evaluate_real_liquidity_gate(series, "BUY", bid=bid, ask=ask, live_price=price)
    assert verdict["passes"] is False
    assert verdict["reason"] == "spread_exceeds_atr_margin"


def test_real_gate_mtf_misalignment_veto():
    # Mostly flat base tape with a single final pop: M1 aligns up, M5/H1 stay
    # flat → 1/3 aligned < MTF_MIN_ALIGNED (2) → mtf_misaligned.
    series = [1.10] * 130 + [1.10 * (1 + 2.5e-4 * i) for i in range(5)]
    series += [series[-1]] * 110  # flat tail to fill >= 160 closes
    price = series[-1]
    bid, ask = _tight_quotes(price)
    verdict = evaluate_real_liquidity_gate(series, "BUY", bid=bid, ask=ask, live_price=price)
    assert verdict["passes"] is False
    assert verdict["reason"] == "mtf_misaligned"


def test_real_gate_short_tape_veto():
    verdict = evaluate_real_liquidity_gate(
        _otc_clean_trend(n=100), "BUY", bid=1.0, ask=1.0002, live_price=1.0
    )
    assert verdict["passes"] is False
    assert verdict["reason"] == "insufficient_history"


# ── 6 ── unified build_execution_surface — OTC ──────────────────────────────

def test_surface_otc_pass_at_strict_bar():
    series = _otc_clean_trend()
    surface = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=96.5, bid=series[-1] * 0.9999, ask=series[-1],
        live_price=series[-1], timeframe="1m",
    )
    assert surface["executable"] is True
    assert surface["regime_gate"] == REGIME_GATE_TRADABLE
    assert surface["suppressed_reason"] is None
    assert surface["asset_class"] == ASSET_CLASS_OTC
    assert surface["class_filter"] == "otc_hf_quality"
    assert surface["status"] == "active"
    assert surface["regime_status"] == "CONFIRMED"
    assert surface["threshold_pct"] == pytest.approx(96.5)


def test_surface_otc_below_bar_demoted_even_though_filter_passes():
    series = _otc_clean_trend()
    surface = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=96.4, bid=series[-1] * 0.9999, ask=series[-1],
        live_price=series[-1], timeframe="1m",
    )
    assert surface["executable"] is False
    assert surface["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION
    assert surface["suppressed_reason"] == SUPPRESSED_REASON_HIGH_PRECISION
    assert surface["tier"] == "T2"  # honest tier below the strict bar (T1 needs 96.5)
    assert surface["signal"] == "BUY"


def test_surface_otc_insufficient_history_veto():
    surface = build_execution_surface(
        symbol="EUR/USD", closes=_otc_clean_trend(n=20), direction="BUY",
        confidence_pct=98.0, bid=None, ask=None, live_price=1.10,
        timeframe="1m",
    )
    assert surface["executable"] is False
    assert surface["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION
    assert surface["suppressed_reason"] == "insufficient_history"
    assert surface["sanitization"]["sufficient"] is False


def test_surface_otc_sanitized_glitched_tape_still_reports_dropped():
    series = _with_glitches(_otc_clean_trend(), n_nan=2, n_inf=1, n_neg=1)
    surface = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=98.0, bid=None, ask=None,
        live_price=series[-1], timeframe="1m",
    )
    # 4 glitched values dropped from 64 raw, 60 clean ticks remain (>= 30) →
    # the filter is still viable on the sanitized window.
    assert surface["sanitization"]["original"] == 64
    assert surface["sanitization"]["dropped"] == 4
    assert surface["sanitization"]["available"] == 60
    assert surface["sanitization"]["minimum_required"] == MIN_OTC_TICKS
    assert surface["sanitization"]["sufficient"] is True


# ── 7 ── unified build_execution_surface — REAL ─────────────────────────────

def test_surface_real_pass_tight_aligned():
    series = _real_clean_tape()
    price = series[-1]
    bid, ask = _tight_quotes(price)
    surface = build_execution_surface(
        symbol="EUR/SEK", closes=series, direction="BUY",
        confidence_pct=97.0, bid=bid, ask=ask, live_price=price, timeframe="1m",
    )
    assert surface["executable"] is True
    assert surface["regime_gate"] == REGIME_GATE_TRADABLE
    assert surface["suppressed_reason"] is None
    assert surface["asset_class"] == ASSET_CLASS_REAL
    assert surface["class_filter"] == "real_liquidity_gate"
    assert surface["max_executable_tier"] == "T1"


def test_surface_real_wide_spread_veto_at_97():
    series = _real_clean_tape()
    price = series[-1]
    surface = build_execution_surface(
        symbol="EUR/SEK", closes=series, direction="BUY",
        confidence_pct=97.0, bid=price * 0.995, ask=price * 1.005,
        live_price=price, timeframe="1m",
    )
    assert surface["executable"] is False
    assert surface["suppressed_reason"] == "spread_too_wide"
    assert surface["class_gate"]["reason"] == "spread_too_wide"


def test_surface_real_no_quotes_veto_at_97():
    series = _real_clean_tape()
    surface = build_execution_surface(
        symbol="EUR/SEK", closes=series, direction="BUY",
        confidence_pct=97.0, bid=None, ask=None, live_price=series[-1],
        timeframe="1m",
    )
    assert surface["executable"] is False
    assert surface["suppressed_reason"] == "no_bid_ask_quotes"


def test_surface_real_mtf_misaligned_veto():
    series = [1.10] * 130 + [1.10 * (1 + 2.5e-4 * i) for i in range(5)]
    series += [series[-1]] * 110
    price = series[-1]
    bid, ask = _tight_quotes(price)
    surface = build_execution_surface(
        symbol="EUR/SEK", closes=series, direction="BUY",
        confidence_pct=98.0, bid=bid, ask=ask, live_price=price, timeframe="1m",
    )
    assert surface["executable"] is False
    assert surface["suppressed_reason"] == "mtf_misaligned"


def test_surface_real_short_tape_veto():
    surface = build_execution_surface(
        symbol="EUR/SEK", closes=_real_clean_tape(n=100), direction="BUY",
        confidence_pct=99.0, bid=1.0, ask=1.0002, live_price=1.10,
        timeframe="1m",
    )
    assert surface["executable"] is False
    assert surface["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION
    assert surface["suppressed_reason"] == "insufficient_history"


# ── 8 ── the audit surface is always present and complete ──────────────────

def test_surface_always_carries_full_audit_record():
    series = _otc_clean_trend()
    surface = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=97.5, bid=None, ask=None, live_price=series[-1],
        timeframe="1m",
    )
    audit = surface["audit"]
    assert audit["symbol"] == "EUR/USD"
    assert audit["asset_class"] == ASSET_CLASS_OTC
    assert audit["confluence_score"] == pytest.approx(97.5)
    assert audit["confidence_pct"] == pytest.approx(97.5)
    assert audit["executable"] is True
    assert audit["tier"] == "T1"
    assert audit["regime_gate"] == REGIME_GATE_TRADABLE
    assert audit["suppressed_reason"] is None
    assert audit["class_filter"] == "otc_hf_quality"
    assert "regime_type" in audit
    assert "spread_status" in audit

    metrics = surface["metrics"]
    assert metrics["confluence_score"] == pytest.approx(97.5)
    assert "regime_type" in metrics
    assert "spread_status" in metrics


def test_surface_rejects_bogus_glitched_confidence_never_fabricates():
    # A NaN confidence must collapse to a safe, honest non-executable verdict.
    series = _otc_clean_trend()
    surface = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY",
        confidence_pct=float("nan"), bid=None, ask=None, live_price=series[-1],
        timeframe="1m",
    )
    assert surface["executable"] is False
    assert surface["regime_gate"] == REGIME_GATE_PENDING_HIGH_PRECISION