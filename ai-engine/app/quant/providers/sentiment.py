"""Local, deterministic financial-text sentiment analysis.

The provider scores only source-attributed text explicitly supplied with the
request. It does not fetch, invent, cache, or infer missing articles. The
lexicon is a transparent offline analyzer, not a FinGPT transformer model.
"""

from __future__ import annotations

import asyncio
import re
from app.quant.contracts import (
    SCHEMA_VERSION,
    ConfluenceRequest,
    Direction,
    ProviderResult,
    ProviderStatus,
    SentimentAssessment,
    SentimentEvidence,
    SentimentTextInput,
)
from app.quant.providers.base import ConfluenceProvider, feature_freshness_error

_TOKEN_RE = re.compile(r"[a-z]+")
_LEXICON: dict[str, float] = {
    "accelerate": 0.6,
    "beat": 0.8,
    "bullish": 1.0,
    "climb": 0.6,
    "confidence": 0.5,
    "gain": 0.7,
    "growth": 0.7,
    "hawkish": 0.6,
    "improve": 0.6,
    "outperform": 0.8,
    "profit": 0.6,
    "rally": 0.8,
    "rebound": 0.6,
    "resilient": 0.5,
    "rise": 0.6,
    "strong": 0.6,
    "surge": 0.9,
    "upgrade": 0.8,
    "upside": 0.7,
    "bearish": -1.0,
    "crash": -1.0,
    "decline": -0.6,
    "default": -0.9,
    "downgrade": -0.8,
    "fall": -0.6,
    "inflation": -0.3,
    "loss": -0.7,
    "miss": -0.7,
    "risk": -0.3,
    "recession": -0.9,
    "selloff": -0.9,
    "weak": -0.6,
    "worsen": -0.7,
}
_NEGATIONS = frozenset({"no", "not", "never", "without", "unlikely", "failed"})
_INTENSIFIERS = frozenset({"highly", "sharply", "strongly", "significantly", "severely"})


def direction_from_score(score: float, threshold: float = 0.05) -> Direction:
    if score > threshold:
        return Direction.BUY
    if score < -threshold:
        return Direction.SELL
    return Direction.NEUTRAL


def _score_text(text: str) -> tuple[float | None, list[str]]:
    tokens = _TOKEN_RE.findall(text.lower())
    matched: list[str] = []
    weighted_polarity = 0.0
    total_weight = 0.0
    for index, token in enumerate(tokens):
        polarity = _LEXICON.get(token)
        if polarity is None:
            continue
        modifier = 1.25 if any(
            word in _INTENSIFIERS for word in tokens[max(0, index - 2):index]
        ) else 1.0
        negated = any(
            word in _NEGATIONS for word in tokens[max(0, index - 3):index]
        )
        if negated:
            polarity *= -1.0
        weighted_polarity += polarity * modifier
        total_weight += abs(polarity * modifier)
        matched.append(("not " if negated else "") + token)

    if total_weight == 0.0:
        return None, []
    score = max(-1.0, min(1.0, weighted_polarity / total_weight))
    return score, matched


class SentimentProvider(ConfluenceProvider):
    """Analyze provided raw news/social text without external services."""

    name = "sentiment"
    weight = 0.15
    description = "Source-attributed local financial lexicon sentiment"

    async def evaluate(self, request: ConfluenceRequest) -> ProviderResult:
        documents = [
            item
            for item in request.sentiment_evidence
            if item.symbol == request.symbol
        ]
        if not documents:
            return self.unavailable(
                "no timestamped news/social text was supplied for this symbol"
            )

        freshness_errors = [
            error
            for item in documents
            if (error := feature_freshness_error(item.as_of)) is not None
        ]
        if freshness_errors:
            return ProviderResult(
                name=self.name,
                status=ProviderStatus.DEGRADED,
                weight=self.weight,
                reason=f"stale or invalid sentiment evidence: {freshness_errors[0]}",
            )

        parsed = await asyncio.to_thread(
            self._analyze_documents, documents
        )
        if parsed is None:
            return self.unavailable(
                "supplied text contains no recognized financial sentiment terms"
            )

        evidence, document_scores = parsed
        score = sum(document_scores) / len(document_scores)
        direction = direction_from_score(score)
        directional_items = [
            direction_from_score(item.polarity)
            for item, _ in evidence
            if direction_from_score(item.polarity) != Direction.NEUTRAL
        ]
        agreement = (
            sum(item == direction for item in directional_items)
            / len(directional_items)
            if directional_items and direction != Direction.NEUTRAL
            else 0.0
        )
        confidence = 100.0 * abs(score) * agreement
        newest_as_of = max(item.as_of for item, _ in evidence)
        assessment = SentimentAssessment(
            schema_version=SCHEMA_VERSION,
            symbol=request.symbol,
            direction=direction,
            score=score,
            confidence=confidence,
            confidence_unit="percent",
            source="request_supplied_news_social_text",
            model="local-financial-lexicon-v1",
            confidence_method=(
                "absolute_mean_polarity_times_directional_agreement_percent"
            ),
            evidence=[item for item, _ in evidence],
            as_of=newest_as_of,
        )
        return ProviderResult(
            name=self.name,
            status=ProviderStatus.OK,
            weight=self.weight,
            direction=assessment.direction,
            score=assessment.score,
            confidence=assessment.confidence,
            evidence=assessment.model_dump(mode="json"),
        )

    def is_requested(self, request: ConfluenceRequest) -> bool:
        return any(item.symbol == request.symbol for item in request.sentiment_evidence)

    @staticmethod
    def _analyze_documents(
        documents: list[SentimentTextInput],
    ) -> tuple[list[tuple[SentimentEvidence, list[str]]], list[float]] | None:
        evidence: list[tuple[SentimentEvidence, list[str]]] = []
        scores: list[float] = []
        for document in documents:
            score, matched = _score_text(document.text)
            if score is None:
                continue
            item = SentimentEvidence(
                schema_version=SCHEMA_VERSION,
                kind=document.kind,
                symbol=document.symbol,
                source=document.source,
                reference_id=document.reference_id,
                polarity=score,
                as_of=document.as_of,
                matched_terms=matched,
            )
            evidence.append((item, matched))
            scores.append(score)
        if not evidence:
            return None
        return evidence, scores

    async def close(self) -> None:
        return None
