"""Confluence API: independent provider evidence, no synthesized signals."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_api_key
from app.core.config import settings
from app.quant.contracts import (
    ConfluenceRequest,
    ConfluenceResponse,
    ProviderDescriptor,
)
from app.quant.pipeline import ConfluencePipeline
from app.quant.providers import default_registry

router = APIRouter()

_pipeline = ConfluencePipeline(
    default_registry(),
    provider_timeout_seconds=settings.QUANT_PROVIDER_TIMEOUT_SECONDS,
)


@router.post(
    "/quant/confluence",
    response_model=ConfluenceResponse,
    dependencies=[Depends(get_api_key)],
)
async def evaluate_confluence(request: ConfluenceRequest) -> ConfluenceResponse:
    return await _pipeline.evaluate(request)


@router.get(
    "/quant/providers",
    response_model=list[ProviderDescriptor],
    dependencies=[Depends(get_api_key)],
)
async def list_confluence_providers() -> list[ProviderDescriptor]:
    return _pipeline.registry.descriptors()


async def close_quant_pipeline() -> None:
    await _pipeline.close()
