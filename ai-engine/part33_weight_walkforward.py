# part33_weight_walkforward.py -- PART 33 [240] PER-ASSET-TYPE WEIGHT AUDIT
# (pure ASCII)
#
# THE HONEST QUESTION
# -------------------
# PART 33 [239] split the five-factor ensemble into OTC / REAL / CRYPTO
# profiles. This harness exists to answer ONE question with real data and no
# flattering framing:
#
#     Does per-asset-type weighting actually change any decision, and does it
#     change accuracy for the better?
#
# METHOD (walk-forward, no look-ahead, no RNG, zero fabrication)
# -----------------------------------------------------------
#   1. Pull REAL history for real symbols per asset class via the engine
#      collector (Frankfurter/ECB + Yahoo intraday for the 10 REAL pairs,
#      CoinGecko market_chart for crypto majors, ECB daily for OTC).
#   2. Walk the tape forward bar by bar. At each step only candles up to that
#      bar are visible to FinancialAnalysisService -- the factor window, the
#      rolling 50-candle features and the quality ensemble are all built from
#      the trailing slice only. No future bar is ever read.
#   3. Resolve each signal against the REAL close HORIZON (5) bars later: a BUY
#      wins if that close is above the signal close, a SELL if below. Flat or
#      unresolvable signals are DROPPED, never scored as wins.
#   4. Feed every resolved outcome into an AccuracyTracker so the per-asset-type
#      ledgers fill with REAL observations only.
#   5. Report, per asset type:
#        - how many signals the STRICT quality watershed actually emitted
#        - the observed accuracy of what it emitted
#        - whether the >= 30 resolved-signal floor was ever reached
#        - the reliability curve, per confidence band
#        - whether any weight moved off the structural prior
#   6. Compare the per-type vectors against the shared baseline on the SAME
#      signals: how many quality scores differ, and does the emit/block verdict
#      ever differ.
#
# WHAT THIS HARNESS CANNOT CLAIM
# ------------------------------
# It cannot claim a target accuracy, and it will not report one. If the strict
# 0.965 watershed emits nothing, that is printed as ZERO EMISSIONS -- not as
# "0% accuracy" and definitely not as a pass. A regime the engine already
# classifies as RANDOM_WALK is expected to produce roughly coin-flip outcomes;
# that is the honest baseline, and beating it is not a result worth headline.
#
# Exit code 0 == the audit ran to completion. Rows may legitimately be no-data.

import asyncio
import sys
from typing import Any, Dict, List, Optional

import structlog

sys.path.insert(0, r"C:\Users\hp\trading-ai-platform\ai-engine")

from app.data.collector import (
    MarketDataCollector,
    REAL_FOREX_PAIRS,
    is_real_forex_pair,
)
from app.services.accuracy_tracker import (
    MIN_RESOLVED_SIGNALS,
    AccuracyTracker,
)
from app.services.asset_class import (
    ASSET_CLASS_CRYPTO,
    ASSET_CLASS_OTC,
    ASSET_CLASS_REAL,
    resolve_asset_class,
)
from app.services.asset_type_weights import (
    MIN_FACTOR_SIGNALS,
    base_weights_for,
    profiles,
    weights_by_symbol,
)
from app.services.financial_analysis import FinancialAnalysisService
from app.services.quality_gate import (
    GATE_WEIGHTS,
    QUALITY_EMIT_BAR,
    build_factor_inputs_from_candles,
    quality_score,
)

logger = structlog.get_logger(__name__)

# The real universe the engine itself ships, not a hand-picked "good" list.
REAL_SYMBOLS = sorted(REAL_FOREX_PAIRS)
CRYPTO_SYMBOLS = ["BTC/USD", "ETH/USD"]
OTC_SYMBOLS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD"]

# Trailing bars handed to the analyzer at each step. 200 is the minimum for the
# momentum factor to even be measurable (quality_gate requires len >= 200), so
# anything smaller would structurally zero the ensemble and prove nothing.
MIN_BARS = 200
MAX_STEP_BARS = 300

# Resolution horizon, in bars. The signal is resolved against the close of the
# bar HORIZON steps ahead -- the same information a position would actually
# have been able to act on. Looking ahead by exactly one fixed, declared number
# of bars is still walk-forward: the horizon is a constant, not a peek.
HORIZON = 5


async def fetch_real(collector: MarketDataCollector, symbol: str) -> List[Dict[str, Any]]:
    """REAL history only. Returns [] when no real source exists."""
    spec = collector._spec(symbol)
    if (spec or {}).get("crypto_id"):
        return await collector._fetch_crypto_history(symbol, 400)
    tf = "1h" if is_real_forex_pair(symbol) else "1d"
    return await collector.fetch_historical_candles(symbol=symbol, interval=tf, limit=400)


