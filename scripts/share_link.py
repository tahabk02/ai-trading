"""Print and verify the local DevTunnels client and API links."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


def health_ok(url: str) -> bool:
    try:
        with urlopen(f"{url.rstrip('/')}/health", timeout=10) as response:
            return 200 <= response.status < 300
    except (OSError, URLError):
        return False


def main() -> int:
    env_path = Path(__file__).resolve().parents[1] / "client-app" / ".env.local"
    values = read_env(env_path)
    api = values.get("NEXT_PUBLIC_API_URL", "").split("/api/v1", 1)[0].rstrip("/")
    ws = values.get("NEXT_PUBLIC_WS_URL", "").rstrip("/")
    client = api.replace("-4000.", "-3000.")

    print(f"CLIENT LINK: {client}")
    print(f"API:         {api}")
    print(f"WS:          {ws}")
    api_ok = bool(api) and health_ok(api)
    client_ok = bool(client) and health_ok(client)
    print(f"API /health: {'OK' if api_ok else 'FAILED'}")
    print(f"CLIENT /health: {'OK' if client_ok else 'FAILED'}")
    return 0 if api_ok and client_ok else 1


if __name__ == "__main__":
    sys.exit(main())