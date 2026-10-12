"""
test_real_proxy_fallback.py — REAL ASSET QUOTE-PROXY FALLBACK (P1-2026-09-24)

The institutional liquidity gate must never permanently block a REAL pair
when the L2 order book is absent:
  * OTC tape keeps its HF synthetic price-action loop untouched.
  * REAL assets fall back to the approved "Spread/ATR + flow + MTF proxies"
    validator (spread_status="synthetic_proxy", quote_proxy=True), and the
    strict 96.5% bar relaxes to the dynamic per-class floor
    (bar_source="real_proxy_floor"; default 80.0% = T3) ONLY when the proxied
    gate is fully green and no user filter is set — never below T4, never a
    fabricated executable.

Default (allow_proxy_quotes=False) MUST preserve the strict no_bid_ask_quotes
veto so direct-caller semantics stay unchanged.
"""

import numpy as np
import pytest

from app.services.execution_gate import build_execution_surface
from app.services.real_liquidity_gate import evaluate_real_liquidity_gate
from app.services.signal_gatekeeper import (
    apply_strict_execution_gate,
    REAL_PROXY_EXECUTABLE_FLOOR_FRAC,
)


def _clean_rising_series(n: int = 200, start: float = 1.1000, step: float = 0.0002) -> list:
    return [round(start + i * step, 5) for i in range(n)]


# ── 1 ── default gate: missing quotes still vetoes (strict semantics intact) ──
def test_default_gate_still_vetoes_no_quotes():
    series = _clean_rising_series()
    verdict = evaluate_real_liquidity_gate(series, "BUY", bid=None, ask=None, live_price=series[-1])
    assert verdict["passes"] is False
    assert verdict["reason"] == "no_bid_ask_quotes"
    assert verdict["metrics"]["quote_proxy"] in (None, False)


# ── 2 ── proxy gate: healthy tape with no quotes PASSES on proxies ──
def test_proxy_gate_passes_healthy_tape_without_quotes():
    series = _clean_rising_series()
    verdict = evaluate_real_liquidity_gate(
        series, "BUY", bid=None, ask=None, live_price=series[-1], allow_proxy_quotes=True
    )
    assert verdict["passes"] is True
    assert verdict["reason"] is None
    assert verdict["metrics"]["spread_status"] == "synthetic_proxy"
    assert verdict["metrics"]["quote_proxy"] is True


# ── 3 ── proxy gate: dead tape (no ATR) cannot validate spread → honest fail ──
def test_proxy_gate_fails_dead_tape():
    series = [1.1000] * 200
    verdict = evaluate_real_liquidity_gate(
        series, "BUY", bid=None, ask=None, live_price=1.1000, allow_proxy_quotes=True
    )
    assert verdict["passes"] is False
    assert verdict["metrics"]["atr_ratio"] == 0.0
    assert verdict["metrics"]["quote_proxy"] is True


# ── 4 ── proxy gate: real quotes still take the strict real path ──
def test_proxy_flag_does_not_disturb_real_quotes():
    series = _clean_rising_series()
    mid = series[-1]
    bid, ask = round(mid - 0.0001, 5), round(mid + 0.0001, 5)
    verdict = evaluate_real_liquidity_gate(
        series, "BUY", bid=bid, ask=ask, live_price=mid, allow_proxy_quotes=True
    )
    assert verdict["metrics"]["quote_proxy"] in (None, False)
    assert verdict["metrics"]["spread_status"] == "tight"


# ── 5 ── dynamic floor: REAL + green proxy gate → 80% bar (real_proxy_floor) ──
def test_dynamic_floor_applies_for_real_proxy():
    if REAL_PROXY_EXECUTABLE_FLOOR_FRAC is None:
        pytest.skip("real-proxy floor disabled via env")
    class_gate = {
        "passes": True,
        "reason": None,
        "metrics": {"quote_proxy": True, "spread_status": "synthetic_proxy"},
    }
    out = apply_strict_execution_gate(
        "BUY",
        82.0,
        asset_class="REAL",
        class_gate=class_gate,
        regime_type="trending",
        spread_status="synthetic_proxy",
    )
    assert out["executable"] is True
    assert out["bar_source"] == "real_proxy_floor"
    assert out["threshold_pct"] == round(REAL_PROXY_EXECUTABLE_FLOOR_FRAC * 100.0, 2)
    assert out["metrics"]["dynamic_floor"]["asset_class"] == "REAL"


