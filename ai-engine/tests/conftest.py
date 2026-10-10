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

import pytest

from app.services.signal_lock import signal_lock


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
