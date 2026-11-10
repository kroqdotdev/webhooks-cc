"""Sharing: client.shares, client.names and share() (whk share run as a child process)."""

from __future__ import annotations

import json
import os
import stat
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from webhooks_cc import (
    WHK_INSTALL_COMMAND,
    WHK_INSTALL_WINDOWS,
    TunnelNameList,
    TunnelShareList,
    WebhooksCCError,
    share,
    whk_install_hint,
)
from webhooks_cc.client import WebhooksCC

SHARE = {
    "id": "8f0c6f9e-1d5a-4c1b-9a0e-1b2c3d4e5f60",
    "kind": "share",
    "name": "acme-demo",
    "url": "https://acme-demo.sharehooks.cc",
    "endpointSlug": None,
    "client": "laptop, Linux",
    "startedAt": "2026-11-10T10:00:00.000Z",
    "endedAt": None,
    "endReason": None,
    "expiresAt": None,
    "bytes": 1234,
    "requests": 7,
    "password": True,
    "notice": False,
    "mine": True,
    "startedBy": None,
}

LIST = {
    "shares": [
        SHARE,
        {
            **SHARE,
            "id": "live-1",
            "kind": "live",
            "name": None,
            "url": "https://go.webhooks.cc/w/acme1",
            "endpointSlug": "acme1",
            "mine": False,
            "startedBy": {"id": "u2", "email": "teammate@example.com"},
        },
    ],
    "usage": {
        "month": "2026-11",
        "bytes": 1234,
        "limitBytes": 26843545600,
        "over": False,
        "resetsAt": "2026-12-01T00:00:00.000Z",
        "message": None,
    },
    "limits": {
        "plan": "pro",
        "label": "Pro",
        "shares": 3,
        "reservedNames": 3,
        "sessionMinutes": None,
        "dataGb": 25,
        "passwords": True,
        "notice": False,
    },
    "names": {"limit": 3, "used": 1, "usable": 1},
    "suspended": False,
    "hints": ["Stop a share with whk shares stop <id> to free a slot."],
}

NAMES = {
    "names": [
        {
            "name": "acme-demo",
            "url": "https://acme-demo.sharehooks.cc",
            "team": None,
            "reservedBy": {"id": "u1", "email": "dev@example.com"},
            "mine": True,
            "password": True,
            "live": True,
            "usable": True,
            "createdAt": "2026-11-01T00:00:00.000Z",
        },
        {
            "name": "acme-team",
            "url": "https://acme-team.sharehooks.cc",
            "team": {"id": "11111111-2222-3333-4444-555555555555", "name": "Acme"},
            "reservedBy": None,
            "mine": False,
            "password": False,
            "live": False,
            "usable": False,
            "createdAt": "2026-11-02T00:00:00.000Z",
        },
    ],
    "limit": 3,
    "used": 1,
    "plan": "pro",
    "teams": [
        {
            "id": "11111111-2222-3333-4444-555555555555",
            "name": "Acme",
            "active": False,
            "limit": 6,
            "used": 1,
        }
    ],
}

TEAM_ID = "11111111-2222-3333-4444-555555555555"