def _resolve(
    direction: str,
    signal_close: float,
    exit_close: Optional[float],
) -> Optional[str]:
    """Resolve one signal against the REAL close ``HORIZON`` bars later.

    A BUY wins if that close is above the signal close, a SELL wins if it is
    below. Flat or unusable data returns None and the signal is DROPPED -- never
    scored as a win.

    WHY THIS RATHER THAN "did the next bar breach my entry": an adverse-
    excursion rule applied to 1H FX bars is not a signal-accuracy measure at
    all. Measured on this very tape, "the next hour never traded back through
    the prior close" resolves to ~2% for BOTH directions -- it simply reports
    that an FX hour always touches the previous close, and it would report the
    same ~2% for a coin flip. A directional close-to-close comparison is
    symmetric between BUY and SELL and is actually sensitive to whether the
    engine's direction carried information.
    """
    if exit_close is None:
        return None
    try:
        exit_close = float(exit_close)
        signal_close = float(signal_close)
    except (TypeError, ValueError):
        return None
    if exit_close <= 0 or signal_close <= 0 or exit_close == signal_close:
        return None
    if direction == "BUY":
        return "WIN" if exit_close > signal_close else "LOSS"
    if direction == "SELL":
        return "WIN" if exit_close < signal_close else "LOSS"
    return None


