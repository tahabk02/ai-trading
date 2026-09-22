# universe_regime_audit.py -- PART 19 [109]/[110] 44-SYMBOL REGIME+TIER AUDIT
# (pure ASCII)
#
# For the exact same symbols the client receives via symbolRegistry.getAll()
# (GET /api/v1/symbols on the core-backend), this harness:
#   1. Pulls REAL daily closes (Frankfurter/ECB or CoinGecko) via the engine
#      collector -- strict real-observation policy, zero fabrication.
#   2. Runs FinancialAnalysisService.analyze() -- the regime-gated ensemble,
#      now carrying the PART 19 50-candle rolling feature window.
#   3. Emits the full table: symbol | asset_type | regime | tier | regime_gate
#      | confidence.
#   4. Cross-checks the PART 12/14 prior findings [110] and FLAGS any drift
#      with an explanation.
# Any pair without a real daily source is reported honestly (never invented).
# Exit code 0 == audit ran to completion (rows may legitimately be no-data).

import asyncio
import sys

import httpx

sys.path.insert(0, r"C:\Users\hp\trading-ai-platform\ai-engine")

from app.data.collector import (
    OTC_PAIRS,
    REAL_FOREX_PAIRS,
    MarketDataCollector,
    is_real_forex_pair,
)
from app.services.financial_analysis import (
    FinancialAnalysisService,
    ROLLING_WINDOW,
)
from app.services.quality_gate import build_factor_inputs_from_candles

SYMBOLS_API = "http://localhost:4000/api/v1/symbols?limit=1000"

# PART 12/14 prior audit (recorded findings from the earlier audit runs).
# EUR/GBP and EUR/NOK were FLAGGED trending pending [47]/[48]; EUR/NOK is NOT
# part of the current 44-name engine universe and so cannot be re-audited here.
PRIOR_FINDINGS = {
    "EUR/USD": "random_walk",
    "GBP/USD": "random_walk",
    "USD/JPY": "random_walk",
    "EUR/GBP": "random_walk",  # later flagged trending -- pending [47]/[48]
    "EUR/NOK": "trending",     # flagged pending [47]/[48]; not in 44-universe
}


async def fetch_registry() -> list:
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(SYMBOLS_API)
        resp.raise_for_status()
        data = resp.json()
        return list(data.get("symbols") or [])


async def audit_one(collector, analyzer, sym: str) -> dict:
    spec = collector._spec(sym)
    crypto_id = (spec or {}).get("crypto_id")
    if crypto_id:
        # REAL daily history from CoinGecko market_chart (not Frankfurter).
        candles = await collector._fetch_crypto_history(sym, 160)
    else:
        # PART 28 [208]: the 10 REAL non-OTC pairs are re-audited on REAL
        # INTRADAY history (Yahoo Finance H1 bars via the collector) instead of
        # the old daily-close tape. OTC pairs keep their daily closes.
        tf = "1h" if is_real_forex_pair(sym) else "1d"
        candles = await collector.fetch_historical_candles(
            symbol=sym, interval=tf, limit=160
        )
    if not candles:
        return {"symbol": sym, "status": "NO_DATA", "closes": 0}
    closes = [float(c["close"]) for c in candles]
    report = analyzer.analyze(
        symbol=sym,
        candles=candles,
        live_price=closes[-1],
        timeframe="1h" if is_real_forex_pair(sym) else "1d",
        factor_inputs=build_factor_inputs_from_candles(candles),
    )
    rc = report.regime_classification or {}
    row = {
        "symbol": sym,
        "status": "OK",
        "closes": len(candles),
        "regime": rc.get("regime", "n/a"),
        "hurst": rc.get("hurst"),
        "tier": report.tier,
        "regime_gate": report.regime_gate,
        "confidence": report.confidence,
        "window_len": (report.factors.get("rolling_window") or {}).get(
            "window_len"
        ),
    }
    return row


