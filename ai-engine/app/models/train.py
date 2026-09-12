import structlog
import pandas as pd
from app.data.collector import MarketDataCollector
from app.data.processor import DataProcessor
from app.models.xgboost_model import XGBoostModel
from app.models.registry import ModelRegistry

logger = structlog.get_logger(__name__)

async def train_pipeline(symbol: str):
    """
    End-to-end training pipeline for the AI Engine.
    """
    collector = MarketDataCollector()
    processor = DataProcessor()
    registry = ModelRegistry()

    try:
        # 1. Collect Data
        logger.info("Training started", symbol=symbol)
        raw_candles = await collector.fetch_historical_candles(symbol, limit=1000)
        df = pd.DataFrame(raw_candles)

        # 2. Engineer Features
        df = processor.engineer_features(df)
        
        # 3. Prepare Training Sets
        X = df.drop(columns=['target']).values
        y = df['target'].values
        
        # 4. Train XGBoost
        model = XGBoostModel()
        model.train(X, y)

        # 5. Save to Registry
        registry.save_model(
            model.model, 
            name="xgboost_classifier", 
            version="v1", 
            metadata={
                "symbol": symbol,
                "features": list(df.columns),
                "note": (
                    "Explicitly NO simulated accuracy is stored here. The old "
                    "hardcoded `accuracy: 0.82` (Simulated) is PURGED — evaluate "
                    "model quality via the real xgb eval path instead."
                ),
            }
        )
        
        logger.info("Pipeline complete", symbol=symbol)

    except Exception as e:
        logger.error("Training pipeline failed", error=str(e))
    finally:
        await collector.close()

if __name__ == "__main__":
    import asyncio
    asyncio.run(train_pipeline("BTC/USDT"))
