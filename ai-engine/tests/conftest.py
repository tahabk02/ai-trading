"""
Shared pytest fixtures.

The expiry signal lock is deliberately PROCESS-GLOBAL (a module-level
singleton, mirroring data_cache / RedisPublisher) so a verdict committed for an
expiry is the same verdict for every request in the process. That is correct in
production and wrong in tests: a lock committed by one test would be served to
the next, making the suite order-dependent.

`clean_signal_locks` isolates every test from that global state and forces the
deterministic process-local path, so the suite never depends on whether a Redis
happens to be reachable.
"""

import os

import pytest

# PART 48 [env-hardening] — the test suite is the explicit "mock/test" posture.
# `app/core/config.py` now refuses to boot with a missing/placeholder
# AI_ENGINE_API_KEY in EVERY environment; its single escape hatch is this flag.
# The suite sets it so tests need no real deployment secret. The strict path is
# still covered by `test_boot_guard.py`, which runs a child process with the flag
# deliberately removed. `setdefault` keeps an operator's explicit choice.
#
# This MUST run before any `app.*` import below, because importing the config
# runs the boot guard.
os.environ.setdefault("ALLOW_INSECURE_DEV_DEFAULTS", "true")

from app.services.signal_lock import signal_lock  # noqa: E402


@pytest.fixture(autouse=True)
def clean_signal_locks():
    """No lock survives a test, in either the Redis or the local path.

    The Redis client is detached for the duration of the test so lock reads/writes
    are deterministic and offline. Tests that specifically need the Redis path
    should drive ``SignalLock`` directly with a stub client instead of relaxing
    this.
    """
    signal_lock._local.clear()
    signal_lock._redis = None
    yield
    signal_lock._local.clear()
    signal_lock._redis = None
