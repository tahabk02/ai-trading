"""PART 48 [env-hardening] — the ai-engine boot guard.

`app/core/config.py` refuses to import when `AI_ENGINE_API_KEY` is missing or a
placeholder, in EVERY environment, unless the explicit
`ALLOW_INSECURE_DEV_DEFAULTS=true` opt-out is set. This mirrors core-backend's
`assertRequiredConfig` (see `core-backend/src/lib/__tests__/failFast.test.ts`).

The guard fires at IMPORT time, so it is exercised with a real CHILD process:
an in-process test would poison the already-imported `settings` singleton for
every other test file.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

AI_ENGINE_ROOT = Path(__file__).resolve().parents[1]

_PROBE = (
    "import sys; sys.path.insert(0, r'%s'); "
    "from app.core.config import settings; "
    "print('BOOTED')" % AI_ENGINE_ROOT
)


def _probe(extra: dict) -> subprocess.CompletedProcess:
    """Import `app.core.config` in a child process with a controlled environment.

    `ALLOW_INSECURE_DEV_DEFAULTS` is always removed first: the suite sets it via
    `conftest.py`, but each case here decides the posture for itself. A real
    environment value overrides the env FILE, which is how an empty key reaches
    the guard exactly as a broken deploy would.
    """
    env = {k: v for k, v in os.environ.items() if k != "ALLOW_INSECURE_DEV_DEFAULTS"}
    env.update(extra)
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=str(AI_ENGINE_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


def test_refuses_to_boot_without_a_service_key():
    out = _probe({"AI_ENGINE_API_KEY": ""})
    assert out.returncode != 0, out.stdout
    assert "AI_ENGINE_API_KEY" in out.stderr


def test_refuses_to_boot_with_a_placeholder_key():
    out = _probe({"AI_ENGINE_API_KEY": "change-me"})
    assert out.returncode != 0, out.stdout
    assert "AI_ENGINE_API_KEY" in out.stderr


def test_never_prints_the_secret_in_the_failure_output():
    secret = "super-secret-value-that-must-never-be-logged"
    # A placeholder value still fails the guard; the value itself must never
    # appear in the failure output, only the key name and the remedy.
    out = _probe({"AI_ENGINE_API_KEY": f"change-me-{secret}"})
    assert out.returncode != 0
    assert secret not in out.stderr
    assert secret not in out.stdout


def test_the_explicit_opt_out_allows_boot():
    out = _probe(
        {
            "AI_ENGINE_API_KEY": "",
            "ALLOW_INSECURE_DEV_DEFAULTS": "true",
            "ENVIRONMENT": "development",
        }
    )
    assert out.returncode == 0, out.stderr
    assert "BOOTED" in out.stdout
