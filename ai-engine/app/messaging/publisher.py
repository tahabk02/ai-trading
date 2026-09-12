import json
import httpx
import structlog
from typing import Dict, Any
from ..core.config import settings
import redis.asyncio as redis

logger = structlog.get_logger(__name__)

class RedisPublisher:
    """
    Hybrid publisher: Tries Redis Pub/Sub, falls back to HTTP POST if Redis is down.
    Ensures 'non-stop' signaling even in local dev environments.
    """

    def __init__(self):
        self.redis_client: redis.Redis = None
        self.http_client = httpx.AsyncClient(timeout=5.0)

    async def connect(self):
        try:
            self.redis_client = redis.from_url(
                settings.redis_connection_url,
                encoding="utf-8",
                decode_responses=True
            )
            await self.redis_client.ping()
            logger.info("Connected to Redis")
        except Exception:
            logger.warning("Redis unavailable, switching to HTTP signaling mode")
            self.redis_client = None

    async def publish_signal(self, channel: str, message: Dict[str, Any]):
        # 1. Try Redis first
        if self.redis_client:
            try:
                await self.redis_client.publish(channel, json.dumps(message))
                logger.info("Signal published via Redis")
                return
            except Exception as e:
                logger.error("Redis publish failed", error=str(e))

        # 2. Fallback to HTTP POST to Core Backend
        try:
            url = f"{settings.BACKEND_API_URL}/signals/receive"
            response = await self.http_client.post(url, json=message)
            if response.status_code == 200:
                logger.info("Signal forwarded via HTTP Fallback")
            else:
                logger.error("HTTP Fallback failed", status=response.status_code)
        except Exception as e:
            logger.error("Signal delivery failed entirely", error=str(e))

    async def close(self):
        if self.redis_client:
            await self.redis_client.close()
        await self.http_client.aclose()
