"""Pre-flight environment check for the Pocket Option bridge.

Verifies that the correct Python interpreter (the project virtualenv) is in
use and that `BinaryOptionsToolsV2` imports cleanly BEFORE starting the
backend / bridge again.

Usage (from the repo root, inside the venv):
    c:\\Users\\hp\\trading-ai-platform\\.venv-1\\Scripts\\python.exe pocket-bridge\\verify_env.py

Exits:
    0  -> all checks passed, safe to start the bridge
    1  -> something is wrong (wrong interpreter, missing package, bad import)
"""

from __future__ import annotations

import sys
from pathlib import Path

EXPECTED_VENV_MARKER = "trading-ai-platform\\.venv-1"
PACKAGE = "BinaryOptionsToolsV2"


def _venv_report() -> tuple[bool, str]:
    exe = Path(sys.executable).resolve()
    ok = ".venv-1" in str(exe)
    return ok, str(exe)


def main() -> int:
    print("=" * 62)
    print("Pocket Option Bridge - environment pre-flight check")
    print("=" * 62)

    # 1) Correct interpreter
    venv_ok, exe = _venv_report()
    print(f"\n[1/3] Python interpreter : {exe}")
    if not venv_ok:
        print("      -> NOT the project venv (.venv-1).")
        print(f"      Re-run with: c:\\Users\\hp\\trading-ai-platform\\{EXPECTED_VENV_MARKER}\\Scripts\\python.exe")
        return 1
    print(f"      -> OK (project virtualenv detected)")
    print(f"      version             : {sys.version.split()[0]}")

    # 2) Package importable
    print(f"\n[2/3] Import `{PACKAGE}`  ...")
    try:
        import BinaryOptionsToolsV2  # noqa: F401
        print(f"      -> OK (version {getattr(BinaryOptionsToolsV2, '__version__', '?')})")
    except ModuleNotFoundError as exc:
        print(f"      -> FAILED: {exc}")
        print("      Install with:")
        print(f"          {exe} -m pip install 'BinaryOptionsToolsV2==0.2.14'")
        return 1

    # 3) Bridge submodule import (the exact import used at runtime)
    print("\n[3/3] Import `BinaryOptionsToolsV2.pocketoption` ...")
    try:
        from BinaryOptionsToolsV2.pocketoption import PocketOptionAsync  # noqa: F401
        print("      -> OK (PocketOptionAsync available)")
    except Exception as exc:  # noqa: BLE001
        print(f"      -> FAILED: {exc.__class__.__name__}: {exc}")
        return 1

    print("\n" + "=" * 62)
    print("ALL CHECKS PASSED  ->  safe to start the bridge / backend now.")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
