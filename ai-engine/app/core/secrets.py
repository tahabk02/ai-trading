import structlog
from app.core.config import settings

logger = structlog.get_logger(__name__)

def get_secret(key: str, default: str = None) -> str:
    """
    Retrieves secrets from environment or a secure vault.
    """
    # In production, this could integrate with HashiCorp Vault or AWS Secrets Manager
    return getattr(settings, key, default)
