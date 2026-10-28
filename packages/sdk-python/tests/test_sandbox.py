"""The agent sandbox, the claim, connected agents and the shared credential file, against a
mocked server."""

from __future__ import annotations

import json
import os
import stat
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest

from webhooks_cc import (
    AgentAuthError,
    RateLimitError,
    SandboxError,
    UnauthorizedError,
    WebhooksCC,
    agent,
)
from webhooks_cc.credentials import format_timestamp

BASE = "https://agent.test"
NOW_MS = int(time.time() * 1000)
JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"
CLAIM = "urn:workos:agent-auth:grant-type:claim"

Reply = httpx.Response | Callable[[httpx.Request], httpx.Response]


def later(**delta: float) -> str:
    return format_timestamp(datetime.now(timezone.utc) + timedelta(**delta))


class Server:
    """Answers by route (``"POST /api/agent/identity"``; the token endpoint by grant,
    ``"POST /api/oauth2/token jwt-bearer"``). Each route's replies are used in order,
    the last one repeating; an unknown route fails the test."""

    def __init__(self, routes: dict[str, list[Reply]]) -> None:
        self.routes = routes
        self.calls: list[str] = []
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        key = f"{request.method} {request.url.path}"
        if request.url.path == "/api/oauth2/token":
            grant = parse_qs(request.content.decode())["grant_type"][0]
            key += " jwt-bearer" if grant == JWT_BEARER else " claim"
        self.calls.append(key)
        self.requests.append(request)
        replies = self.routes.get(key)
        assert replies, f"unexpected call {key}"
        reply = replies.pop(0) if len(replies) > 1 else replies[0]
        return reply(request) if callable(reply) else reply

    def http(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self))

    def bearers(self, path: str) -> list[str]:
        return [
            request.headers["authorization"]
            for request in self.requests
            if request.url.path.startswith(path)
        ]


def token(name: str, expires_in: int = 3600, scope: str = "webhooks:sandbox") -> httpx.Response:
    return httpx.Response(
        200, json={"access_token": name, "expires_in": expires_in, "scope": scope}
    )


def registration(registration_id: str = "reg-anon") -> dict[str, Any]:
    expires = later(hours=24)
    return {
        "registration_id": registration_id,
        "registration_type": "anonymous",
        "identity_assertion": f"assertion-{registration_id}",
        "assertion_expires": expires,
        "pre_claim_scopes": ["webhooks:sandbox"],
        "claim_token": "clm_secret",
        "claim_token_expires": expires,
        "post_claim_scopes": ["webhooks:read", "webhooks:write"],
        "sandbox": {"status": "available", "endpoints_url": f"{BASE}/api/agent/sandbox/endpoints"},
    }


def challenge(name: str) -> dict[str, Any]:
    return {
        "challenge": f"pow1.{name}.sig",
        "algorithm": "sha256-zero-bits",
        "difficulty": 4,
        "count": 2,
    }


def endpoint(slug: str = "sbx1", **fields: Any) -> dict[str, Any]:
    return {
        "id": f"id-{slug}",
        "slug": slug,
        "createdAt": NOW_MS,
        "isEphemeral": True,
        "expiresAt": NOW_MS + 86_400_000,
        "url": f"https://go.agent.test/w/{slug}",
        "requestCount": 0,
        "sandbox": {
            "expiresAt": NOW_MS + 86_400_000,
            "maxEndpoints": 3,
            "requestLimit": 25,
            "budget": {"used": 1, "limit": 100},
        },
        **fields,
    }


def captured(request_id: str) -> dict[str, Any]:
    return {
        "id": request_id,
        "endpointId": "id-sbx1",
        "method": "POST",
        "path": "/",
        "headers": {"content-type": "application/json"},
        "body": '{"type": "ping"}',
        "queryParams": {},
        "ip": "203.0.113.7",
        "size": 16,
        "receivedAt": NOW_MS,
        "kind": "http",
    }


def claimed() -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "access_token": "whcc_account",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "webhooks:read webhooks:write",
            "identity_assertion": "claimed-assertion",
            "assertion_expires": later(days=90),
        },
    )


