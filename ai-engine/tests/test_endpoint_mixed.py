"""
test_endpoint_mixed.py — END-TO-END /predict VERIFICATION OF THE 98% THERMAL GATE

Boots the FastAPI app in-process (TestClient) and fires REAL requests at
POST /api/v1/predict across multiple symbols and horizons, asserting:

  1. Healthy mixed arbitration THROUGH the full API: a fully-converged uptrend
     (v10 two-factor confluence) ORGANICALLY CLEARS the 98% gate and
     dispatches BUY even without a live order book — the microstructure queue
     falls back to the honest REAL tick-position proxy — while a sub-thermal
     downtrend gates to the OPPOSITE attempt (diagnostics.gated_direction
     SELL), never two identical directions.
  2. The strict 98% confluence gate: any directional attempt whose
     convergence index (agreement × magnitude through the canonical logistic)
     is below DEFINITIVE_CONFIDENCE_MIN KEEPS its true BUY/SELL direction and
     becomes an honest market-waiting signal:
     signal=<true direction>, waiting_reason=CONFLUENCE_BELOW_THERMAL,
     market_waiting=True, confidence == the REAL confluence score (< 98),
     gate=INSUFFICIENT, high_confidence_alert=False, and the waiting target is
     the REAL directional projection (SELL → below current, never a bogus
     reversed projection).
  3. The response ships book_confluence (diagnostics.book) whose confluence
     block (score/gate/geo_mean/clusters/blockers) is the authoritative gate —
     the confidence the client sees IS the confluence number.
  4. Multi-day timeframes (1h/1d/10d) are accepted; a dispatched BUY computes a
     REAL target whose distance scales with √horizon (1h → 10d), while an
     unconverged-microstructure tape would pin flat at every horizon.
  5. Invalid input → clean descriptive HTTP error (never a fake signal).

Run:  python tests/test_endpoint_mixed.py
"""

import sys
import io
from pathlib import Path

# Windows consoles default to cp1252 — force UTF-8-safe stdout.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from app.services.book_instruments import DEFINITIVE_CONFIDENCE_MIN


def make_candles(closes, base_spread=0.0008, volume=None):
    closes = list(closes)
    candles = []
    for i, c in enumerate(closes):
        o = closes[i - 1] if i > 0 else c * (1 - base_spread)
        hi = max(o, c) * (1 + base_spread)
        lo = min(o, c) * (1 - base_spread)
        candles.append(
            {
                "timestamp": i * 60_000,
                "open": round(o, 6),
                "high": round(hi, 6),
                "low": round(lo, 6),
                "close": round(c, 6),
                "volume": (volume[i] if volume is not None
                           else 1000.0 + (i % 7) * 50.0),
            }
        )
    return candles


def _trend_candles(base, n=120, seed=42, sign=+1):
    """Price-CONSISTENT trend generator — ATR scales with the symbol's
    actual price level exactly like real market feeds do."""
    rng = np.random.default_rng(seed)
    drift = np.linspace(0, 0.03, n) * sign
    noise = rng.normal(0, 0.0015, n).cumsum() * 0.3
    return make_candles(base * (1 + drift + noise))


def bullish_candles(n=120):
    return _trend_candles(1.1000, n=n, seed=42, sign=+1)


def bearish_candles(n=120):
    return _trend_candles(1.1000, n=n, seed=7, sign=-1)


def jpy_bullish_candles(n=120):
    """USD/JPY-scale uptrend (base ≈ 150.00) — keeps ATR proportional."""
    return _trend_candles(150.00, n=n, seed=42, sign=+1)


def last_close(candles):
    """Consistent runtime spot for a candle series — the freshest real close.

    A live feed always prices the spot at/near the latest candle close. Using
    a hardcoded spot that diverges 0.8% from the series (as the old test did)
    made price_action_delta/live_tick_move/instant_delta saturate +1 and
    flipped a genuine downtrend into BUY. The spot must be anchored to the
    real last close of the forwarded tape.
    """
    return float(candles[-1]["close"])


