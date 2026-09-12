from fastapi import Depends, Header, HTTPException
from typing import Optional
from app.core.config import settings

async def get_api_key(api_key: Optional[str] = Header(None)):
    """
    Dependency to validate internal service communication via API Key.
    """
    # Simple internal security for microservices
    internal_key = "INTERNAL_SECRET_AI_ENGINE" 
    if api_key != internal_key and settings.ENVIRONMENT == "production":
        raise HTTPException(status_code=403, detail="Invalid Service API Key")
    return api_key
