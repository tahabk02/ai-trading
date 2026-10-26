"""
fundamental_analysis.py — REAL FUNDAMENTAL DATA SERVICE (LIVE API TIER)

ZERO STUBS. ZERO NEUTRAL PLACEHOLDERS.

Fetches genuine fundamental metrics from free, keyless public APIs:

  • Fiat FX pairs (EUR/USD ...):
      ECB reference-rate context via Frankfurter.dev — real 30-day rate
      momentum and realised volatility of the pair (macro trend context).

Every returned metric is a REAL observed value from a live source. When no
source can answer for a symbol, an EMPTY dict is returned (never neutral
fabrications) and callers treat "no fundamentals" as an explicit state.
"""

import asyncio
import structlog
from datetime import date, timedelta
from typing import Any, Dict

import httpx

logger = structlog.get_logger(__name__)

_HTTP_TIMEOUT_S = 8.0

# Currencies covered by the ECB/Frankfurter reference set.
_ECB_CURRENCIES = {
    "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
    "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR",
    "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD",
    "ZAR",
}


def _split_pair(symbol: str):
    """Split 'BASE/QUOTE' → (base, quote); returns (None, None) on failure."""
    parts = (symbol or "").strip().upper().split("/")
    if len(parts) == 2 and all(parts):
        return parts[0], parts[1]
    return None, None


class FundamentalAnalysisService:
    """Live fundamental/macro context service backed by REAL public APIs."""

    @staticmethod
    async def fetch_fundamentals(symbol: str) -> Dict[str, Any]:
        """Fetch REAL fundamental data for a given symbol.

        Args:
            symbol: Trading pair (e.g. "EUR/USD").

        Returns:
            Dict of live fundamental metrics; EMPTY dict when no real source
            answers (callers must treat absence explicitly — never invent).
        """
        logger.info("Fundamental analysis requested", symbol=symbol)

        base, quote = _split_pair(symbol)
        if not base or not quote:
            logger.debug(
                "Unparseable symbol for fundamentals", symbol=symbol
            )
            return {}

        # ── Fiat pairs via Frankfurter (ECB macro context) ──
        if base in _ECB_CURRENCIES and quote in _ECB_CURRENCIES:
            try:
                end_date = date.today()
                start_date = end_date - timedelta(days=45)
                async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
                    resp = await client.get(
                        f"https://api.frankfurter.dev/v1/"
                        f"{start_date.isoformat()}..{end_date.isoformat()}",
                        params={"from": base, "to": quote},
                    )
                    resp.raise_for_status()
                    rates = (resp.json() or {}).get("rates") or {}

                dates = sorted(rates.keys())
                closes = [float(rates[d][quote]) for d in dates if rates.get(d)]
                if len(closes) >= 10:
                    import math

                    log_ret = [
                        math.log(closes[i] / closes[i - 1])
                        for i in range(1, len(closes))
                    ]
                    mean_r = sum(log_ret) / len(log_ret)
                    var_r = sum((r - mean_r) ** 2 for r in log_ret) / max(len(log_ret) - 1, 1)
                    realized_vol_daily = math.sqrt(var_r)
                    momentum_30d = (closes[-1] / closes[max(0, len(closes) - 22)] - 1.0)

                    result_fx: Dict[str, Any] = {
                        "asset_class": "fx",
                        "observations": len(closes),
                        "momentum_30d_pct": round(momentum_30d * 100.0, 4),
                        "realized_vol_daily_pct": round(realized_vol_daily * 100.0, 4),
                        "trend_direction": (
                            "UP" if momentum_30d > 0 else ("DOWN" if momentum_30d < 0 else "FLAT")
                        ),
                    }
                    logger.info(
                        "Live FX macro fundamentals fetched",
                        symbol=symbol,
                        observations=len(closes),
                        momentum_30d_pct=result_fx["momentum_30d_pct"],
                    )
                    return result_fx
                logger.debug(
                    "Frankfurter returned insufficient observations",
                    symbol=symbol,
                    count=len(closes),
                )
                return {}
            except Exception as exc:  # noqa: BLE001 — network tier, non-fatal
                logger.debug(
                    "FX fundamentals tier failed",
                    symbol=symbol,
                    error=str(exc),
                )

        logger.debug(
            "No fundamental source covers this symbol", symbol=symbol
        )
        return {}

    @staticmethod
    def compute_sentiment_score(fundamentals: Dict[str, Any]) -> float:
        """Compute a normalised sentiment score in [0, 1] from REAL metrics.

        Aggregates whichever live signals are present:
          • fx:     realised 30-day macro momentum direction/strength
        Returns 0.5 (neutral) ONLY when no real data was supplied — callers
        pass an empty dict explicitly when no source answered.
        """
        if not fundamentals:
            return 0.5

        scores: list[float] = []

        asset_class = fundamentals.get("asset_class")

        if asset_class == "fx":
            # Real ECB-derived 30-day momentum, ±% → mapped onto [0,1].
            mom = fundamentals.get("momentum_30d_pct")
            if isinstance(mom, (int, float)):
                # +2% monthly move → 1.0; −2% → 0.0 (clamped).
                scores.append(max(0.0, min(1.0, 0.5 + float(mom) / 4.0)))

        if not scores:
            return 0.5

        return sum(scores) / len(scores)

    @staticmethod
    def get_fundamental_regime(fundamentals: Dict[str, Any]) -> str:
        """Return a regime label based on fundamental data."""
        score = FundamentalAnalysisService.compute_sentiment_score(fundamentals)
        if score >= 0.7:
            return "BULLISH"
        elif score >= 0.45:
            return "NEUTRAL"
        else:
            return "BEARISH"

