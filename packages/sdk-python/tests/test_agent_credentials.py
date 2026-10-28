"""The shared agent credential file: the conformance vectors, and the store's file I/O."""

from __future__ import annotations

import json
import logging
import os
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from webhooks_cc.credentials import (
    AgentCredentialStore,
    AgentSlot,
    agent_credentials_path,
    apply_write,
    format_timestamp,
    normalize_issuer,
    parse_file_text,
    parse_timestamp,
    read_slots,
    resolve_agent_credentials_path,
)

from .conformance import CONFORMANCE_DIR, load, vector_id

VECTORS_FILE = CONFORMANCE_DIR / "agent-credentials.json"
needs_vectors = pytest.mark.skipif(
    not VECTORS_FILE.exists(),
    reason="packages/sdk/conformance/agent-credentials.json has not been generated yet",
)


def _vectors(kind: str) -> list[dict[str, Any]]:
    if not VECTORS_FILE.exists():
        return []
    vectors: list[dict[str, Any]] = load("agent-credentials")[kind]
    return vectors


@needs_vectors
@pytest.mark.parametrize("vector", _vectors("paths"), ids=vector_id)
def test_path_vectors(vector: dict[str, Any]) -> None:
    resolved = resolve_agent_credentials_path(vector["platform"], vector["home"], vector["env"])
    if vector["expected"] is None:
        assert resolved is None
    else:
        assert resolved is not None
        assert resolved.replace("\\", "/") == vector["expected"]


@needs_vectors
@pytest.mark.parametrize("vector", _vectors("issuers"), ids=vector_id)
def test_issuer_vectors(vector: dict[str, Any]) -> None:
    assert normalize_issuer(vector["input"]) == vector["expected"]


@needs_vectors
@pytest.mark.parametrize("vector", _vectors("reads"), ids=vector_id)
def test_read_vectors(vector: dict[str, Any]) -> None:
    # fileText is the raw file; file the parsed one; neither means there is no file.
    file = parse_file_text(vector["fileText"]) if "fileText" in vector else vector.get("file")
    now = parse_timestamp(vector["now"])
    assert now is not None
    slots = read_slots(file, vector["issuer"], now)
    assert {
        "claimed": slots.claimed is not None,
        "sandbox": slots.sandbox is not None,
        "claimedToken": slots.claimed is not None and slots.claimed.usable_token(now) is not None,
        "sandboxToken": slots.sandbox is not None and slots.sandbox.usable_token(now) is not None,
    } == vector["expected"]


@needs_vectors
@pytest.mark.parametrize("vector", _vectors("writes"), ids=vector_id)
def test_write_vectors(vector: dict[str, Any]) -> None:
    now = parse_timestamp(vector["now"])
    assert now is not None
    op = vector["op"]
    if "set" in op:
        after = apply_write(vector["before"], vector["issuer"], op["set"], op["slot"], now)
    else:
        after = apply_write(vector["before"], vector["issuer"], op["remove"], None, now)
    assert after == vector["expected"]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2026-10-28T12:00:00Z", "2026-10-28T12:00:00.000Z"),
        ("2026-10-28T14:30:00.123456+02:30", "2026-10-28T12:00:00.123Z"),
        ("2026-10-28T12:00:00.9999Z", "2026-10-28T12:00:00.999Z"),
        ("2028-02-29T00:00:00Z", "2028-02-29T00:00:00.000Z"),
        ("2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000Z"),
    ],
)
def test_parse_timestamp_reads_rfc_3339(value: str, expected: str) -> None:
    millis = parse_timestamp(value)
    assert millis is not None
    assert format_timestamp(millis) == expected


@pytest.mark.parametrize(
    "value",
    [
        "2027-02-29T00:00:00Z",
        "1900-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-10-30T24:00:00Z",
        "2026-12-31T23:59:60Z",
        "2026-10-28T12:00:00+24:00",
        "2026-10-28t12:00:00z",
        "2026-10-28 12:00:00Z",
        "2026-10-28T12:00:00Z\n",
        "2026-10-28",
        # Python's \d takes other scripts' digits; JavaScript's does not.
        "2026-10-2" + chr(0x0668) + "T12:00:00Z",
        None,
        1793534400000,
    ],
)
def test_parse_timestamp_refuses_what_is_not_a_real_time(value: Any) -> None:
    assert parse_timestamp(value) is None


