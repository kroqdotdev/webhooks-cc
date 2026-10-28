"""Settings every test shares."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def agent_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A credential file of the test's own, so no test reads or writes the real one."""
    path = tmp_path / "config" / "whk" / "agent.json"
    monkeypatch.setenv("WHK_AGENT_FILE", str(path))
    return path