# ── 6 ── dynamic floor: below the relaxed bar is still SCORED-ONLY ──
def test_dynamic_floor_below_bar_not_executable():
    if REAL_PROXY_EXECUTABLE_FLOOR_FRAC is None:
        pytest.skip("real-proxy floor disabled via env")
    floor = REAL_PROXY_EXECUTABLE_FLOOR_FRAC
    class_gate = {"passes": True, "metrics": {"quote_proxy": True}}
    out = apply_strict_execution_gate(
        "BUY", round(floor * 100.0, 2) - 1.0, asset_class="REAL",
        class_gate=class_gate,
    )
    assert out["executable"] is False
    assert out["regime_gate"] == "pending_high_precision"
    assert out["suppressed_reason"] == "below_high_precision_bar"


# ── 7 ── dynamic floor: failing proxy gate is still vetoed (no unlock) ──
def test_dynamic_floor_never_bypasses_gate_veto():
    class_gate = {
        "passes": False,
        "reason": "volatility_stress",
        "metrics": {"quote_proxy": True},
    }
    out = apply_strict_execution_gate(
        "BUY", 98.0, asset_class="REAL", class_gate=class_gate,
    )
    assert out["executable"] is False
    assert out["suppressed_reason"] == "volatility_stress"


# ── 8 ── user filter wins over the dynamic floor (user bar is the bar) ──
def test_user_filter_overrides_dynamic_floor():
    class_gate = {"passes": True, "metrics": {"quote_proxy": True}}
    out = apply_strict_execution_gate(
        "BUY", 85.0, asset_class="REAL", class_gate=class_gate, min_confidence=90.0
    )
    assert out["executable"] is False  # 85 < user bar 90
    assert out["bar_source"] in ("user", "floored")
    assert out["threshold_pct"] == 90.0


# ── 9 ── NON-REAL classes never relax (OTC stays strict 96.5%) ──
def test_otc_never_relaxes():
    class_gate = {"passes": True, "metrics": {"quote_proxy": True}}
    out = apply_strict_execution_gate(
        "BUY", 90.0, asset_class="OTC", class_gate=class_gate,
    )
    assert out["executable"] is False  # 90 < 96.5 strict bar
    assert out["bar_source"] == "default"
    assert out["threshold_pct"] == 96.5
    assert "dynamic_floor" not in out["metrics"]


# ── 10 ── full surface: REAL / no quotes / green proxies → executable at 82% ──
def test_full_surface_real_without_quotes_is_executable():
    if REAL_PROXY_EXECUTABLE_FLOOR_FRAC is None:
        pytest.skip("real-proxy floor disabled via env")
    series = _clean_rising_series()
    surface = build_execution_surface(
        symbol="EUR/NOK",
        closes=series,
        direction="BUY",
        confidence_pct=82.0,
        bid=None,
        ask=None,
        live_price=series[-1],
        timeframe="1h",
        allow_real_quote_proxy=True,
    )
    assert surface["asset_class"] == "REAL"
    assert surface["class_filter"] == "real_liquidity_gate"
    assert surface["class_gate"]["metrics"]["quote_proxy"] is True
    assert surface["quote_proxy_enabled"] is True
    assert surface["executable"] is True
    assert surface["bar_source"] == "real_proxy_floor"
    assert surface["suppressed_reason"] is None


# ── 11 ── full surface: proxy disabled → strict no_bid_ask_quotes veto ──
def test_full_surface_real_without_quotes_strict_veto_when_disabled():
    series = _clean_rising_series()
    surface = build_execution_surface(
        symbol="EUR/NOK",
        closes=series,
        direction="BUY",
        confidence_pct=97.0,
        bid=None,
        ask=None,
        live_price=series[-1],
        timeframe="1h",
        allow_real_quote_proxy=False,
    )
    assert surface["asset_class"] == "REAL"
    assert surface["executable"] is False
    assert surface["suppressed_reason"] == "no_bid_ask_quotes"
    assert surface["bar_source"] == "default"
    assert surface.get("quote_proxy_enabled") is not True


# ── 12 ── OTC full surface untouched by the proxy plumbing ──
def test_otc_surface_untouched():
    series = _clean_rising_series(n=120)
    surface = build_execution_surface(
        symbol="EUR/USD", closes=series, direction="BUY", confidence_pct=97.0,
        bid=None, ask=None, live_price=series[-1], timeframe="1h",
        allow_real_quote_proxy=True,
    )
    assert surface["asset_class"] == "OTC"
    assert surface["class_filter"] == "otc_hf_quality"
    assert surface.get("quote_proxy_enabled") is not True