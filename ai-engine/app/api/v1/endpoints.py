from fastapi import APIRouter
from app.api.v1 import signals, health

api_router = APIRouter()
# Mounted at the api_router root so the health routes surface exactly as
# /api/v1/health{,/ai,/health} — matching the core-backend's probe URL
# (AI_ENGINE_URL + /api/v1/health).
api_router.include_router(health.router)
# Mount signals router at root so its routes become /predict and /analyze
# under the /api/v1 prefix set in main.py, matching the Node.js AI_ENGINE_URL
api_router.include_router(signals.router, tags=["signals"])
