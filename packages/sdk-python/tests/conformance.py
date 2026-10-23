"""Loads the shared conformance vectors that every webhooks.cc SDK must pass."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CONFORMANCE_DIR = Path(__file__).resolve().parents[2] / "sdk" / "conformance"


def load(name: str) -> dict[str, Any]:
    """The parsed contents of ``packages/sdk/conformance/<name>.json``."""
    with (CONFORMANCE_DIR / f"{name}.json").open(encoding="utf-8") as file:
        data: dict[str, Any] = json.load(file)
    assert data["version"] == 1, f"{name}.json is format version {data['version']}; update the port"
    return data


def vector_id(vector: dict[str, Any]) -> str:
    return str(vector.get("name", vector.get("input")))
