import xgboost as xgb
import numpy as np
import structlog
from typing import Any

logger = structlog.get_logger(__name__)

class XGBoostModel:
    """
    XGBoost Classifier for directional price movement prediction.
    """

    def __init__(self, params: dict = None):
        self.params = params or {
            'max_depth': 6,
            'eta': 0.1,
            'objective': 'binary:logistic',
            'eval_metric': 'logloss',
            'nthread': 4
        }
        self.model = None

    def train(self, X_train: np.ndarray, y_train: np.ndarray):
        """
        Trains the XGBoost model.
        """
        logger.info("Starting XGBoost training", samples=X_train.shape[0])
        dtrain = xgb.DMatrix(X_train, label=y_train)
        self.model = xgb.train(self.params, dtrain, num_boost_round=100)
        logger.info("XGBoost training complete")

    def predict_proba(self, X: np.ndarray) -> float:
        """
        Predicts the probability of the positive class (price increase).
        """
        if self.model is None:
            raise ValueError("Model not trained or loaded")
        
        dtest = xgb.DMatrix(X)
        prob = self.model.predict(dtest)
        return float(prob[0])