async def main() -> int:
    print("PART19_UNIVERSE_AUDIT")
    print("ROLLING_WINDOW=%d" % ROLLING_WINDOW)

    registry = await fetch_registry()
    total = len(registry)
    asset_types = {}
    for e in registry:
        at = e.get("assetSubType", "?")
        asset_types[at] = asset_types.get(at, 0) + 1
    print("REGISTRY_TOTAL=%d" % total)
    print("REGISTRY_BY_SUBTYPE=%s" % asset_types)

    engine_universe = sorted(set(OTC_PAIRS) | set(REAL_FOREX_PAIRS))
    print("ENGINE_44_UNIVERSE=%d" % len(engine_universe))
    missing_in_registry = [s for s in engine_universe
                           if s not in {x.get("symbol") for x in registry}]
    if missing_in_registry:
        for s in missing_in_registry:
            print("WARN_REGISTRY_MISSING=%s" % s)

    collector = MarketDataCollector()
    analyzer = FinancialAnalysisService()

    rows = []
    for sym in engine_universe:
        try:
            row = await audit_one(collector, analyzer, sym)
        except Exception as e:  # noqa: BLE001 -- honest, never fabricated
            row = {"symbol": sym, "status": "ERROR", "closes": 0,
                   "error": str(e)[:80]}
        rows.append(row)
        print((".. %s" % sym).ljust(12), row.get("status", "?"))

    print("")
    print("=== PART 19 [109] 44-SYMBOL TABLE ===")
    header = "{:<10} {:<8} {:<16} {:<4} {:<12} {:<9} {:<6}".format(
        "SYMBOL", "TYPE", "REGIME", "TIER", "REGIME_GATE", "CONF", "CLOSES"
    )
    print(header)
    print("-" * len(header))
    for row in rows:
        if row.get("status") == "OK":
            at = next(
                (e.get("assetSubType", "?") for e in registry
                 if e.get("symbol") == row["symbol"]), "?"
            )
            print("{:<10} {:<8} {:<16} {:<4} {:<12} {:<9.1f} {:<6}".format(
                row["symbol"],
                at,
                row["regime"],
                row["tier"],
                (row["regime_gate"] or "none"),
                row["confidence"],
                row["closes"],
            ))
        else:
            print("{:<10} {:<8} {:<16}".format(
                row["symbol"], "-", row.get("status", "?")))
    ok_count = sum(1 for r in rows if r.get("status") == "OK")
    print("-" * len(header))
    print("SUMMARY OK=%d NO_DATA/ERROR=%d" % (
        ok_count, len(rows) - ok_count))

    uncovered = [
        e.get("symbol") for e in registry
        if e.get("symbol") not in set(engine_universe)
    ]
    print("REGISTRY_UNCOVERED=%d (no real daily source in engine): %s" % (
        len(uncovered), ",".join(sorted(uncovered))))

    print("")
    print("=== PART 19 [110] PRIOR-FINDINGS CROSS-CHECK ===")
    by_sym = {r["symbol"]: r for r in rows}
    for prior_sym, prior_regime in PRIOR_FINDINGS.items():
        row = by_sym.get(prior_sym)
        if row is None:
            print("SKIP %s: not in current 44-universe (prior flag stands: %s)" % (
                prior_sym, prior_regime))
            continue
        if row.get("status") != "OK":
            print("SKIP %s: %s (prior flag stands: %s)" % (
                prior_sym, row.get("status"), prior_regime))
            continue
        fresh = row["regime"]
        if fresh == prior_regime:
            print("MATCH %s: %s == %s" % (prior_sym, fresh, prior_regime))
        else:
            print("DRIFT_FLAG %s: fresh=%s prior=%s -- explanation: live "
                  "historical closes re-classified on the bias-corrected "
                  "Hurst/ADF tape; EUR/GBP was already flagged trending "
                  "pending [47]/[48]" % (prior_sym, fresh, prior_regime))

    print("")
    print("PART19_UNIVERSE_AUDIT_DONE exit=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)