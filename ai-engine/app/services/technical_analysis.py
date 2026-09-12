import pandas as pd
import numpy as np
import structlog
from typing import Tuple

logger = structlog.get_logger(__name__)


class TechnicalAnalysisService:
    """Production-grade, fully vectorized technical analysis service.

    Target timeframe: 1H candles (assumes caller provides 1H OHLCV rows).

    Implemented indicators:
    - ADX(14) using vectorized Wilder's smoothing.
    - ATR(14)

    Regime rule:
    - ADX < 20  -> SIDEWAYS/CHOP (No Trade)
    - ADX >= 20 -> TRENDING
    """

    ADX_PERIOD: int = 14
    ATR_PERIOD: int = 14

    @staticmethod
    def _validate_ohlc(df: pd.DataFrame) -> None:
        required = {"open", "high", "low", "close"}
        missing = required - set(df.columns)
        if missing:
            raise ValueError(f"Missing OHLC columns: {sorted(missing)}")
        if df.empty:
            raise ValueError("Empty dataframe provided")

    @staticmethod
    def _wilder_smooth(values: pd.Series, period: int) -> pd.Series:
        """Vectorized Wilder's smoothing using exponential moving average.

        Wilder's smoothing is equivalent to EMA with alpha=1/period and adjust=False.
        """
        return values.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()

    @staticmethod
    def calculate_indicators(df: pd.DataFrame) -> pd.DataFrame:
        """Compute ADX(14) and ATR(14) plus common auxiliaries.

        Expects a DataFrame with columns: open, high, low, close, (optional volume).
        Adds:
        - adx
        - atr
        - regime (TRENDING | SIDEWAYS/CHOP)

        Returns the same df instance with added columns.
        """
        TechnicalAnalysisService._validate_ohlc(df)

        # Work on a copy to prevent SettingWithCopy issues.
        out = df.copy()

        high = out["high"].astype(float)
        low = out["low"].astype(float)
        close = out["close"].astype(float)
        open_ = out["open"].astype(float)

        # True Range (vectorized)
        prev_close = close.shift(1)
        tr_components = pd.concat(
            [
                (high - low).abs().rename("tr_hl"),
                (high - prev_close).abs().rename("tr_hpc"),
                (low - prev_close).abs().rename("tr_lpc"),
            ],
            axis=1,
        )
        true_range = tr_components.max(axis=1)

        # ATR(14): Wilder smoothing of TR
        atr = TechnicalAnalysisService._wilder_smooth(true_range, TechnicalAnalysisService.ATR_PERIOD)
        out["atr"] = atr

        # ADX(14)
        # directional movement
        up_move = high.diff()
        down_move = -low.diff()

        plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
        minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

        plus_dm_s = pd.Series(plus_dm, index=out.index)
        minus_dm_s = pd.Series(minus_dm, index=out.index)

        # Wilder smoothing of DM and TR
        tr_smooth = TechnicalAnalysisService._wilder_smooth(true_range, TechnicalAnalysisService.ADX_PERIOD)
        plus_dm_smooth = TechnicalAnalysisService._wilder_smooth(plus_dm_s, TechnicalAnalysisService.ADX_PERIOD)
        minus_dm_smooth = TechnicalAnalysisService._wilder_smooth(minus_dm_s, TechnicalAnalysisService.ADX_PERIOD)

        # Avoid divide-by-zero
        eps = 1e-12
        plus_di = 100.0 * (plus_dm_smooth / (tr_smooth.replace(0.0, np.nan) + eps))
        minus_di = 100.0 * (minus_dm_smooth / (tr_smooth.replace(0.0, np.nan) + eps))

        dx = 100.0 * ((plus_di - minus_di).abs() / (plus_di + minus_di + eps))
        adx = TechnicalAnalysisService._wilder_smooth(dx, TechnicalAnalysisService.ADX_PERIOD)
        out["adx"] = adx

        # Regime from ADX (strictly using rule requested)
        out["regime"] = np.where(out["adx"] >= 20.0, "TRENDING", "SIDEWAYS/CHOP")

        # Lightweight auxiliaries that other parts may expect (non-essential)
        # RSI(14) and MACD are intentionally omitted to keep this module strictly aligned
        # with the 3-layer guardrail implementation. If other modules need them, compute
        # them in their own service.

        # Sanity logs
        try:
            last = out.iloc[-1]
            logger.info(
                "Technical indicators calculated (ADX/ATR)",
                adx_last=float(last.get("adx", np.nan)) if pd.notna(last.get("adx", np.nan)) else None,
                atr_last=float(last.get("atr", np.nan)) if pd.notna(last.get("atr", np.nan)) else None,
                regime=str(last.get("regime", "")),
                rows=len(out),
            )
        except Exception:
            logger.warning("Technical indicators calculated, but logging failed")

        return out

    @staticmethod
    def get_market_regime(adx_value: float) -> str:
        """Backward-compatible mapping (strict rule)."""
        try:
            adx_value = float(adx_value)
        except (TypeError, ValueError):
            return "SIDEWAYS/CHOP"
        return "TRENDING" if adx_value >= 20.0 else "SIDEWAYS/CHOP"


def compute_latest_adx_atr(candles: pd.DataFrame) -> Tuple[float, float]:
    """Convenience function for callers that want just the last ADX/ATR."""
    enriched = TechnicalAnalysisService.calculate_indicators(candles)
    last = enriched.iloc[-1]
    adx = float(last["adx"]) if pd.notna(last["adx"]) else float("nan")
    atr = float(last["atr"]) if pd.notna(last["atr"]) else float("nan")
    return adx, atr

