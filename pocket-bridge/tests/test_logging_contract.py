"""Guard against ``logger.info("MSG", key=value)`` crashes.

The stdlib logger only accepts ``exc_info``, ``stack_info``, ``stacklevel`` and
``extra`` as keyword arguments. Passing structured fields (``uid=``,
``is_demo=``, ``format=``) raises ``TypeError`` at runtime and can kill the
task/process that emitted the log — which is exactly how a successful SSID
refresh used to crash the bridge.
"""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "pocket_bridge"

_ALLOWED = {"exc_info", "stack_info", "stacklevel", "extra"}


def _logger_calls(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "logger"
        ):
            yield node


def test_no_logger_call_uses_unsupported_keyword_arguments():
    offenders = []
    for path in PACKAGE.glob("*.py"):
        for call in _logger_calls(path):
            bad = [
                keyword.arg
                for keyword in call.keywords
                if keyword.arg not in _ALLOWED
            ]
            if bad:
                offenders.append(
                    f"{path.name}:{call.lineno} {call.func.attr} {bad}"
                )
    assert not offenders, "unsupported logger kwargs: " + "; ".join(offenders)
