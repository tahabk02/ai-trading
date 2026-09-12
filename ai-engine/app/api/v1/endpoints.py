from fastapi import APIRouter
from app.api.v1 import signals, health

api_router = APIRouter()
api_router.include_router(health.router, prefix="/health", tags=["health"])
# Mount signals router at root so its routes become /predict and /analyze
# under the /api/v1 prefix set in main.py, matching the Node.js AI_ENGINE_URL
api_router.include_router(signals.router, tags=["signals"])
