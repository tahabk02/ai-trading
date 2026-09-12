"""
fundamental_analysis.py — REAL FUNDAMENTAL DATA SERVICE (LIVE API TIER)

ZERO STUBS. ZERO NEUTRAL PLACEHOLDERS.

Fetches genuine fundamental metrics from free, keyless public APIs:

  • Crypto assets (BTC/USD, ETH/USD ...):
      CoinGecko /coins/{id} — real market cap, circulating/total supply,
      ATH distance, 24h volume, community sentiment votes.
  • Fiat FX pairs (EUR/USD ...):
      ECB reference-rate context via Frankfurter.dev — real 30-day rate
      momentum and realised volatility of the pair (macro trend context).

Every returned metric is a REAL observed value from a live source. When no
source can answer for a symbol, an EMPTY dict is returned (never neutral
fabrications) and callers treat "no fundamentals" as an explicit state.
"""

import asyncio
import structlog
from typing import Any, Dict

import httpx

logger = structlog.get_logger(__name__)

_HTTP_TIMEOUT_S = 8.0

# CoinGecko asset ids for crypto bases (mirrors core-backend mapping).
_COINGECKO_IDS: Dict[str, str] = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
}

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
            symbol: Trading pair (e.g. "BTC/USD", "EUR/USD").

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

        # ── Tier 1: crypto majors via CoinGecko ──
        coin_id = _COINGECKO_IDS.get(base)
        if coin_id and quote in ("USD", "USDT", "USDC"):
            try:
                async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
                    resp = await client.get(
                        f"https://api.coingecko.com/api/v3/coins/{coin_id}",
                        params={
                            "localization": "false",
                            "tickers": "false",
                            "community_data": "true",
                            "developer_data": "false",
                        },
                    )
                    resp.raise_for_status()
                    data = resp.json()

                md = data.get("market_data") or {}
                mcap = md.get("market_cap", {}).get("usd")
                vol24 = md.get("total_volume", {}).get("usd")
                supply = md.get("circulating_supply")
                total_supply = md.get("total_supply")
                ath = md.get("ath", {}).get("usd")
                price_now = md.get("current_price", {}).get("usd")

                result: Dict[str, Any] = {"asset_class": "crypto"}
                if isinstance(mcap, (int, float)) and mcap > 0:
                    result["market_cap"] = float(mcap)
                if isinstance(vol24, (int, float)) and vol24 > 0:
                    result["volume_24h"] = float(vol24)
                if isinstance(supply, (int, float)) and supply > 0:
                    result["circulating_supply"] = float(supply)
                if (
                    isinstance(total_supply, (int, float)) and total_supply > 0
                ):
                    result["supply_ratio"] = round(float(supply) / float(total_supply), 6)
                if (
                    isinstance(ath, (int, float)) and ath > 0
                    and isinstance(price_now, (int, float)) and price_now > 0
                ):
                    result["ath_distance_pct"] = round(
                        ((float(ath) - float(price_now)) / float(ath)) * 100.0, 4
                    )

                cd = data.get("community_data") or {}
                up = cd.get("sentiment_votes_up_percentage")
                if isinstance(up, (int, float)):
                    result["community_sentiment"] = round(float(up) / 100.0, 4)

                if result.get("market_cap"):
                    logger.info(
                        "Live crypto fundamentals fetched",
                        symbol=symbol,
                        market_cap=result["market_cap"],
                    )
                    return result
                logger.debug(
                    "CoinGecko responded without usable market data",
                    symbol=symbol,
                )
                return {}
            except Exception as exc:  # noqa: BLE001 — network tier, non-fatal
                logger.debug(
                    "Crypto fundamentals tier failed",
                    symbol=symbol,
                    error=str(exc),
                )

        # ── Tier 2: fiat pairs via Frankfurter (ECB macro context) ──
        if base in _ECB_CURRENCIES and quote in _ECB_CURRENCIES:
            try:
                end_date = __import__("datetime").date.today()
                start_date = end_date - __import__("datetime").timedelta(days=45)
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
          • crypto: community sentiment votes, distance from all-time high
          • fx:     realised 30-day macro momentum direction/strength
        Returns 0.5 (neutral) ONLY when no real data was supplied — callers
        pass an empty dict explicitly when no source answered.
        """
        if not fundamentals:
            return 0.5

        scores: list[float] = []

        asset_class = fundamentals.get("asset_class")

        if asset_class == "crypto":
            # Real CoinGecko community vote share (0..1)
            sent = fundamentals.get("community_sentiment")
            if isinstance(sent, (int, float)) and 0.0 <= sent <= 1.0:
                scores.append(float(sent))

            # Distance below ATH — closer to ATH ⇒ stronger structure.
            ath_dist = fundamentals.get("ath_distance_pct")
            if isinstance(ath_dist, (int, float)) and 0.0 <= ath_dist <= 100.0:
                # 0% below ATH → 1.0; ≥50% below → ~0.0
                scores.append(max(0.0, min(1.0, 1.0 - float(ath_dist) / 50.0)))

        elif asset_class == "fx":
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

