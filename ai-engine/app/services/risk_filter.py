import time
from dataclasses import dataclass
from typing import Dict, Any, Optional

import pandas as pd
import numpy as np
import structlog

logger = structlog.get_logger(__name__)


@dataclass
class FreezeState:
    """In-memory freeze state for the 2-hour macro/news barrier."""

    until_ts: float = 0.0

    def is_frozen(self, now_ts: Optional[float] = None) -> bool:
        now = time.time() if now_ts is None else now_ts
        return now < self.until_ts


class RiskFilter:
    """Macro Volatility & News Barrier.

    Rule (1H candles):
    - Compute ATR(14) from caller (must be present in dataframe as `atr`).
    - Compute candle range = high - low.
    - If (high-low) > 2.5 * ATR => flag high-risk anomaly.
    - If anomaly triggered at time t_last, freeze signal emission for next 2 hours.

    Temporal state persistence:
    - In-memory FreezeState for fast checks during runtime ticks.
    - This is intentionally simple per requirement; in multi-instance deployments
      you should swap to Redis key-based coordination.
    """

    ATR_SPIKE_MULTIPLIER: float = 2.5
    FREEZE_HOURS: int = 2

    def __init__(self) -> None:
        self._freeze_state = FreezeState(until_ts=0.0)

    def check_and_update_freeze(self, df: pd.DataFrame) -> Dict[str, Any]:
        """Checks latest candle against ATR spike rule and updates freeze state.

        Expected df columns:
        - high, low, atr
        The caller should ensure df already has ATR(14) computed.
        """
        required = {"high", "low", "atr"}
        missing = required - set(df.columns)
        if missing:
            raise ValueError(f"Missing required columns in RiskFilter: {sorted(missing)}")
        if df.empty:
            return {"frozen": False, "reason": "NO_DATA"}

        out = df
        high = out["high"].astype(float)
        low = out["low"].astype(float)
        atr = out["atr"].astype(float)

        # Candle range (vectorized, then take last)
        candle_range = (high - low)
        last_range = float(candle_range.iloc[-1])
        last_atr = float(atr.iloc[-1])

        # If ATR is not ready yet, do not freeze.
        if not np.isfinite(last_atr) or last_atr <= 0:
            frozen = self._freeze_state.is_frozen()
            return {
                "frozen": frozen,
                "reason": "ATR_NOT_READY",
                "last_atr": last_atr,
                "last_range": last_range,
            }

        threshold = self.ATR_SPIKE_MULTIPLIER * last_atr
        is_anomaly = last_range > threshold

        now_ts = time.time()
        if is_anomaly:
            self._freeze_state.until_ts = now_ts + (self.FREEZE_HOURS * 3600)
            logger.info(
                "ATR spike anomaly detected; freezing signals",
                last_range=last_range,
                last_atr=last_atr,
                threshold=threshold,
                freeze_until=self._freeze_state.until_ts,
            )

        frozen_now = self._freeze_state.is_frozen(now_ts)
        return {
            "frozen": frozen_now,
            "reason": "ANOMALY_FREEZE" if frozen_now else "OK",
            "last_range": last_range,
            "last_atr": last_atr,
            "threshold": threshold,
            "freeze_until_ts": self._freeze_state.until_ts,
        }

    def is_frozen(self) -> bool:
        """Fast-path check used by SignalGenerator without recomputation."""
        return self._freeze_state.is_frozen()