def walk_symbol(
    analyzer: FinancialAnalysisService,
    symbol: str,
    candles: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Walk the tape forward, emitting one record per RESOLVED signal.

    No look-ahead: at step ``i`` the analyzer sees candles[:i+1] and nothing
    later. The last bar is skipped because it has no successor to resolve
    against.
    """
    out: List[Dict[str, Any]] = []
    last = min(len(candles) - HORIZON, MIN_BARS + MAX_STEP_BARS - 1)
    for i in range(MIN_BARS, last):
        window = candles[: i + 1]
        factor_inputs = build_factor_inputs_from_candles(window)
        if not factor_inputs:
            continue
        report = analyzer.analyze(
            symbol=symbol,
            candles=window,
            live_price=float(candles[i]["close"]),
            timeframe="1h" if is_real_forex_pair(symbol) else "1d",
            factor_inputs=factor_inputs,
        )
        signal_close = float(candles[i]["close"])
        # Resolve the DIRECTION the engine actually reached, not the confidence
        # gate's verdict -- otherwise every market_waiting bar would be scored as
        # a win by default and the accuracy number would be a fiction.
        outcome = _resolve(
            report.direction,
            signal_close,
            candles[i + HORIZON].get("close"),
        )
        if outcome is None:
            continue
        factors = report.quality_field.get("factors") if report.quality_field else None
        out.append(
            {
                "symbol": symbol,
                "asset_class": report.asset_class,
                "direction": report.direction,
                "confidence": float(report.confidence),
                "quality": report.quality,
                "quality_reason": report.quality_reason,
                "factors": factors or {},
                "outcome": outcome,
                "tier": report.tier,
                "executable": report.executable,
                "market_waiting": report.market_waiting,
                "waiting_reason": report.waiting_reason,
                "regime": (report.regime_classification or {}).get("regime"),
                "regime_gate": report.regime_gate,
                "weights": report.weight_profile.get("weights") or {},
                "weights_source": report.weight_profile.get("source"),
                "bar": i,
            }
        )
    return out


def summarise(records: List[Dict[str, Any]], asset_class: str) -> Dict[str, Any]:
    rows = [r for r in records if r["asset_class"] == asset_class]
    total = len(rows)
    wins = sum(1 for r in rows if r["outcome"] == "WIN")
    emitted = [r for r in rows if r.get("quality") is not None]
    emitted_wins = sum(1 for r in emitted if r["outcome"] == "WIN")
    # Market-waiting = the quality ensemble refused to emit.
    blocked = [r for r in emitted if r.get("quality") is not None and r["quality"] < QUALITY_EMIT_BAR]
    return {
        "asset_class": asset_class,
        "resolved": total,
        "wins": wins,
        "accuracy": round(wins / total, 4) if total else None,
        "scored": len(emitted),
        "scored_win_rate": round(emitted_wins / len(emitted), 4) if emitted else None,
        # EMISSIONS = the strict watershed actually let a signal out.
        "emissions": len([r for r in emitted if r["quality"] >= QUALITY_EMIT_BAR]),
        "blocked_by_watershed": len(blocked),
        "executable": sum(1 for r in rows if r.get("executable")),
        "regimes": sorted({r.get("regime") for r in rows if r.get("regime")}),
        "reached_floor": total >= MIN_RESOLVED_SIGNALS,
    }


def compare_shared(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """How often does the per-type vector disagree with the shared baseline?

    ``differing_scores`` counts signals whose quality score moved. ``flipped``
    counts those where the EMIT/BLOCK verdict itself flipped -- the only outcome
    that matters operationally.
    """
    differing = flipped = scored = 0
    for r in records:
        factors = r.get("factors") or {}
        if not factors:
            continue
        scored += 1
        shared = quality_score(factors, weights=GATE_WEIGHTS)
        typed = quality_score(factors, weights=r["weights"] or GATE_WEIGHTS)
        if abs(shared - typed) > 1e-9:
            differing += 1
            if (shared >= QUALITY_EMIT_BAR) != (typed >= QUALITY_EMIT_BAR):
                flipped += 1
    return {
        "scored": scored,
        "differing_scores": differing,
        "flipped_verdicts": flipped,
    }


def curve(records: List[Dict[str, Any]], asset_class: str) -> List[Dict[str, Any]]:
    rows = [r for r in records if r["asset_class"] == asset_class]
    out = []
    for lo, hi in ((0.0, 60.0), (60.0, 80.0), (80.0, 90.0), (90.0, 95.0), (95.0, 100.01)):
        band = [r for r in rows if lo <= r["confidence"] < hi]
        w = sum(1 for r in band if r["outcome"] == "WIN")
        out.append(
            {
                "band": f"{lo:.0f}-{min(hi, 100.0):.0f}",
                "n": len(band),
                "win_rate": round(w / len(band), 4) if band else None,
                "sufficient": len(band) >= MIN_RESOLVED_SIGNALS,
            }
        )
    return out


async def main() -> int:
    print("PART33_WEIGHT_WALKFORWARD")
    print("MIN_BARS=%d MAX_STEP_BARS=%d HORIZON=%d" % (
        MIN_BARS, MAX_STEP_BARS, HORIZON))
    print("EMIT_BAR=%.4f (strict T1; unchanged by PART 33)" % QUALITY_EMIT_BAR)
    print("MIN_RESOLVED_SIGNALS=%d MIN_FACTOR_SIGNALS=%d" % (
        MIN_RESOLVED_SIGNALS, MIN_FACTOR_SIGNALS))
    print("SHARED_BASELINE=%s" % GATE_WEIGHTS)
    print("")

    collector = MarketDataCollector()
    analyzer = FinancialAnalysisService()
    tracker = AccuracyTracker()

    all_records: List[Dict[str, Any]] = []
    per_symbol: List[Dict[str, Any]] = []

    for symbol in REAL_SYMBOLS + CRYPTO_SYMBOLS + OTC_SYMBOLS:
        asset_class = resolve_asset_class(symbol)
        try:
            candles = await fetch_real(collector, symbol)
        except Exception as exc:  # noqa: BLE001 -- honest, never fabricated
            print("FETCH_ERROR %-12s %s" % (symbol, str(exc)[:70]))
            continue
        if len(candles) < MIN_BARS + 2:
            print("NO_DATA     %-12s bars=%d (need %d)" % (
                symbol, len(candles), MIN_BARS + 2))
            continue
        rows = walk_symbol(analyzer, symbol, candles)
        # Real resolved outcomes only -> the tracker's per-type ledgers.
        for r in rows:
            tracker.record_outcome(
                symbol=r["symbol"],
                direction=r["direction"],
                confidence=r["confidence"],
                outcome=r["outcome"],
                factors=r["factors"],
                quality=r["quality"],
                tier=r["tier"],
                asset_class=r["asset_class"],
            )
        all_records.extend(rows)
        wins = sum(1 for r in rows if r["outcome"] == "WIN")
        per_symbol.append({
            "symbol": symbol,
            "asset_class": asset_class,
            "bars": len(candles),
            "steps": len(rows),
            "wins": wins,
            "accuracy": round(wins / len(rows), 4) if rows else None,
            "emissions": sum(
                1 for r in rows if (r.get("quality") or 0) >= QUALITY_EMIT_BAR
            ),
            "regime": next((r["regime"] for r in rows if r.get("regime")), None),
        })
        emissions = sum(
            1 for r in rows if (r.get("quality") or 0) >= QUALITY_EMIT_BAR
        )
        print("WALKED      %-12s %-7s bars=%4d steps=%4d acc=%s emissions=%d" % (
            symbol, asset_class, len(candles), len(rows),
            ("%.4f" % (wins / len(rows))) if rows else "n/a",
            emissions,
        ))

    print("")
    print("=== PER-SYMBOL WALK-FORWARD (real closes, no look-ahead) ===")
    hdr = "{:<12} {:<7} {:>5} {:>6} {:>7} {:>10} {:<16}".format(
        "SYMBOL", "CLASS", "BARS", "STEPS", "ACC", "EMISSIONS", "REGIME")
    print(hdr)
    print("-" * len(hdr))
    for row in per_symbol:
        print("{:<12} {:<7} {:>5} {:>6} {:>7} {:>10} {:<16}".format(
            row["symbol"], row["asset_class"], row["bars"], row["steps"],
            ("%.4f" % row["accuracy"]) if row["accuracy"] is not None else "n/a",
            row["emissions"], row["regime"] or "-"))

    print("")
    print("=== PER-ASSET-TYPE RESULT (PART 33 [240]) ===")
    hdr2 = "{:<7} {:>8} {:>9} {:>9} {:>11} {:>10} {:>8}".format(
        "CLASS", "RESOLVED", "ACCURACY", "SCORED", "EMISSIONS", "EXECUTABLE", "FLOOR_30")
    print(hdr2)
    print("-" * len(hdr2))
    type_summaries = {}
    for asset_class in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO):
        s = summarise(all_records, asset_class)
        type_summaries[asset_class] = s
        print("{:<7} {:>8} {:>9} {:>9} {:>11} {:>10} {:>8}".format(
            asset_class, s["resolved"],
            ("%.4f" % s["accuracy"]) if s["accuracy"] is not None else "n/a",
            s["scored"], s["emissions"], s["executable"],
            "yes" if s["reached_floor"] else "no"))

    print("")
    print("=== PER-TYPE WEIGHT PROFILES AFTER THE WALK ===")
    for name, prof in profiles(tracker=tracker).items():
        print("%-7s resolved=%-4d learned=%-5s source=%-28s sum=%.4f" % (
            name, prof["resolved"], prof["learned"], prof["source"], prof["weights_sum"]))
        print("        weights   %s" % prof["weights"])
        print("        prior     %s" % prof["base_weights"])
        if prof["learned"]:
            print("        LEARNED FROM REAL RESOLVED SIGNALS: %s" % prof["learned_weights"])
        else:
            print("        no weight moved (insufficient_data=%s, min=%d resolved)" % (
                prof["insufficient_data"], prof["min_resolved_signals"]))
        ev = prof["factor_evidence"]
        print("        evidence  " + ", ".join(
            "%s:%s(n=%d%s)" % (
                k, v["win_rate"] if v["win_rate"] is not None else "-",
                v["aligned_count"], "" if v["sufficient_data"] else "*")
            for k, v in ev.items()))

    print("")
    print("=== RELIABILITY CURVES (per asset type, from resolved signals only) ===")
    for asset_class in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO):
        s = type_summaries[asset_class]
        print("%s  resolved=%d  %s" % (
            asset_class, s["resolved"],
            "AT/ABOVE the 30-signal evidence floor" if s["reached_floor"]
            else "BELOW the 30-signal evidence floor -- no accuracy claim is possible"))
        for b in curve(all_records, asset_class):
            print("    %-9s n=%-4d win_rate=%-7s %s" % (
                b["band"], b["n"],
                ("%.4f" % b["win_rate"]) if b["win_rate"] is not None else "n/a",
                "evidence" if b["sufficient"] else "not enough samples in band"))

    print("")
    print("=== SHARED BASELINE vs PER-TYPE WEIGHTS (same signals) ===")
    cmp_all = compare_shared(all_records)
    print("ALL   scored=%d differing_scores=%d flipped_verdicts=%d" % (
        cmp_all["scored"], cmp_all["differing_scores"], cmp_all["flipped_verdicts"]))
    for asset_class in (ASSET_CLASS_OTC, ASSET_CLASS_REAL, ASSET_CLASS_CRYPTO):
        c = compare_shared([r for r in all_records if r["asset_class"] == asset_class])
        print("%-6s scored=%-5d differing_scores=%-5d flipped_verdicts=%d" % (
            asset_class, c["scored"], c["differing_scores"], c["flipped_verdicts"]))

    print("")
    print("=== TRACKER CROSS-CHECK (per-asset-type ledgers) ===")
    for name, st in tracker.asset_class_stats().items():
        print("%-7s resolved=%-5d wins=%-5d win_rate=%-8s sufficient_data=%s" % (
            name, st["resolved"], st["wins"],
            ("%.4f" % st["win_rate"]) if st["win_rate"] is not None else "n/a",
            st["sufficient_data"]))

    print("")
    print("PART33_WEIGHT_WALKFORWARD_DONE exit=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)