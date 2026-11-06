from __future__ import annotations

import asyncio
from collections.abc import Iterable

from app.quant.contracts import ProviderDescriptor
from app.quant.providers.base import ConfluenceProvider


class ProviderRegistry:
    """Ordered provider registry with duplicate-name protection."""

    def __init__(self, providers: Iterable[ConfluenceProvider] = ()) -> None:
        self._providers: list[ConfluenceProvider] = []
        self._by_name: dict[str, ConfluenceProvider] = {}
        for provider in providers:
            self.register(provider)

    def register(self, provider: ConfluenceProvider) -> None:
        if provider.name in self._by_name:
            raise ValueError(f"duplicate confluence provider: {provider.name}")
        if provider.weight <= 0:
            raise ValueError(f"provider weight must be positive: {provider.name}")
        self._providers.append(provider)
        self._by_name[provider.name] = provider

    @property
    def providers(self) -> tuple[ConfluenceProvider, ...]:
        return tuple(self._providers)

    def get(self, name: str) -> ConfluenceProvider | None:
        return self._by_name.get(name)

    def descriptors(self) -> list[ProviderDescriptor]:
        return [provider.descriptor() for provider in self._providers]

    def total_weight(self) -> float:
        return sum(provider.weight for provider in self._providers)

    async def close(self) -> None:
        """Close all providers even if one client's shutdown fails."""
        results = await asyncio.gather(
            *(provider.close() for provider in self._providers),
            return_exceptions=True,
        )
        failures = [
            result for result in results if isinstance(result, BaseException)
        ]
        if failures:
            raise RuntimeError(
                f"{len(failures)} quant provider client(s) failed to close"
            ) from failures[0]
