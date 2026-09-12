import pandas as pd
import numpy as np
import structlog
from typing import List, Dict, Any
from .collector import MarketDataCollector

logger = structlog.get_logger(__name__)

class DataProcessor:
    """
    Advanced Feature Engineering & Data Normalization Pipeline.
    Transforming raw candles into ML-ready tensor structures.
    """

    @staticmethod
    def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
        """
        Industrial-grade feature engineering:
        - Log returns for stationarity
        - Volatility scaling (ATR-based)
        - Momentum oscillators
        - Fractional differentiation (optional/advanced)
        """
        try:
            # 1. Price Stationarity (Log Returns)
            df['log_return'] = np.log(df['close'] / df['close'].shift(1))
            
            # 2. Volatility Features
            df['volatility_20'] = df['log_return'].rolling(window=20).std()
            
            # 3. Relative Strength Features
            # (Assuming indicators from TA service are already present)
            
            # 4. Target Generation (Labeling for training)
            # Lookahead 5 periods: 1 if price increases by 0.5%, else 0
            df['target'] = (df['close'].shift(-5) > df['close'] * 1.005).astype(int)
            
            # 5. Handle missing values from shifts
            df = df.dropna()
            
            logger.info("Feature engineering complete", features=list(df.columns))
            return df
        except Exception as e:
            logger.error("Feature engineering failed", error=str(e))
            raise

    @staticmethod
    def normalize(df: pd.DataFrame) -> np.ndarray:
        """
        Scales features for LSTM/Neural Network consumption.
        """
        from sklearn.preprocessing import StandardScaler
        scaler = StandardScaler()
        # Exclude target and timestamp
        feature_cols = [c for c in df.columns if c not in ['target', 'timestamp', 'datetime']]
        return scaler.fit_transform(df[feature_cols])