def assert_gated_waiting(d, failures, tag):
    """v11 contract: a sub-thermal directional attempt KEEPS its true
    BUY/SELL direction as an honest market-waiting signal (never HOLD)."""
    sig = d.get("signal")
    if sig not in ("BUY", "SELL"):
        failures.append(f"{tag}: signal={sig}, expected true directional BUY/SELL (never HOLD)")
        return {}
    diag = d.get("diagnostics", {})
    if not diag.get("confidence_gated"):
        failures.append(f"{tag}: directional signal missing diagnostics.confidence_gated")
    if diag.get("gated_direction") != sig:
        failures.append(f"{tag}: gated_direction={diag.get('gated_direction')} does not match emitted signal {sig}")
    if d.get("waiting_reason") != "CONFLUENCE_BELOW_THERMAL":
        failures.append(f"{tag}: waiting_reason={d.get('waiting_reason')}, expected CONFLUENCE_BELOW_THERMAL")
    if not d.get("market_waiting"):
        failures.append(f"{tag}: market_waiting must be True on a gated market-waiting signal")
    if d.get("high_confidence_alert"):
        failures.append(f"{tag}: gated market-waiting signal must never fire the alert")
    conf = float(d.get("confidence", 0))
    if not (0.0 <= conf < 98):
        failures.append(f"{tag}: gated confidence {conf} outside [0, 98)")
    # The confidence the client sees IS the authoritative confluence number.
    bc = d.get("book_confluence", {})
    cs = float((bc.get("confluence") or {}).get("score", -1))
    if abs(cs - conf) > 0.01:
        failures.append(f"{tag}: confidence {conf} != confluence score {cs} — number is padded/hidden")
    gate = (bc.get("confluence") or {}).get("gate")
    if gate != "INSUFFICIENT":
        failures.append(f"{tag}: confluence gate={gate}, expected INSUFFICIENT (directional but sub-thermal)")
    for p in ("volatility", "momentum", "microstructure"):
        if p not in (bc.get("confluence") or {}).get("clusters", {}):
            failures.append(f"{tag}: confluence missing pillar {p}")
    # Market-waiting signal KEEPS its true direction, so its target is the real
    # directional projection (SELL → below, BUY → above) — never a bogus flat
    # pin and never reversed against the retained direction.
    tgt = float(d.get("target_price", 0) or 0)
    cur = float(d.get("current_price", 0) or 0)
    dist = tgt - cur
    if abs(dist) <= 1e-9:
        failures.append(f"{tag}: market-waiting target must be a real directional projection, got flat dist {abs(dist)}")
    if sig == "SELL" and dist >= -1e-9:
        failures.append(f"{tag}: SELL market-waiting target {dist:.6f} must project BELOW the current price")
    if sig == "BUY" and dist <= 1e-9:
        failures.append(f"{tag}: BUY market-waiting target {dist:.6f} must project ABOVE the current price")
    return diag


def scenario_perfect_confluence(n=120):
    """Every book converges hard in the bullish direction + a LIVE order book.

    The same tape that fires the genuine ~97%+ DEFINITIVE BUY through the
    in-process engine — forwarded intact through the full HTTP endpoint with a
    real bid/ask so the mandatory microstructure (Aldridge queue) pillar is
    live and the DEFINITIVE emission branch (incl. the ML corroborator) runs.
    """
    rng = np.random.default_rng(99)
    drift = np.linspace(0, 0.02, n - 6)
    noise = rng.normal(0, 0.0006, n - 6).cumsum() * 0.12
    closes = [float(x) for x in (1.1000 * (1 + drift + noise))]
    base = closes[-1]
    closes += [
        base * 1.004, base * 1.009, base * 1.016,
        base * 1.024, base * 1.034, base * 1.046,
    ]
    vol = [1200.0 + (i % 7) * 50.0 for i in range(n - 6)] + [12000.0] * 6
    candles = make_candles(closes, base_spread=0.0001, volume=vol)
    spot = float(candles[-1]["close"])
    bid = spot * (1 - 0.0004)
    ask = spot
    return candles, spot, bid, ask


