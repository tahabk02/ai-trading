"""Shared runtime state for the AI Engine.

Thread-safe flags consumed by the /health endpoints (in app/api/v1/health.py)
so an operator can distinguish a warm-up engine (degraded but serving) from a
fully warm one (healthy). Keep this module leaf-side — it must NOT import any
FastAPI app component, so both `main.py` and the api routers can depend on it
without a circular import.
"""

import threading
from typing import Dict

_lock = threading.Lock()
_warmup_running = False
_warmup_progress: Dict[str, int] = {"completed": 0, "total": 0}
_last_error: str | None = None


def set_warmup_running(running: bool) -> None:
    global _warmup_running
    with _lock:
        _warmup_running = running


def warmup_is_running() -> bool:
    with _lock:
        return _warmup_running


def set_warmup_progress(completed: int, total: int) -> None:
    with _lock:
        _warmup_progress["completed"] = completed
        _warmup_progress["total"] = total


def warmup_progress() -> Dict[str, int]:
    with _lock:
        return dict(_warmup_progress)


def set_last_health_error(error: str | None) -> None:
    global _last_error
    with _lock:
        _last_error = error


def last_health_error() -> str | None:
    with _lock:
        return _last_error