class Api:
    """A mocked API that records each call and answers from a table."""

    def __init__(self, answers: dict[tuple[str, str], tuple[int, Any]]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path + (f"?{request.url.query.decode()}" if request.url.query else "")
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        status, payload = self.answers.get((request.method, path), (404, {"error": "Not found"}))
        return httpx.Response(status, json=payload)


def client_for(api: Api) -> WebhooksCC:
    return WebhooksCC(
        "whcc_test",
        base_url="https://api.test",
        http_client=httpx.Client(transport=httpx.MockTransport(api)),
    )


# --- client.shares ------------------------------------------------------------------


def test_shares_list_reads_everything_the_shares_page_shows() -> None:
    api = Api({("GET", "/api/shares"): (200, LIST)})
    result = client_for(api).shares.list()
    assert isinstance(result, TunnelShareList)
    first, live = result.shares
    assert first.name == "acme-demo" and first.password and first.mine
    assert first.started_by is None and first.expires_at is None
    assert live.kind == "live" and live.endpoint_slug == "acme1" and not live.mine
    assert live.started_by is not None and live.started_by.email == "teammate@example.com"
    assert result.usage.limit_bytes == 26843545600 and not result.usage.over
    assert result.limits.label == "Pro" and result.limits.session_minutes is None
    assert result.names is not None and result.names.usable == 1
    assert result.hints == ["Stop a share with whk shares stop <id> to free a slot."]
    assert not result.suspended


def test_shares_list_narrows_by_state_and_refuses_others() -> None:
    api = Api({("GET", "/api/shares?state=ended"): (200, {**LIST, "shares": []})})
    assert client_for(api).shares.list(state="ended").shares == []
    with pytest.raises(ValueError, match="live"):
        client_for(api).shares.list(state="all")  # type: ignore[arg-type]


def test_shares_list_tolerates_an_older_server() -> None:
    api = Api({("GET", "/api/shares"): (200, {"shares": [{"id": "x"}], "usage": {}, "limits": {}})})
    result = client_for(api).shares.list()
    assert result.names is None and result.hints == [] and result.shares[0].kind == "share"


def test_shares_stop_and_requests() -> None:
    api = Api(
        {
            ("POST", "/api/shares/abc/stop"): (200, {"ok": True, "stopped": True}),
            ("GET", "/api/shares/abc/requests"): (
                200,
                {
                    "available": True,
                    "requests": [
                        {
                            "method": "GET",
                            "path": "/",
                            "status": 200,
                            "ms": 4,
                            "bytes": 512,
                            "at": "2026-11-10T10:00:01.000Z",
                            "country": "DK",
                            "device": "phone",
                            "visitor": 1,
                        }
                    ],
                },
            ),
        }
    )
    client = client_for(api)
    client.shares.stop("abc")
    assert api.calls[-1] == ("POST", "/api/shares/abc/stop", {})
    visits = client.shares.requests("abc")
    assert visits.available and visits.requests[0].device == "phone"
    with pytest.raises(ValueError):
        client.shares.stop("../x")


def test_shares_errors_carry_the_servers_words() -> None:
    api = Api({("POST", "/api/shares/abc/stop"): (404, {"error": "Share not found"})})
    with pytest.raises(WebhooksCCError, match="Share not found"):
        client_for(api).shares.stop("abc")


# --- client.names -------------------------------------------------------------------


def test_names_list_has_own_and_team_counts() -> None:
    api = Api({("GET", "/api/tunnel-names"): (200, NAMES)})
    result = client_for(api).names.list()
    assert isinstance(result, TunnelNameList)
    own, team = result.names
    assert own.usable and own.live and own.reserved_by is not None
    assert team.team is not None and team.team.name == "Acme" and not team.usable
    assert result.limit == 3 and result.used == 1 and result.plan == "pro"
    assert result.teams[0].limit == 6 and not result.teams[0].active


def test_names_reserve_with_a_team_by_id_or_by_name() -> None:
    shown = NAMES["names"][1]
    api = Api(
        {
            ("POST", "/api/tunnel-names"): (201, {"name": shown}),
            ("GET", "/api/teams"): (200, [{"id": TEAM_ID, "name": "Acme"}]),
        }
    )
    client = client_for(api)
    assert client.names.reserve("acme-team", team=TEAM_ID).team is not None
    assert api.calls[-1] == ("POST", "/api/tunnel-names", {"name": "acme-team", "team": TEAM_ID})
    client.names.reserve("acme-team", team="acme")
    assert api.calls[-2][1] == "/api/teams"
    assert api.calls[-1][2] == {"name": "acme-team", "team": TEAM_ID}
    with pytest.raises(ValueError, match="No team"):
        client.names.reserve("acme-team", team="globex")


def test_names_release_and_passwords() -> None:
    api = Api(
        {
            ("DELETE", "/api/tunnel-names/acme-demo"): (200, {"ok": True}),
            ("PUT", "/api/tunnel-names/acme-demo/password"): (200, {"ok": True, "password": True}),
            ("DELETE", "/api/tunnel-names/acme-demo/password"): (
                200,
                {"ok": True, "password": False},
            ),
        }
    )
    client = client_for(api)
    client.names.release("acme-demo")
    client.names.set_password("acme-demo", "correct-horse")
    assert api.calls[-1] == (
        "PUT",
        "/api/tunnel-names/acme-demo/password",
        {"password": "correct-horse"},
    )
    client.names.clear_password("acme-demo")
    assert api.calls[-1][0:2] == ("DELETE", "/api/tunnel-names/acme-demo/password")
    with pytest.raises(ValueError, match="8 to 200"):
        client.names.set_password("acme-demo", "short")


# --- share() with a fake whk ---------------------------------------------------------

FAKE_WHK = """
import json, os, sys, time
record = os.environ["FAKE_WHK_RECORD"]
with open(record, "w") as f:
    json.dump({"argv": sys.argv[1:], "env": {k: v for k, v in os.environ.items()
               if k.startswith("WHK_")}}, f)
mode = os.environ.get("FAKE_WHK_MODE", "live")
def say(**event):
    print(json.dumps(event), flush=True)
if mode == "refuse":
    say(event="error", message="Free allows 1 live share at a time.")
    sys.exit(1)
if mode == "old":
    print("error: unrecognized subcommand 'share'", file=sys.stderr, flush=True)
    sys.exit(2)
if mode == "silent":
    time.sleep(30)
    sys.exit(0)
say(event="retrying", message="the tunnel answered 503", seconds=1)
say(event="live", url="https://calm-river-1234-free.sharehooks.cc", name="calm-river-1234-free",
    expiresAt="2026-11-10T12:00:00Z", notice=True, password=False)
say(event="request", method="GET", path="/", status=200, ms=3)
say(event="notice", text="kept back a download")
if mode == "ends":
    say(event="stopped", reason="the plan's time ran out")
    sys.exit(0)
sys.stdin.read()
say(event="stopped", reason="you stopped it on this computer")
"""


@pytest.fixture
def fake_whk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    script = tmp_path / "whk"
    script.write_text(f"#!{sys.executable}\n{FAKE_WHK}")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    record = tmp_path / "record.json"
    monkeypatch.setenv("FAKE_WHK_RECORD", str(record))
    monkeypatch.setenv("WHK_API_KEY", "whcc_from_environment")
    monkeypatch.setenv("WHK_AUTH", "agent")
    return script, record


pytestmark_posix = pytest.mark.skipif(os.name == "nt", reason="the fake whk is a script")


@pytestmark_posix
def test_share_returns_once_live_and_stops_cleanly(fake_whk: tuple[Path, Path]) -> None:
    script, record = fake_whk
    seen: list[str] = []
    requests: list[str] = []
    notices: list[str] = []
    live = share(
        3000,
        name="acme-demo",
        password="correct-horse",
        whk_path=str(script),
        api_key="whcc_given",
        tunnel_url="ws://localhost:4000",
        on_event=lambda e: seen.append(e.event),
        on_request=lambda r: requests.append(f"{r.method} {r.path} {r.status}"),
        on_notice=notices.append,
    )
    assert live.url == "https://calm-river-1234-free.sharehooks.cc"
    assert live.notice and not live.password and live.expires_at == "2026-11-10T12:00:00Z"
    assert live.running and live.port == 3000
    reason = live.stop()
    assert reason == "you stopped it on this computer"
    assert not live.running and live.reason == reason
    assert requests == ["GET / 200"] and notices == ["kept back a download"]
    assert "live" in seen and "stopped" in seen

    sent = json.loads(record.read_text())
    assert sent["argv"] == [
        "share",
        "3000",
        "--json",
        "--until-stdin-closes",
        "--name",
        "acme-demo",
        "--password",
    ]
    # The password never rides on the command line; the given key wins over the
    # environment's, and an inherited WHK_AUTH is not passed on.
    assert "correct-horse" not in " ".join(sent["argv"])
    assert sent["env"]["WHK_SHARE_PASSWORD"] == "correct-horse"
    assert sent["env"]["WHK_API_KEY"] == "whcc_given"
    assert "WHK_AUTH" not in sent["env"]
    assert sent["env"]["WHK_TUNNEL_URL"] == "ws://localhost:4000"


@pytestmark_posix
def test_share_as_a_connected_agent_uses_the_credential_file(
    fake_whk: tuple[Path, Path], tmp_path: Path
) -> None:
    script, record = fake_whk
    with share(3000, whk_path=str(script), auth="agent", agent_file=tmp_path / "agent.json"):
        pass
    sent = json.loads(record.read_text())["env"]
    assert sent["WHK_AUTH"] == "agent"
    assert sent["WHK_AGENT_FILE"] == str(tmp_path / "agent.json")
    assert "WHK_API_KEY" not in sent


@pytestmark_posix
def test_share_events_iterate_until_it_ends(
    fake_whk: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    script, _ = fake_whk
    monkeypatch.setenv("FAKE_WHK_MODE", "ends")
    live = share(3000, whk_path=str(script))
    names = [e.event for e in live.events()]
    assert names[-1] == "stopped"
    assert live.wait(5) == "the plan's time ran out"


@pytestmark_posix
def test_share_refused_raises_the_clis_words(
    fake_whk: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    script, _ = fake_whk
    monkeypatch.setenv("FAKE_WHK_MODE", "refuse")
    with pytest.raises(WebhooksCCError, match="Free allows 1 live share"):
        share(3000, whk_path=str(script))


@pytestmark_posix
def test_share_with_an_old_whk_says_to_update(
    fake_whk: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    script, _ = fake_whk
    monkeypatch.setenv("FAKE_WHK_MODE", "old")
    with pytest.raises(WebhooksCCError, match="whk update"):
        share(3000, whk_path=str(script))


@pytestmark_posix
def test_share_gives_up_when_no_link_comes(
    fake_whk: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    script, _ = fake_whk
    monkeypatch.setenv("FAKE_WHK_MODE", "silent")
    started = time.monotonic()
    with pytest.raises(WebhooksCCError, match="did not open within"):
        share(3000, whk_path=str(script), timeout=0.5)
    assert time.monotonic() - started < 15


def test_share_without_whk_says_how_to_install(tmp_path: Path) -> None:
    with pytest.raises(WebhooksCCError, match="To install it") as raised:
        share(3000, whk_path=str(tmp_path / "missing-whk"))
    assert "there is none at" in str(raised.value)


def test_share_checks_its_options_before_running_anything() -> None:
    with pytest.raises(WebhooksCCError, match="not a port"):
        share(0)
    with pytest.raises(WebhooksCCError, match="not a port"):
        share(True)  # type: ignore[arg-type]
    with pytest.raises(WebhooksCCError, match="share name"):
        share(3000, name="Acme Demo")
    with pytest.raises(WebhooksCCError, match="8 to 200"):
        share(3000, password="short")


def test_install_hint_follows_the_platform() -> None:
    assert whk_install_hint("linux") == WHK_INSTALL_COMMAND
    assert whk_install_hint("darwin") == WHK_INSTALL_COMMAND
    assert whk_install_hint("win32") == WHK_INSTALL_WINDOWS


# --- client.shares.start ---------------------------------------------------------------


@pytestmark_posix
def test_shares_start_passes_the_clients_key_and_base_url(fake_whk: tuple[Path, Path]) -> None:
    script, record = fake_whk
    client = client_for(Api({}))
    with client.shares.start(3000, whk_path=str(script)) as live:
        assert live.url.endswith(".sharehooks.cc")
    sent = json.loads(record.read_text())["env"]
    assert sent["WHK_API_KEY"] == "whcc_test"
    assert sent["WHK_API_URL"] == "https://api.test"


def test_shares_start_refuses_a_client_without_a_key_or_connection() -> None:
    client = client_for(Api({}))
    client._api_key = None
    with pytest.raises(WebhooksCCError, match="API key or one from"):
        client.shares.start(3000)


@pytestmark_posix
def test_shares_start_for_a_connected_agent_shares_through_its_credential_file(
    fake_whk: tuple[Path, Path], tmp_path: Path
) -> None:
    from webhooks_cc._agent_tokens import SlotBinding
    from webhooks_cc.credentials import AgentCredentialStore

    script, record = fake_whk
    store = AgentCredentialStore(tmp_path / "agents" / "agent.json")
    client = WebhooksCC._for_agent(
        assertion="assertion",
        token=None,
        binding=SlotBinding(store, "https://api.test", "claimed", "reg_1"),
        base_url="https://api.test",
        http_client=httpx.Client(transport=httpx.MockTransport(Api({}))),
    )
    with client.shares.start(3000, whk_path=str(script)):
        pass
    sent = json.loads(record.read_text())["env"]
    assert sent["WHK_AUTH"] == "agent"
    assert sent["WHK_AGENT_FILE"] == str(tmp_path / "agents" / "agent.json")
    assert "WHK_API_KEY" not in sent