def main():
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    failures = []

    # ── TEST A: MIXED DIRECTIONS THROUGH THE FULL ENDPOINT (v9 gate) ──
    bull_payload = {
        "symbol": "EUR/USD",
        "timeframe": "1h",
        "candles": bullish_candles(),
        "live_price": last_close(bullish_candles()),
        "dataSource": "forex_otc_test",
    }
    r1 = client.post("/api/v1/predict", json=bull_payload)
    print(f"bullish EUR/USD -> HTTP {r1.status_code}")
    if r1.status_code != 200:
        print(f"   ERROR BODY: {str(r1.json())[:400]}")
    d1 = r1.json()
    print(f"   signal={d1.get('signal')} conf={d1.get('confidence')} "
          f"alert={d1.get('high_confidence_alert')} reason={d1.get('waiting_reason')} "
          f"gated={d1.get('diagnostics', {}).get('gated_direction')}")

    bear_payload = {
        "symbol": "GBP/USD",
        "timeframe": "4h",
        "candles": bearish_candles(),
        "live_price": last_close(bearish_candles()),
        "dataSource": "forex_otc_test",
    }
    r2 = client.post("/api/v1/predict", json=bear_payload)
    print(f"bearish GBP/USD -> HTTP {r2.status_code}")
    if r2.status_code != 200:
        print(f"   ERROR BODY: {str(r2.json())[:400]}")
    d2 = r2.json()
    print(f"   signal={d2.get('signal')} conf={d2.get('confidence')} "
          f"alert={d2.get('high_confidence_alert')} reason={d2.get('waiting_reason')} "
          f"gated={d2.get('diagnostics', {}).get('gated_direction')}")

    if r1.status_code != 200:
        failures.append(f"Bullish predict failed: {r1.status_code} {str(d1)[:200]}")
    else:
        # v10: this tape is FULLY CONVERGED (all three pillars live — the
        # microstructure queue uses the real tick-position proxy when the API
        # call carries no order book) so it ORGANICALLY CLEARS 98% and
        # dispatches BUY, ending the old permanent "no-book => always HOLD".
        diag1 = d1.get("diagnostics", {})
        if d1.get("signal") != "BUY":
            failures.append(
                f"bullish: signal={d1.get('signal')}, expected BUY (fully-converged "
                f"tape must clear the {DEFINITIVE_CONFIDENCE_MIN}% gate)"
            )
        if float(d1.get("confidence", 0)) < DEFINITIVE_CONFIDENCE_MIN:
            failures.append(
                f"bullish confidence {d1.get('confidence')} below {DEFINITIVE_CONFIDENCE_MIN}%"
            )
        if not d1.get("high_confidence_alert"):
            failures.append("bullish dispatched BUY must fire the alert")
        if diag1.get("gated_direction") == "SELL":
            failures.append("Bullish trend gated toward SELL — arbitration inverted")
        if float(d1.get("target_price", 0) or 0) <= float(d1.get("current_price", 0) or 0):
            failures.append("Bullish BUY target must clear the current price")

    if r2.status_code != 200:
        failures.append(f"Bearish predict failed: {r2.status_code} {str(d2)[:200]}")
    else:
        diag2 = assert_gated_waiting(d2, failures, "bearish")
        if diag2.get("gated_direction") == "BUY":
            failures.append("Bearish trend gated toward BUY — arbitration inverted")

    # Mixed-direction proof: the two scenarios must gate to OPPOSITE attempts
    # (BUY vs SELL) — never both BUY.
    if r1.status_code == 200 and r2.status_code == 200:
        g1 = d1.get("diagnostics", {}).get("gated_direction")
        g2 = d2.get("diagnostics", {}).get("gated_direction")
        print(f"MIXED-DIRECTION CHECK (gated attempts): {g1} vs {g2}")
        if g1 == "BUY" and g2 == "BUY":
            failures.append("ALL-CALL BIAS: uptrend AND downtrend both gated BUY")

    # ── TEST B: MULTI-DAY HORIZONS ACCEPTED; DISPATCHED TARGETS SCALE √HORIZON ──
    # The USD/JPY uptrend is fully converged (all pillars live via the real
    # volume feed + tick-position proxy), so it dispatches BUY at EVERY horizon
    # and each target is the projected √horizon-scaled distance — never flat,
    # never a phantom hold. (An unconverged-microstructure tape — silent volume
    # — would instead pin flat: the PILLAR_INCOMPLETE rule blocks dispatch.)
    horizon_dists = []
    for tf in ("1h", "1d", "10d"):
        payload = {
            "symbol": "USD/JPY",
            "timeframe": tf,
            "candles": jpy_bullish_candles(),
            "live_price": last_close(jpy_bullish_candles()),
            "dataSource": "forex_otc_test",
        }
        rr = client.post("/api/v1/predict", json=payload)
        dd = rr.json()
        sig = dd.get("signal")
        dist = abs(dd.get("target_price", 0) - dd.get("current_price", 0))
        print(f"{tf:>4s} -> HTTP {rr.status_code} signal={sig} distance={dist:.5f} "
              f"reason={dd.get('waiting_reason')}")
        if rr.status_code != 200:
            print(f"   ERROR BODY: {str(dd)[:300]}")
            failures.append(f"Timeframe {tf} rejected: {rr.status_code} {str(dd)[:150]}")
            continue
        if sig != "BUY":
            failures.append(
                f"USD/JPY {tf} returned {sig} — fully-converged trend must dispatch "
                f"BUY at every horizon"
            )
        elif float(dd.get("confidence", 0)) < DEFINITIVE_CONFIDENCE_MIN:
            failures.append(f"USD/JPY {tf} confidence {dd.get('confidence')} below 98%")
        elif dd.get("waiting_reason") is not None:
            failures.append(f"USD/JPY {tf} dispatched but waiting_reason={dd.get('waiting_reason')}")
        if dist <= 1e-9:
            failures.append(f"USD/JPY {tf} dispatched BUY must compute a real target (flat distance {dist})")
        horizon_dists.append(dist)
    if len(horizon_dists) == 3 and not (horizon_dists[0] < horizon_dists[1] < horizon_dists[2]):
        failures.append(
            f"√horizon target scaling broken: 1h={horizon_dists[0]:.5f} "
            f"1d={horizon_dists[1]:.5f} 10d={horizon_dists[2]:.5f}"
        )

    # ── TEST C: INVALID INPUT → CLEAN ERROR, NEVER A FAKE SIGNAL ──
    bad_payload = {
        "symbol": "EUR/USD",
        "timeframe": "1h",
        "candles": bullish_candles()[:20],  # too few bars
        "live_price": 1.13,
    }
    rb = client.post("/api/v1/predict", json=bad_payload)
    db = rb.json()
    print(f"short-series -> HTTP {rb.status_code} error={str(db)[:80]}")
    if rb.status_code not in (400, 422):
        failures.append(f"Short series should be rejected 400/422, got {rb.status_code}")
    body_str = str(db)
    if '"signal": "BUY"' in body_str or '"signal":"BUY"' in body_str:
        failures.append("Error response contains a fabricated BUY signal!")

    # ── TEST D: DEFINITIVE 98% EMISSION THROUGH THE FULL API ──
    # The same fully-converged tape, forwarded WITH a live order book — the
    # mandatory microstructure pillar converges, the confluence gate fires
    # DEFINITIVE (≥98), the alert trips, and the emitted confidence equals
    # the confluence score (the ML corroborator enrichs diagnostics.ml only).
    pc, pspot, pbid, pask = scenario_perfect_confluence()
    rd = client.post("/api/v1/predict", json={
        "symbol": "EUR/USD",
        "timeframe": "1h",
        "candles": pc,
        "live_price": pspot,
        "bid": pbid,
        "ask": pask,
        "dataSource": "forex_otc_test",
    })
    dd = rd.json()
    print(f"definitive -> HTTP {rd.status_code} signal={dd.get('signal')} "
          f"conf={dd.get('confidence')} alert={dd.get('high_confidence_alert')} "
          f"gate={((dd.get('book_confluence') or {}).get('confluence') or {}).get('gate')}")
    if rd.status_code != 200:
        failures.append(f"Definitive predict failed: {rd.status_code} {str(dd)[:200]}")
    else:
        if dd.get("signal") != "BUY":
            failures.append(f"Definitive tape returned {dd.get('signal')}, expected BUY")
        if float(dd.get("confidence", 0)) < 98:
            failures.append(f"Definitive confidence {dd.get('confidence')} below the 98% gate")
        if not dd.get("high_confidence_alert"):
            failures.append("Definitive BUY through the API must fire the alert")
        if dd.get("market_waiting") or dd.get("waiting_reason"):
            failures.append("Definitive BUY must have market_waiting=False / no waiting_reason")
        if dd.get("target_price", 0) <= dd.get("current_price", 0):
            failures.append("Definitive BUY target must clear the current price")
        bc = dd.get("book_confluence", {})
        if float((bc.get("confluence") or {}).get("score", -1)) != float(dd.get("confidence", -1)):
            failures.append("Definitive confidence must equal the confluence score")
        if (bc.get("confluence") or {}).get("gate") != "DEFINITIVE":
            failures.append(f"Definitive gate={((bc.get('confluence') or {}).get('gate'))}, expected DEFINITIVE")
        ml = dd.get("diagnostics", {}).get("ml")
        if not isinstance(ml, dict) or ml.get("confidence") is None:
            failures.append("ML corroboration diagnostics.ml missing on the DEFINITIVE path")

    # ── RESULT ──
    print()
    if failures:
        print("FAILURES:")
        for f in failures:
            print("  X", f)
        sys.exit(1)
    else:
        print("ALL ENDPOINT TESTS PASSED  (mixed arbitration through the "
              "full API — fully-converged trend clears 98% + dispatches BUY "
              "via the real tick-position proxy, sub-thermal attempt gates to "
              "the opposite gated_direction, strict 98% confluence gate + "
              "CONFLUENCE_BELOW_THERMAL market-waiting, confidence == "
              "book_confluence.confluence.score, √horizon target scaling, "
              "DEFINITIVE 98% emission with ML corroboration, clean errors "
              "on bad input)")


if __name__ == "__main__":
    main()