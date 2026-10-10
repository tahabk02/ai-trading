"""
execution_audit.py — PER-SIGNAL EVALUATION AUDIT LOG (STRICT QUALITY UPGRADE)

Every signal evaluation produces one structured audit record capturing the
three mandated dimensions — confluence score, regime type, spread status —
plus the asset class, resolved tier, executable decision and the suppression
reason. Records are emitted under the ``SIGNAL_EVALUATION_AUDIT`` event key so
ops can grep one stable label across the whole engine.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import structlog

_logger = structlog.get_logger(__name__)

AUDIT_EVENT = "SIGNAL_EVALUATION_AUDIT"


def log_signal_evaluation(
    *,
    symbol: Any,
    asset_class: str,
    direction: Optional[str],
    confidence_pct: float,
    regime_type: Optional[str],
    spread_status: Optional[str],
    executable: bool,
    tier: str,
    regime_gate: str,
    suppressed_reason: Optional[str],
    class_filter: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Emit + return the structured audit record for one signal evaluation.

    Conforms to the audit mandate: exact confluence score, regime type, and
    spread status are ALWAYS present in the record (None when unknown).
    """
    record: Dict[str, Any] = {
        "symbol": symbol,
        "asset_class": asset_class,
        "signal": direction,
        "confluence_score": round(float(confidence_pct), 2),
        "confidence_pct": round(float(confidence_pct), 2),
        "regime_type": regime_type,
        "spread_status": spread_status,
        "class_filter": class_filter,
        "executable": bool(executable),
        "tier": tier,
        "regime_gate": regime_gate,
        "suppressed_reason": suppressed_reason,
    }
    if extra:
        record.update(extra)
    _logger.info(AUDIT_EVENT, **record)
    return record