"""The auth.md steps (webhooks_cc.agent) against a mocked server, and the proof-of-work solver."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest

from webhooks_cc import agent
from webhooks_cc.agent import (
    AgentAuthError,
    PowChallenge,
    PowError,
    check_challenge,
    exchange,
    poll_claim,
    register_anonymous,
    register_service_auth,
    solve_challenge,
    start_claim,
    wait_for_claim,
)
from webhooks_cc.errors import WebhooksCCError

BASE = "https://agent.test"
# The server's fixture: the TypeScript solver and the server agree on these nonces,
# which are the smallest that work, so this solver must find exactly them.
POW_VECTORS = (
    Path(__file__).resolve().parents[3] / "apps" / "web" / "lib" / "agent" / "pow-vectors.json"
)


def _vectors() -> list[dict[str, Any]]:
    with POW_VECTORS.open(encoding="utf-8") as file:
        vectors: list[dict[str, Any]] = json.load(file)["vectors"]
    return vectors


def leading_zero_bits(challenge: str, index: int, nonce: str) -> int:
    """An independent checker: the zero bits SHA-256 of the whole string starts with."""
    digest = hashlib.sha256(f"{challenge}.{index}.{nonce}".encode()).digest()
    value = int.from_bytes(digest, "big")
    return 256 - value.bit_length()


@pytest.mark.parametrize(
    "vector", _vectors(), ids=lambda v: f"difficulty {v['difficulty']} x {v['count']}"
)
def test_solver_finds_the_servers_nonces(vector: dict[str, Any]) -> None:
    nonces = solve_challenge({**vector, "algorithm": "sha256-zero-bits"})
    assert nonces == vector["nonces"]
    for index, nonce in enumerate(nonces):
        assert leading_zero_bits(vector["challenge"], index, nonce) >= vector["difficulty"]


@pytest.mark.parametrize("length", [40, 50, 55, 60, 63, 64, 200])
def test_solver_works_across_block_boundaries(length: int) -> None:
    challenge = f"pow1.{'a' * length}.sig"
    nonces = solve_challenge(
        PowChallenge(challenge=challenge, algorithm="sha256-zero-bits", difficulty=10, count=3)
    )
    assert len(nonces) == 3
    for index, nonce in enumerate(nonces):
        assert nonce.isdigit()
        assert leading_zero_bits(challenge, index, nonce) >= 10


def test_checker_refuses_unknown_algorithms_and_too_much_work() -> None:
    base = {"challenge": "c", "algorithm": "sha256-zero-bits", "difficulty": 18, "count": 32}
    check_challenge(base)
    with pytest.raises(PowError, match="algorithm"):
        check_challenge({**base, "algorithm": "scrypt"})
    with pytest.raises(PowError, match=r"2\^26"):
        check_challenge({**base, "difficulty": 22})
    with pytest.raises(PowError):
        check_challenge({**base, "count": 0})
    with pytest.raises(PowError):
        check_challenge({**base, "difficulty": 1.5})
    with pytest.raises(PowError):
        check_challenge({**base, "difficulty": True})
    with pytest.raises(PowError):
        solve_challenge({**base, "difficulty": 33, "count": 1})


# --- protocol steps -------------------------------------------------------------------


REGISTRATION = {
    "registration_id": "11111111-1111-4111-8111-111111111111",
    "registration_type": "anonymous",
    "identity_assertion": "assertion-1",
    "assertion_expires": "2026-10-29T00:00:00.000Z",
    "pre_claim_scopes": ["webhooks:sandbox"],
    "claim_url": f"{BASE}/api/agent/identity/claim",
    "claim_token": "clm_token",
    "claim_token_expires": "2026-10-29T00:00:00.000Z",
    "post_claim_scopes": ["webhooks:read", "webhooks:write"],
    "sandbox": {"status": "available", "endpoints_url": f"{BASE}/api/agent/sandbox/endpoints"},
}


def challenge_body(name: str) -> dict[str, Any]:
    return {
        "challenge": f"pow1.{name}.sig",
        "algorithm": "sha256-zero-bits",
        "difficulty": 4,
        "count": 2,
    }


def mock(handler: Any) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def form(request: httpx.Request) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(request.content.decode()).items()}


def test_register_anonymous_retries_once_with_the_fresh_challenge() -> None:
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/agent/identity/challenge":
            return httpx.Response(200, json=challenge_body("first"))
        body = json.loads(request.content)
        sent.append(body)
        if len(sent) == 1:
            return httpx.Response(
                400,
                json={
                    "error": "invalid_challenge",
                    "error_description": "expired",
                    **challenge_body("second"),
                },
            )
        return httpx.Response(200, json=REGISTRATION)

    result = register_anonymous(client_name="unit", base_url=BASE, http_client=mock(handler))
    assert result.registration_id == REGISTRATION["registration_id"]
    assert result.claim_token == "clm_token"
    assert result.sandbox.status == "available"
    assert "clm_token" not in repr(result) and "assertion-1" not in repr(result)

    assert [body["proof_of_work"]["challenge"] for body in sent] == [
        "pow1.first.sig",
        "pow1.second.sig",
    ]
    assert sent[1]["type"] == "anonymous" and sent[1]["client_name"] == "unit"
    for index, nonce in enumerate(sent[1]["proof_of_work"]["nonces"]):
        assert leading_zero_bits("pow1.second.sig", index, nonce) >= 4


def test_register_anonymous_gives_up_after_the_second_refusal() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/agent/identity/challenge":
            return httpx.Response(200, json=challenge_body("a"))
        return httpx.Response(400, json={"error": "invalid_challenge", **challenge_body("b")})

    with pytest.raises(AgentAuthError) as caught:
        register_anonymous(base_url=BASE, http_client=mock(handler))
    assert caught.value.code == "invalid_challenge"
    assert caught.value.details["challenge"] == "pow1.b.sig"
    assert isinstance(caught.value, WebhooksCCError)


def test_rate_limited_registration_reports_retry_after() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/agent/identity/challenge":
            return httpx.Response(200, json=challenge_body("a"))
        return httpx.Response(
            429,
            json={"error": "rate_limited", "error_description": "Too many requests."},
            headers={"Retry-After": "120"},
        )

    with pytest.raises(AgentAuthError) as caught:
        register_anonymous(base_url=BASE, http_client=mock(handler))
    assert (caught.value.code, caught.value.status, caught.value.retry_after) == (
        "rate_limited",
        429,
        120,
    )


def test_exchange_sends_only_the_grant_and_the_assertion() -> None:
    seen: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(form(request))
        return httpx.Response(
            200, json={"access_token": "whcc_a", "expires_in": 3600, "scope": "webhooks:sandbox"}
        )

    token = exchange("assertion-1", base_url=BASE, http_client=mock(handler))
    assert token.access_token == "whcc_a" and token.scope == "webhooks:sandbox"
    # resource is left out: the server compares it with its own public URL.
    assert seen == [
        {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": "assertion-1"}
    ]


def test_exchange_reports_invalid_grant() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_grant", "error_description": "gone"})

    with pytest.raises(AgentAuthError) as caught:
        exchange("assertion-1", base_url=BASE, http_client=mock(handler))
    assert caught.value.code == "invalid_grant"
    assert str(caught.value) == "invalid_grant (HTTP 400): gone"


def test_service_auth_and_claim_attempts() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("type") == "service_auth":
            assert body == {
                "type": "service_auth",
                "login_hint": "dev@example.com",
                "client_name": "unit",
            }
            return httpx.Response(
                200,
                json={
                    "registration_id": "reg-s",
                    "claim_token": "clm_s",
                    "claim_token_expires": "2026-10-29T00:00:00Z",
                    "post_claim_scopes": ["webhooks:read"],
                    "claim": {
                        "user_code": "123456",
                        "expires_in": 900,
                        "verification_uri": f"{BASE}/agent/claim?attempt=cat_1",
                        "interval": 5,
                    },
                },
            )
        assert body == {"claim_token": "clm_s", "email": "dev@example.com"}
        return httpx.Response(
            200,
            json={
                "registration_id": "reg-s",
                "claim_attempt": {
                    "user_code": "654321",
                    "expires_in": 900,
                    "verification_uri": f"{BASE}/agent/claim?attempt=cat_2",
                    "interval": 7,
                },
            },
        )

    http = mock(handler)
    registration = register_service_auth(
        "dev@example.com", client_name="unit", base_url=BASE, http_client=http
    )
    assert registration.claim.user_code == "123456"
    assert registration.claim.registration_id == "reg-s"
    attempt = start_claim("clm_s", email="dev@example.com", base_url=BASE, http_client=http)
    assert (attempt.user_code, attempt.interval, attempt.registration_id) == ("654321", 7, "reg-s")


def claimed_body() -> dict[str, Any]:
    return {
        "access_token": "whcc_account",
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": "webhooks:read webhooks:write",
        "identity_assertion": "claimed-assertion",
        "assertion_expires": "2027-01-26T00:00:00.000Z",
    }


def test_wait_for_claim_polls_until_claimed(monkeypatch: pytest.MonkeyPatch) -> None:
    pauses: list[float] = []
    monkeypatch.setattr(agent, "_sleep", pauses.append)
    answers = [
        httpx.Response(400, json={"error": "authorization_pending"}),
        httpx.Response(400, json={"error": "slow_down"}),
        httpx.Response(200, json=claimed_body()),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert form(request) == {
            "grant_type": "urn:workos:agent-auth:grant-type:claim",
            "claim_token": "clm_token",
        }
        return answers.pop(0)

    claimed = wait_for_claim("clm_token", interval=5, base_url=BASE, http_client=mock(handler))
    assert claimed.token.access_token == "whcc_account"
    assert claimed.identity_assertion == "claimed-assertion"
    assert pauses == [5, 10]


@pytest.mark.parametrize(
    ("error", "code"), [("expired_token", "expired_token"), ("access_denied", "access_denied")]
)
def test_wait_for_claim_stops_when_the_code_ends(
    monkeypatch: pytest.MonkeyPatch, error: str, code: str
) -> None:
    monkeypatch.setattr(agent, "_sleep", lambda _seconds: None)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": error})

    with pytest.raises(AgentAuthError) as caught:
        wait_for_claim("clm_token", base_url=BASE, http_client=mock(handler))
    assert caught.value.code == code


def test_wait_for_claim_times_out() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "authorization_pending"})

    with pytest.raises(AgentAuthError) as caught:
        wait_for_claim(
            "clm_token", interval=5, timeout="1s", base_url=BASE, http_client=mock(handler)
        )
    assert caught.value.code == "timeout"


def test_poll_claim_raises_other_errors() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_grant"})

    with pytest.raises(AgentAuthError, match="invalid_grant"):
        poll_claim("clm_token", base_url=BASE, http_client=mock(handler))
