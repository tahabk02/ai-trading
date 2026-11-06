from __future__ import annotations

import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any


class Metrics:
    def __init__(self) -> None:
        self._counters: Counter[str] = Counter()
        self._started_at = time.time()
        self.last_error: str | None = None
        self.last_signal_at: str | None = None

    def inc(self, name: str, amount: int = 1) -> None:
        self._counters[name] += amount

    def error(self, message: str) -> None:
        self.last_error = message
        self._counters["errors"] += 1

    def mark_signal(self) -> None:
        self.last_signal_at = datetime.now(timezone.utc).isoformat()

    def snapshot(self) -> dict[str, Any]:
        return {
            "uptime_seconds": round(time.time() - self._started_at, 3),
            "counters": dict(self._counters),
            "last_error": self.last_error,
            "last_signal_at": self.last_signal_at,
        }
