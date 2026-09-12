import os
import pickle
import json
import structlog
from typing import Any, Optional

logger = structlog.get_logger(__name__)

class ModelRegistry:
    """
    Central repository for trained AI models (XGBoost, LSTM).
    Manages versioning and metadata.
    """

    def __init__(self, storage_path: str = "app/models/saved_models"):
        self.storage_path = storage_path
        os.makedirs(storage_path, exist_ok=True)

    def save_model(self, model: Any, name: str, version: str, metadata: dict):
        """
        Saves a model and its associated metadata.
        """
        version_path = os.path.join(self.storage_path, version)
        os.makedirs(version_path, exist_ok=True)
        
        # Save Model
        model_file = os.path.join(version_path, f"{name}.pkl")
        with open(model_file, 'wb') as f:
            pickle.dump(model, f)
            
        # Save Metadata
        meta_file = os.path.join(version_path, "metadata.json")
        with open(meta_file, 'w') as f:
            json.dump(metadata, f, indent=2)
            
        logger.info("Model saved to registry", name=name, version=version)

    def load_model(self, version: str, name: str) -> Optional[Any]:
        """
        Loads a specific model version.
        """
        try:
            model_file = os.path.join(self.storage_path, version, f"{name}.pkl")
            with open(model_file, 'rb') as f:
                return pickle.load(f)
        except FileNotFoundError:
            logger.error("Model version not found", version=version)
            return None