def attempt(code: str = "123456") -> dict[str, Any]:
    return {
        "user_code": code,
        "expires_in": 900,
        "verification_uri": f"{BASE}/agent/claim?attempt=cat_{code}",
        "interval": 5,
    }


def write_file(path: Path, **slots: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "issuers": {BASE: slots}}))


def read_file(path: Path) -> dict[str, Any]:
    entry: dict[str, Any] = json.loads(path.read_text())["issuers"][BASE]
    return entry


def saved_sandbox(**fields: str) -> dict[str, str]:
    return {
        "registration_id": "reg-saved",
        "identity_assertion": "assertion-saved",
        "assertion_expires": later(hours=20),
        "client_name": "whk-cli",
        "saved_at": later(hours=-4),
        **fields,
    }


def saved_claimed(**fields: str) -> dict[str, str]:
    return {
        "registration_id": "reg-claimed",
        "identity_assertion": "assertion-claimed",
        "assertion_expires": later(days=60),
        "scope": "webhooks:read webhooks:write",
        "email": "dev@example.com",
        "client_name": "webhooks-cc-mcp",
        "saved_at": later(days=-30),
        **fields,
    }


@pytest.fixture(autouse=True)
def no_sleeping(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(agent, "_sleep", lambda _seconds: None)


# --- registering and reusing a sandbox ------------------------------------------------


def test_registers_with_a_pow_retry_and_saves_the_sandbox(agent_file: Path) -> None:
    server = Server(
        {
            "POST /api/agent/identity/challenge": [httpx.Response(200, json=challenge("a"))],
            "POST /api/agent/identity": [
                httpx.Response(400, json={"error": "proof_of_work_required", **challenge("fresh")}),
                httpx.Response(200, json=registration()),
            ],
            "POST /api/oauth2/token jwt-bearer": [token("whcc_sandbox")],
            "POST /api/agent/sandbox/endpoints": [httpx.Response(201, json=endpoint())],
        }
    )
    with WebhooksCC.sandbox(base_url=BASE, http_client=server.http()) as sandbox:
        assert sandbox.registration_id == "reg-anon"
        assert sandbox.expires_at > datetime.now(timezone.utc)
        created = sandbox.endpoints.create()
    assert created.slug == "sbx1" and created.url == "https://go.agent.test/w/sbx1"
    assert created.sandbox is not None and created.sandbox.budget_used == 1

    sent = [json.loads(r.content) for r in server.requests if r.url.path == "/api/agent/identity"]
    assert [body["proof_of_work"]["challenge"] for body in sent] == [
        "pow1.a.sig",
        "pow1.fresh.sig",
    ]
    assert sent[0]["client_name"] == "webhooks-cc-python"
    assert server.bearers("/api/agent/sandbox") == ["Bearer whcc_sandbox"]

    saved = read_file(agent_file)["sandbox"]
    assert saved["registration_id"] == "reg-anon"
    assert saved["identity_assertion"] == "assertion-reg-anon"
    assert saved["client_name"] == "webhooks-cc-python"
    assert saved["access_token"] == "whcc_sandbox"
    # The claim token never leaves the process.
    assert "clm_" not in agent_file.read_text()


def test_reuses_the_saved_sandbox_without_registering(agent_file: Path) -> None:
    write_file(agent_file, sandbox=saved_sandbox())
    server = Server(
        {
            "POST /api/oauth2/token jwt-bearer": [token("whcc_fresh")],
            "GET /api/agent/sandbox/endpoints": [
                httpx.Response(200, json={"endpoints": [endpoint(url=None)], "sandbox": {}})
            ],
        }
    )
    with WebhooksCC.sandbox(
        base_url=BASE, webhook_url="https://go.agent.test/", http_client=server.http()
    ) as sandbox:
        assert sandbox.registration_id == "reg-saved"
        [listed] = sandbox.endpoints.list()
    assert listed.url == "https://go.agent.test/w/sbx1"
    assert server.calls == ["POST /api/oauth2/token jwt-bearer", "GET /api/agent/sandbox/endpoints"]
    assert parse_qs(server.requests[0].content.decode())["assertion"] == ["assertion-saved"]
    assert read_file(agent_file)["sandbox"]["access_token"] == "whcc_fresh"


def test_uses_the_cached_token_without_exchanging(agent_file: Path) -> None:
    write_file(
        agent_file,
        sandbox=saved_sandbox(access_token="whcc_cached", access_token_expires=later(minutes=30)),
    )
    server = Server(
        {"GET /api/agent/sandbox/endpoints/sbx1": [httpx.Response(200, json=endpoint())]}
    )
    sandbox = WebhooksCC.sandbox(base_url=BASE, http_client=server.http())
    assert server.calls == []
    assert sandbox.endpoints.get("sbx1").request_count == 0
    assert server.bearers("/api/agent/sandbox") == ["Bearer whcc_cached"]


def test_a_401_exchanges_once_more(agent_file: Path) -> None:
    write_file(
        agent_file,
        sandbox=saved_sandbox(access_token="whcc_revoked", access_token_expires=later(minutes=30)),
    )
    server = Server(
        {
            "GET /api/agent/sandbox/endpoints/sbx1/requests": [
                httpx.Response(401, json={"error": "invalid_token"}),
                httpx.Response(200, json=[captured("r1")]),
            ],
            "POST /api/oauth2/token jwt-bearer": [token("whcc_renewed")],
        }
    )
    sandbox = WebhooksCC.sandbox(base_url=BASE, http_client=server.http())
    [request] = sandbox.requests.list("sbx1", since=NOW_MS - 1000, limit=10)
    assert request.id == "r1"
    assert server.bearers("/api/agent/sandbox") == ["Bearer whcc_revoked", "Bearer whcc_renewed"]
    listed = next(r for r in server.requests if r.url.path.endswith("/requests"))
    assert listed.url.params["limit"] == "10"
    assert read_file(agent_file)["sandbox"]["access_token"] == "whcc_renewed"


def test_invalid_grant_removes_the_slot_and_raises(agent_file: Path) -> None:
    write_file(
        agent_file,
        sandbox=saved_sandbox(access_token="whcc_cached", access_token_expires=later(minutes=30)),
        claimed=saved_claimed(),
    )
    server = Server(
        {
            "GET /api/agent/sandbox/endpoints": [httpx.Response(401, json={})],
            "POST /api/oauth2/token jwt-bearer": [
                httpx.Response(400, json={"error": "invalid_grant", "error_description": "gone"})
            ],
        }
    )
    sandbox = WebhooksCC.sandbox(base_url=BASE, http_client=server.http())
    with pytest.raises(AgentAuthError) as caught:
        sandbox.endpoints.list()
    assert caught.value.code == "invalid_grant"
    assert set(read_file(agent_file)) == {"claimed"}


def test_a_dead_saved_sandbox_is_replaced_by_a_new_registration(agent_file: Path) -> None:
    write_file(agent_file, sandbox=saved_sandbox())
    server = Server(
        {
            "POST /api/oauth2/token jwt-bearer": [
                httpx.Response(400, json={"error": "invalid_grant"}),
                token("whcc_new"),
            ],
            "POST /api/agent/identity/challenge": [httpx.Response(200, json=challenge("a"))],
            "POST /api/agent/identity": [httpx.Response(200, json=registration("reg-new"))],
        }
    )
    sandbox = WebhooksCC.sandbox(base_url=BASE, http_client=server.http())
    assert sandbox.registration_id == "reg-new"
    assert read_file(agent_file)["sandbox"]["registration_id"] == "reg-new"


def test_credentials_file_false_leaves_the_file_alone(agent_file: Path) -> None:
    write_file(agent_file, sandbox=saved_sandbox())
    before = agent_file.read_text()
    server = Server(
        {
            "POST /api/agent/identity/challenge": [httpx.Response(200, json=challenge("a"))],
            "POST /api/agent/identity": [httpx.Response(200, json=registration())],
            "POST /api/oauth2/token jwt-bearer": [token("whcc_sandbox")],
        }
    )
    sandbox = WebhooksCC.sandbox(base_url=BASE, credentials_file=False, http_client=server.http())
    assert sandbox.registration_id == "reg-anon"
    assert agent_file.read_text() == before


def test_a_path_overrides_the_file(tmp_path: Path, agent_file: Path) -> None:
    own = tmp_path / "elsewhere" / "agent.json"
    server = Server(
        {
            "POST /api/agent/identity/challenge": [httpx.Response(200, json=challenge("a"))],
            "POST /api/agent/identity": [httpx.Response(200, json=registration())],
            "POST /api/oauth2/token jwt-bearer": [token("whcc_sandbox")],
        }
    )
    WebhooksCC.sandbox(base_url=BASE, credentials_file=own, http_client=server.http())
    assert read_file(own)["sandbox"]["registration_id"] == "reg-anon"
    assert not agent_file.exists()


# --- sandbox calls --------------------------------------------------------------------


def cached_sandbox(agent_file: Path, server: Server) -> Any:
    write_file(
        agent_file,
        sandbox=saved_sandbox(access_token="whcc_cached", access_token_expires=later(minutes=30)),
    )
    return WebhooksCC.sandbox(base_url=BASE, http_client=server.http())


def test_wait_for_polls_the_sandbox_list(agent_file: Path) -> None:
    server = Server(
        {
            "GET /api/agent/sandbox/endpoints/sbx1/requests": [
                httpx.Response(200, json=[]),
                httpx.Response(200, json=[captured("r1")]),
            ]
        }
    )
    sandbox = cached_sandbox(agent_file, server)
    request = sandbox.requests.wait_for("sbx1", timeout="5s", poll_interval=10)
    assert request.id == "r1" and request.json() == {"type": "ping"}
    assert all(r.url.params["limit"] == "100" for r in server.requests)


def test_wait_for_all_refuses_more_than_one_endpoint_holds(agent_file: Path) -> None:
    sandbox = cached_sandbox(agent_file, Server({}))
    with pytest.raises(ValueError, match="at most 25"):
        sandbox.requests.wait_for_all("sbx1", count=26)


def test_refusals_raise_sandbox_errors_and_429_a_rate_limit(agent_file: Path) -> None:
    server = Server(
        {
            "POST /api/agent/sandbox/endpoints": [
                httpx.Response(
                    409,
                    json={"error": "sandbox_endpoint_limit", "error_description": "Delete one."},
                ),
                httpx.Response(429, json={"error": "rate_limited"}, headers={"Retry-After": "30"}),
            ],
            "GET /api/agent/sandbox/requests/r1": [
                httpx.Response(404, json={"error": "not_found"})
            ],
        }
    )
    sandbox = cached_sandbox(agent_file, server)
    with pytest.raises(SandboxError) as caught:
        sandbox.endpoints.create()
    assert (caught.value.code, caught.value.status_code, caught.value.message) == (
        "sandbox_endpoint_limit",
        409,
        "Delete one.",
    )
    with pytest.raises(RateLimitError) as limited:
        sandbox.endpoints.create()
    assert limited.value.retry_after == 30
    with pytest.raises(SandboxError, match="Sandbox request failed"):
        sandbox.requests.get("r1")


def test_delete_and_revoke(agent_file: Path) -> None:
    server = Server(
        {
            "DELETE /api/agent/sandbox/endpoints/sbx1": [httpx.Response(204)],
            "POST /api/oauth2/revoke": [httpx.Response(200, json={})],
        }
    )
    sandbox = cached_sandbox(agent_file, server)
    sandbox.endpoints.delete("sbx1")
    sandbox.revoke_token()
    assert parse_qs(server.requests[-1].content.decode())["token"] == ["whcc_cached"]
    assert "access_token" not in read_file(agent_file)["sandbox"]
    with pytest.raises(ValueError):
        sandbox.endpoints.delete("../etc")


# --- claiming -------------------------------------------------------------------------


@pytest.mark.skipif(os.name != "posix", reason="file modes are Unix")
def test_claim_with_the_claim_token_moves_the_sandbox(agent_file: Path) -> None:
    server = Server(
        {
            "POST /api/agent/identity/challenge": [httpx.Response(200, json=challenge("a"))],
            "POST /api/agent/identity": [httpx.Response(200, json=registration())],
            "POST /api/oauth2/token jwt-bearer": [token("whcc_sandbox")],
            "POST /api/agent/identity/claim": [
                httpx.Response(
                    200, json={"registration_id": "reg-anon", "claim_attempt": attempt()}
                )
            ],
            "POST /api/oauth2/token claim": [
                httpx.Response(400, json={"error": "authorization_pending"}),
                claimed(),
            ],
            "GET /api/usage": [
                httpx.Response(
                    200, json={"used": 3, "limit": 50000, "remaining": 49997, "plan": "pro"}
                )
            ],
        }
    )
    sandbox = WebhooksCC.sandbox(base_url=BASE, http_client=server.http())
    started = sandbox.claim("dev@example.com")
    assert started.user_code == "123456" and started.moves_endpoints
    claim_request = next(r for r in server.requests if r.url.path == "/api/agent/identity/claim")
    assert json.loads(claim_request.content) == {
        "claim_token": "clm_secret",
        "email": "dev@example.com",
    }

    client = sandbox.wait_for_claim(timeout="1m")
    assert client.usage().remaining == 49997
    assert server.bearers("/api/usage") == ["Bearer whcc_account"]

    entry = read_file(agent_file)
    assert set(entry) == {"claimed"}  # the sandbox moved into the account
    assert entry["claimed"]["registration_id"] == "reg-anon"
    assert entry["claimed"]["identity_assertion"] == "claimed-assertion"
    assert entry["claimed"]["email"] == "dev@example.com"
    assert entry["claimed"]["access_token"] == "whcc_account"
    assert stat.S_IMODE(agent_file.stat().st_mode) == 0o600
    assert "clm_" not in agent_file.read_text()

    with pytest.raises(SandboxError) as closed:
        sandbox.endpoints.list()
    assert closed.value.code == "sandbox_closed"


def test_claim_without_the_claim_token_registers_service_auth(agent_file: Path) -> None:
    write_file(
        agent_file,
        sandbox=saved_sandbox(access_token="whcc_cached", access_token_expires=later(minutes=30)),
    )

    def identity(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content) == {
            "type": "service_auth",
            "login_hint": "dev@example.com",
            "client_name": "my-agent",
        }
        return httpx.Response(
            200,
            json={
                "registration_id": "reg-service",
                "claim_token": "clm_service",
                "claim_token_expires": later(hours=24),
                "claim": attempt("777777"),
            },
        )

    server = Server(
        {
            "POST /api/agent/identity": [identity],
            "POST /api/oauth2/token claim": [claimed()],
            "GET /api/agent/sandbox/endpoints": [httpx.Response(200, json={"endpoints": []})],
        }
    )
    sandbox = WebhooksCC.sandbox(base_url=BASE, client_name="my-agent", http_client=server.http())
    started = sandbox.claim("dev@example.com")
    assert (started.user_code, started.moves_endpoints) == ("777777", False)
    assert started.registration_id == "reg-service"

    client = sandbox.wait_for_claim()
    assert isinstance(client, WebhooksCC)
    poll = next(r for r in server.requests if r.url.path == "/api/oauth2/token")
    assert parse_qs(poll.content.decode())["claim_token"] == ["clm_service"]

    entry = read_file(agent_file)
    assert entry["claimed"]["registration_id"] == "reg-service"
    assert entry["claimed"]["client_name"] == "my-agent"
    assert entry["sandbox"]["registration_id"] == "reg-saved"  # stays until it expires
    assert sandbox.endpoints.list() == []


def test_wait_for_claim_needs_a_claim(agent_file: Path) -> None:
    sandbox = cached_sandbox(agent_file, Server({}))
    with pytest.raises(RuntimeError, match="claim"):
        sandbox.wait_for_claim()


# --- connected agents -----------------------------------------------------------------


def usage_route() -> list[Reply]:
    return [
        httpx.Response(200, json={"used": 1, "limit": 50000, "remaining": 49999, "plan": "pro"})
    ]


def test_connected_is_none_without_a_claimed_slot(agent_file: Path) -> None:
    assert WebhooksCC.connected(base_url=BASE) is None
    write_file(agent_file, sandbox=saved_sandbox())
    assert WebhooksCC.connected(base_url=BASE) is None


def test_connected_uses_the_cached_token(agent_file: Path) -> None:
    write_file(
        agent_file,
        claimed=saved_claimed(access_token="whcc_cached", access_token_expires=later(minutes=30)),
    )
    server = Server({"GET /api/usage": usage_route()})
    client = WebhooksCC.connected(base_url=f"{BASE}/", http_client=server.http())
    assert client is not None
    assert server.calls == []
    assert client.usage().used == 1
    assert server.bearers("/api/usage") == ["Bearer whcc_cached"]


def test_connected_exchanges_and_drops_a_disconnected_agent(agent_file: Path) -> None:
    write_file(agent_file, claimed=saved_claimed(), sandbox=saved_sandbox())
    server = Server(
        {
            "POST /api/oauth2/token jwt-bearer": [
                httpx.Response(400, json={"error": "invalid_grant"})
            ]
        }
    )
    assert WebhooksCC.connected(base_url=BASE, http_client=server.http()) is None
    assert set(read_file(agent_file)) == {"sandbox"}

    write_file(agent_file, claimed=saved_claimed())
    server = Server(
        {
            "POST /api/oauth2/token jwt-bearer": [
                token("whcc_new", scope="webhooks:read webhooks:write")
            ],
            "GET /api/usage": usage_route(),
        }
    )
    client = WebhooksCC.connected(base_url=BASE, http_client=server.http())
    assert client is not None
    client.usage()
    assert server.bearers("/api/usage") == ["Bearer whcc_new"]
    assert read_file(agent_file)["claimed"]["access_token"] == "whcc_new"


def test_client_without_a_key_falls_back_to_the_connected_agent(
    agent_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("WHK_API_KEY", raising=False)
    monkeypatch.setenv("WHK_BASE_URL", BASE)
    write_file(
        agent_file,
        claimed=saved_claimed(access_token="whcc_stale", access_token_expires=later(minutes=30)),
    )
    server = Server(
        {
            "GET /api/usage": [httpx.Response(401, json={"error": "Unauthorized"}), *usage_route()],
            "POST /api/oauth2/token jwt-bearer": [token("whcc_renewed")],
        }
    )
    client = WebhooksCC(http_client=server.http())
    assert client.usage().remaining == 49999
    assert server.bearers("/api/usage") == ["Bearer whcc_stale", "Bearer whcc_renewed"]
    assert read_file(agent_file)["claimed"]["access_token"] == "whcc_renewed"


def test_account_client_refreshes_a_token_close_to_expiry(
    agent_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("WHK_API_KEY", raising=False)
    # 90 seconds left: usable when read, but due for renewal before the next call.
    write_file(
        agent_file,
        claimed=saved_claimed(access_token="whcc_old", access_token_expires=later(seconds=90)),
    )
    server = Server(
        {"GET /api/usage": usage_route(), "POST /api/oauth2/token jwt-bearer": [token("whcc_new")]}
    )
    client = WebhooksCC.connected(base_url=BASE, http_client=server.http())
    assert client is not None
    client.usage()
    assert server.bearers("/api/usage") == ["Bearer whcc_old"]
    monkeypatch.setattr(time, "time", lambda: datetime.now(timezone.utc).timestamp() + 60)
    client.usage()
    assert server.bearers("/api/usage") == ["Bearer whcc_old", "Bearer whcc_new"]


def test_a_disconnected_agent_is_a_401(agent_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WHK_API_KEY", raising=False)
    write_file(agent_file, claimed=saved_claimed())
    server = Server(
        {
            "POST /api/oauth2/token jwt-bearer": [
                httpx.Response(400, json={"error": "invalid_grant"})
            ]
        }
    )
    client = WebhooksCC(base_url=BASE, http_client=server.http())
    with pytest.raises(UnauthorizedError, match="invalid_grant"):
        client.usage()
    assert not agent_file.exists()


def test_an_api_key_wins_over_the_file(agent_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_file(
        agent_file,
        claimed=saved_claimed(access_token="whcc_agent", access_token_expires=later(minutes=30)),
    )
    monkeypatch.setenv("WHK_API_KEY", "whcc_key")
    server = Server({"GET /api/usage": usage_route()})
    WebhooksCC(base_url=BASE, http_client=server.http()).usage()
    WebhooksCC("whcc_passed", base_url=BASE, http_client=server.http()).usage()
    assert server.bearers("/api/usage") == ["Bearer whcc_key", "Bearer whcc_passed"]


def test_missing_key_names_the_agent_ways_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WHK_API_KEY", raising=False)
    with pytest.raises(ValueError) as caught:
        WebhooksCC(base_url=BASE)
    message = str(caught.value)
    assert "WHK_API_KEY" in message
    assert "WebhooksCC.sandbox()" in message and "WebhooksCC.connect(email)" in message


def test_connect_waits_and_saves_the_connection(agent_file: Path) -> None:
    server = Server(
        {
            "POST /api/agent/identity": [
                httpx.Response(
                    200,
                    json={
                        "registration_id": "reg-connect",
                        "claim_token": "clm_connect",
                        "claim_token_expires": later(hours=24),
                        "claim": attempt("111111"),
                    },
                )
            ],
            "POST /api/agent/identity/claim": [
                httpx.Response(
                    200, json={"registration_id": "reg-connect", "claim_attempt": attempt("222222")}
                )
            ],
            "POST /api/oauth2/token claim": [
                httpx.Response(400, json={"error": "expired_token"}),
                claimed(),
            ],
            "GET /api/usage": usage_route(),
        }
    )
    pending = WebhooksCC.connect("dev@example.com", base_url=BASE, http_client=server.http())
    assert pending.user_code == "111111"
    assert "clm_" not in repr(pending)
    with pytest.raises(AgentAuthError) as expired:
        pending.wait()
    assert expired.value.code == "expired_token"

    assert pending.restart().user_code == "222222"
    restarted = next(r for r in server.requests if r.url.path == "/api/agent/identity/claim")
    assert json.loads(restarted.content) == {
        "claim_token": "clm_connect",
        "email": "dev@example.com",
    }

    client = pending.wait()
    client.usage()
    assert server.bearers("/api/usage") == ["Bearer whcc_account"]
    saved = read_file(agent_file)["claimed"]
    assert saved["registration_id"] == "reg-connect"
    assert saved["client_name"] == "webhooks-cc-python"
    assert WebhooksCC.connected(base_url=BASE, http_client=server.http()) is not None


def test_a_stream_401_exchanges_once_more(agent_file: Path) -> None:
    write_file(
        agent_file,
        claimed=saved_claimed(access_token="whcc_stale", access_token_expires=later(minutes=30)),
    )
    frame = f"event: request\ndata: {json.dumps(captured('r1'))}\n\n"
    server = Server(
        {
            "GET /api/stream/sbx1": [
                httpx.Response(401, text="Unauthorized"),
                httpx.Response(
                    200,
                    headers={"content-type": "text/event-stream"},
                    content=(frame + "event: endpoint_deleted\ndata: {}\n\n").encode(),
                ),
            ],
            "POST /api/oauth2/token jwt-bearer": [token("whcc_renewed")],
        }
    )
    client = WebhooksCC.connected(base_url=BASE, http_client=server.http())
    assert client is not None
    assert [request.id for request in client.requests.subscribe("sbx1")] == ["r1"]
    assert server.bearers("/api/stream") == ["Bearer whcc_stale", "Bearer whcc_renewed"]