# --- the store ------------------------------------------------------------------------


def slot(registration_id: str, **fields: str) -> dict[str, str]:
    return {
        "registration_id": registration_id,
        "identity_assertion": f"assertion-{registration_id}",
        "assertion_expires": "2999-01-01T00:00:00.000Z",
        **fields,
    }


def test_default_path_follows_the_environment(
    agent_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert agent_credentials_path() == agent_file
    monkeypatch.delenv("WHK_AGENT_FILE")
    monkeypatch.setenv("HOME", "/home/ada")
    monkeypatch.setenv("XDG_CONFIG_HOME", "/xdg")
    if sys.platform not in ("win32", "darwin"):
        assert agent_credentials_path() == Path("/xdg/whk/agent.json")


@pytest.mark.skipif(os.name != "posix", reason="file modes are Unix")
def test_writes_create_a_private_file_and_directory(agent_file: Path) -> None:
    store = AgentCredentialStore(agent_file)
    store.save("https://WebHooks.cc/", "sandbox", slot("a"))
    assert stat.S_IMODE(agent_file.stat().st_mode) == 0o600
    assert stat.S_IMODE(agent_file.parent.stat().st_mode) == 0o700
    assert json.loads(agent_file.read_text()) == {
        "version": 1,
        "issuers": {"https://webhooks.cc": {"sandbox": slot("a")}},
    }
    # No temporary file is left behind.
    assert sorted(path.name for path in agent_file.parent.iterdir()) == ["agent.json"]
    assert store.load("https://webhooks.cc").sandbox == AgentSlot.from_dict(slot("a"))


def test_conditional_remove_and_token_cache(agent_file: Path) -> None:
    store = AgentCredentialStore(agent_file)
    store.save("https://webhooks.cc", "sandbox", {**slot("a"), "future": "kept"})
    store.remove("https://webhooks.cc", "sandbox", registration_id="other")
    assert store.load("https://webhooks.cc").sandbox is not None

    store.save_token(
        "https://webhooks.cc",
        "sandbox",
        "a",
        "whcc_cached",
        datetime(2999, 1, 1, tzinfo=timezone.utc),
    )
    saved = json.loads(agent_file.read_text())["issuers"]["https://webhooks.cc"]["sandbox"]
    assert saved["access_token"] == "whcc_cached"
    assert saved["access_token_expires"] == "2999-01-01T00:00:00.000Z"
    assert saved["future"] == "kept"
    store.save_token("https://webhooks.cc", "sandbox", "other", "whcc_x", None)
    assert store.load("https://webhooks.cc").sandbox.access_token == "whcc_cached"  # type: ignore[union-attr]

    store.remove("https://webhooks.cc", "sandbox", registration_id="a")
    assert not agent_file.exists()


def test_a_newer_format_is_never_overwritten(agent_file: Path) -> None:
    agent_file.parent.mkdir(parents=True)
    agent_file.write_text('{"version": 2, "issuers": {}}')
    AgentCredentialStore(agent_file).save("https://webhooks.cc", "sandbox", slot("a"))
    assert agent_file.read_text() == '{"version": 2, "issuers": {}}'


def test_a_failed_write_warns_once_without_contents(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    import webhooks_cc.credentials as credentials

    monkeypatch.setattr(credentials, "_warned", False)
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("")
    store = AgentCredentialStore(blocker / "agent.json")
    with caplog.at_level(logging.WARNING, logger="webhooks_cc"):
        store.save("https://webhooks.cc", "sandbox", slot("secret-registration"))
        store.save("https://webhooks.cc", "sandbox", slot("secret-registration"))
    assert len(caplog.records) == 1
    assert "could not write the agent credential file" in caplog.text
    assert "assertion-secret-registration" not in caplog.text
