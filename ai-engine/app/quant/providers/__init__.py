from app.quant.providers.base import ConfluenceProvider
from app.quant.providers.macro import MacroProvider
from app.quant.providers.ml import MLProvider
from app.quant.providers.registry import ProviderRegistry
from app.quant.providers.sentiment import SentimentProvider
from app.quant.providers.technical import TechnicalProvider


def default_registry() -> ProviderRegistry:
    return ProviderRegistry(
        [
            TechnicalProvider(),
            MLProvider(),
            SentimentProvider(),
            MacroProvider(),
        ]
    )


__all__ = [
    "ConfluenceProvider",
    "MacroProvider",
    "MLProvider",
    "ProviderRegistry",
    "SentimentProvider",
    "TechnicalProvider",
    "default_registry",
]
