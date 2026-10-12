"""Every module under app/ must at least PARSE.

Why this exists: `app/services/fundamental_analysis.py` shipped with an
IndentationError on line 148 (a botched refactor from `__import__("datetime")`
to a real import) and the whole suite still reported 500 passed, because no
test imports that module. A syntax error in an unimported file is invisible to
test coverage and only explodes at runtime, in whatever request path first
touches it.

This is a compile gate, not an import test. Importing every module would drag
in live connections and side effects, which is exactly what makes a test suite
flaky. Parsing catches the class of failure that is both certain and free.
"""
import pathlib
import py_compile
import tempfile

import pytest

APP_ROOT = pathlib.Path(__file__).resolve().parent.parent / "app"


def _modules():
    return sorted(p for p in APP_ROOT.rglob("*.py") if "__pycache__" not in p.parts)


def test_app_directory_is_discovered():
    """Guard the guard: an empty glob would make the tests below vacuous."""
    found = _modules()
    assert len(found) > 50, (
        "expected the full app tree, found only %d modules -- is APP_ROOT right?"
        % len(found)
    )


def test_every_module_parses():
    """The release gate: zero syntax errors anywhere under app/."""
    failures = []
    with tempfile.TemporaryDirectory() as tmp:
        for path in _modules():
            target = pathlib.Path(tmp) / (path.stem + ".pyc")
            try:
                py_compile.compile(
                    str(path), cfile=str(target), doraise=True, quiet=1
                )
            except py_compile.PyCompileError as exc:
                failures.append("%s: %s" % (path.relative_to(APP_ROOT), exc.msg.strip()))

    assert not failures, "syntax errors:\n" + "\n".join(failures)


@pytest.mark.parametrize("name", ["fundamental_analysis"])
def test_known_module_parses_and_imports(name):
    """The module that shipped broken is not exercised by anything else, so
    pin it explicitly: it must both parse and import."""
    import importlib

    mod = importlib.import_module("app.services.%s" % name)
    assert hasattr(mod, "FundamentalAnalysisService")
    assert callable(getattr(mod.FundamentalAnalysisService, "fetch_fundamentals"))
