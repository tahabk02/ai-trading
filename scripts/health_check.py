"""Probe the local trading platform services and print a compact health table."""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass
class CheckResult:
    service: str
    url: str
    status: str
    latency_ms: float
    healthy: bool


def check(service: str, url: str, payload: dict | None = None) -> CheckResult:
    started = time.perf_counter()
    body = None
    headers = {}
    method = "GET"
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"

    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=3) as response:
            status_code = response.status
            response.read()
        healthy = 200 <= status_code < 300
        status = str(status_code)
    except HTTPError as error:
        healthy = False
        status = str(error.code)
    except (URLError, TimeoutError, OSError) as error:
        healthy = False
        status = type(error).__name__

    latency_ms = (time.perf_counter() - started) * 1000
    return CheckResult(service, url, status, latency_ms, healthy)


def main() -> int:
    checks = [
        check("core-backend", "http://localhost:4000/health"),
        check("ai-engine", "http://localhost:8000/health"),
        check("ai-health-proxy", "http://localhost:4000/api/v1/health/ai"),
        check("pocket-bridge", "http://localhost:8788/health"),
        check(
            "predict",
            "http://localhost:4000/api/v1/predict",
            {"symbol": "EUR/USD", "timeframe": "1m"},
        ),
    ]

    print(f"{'service':<14} {'url':<52} {'status':<16} {'latency_ms':>10}")
    print("-" * 96)
    for result in checks:
        print(
            f"{result.service:<14} {result.url:<52} "
            f"{result.status:<16} {result.latency_ms:>10.2f}"
        )

    return 0 if all(result.healthy for result in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
