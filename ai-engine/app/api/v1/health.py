from fastapi import APIRouter

router = APIRouter()

@router.get("/health")
async def health_check():
    return {"status": "ok", "service": "ai-engine", "version": "1.0.0"}
