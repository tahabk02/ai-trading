"""
Test that ai-engine configuration is isolated from the repository-root .env.

The bug: `SettingsConfigDict(env_file=".env")` resolves relative to the process
working directory. Run pytest or uvicorn from the repo root and the engine
silently loaded the ROOT .env — core-backend's configuration — instead of
ai-engine's own, so it inherited a SQLite DATABASE_URL, a foreign JWT_SECRET
and a foreign AI_ENGINE_API_KEY. The same image behaved differently depending
on the directory it was launched from.

These tests assert the engine reads only files inside ai-engine/ and that the
real environment always wins.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

AI_ENGINE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = AI_ENGINE_ROOT.parent
PARENT_DOTENV = REPO_ROOT / ".env"
CONFIG_PY = AI_ENGINE_ROOT / "app" / "core" / "config.py"


def strip_comments(source: str) -> str:
    """Remove comments so prose about the old bug cannot satisfy the guard."""
    lines = []
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        lines.append(line.split("  #")[0])
    return "\n".join(lines)


def read_key(file: Path, key: str):
    """Read one key from a dotenv file. Returns None when absent."""
    if not file.is_file():
        return None
    import re

    pattern = re.compile(rf"^\s*{re.escape(key)}\s*=\s*[\"']?(.*?)[\"']?\s*$")
    for line in file.read_text(encoding="utf-8", errors="replace").splitlines():
        m = pattern.match(line)
        if m:
            return m.group(1)
    return None


def run_config_probe(cwd: Path) -> dict:
    """Import app.core.config in a real child process launched from `cwd`."""
    # Only `Settings` fields are read: ai-engine does not define JWT_SECRET or
    # DATABASE_URL, so asking for them would raise. Reading os.environ instead
    # proves what actually landed in the process environment.
    code = (
        "import json, os, sys;"
        "sys.path.insert(0, r'%s');"
        "from app.core.config import settings, AI_ENGINE_ROOT, AI_ENGINE_ROOT_ENV;"
        "print('@@' + json.dumps({"
        "'root': str(AI_ENGINE_ROOT),"
        "'files': [p.name for p in AI_ENGINE_ROOT_ENV],"
        "'apiKey': settings.AI_ENGINE_API_KEY,"
        "'redisUrl': settings.REDIS_URL,"
        "'jwt': os.environ.get('JWT_SECRET', ''),"
        "'databaseUrl': os.environ.get('DATABASE_URL', ''),"
        "}))" % AI_ENGINE_ROOT
    )
    env = {k: v for k, v in os.environ.items() if k not in ("AI_ENGINE_API_KEY", "JWT_SECRET", "DATABASE_URL")}
    env["PYTHONIOENCODING"] = "utf-8"
    out = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert out.returncode == 0, f"config import failed from {cwd}:\n{out.stderr[-2000:]}"
    marker = [line for line in out.stdout.splitlines() if line.startswith("@@")][-1]
    import json

    return json.loads(marker[2:])


class TestEnvFileIsolation:
    def test_service_root_resolves_from_module_not_cwd(self):
        result = run_config_probe(AI_ENGINE_ROOT)
        assert Path(result["root"]).resolve() == AI_ENGINE_ROOT.resolve()

    def test_cwd_independence(self):
        """Same result whether launched from ai-engine/ or the repo root."""
        from_service = run_config_probe(AI_ENGINE_ROOT)
        from_repo = run_config_probe(REPO_ROOT)

        assert from_service["root"] == from_repo["root"]
        assert from_service["files"] == from_repo["files"]
        # Neither may pick up the root file's SQLite value.
        assert not (from_repo["databaseUrl"] or "").startswith("file:")

    def test_never_loads_repository_root_dotenv(self):
        result = run_config_probe(REPO_ROOT)
        assert ".env" in result["files"]
        for name in result["files"]:
            assert (AI_ENGINE_ROOT / name).resolve().parent == AI_ENGINE_ROOT.resolve()

    def test_parent_dotenv_is_not_consulted(self):
        """The parent file exists but must not influence the engine's config."""
        assert PARENT_DOTENV.is_file(), (
            "this regression test is only meaningful while the repo-root .env exists"
        )
        result = run_config_probe(AI_ENGINE_ROOT)
        for key in ("AI_ENGINE_API_KEY", "JWT_SECRET", "DATABASE_URL"):
            parent = read_key(PARENT_DOTENV, key)
            own = read_key(AI_ENGINE_ROOT / ".env", key)
            if parent and own and parent != own:
                assert result.get(
                    "apiKey" if key == "AI_ENGINE_API_KEY" else "jwt" if key == "JWT_SECRET" else "databaseUrl"
                ) == own, f"{key} came from the parent .env"

    def test_real_environment_wins_over_files(self):
        injected = "injected-from-the-real-environment"
        code = (
            "import json, sys;"
            "sys.path.insert(0, r'%s');"
            "from app.core.config import settings;"
            "print('@@' + json.dumps({'apiKey': settings.AI_ENGINE_API_KEY}))" % AI_ENGINE_ROOT
        )
        env = {**os.environ, "AI_ENGINE_API_KEY": injected, "PYTHONIOENCODING": "utf-8"}
        out = subprocess.run(
            [sys.executable, "-c", code],
            cwd=str(REPO_ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
        )
        assert out.returncode == 0, out.stderr[-2000:]
        import json

        marker = [line for line in out.stdout.splitlines() if line.startswith("@@")][-1]
        assert json.loads(marker[2:])["apiKey"] == injected


class TestConfigSourceIsCwdIndependent:
    def test_env_file_is_not_a_bare_relative_path(self):
        """`env_file=".env"` is the exact bug; forbid it coming back."""
        code = strip_comments(CONFIG_PY.read_text(encoding="utf-8"))
        assert 'env_file=".env"' not in code
        assert "AI_ENGINE_ROOT_ENV" in code
        assert "AI_ENGINE_ROOT" in code
