"""The auth.md v0.6 steps for an agent, one function each.

See https://webhooks.cc/auth.md: discover, get and solve a proof-of-work
challenge, register (anonymous or service_auth), exchange the identity
assertion for an access token, start a claim and poll it, revoke a token.

Most callers want :meth:`WebhooksCC.sandbox() <webhooks_cc.WebhooksCC.sandbox>`
or :meth:`WebhooksCC.connect() <webhooks_cc.WebhooksCC.connect>`, which run
these in order and keep the result in the shared credential file. Everything
here is unauthenticated or uses the agent's own assertion and tokens; no API
key is involved. ``base_url`` defaults to ``WHK_BASE_URL``, else
https://webhooks.cc, and ``timeout`` (per request) to 30 seconds.
"""

from __future__ import annotations

import hashlib
import math
import os
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import httpx

from . import __version__
from .credentials import parse_timestamp
from .durations import Duration, parse_duration
from .errors import TimeoutError, WebhooksCCError

DEFAULT_BASE_URL = "https://webhooks.cc"
BASE_URL_ENV = "WHK_BASE_URL"
DEFAULT_CLIENT_NAME = "webhooks-cc-python"
"""The ``client_name`` the SDK registers with unless you pass one: the human sees it,
labelled as self-reported, when they connect the agent."""

JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"
CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim"
POW_ALGORITHM = "sha256-zero-bits"
MAX_POW_WORK_BITS = 26
"""Expected work above 2**26 hashes is refused, so a hostile or broken server cannot pin
the CPU. webhooks.cc never asks for more."""

_DEFAULT_TIMEOUT_MS = 30_000
_DEFAULT_CLAIM_TIMEOUT_MS = 15 * 60 * 1000
_SLOW_DOWN_SECONDS = 5


class AgentAuthError(WebhooksCCError):
    """A refused step. ``code`` is auth.md's or OAuth's error code (``invalid_grant``,
    ``invalid_challenge``, ``rate_limited``, ...), ``status`` the HTTP status (0 when no
    request failed, as for ``timeout``), and ``details`` the rest of the error body, such
    as a fresh challenge. ``retry_after`` is in seconds when the server said."""

    def __init__(
        self,
        code: str,
        status: int,
        description: str | None = None,
        details: Mapping[str, Any] | None = None,
        *,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(
            status, f"{code} (HTTP {status})" + (f": {description}" if description else "")
        )
        self.code = code
        self.status = status
        self.description = description
        self.details: dict[str, Any] = dict(details or {})
        self.retry_after = retry_after


class PowError(ValueError):
    """A proof-of-work challenge the solver will not take on."""


# --- results ------------------------------------------------------------------------


@dataclass(frozen=True)
class AgentDiscovery:
    """The authorization server metadata (auth.md Step 1b)."""

    issuer: str
    token_endpoint: str
    revocation_endpoint: str
    identity_endpoint: str
    claim_endpoint: str
    identity_types: list[str]
    grant_types: list[str]
    challenge_endpoint: str | None = None
    sandbox_endpoints_url: str | None = None


@dataclass(frozen=True)
class PowChallenge:
    """A proof-of-work challenge: for each ``i`` below ``count``, find a decimal nonce so
    that SHA-256 of ``<challenge>.<i>.<nonce>`` starts with ``difficulty`` zero bits."""

    challenge: str
    algorithm: str
    difficulty: int
    count: int
    expires_at: str | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> PowChallenge:
        return cls(
            challenge=str(data.get("challenge") or ""),
            algorithm=str(data.get("algorithm") or ""),
            difficulty=_whole(data.get("difficulty")),
            count=_whole(data.get("count")),
            expires_at=data.get("expires_at") if isinstance(data.get("expires_at"), str) else None,
        )


@dataclass(frozen=True)
class SandboxInfo:
    """What an anonymous registration's sandbox holds. ``status`` is ``"full"`` when the
    shared sandbox has no free endpoint slot."""

    status: Literal["available", "full"]
    endpoints_url: str
    max_endpoints: int
    max_requests_per_endpoint: int
    max_requests: int


@dataclass(frozen=True)
class AnonymousRegistration:
    """An anonymous registration. Keep ``claim_token`` in memory only: it starts a claim
    and collects its result, and auth.md asks agents never to persist it."""

    registration_id: str
    identity_assertion: str = field(repr=False)
    assertion_expires: datetime
    claim_token: str = field(repr=False)
    claim_token_expires: datetime
    pre_claim_scopes: list[str]
    post_claim_scopes: list[str]
    sandbox: SandboxInfo


@dataclass(frozen=True)
class ClaimAttempt:
    """A claim attempt: show the human ``verification_uri`` and ``user_code`` together.
    ``interval`` is the seconds to wait between polls."""

    user_code: str
    verification_uri: str
    expires_at: datetime
    interval: int
    registration_id: str | None = None


@dataclass(frozen=True)
class ServiceAuthRegistration:
    """A registration for a human you know by email. ``claim`` is its first attempt."""

    registration_id: str
    claim_token: str = field(repr=False)
    claim_token_expires: datetime
    post_claim_scopes: list[str]
    claim: ClaimAttempt


@dataclass(frozen=True)
class AccessToken:
    """An access token and when it stops working."""

    access_token: str = field(repr=False)
    scope: str
    expires_at: datetime


@dataclass(frozen=True)
class ClaimedAgent:
    """A completed claim: an account token, and the claimed assertion that mints new
    ones (90 days)."""

    token: AccessToken
    identity_assertion: str = field(repr=False)
    assertion_expires: datetime


@dataclass(frozen=True)
class ClaimPoll:
    """One poll of the claim grant. ``claimed`` is set when ``status`` is ``"claimed"``."""

    status: Literal["pending", "slow_down", "expired", "denied", "claimed"]
    claimed: ClaimedAgent | None = None


# --- plumbing -----------------------------------------------------------------------


def _whole(value: Any) -> int:
    if isinstance(value, bool):
        return -1
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return -1


def resolve_base_url(base_url: str | None = None) -> str:
    """``base_url``, else ``WHK_BASE_URL``, else https://webhooks.cc, without trailing
    slashes."""
    return (base_url or os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL).rstrip("/")


@contextmanager
def _session(http_client: httpx.Client | None) -> Iterator[httpx.Client]:
    if http_client is not None:
        yield http_client
        return
    with httpx.Client(headers={"User-Agent": f"webhooks-cc-python/{__version__}"}) as http:
        yield http


def _call(
    http: httpx.Client,
    base_url: str | None,
    path: str,
    timeout: Duration | None,
    *,
    json: Any = None,
    form: Mapping[str, str] | None = None,
) -> tuple[int, dict[str, Any], httpx.Headers]:
    timeout_ms = parse_duration(timeout) if timeout is not None else _DEFAULT_TIMEOUT_MS
    try:
        response = http.request(
            "GET" if json is None and form is None else "POST",
            f"{resolve_base_url(base_url)}{path}",
            json=json,
            data=dict(form) if form is not None else None,
            headers={"Accept": "application/json"},
            timeout=timeout_ms / 1000,
        )
    except httpx.TimeoutException:
        raise TimeoutError(timeout_ms) from None
    body: dict[str, Any] = {}
    if response.content:
        try:
            parsed = response.json()
        except ValueError:
            parsed = None  # non-JSON bodies only come with errors; the status says enough
        if isinstance(parsed, dict):
            body = parsed
    return response.status_code, body, response.headers


def _fail(status: int, body: Mapping[str, Any], headers: httpx.Headers) -> AgentAuthError:
    details = {
        key: value for key, value in body.items() if key not in ("error", "error_description")
    }
    error = body.get("error")
    description = body.get("error_description")
    retry_after = headers.get("retry-after")
    return AgentAuthError(
        error if isinstance(error, str) else f"http_{status}",
        status,
        description if isinstance(description, str) else None,
        details,
        retry_after=int(retry_after) if retry_after and retry_after.strip().isdigit() else None,
    )


def _string(body: Mapping[str, Any], key: str, status: int = 200) -> str:
    value = body.get(key)
    if not isinstance(value, str):
        raise AgentAuthError("invalid_response", status, f"Malformed response: missing {key}")
    return value


def _time(body: Mapping[str, Any], key: str, status: int = 200) -> datetime:
    millis = parse_timestamp(_string(body, key, status))
    if millis is None:
        raise AgentAuthError("invalid_response", status, f"Malformed response: {key}")
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc)


def _seconds_from_now(value: Any, default: float) -> datetime:
    seconds = value if isinstance(value, (int, float)) and not isinstance(value, bool) else default
    return datetime.now(timezone.utc) + timedelta(seconds=seconds)


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _strings(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _number(value: Any, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return int(value)


# --- discovery ----------------------------------------------------------------------


def discover(
    *,
    base_url: str | None = None,
    timeout: Duration | None = None,
    http_client: httpx.Client | None = None,
) -> AgentDiscovery:
    """Read the authorization server metadata (auth.md Step 1b)."""
    with _session(http_client) as http:
        status, body, headers = _call(
            http, base_url, "/.well-known/oauth-authorization-server", timeout
        )
    if status != 200:
        raise _fail(status, body, headers)
    agent = _object(body.get("agent_auth"))
    anonymous = _object(agent.get("anonymous"))
    challenge_endpoint = _object(anonymous.get("proof_of_work")).get("challenge_endpoint")
    sandbox_url = _object(anonymous.get("sandbox")).get("endpoints_url")
    return AgentDiscovery(
        issuer=_string(body, "issuer"),
        token_endpoint=_string(body, "token_endpoint"),
        revocation_endpoint=_string(body, "revocation_endpoint"),
        identity_endpoint=_string(agent, "identity_endpoint"),
        claim_endpoint=_string(agent, "claim_endpoint"),
        identity_types=_strings(agent.get("identity_types_supported")),
        grant_types=_strings(body.get("grant_types_supported")),
        challenge_endpoint=challenge_endpoint if isinstance(challenge_endpoint, str) else None,
        sandbox_endpoints_url=sandbox_url if isinstance(sandbox_url, str) else None,
    )


# --- proof of work ------------------------------------------------------------------


def challenge(
    *,
    base_url: str | None = None,
    timeout: Duration | None = None,
    http_client: httpx.Client | None = None,
) -> PowChallenge:
    """A fresh proof-of-work challenge for anonymous registration."""
    with _session(http_client) as http:
        status, body, headers = _call(
            http, base_url, "/api/agent/identity/challenge", timeout, json={}
        )
    if status != 200:
        raise _fail(status, body, headers)
    return PowChallenge.from_dict(body)


def check_challenge(challenge: PowChallenge | Mapping[str, Any]) -> PowChallenge:
    """The challenge, checked before any CPU is spent on it.

    Raises :class:`PowError` for an unknown algorithm, parameters out of range, or
    more expected work than ``2**MAX_POW_WORK_BITS`` hashes.
    """
    parsed = challenge if isinstance(challenge, PowChallenge) else PowChallenge.from_dict(challenge)
    if parsed.algorithm != POW_ALGORITHM:
        raise PowError(f"Unsupported proof-of-work algorithm: {parsed.algorithm}")
    if not (0 <= parsed.difficulty <= 32 and 1 <= parsed.count <= 64):
        raise PowError("Invalid proof-of-work parameters")
    if parsed.difficulty + math.log2(parsed.count) > MAX_POW_WORK_BITS:
        raise PowError(
            f"Refusing proof of work above 2^{MAX_POW_WORK_BITS} hashes "
            f"(difficulty {parsed.difficulty} x {parsed.count})"
        )
    return parsed


def _solve_one(prefix: str, difficulty: int) -> str:
    # The prefix is hashed once; each attempt copies that state and adds only the digits.
    base = hashlib.sha256(prefix.encode("utf-8"))
    shift = 256 - difficulty
    nonce = 0
    while True:
        attempt = base.copy()
        attempt.update(str(nonce).encode("ascii"))
        if int.from_bytes(attempt.digest(), "big") >> shift == 0:
            return str(nonce)
        nonce += 1


def solve_challenge(challenge: PowChallenge | Mapping[str, Any]) -> list[str]:
    """One nonce per sub-puzzle, each the smallest that works (a few seconds of CPU at
    the difficulty webhooks.cc asks for). Raises :class:`PowError` first when the
    challenge is one :func:`check_challenge` refuses."""
    parsed = check_challenge(challenge)
    return [
        _solve_one(f"{parsed.challenge}.{index}.", parsed.difficulty)
        for index in range(parsed.count)
    ]


# --- registration -------------------------------------------------------------------


def _anonymous_registration(body: Mapping[str, Any]) -> AnonymousRegistration:
    sandbox = _object(body.get("sandbox"))
    return AnonymousRegistration(
        registration_id=_string(body, "registration_id"),
        identity_assertion=_string(body, "identity_assertion"),
        assertion_expires=_time(body, "assertion_expires"),
        claim_token=_string(body, "claim_token"),
        claim_token_expires=_time(body, "claim_token_expires"),
        pre_claim_scopes=_strings(body.get("pre_claim_scopes")),
        post_claim_scopes=_strings(body.get("post_claim_scopes")),
        sandbox=SandboxInfo(
            status="full" if sandbox.get("status") == "full" else "available",
            endpoints_url=str(sandbox.get("endpoints_url") or ""),
            max_endpoints=_number(sandbox.get("max_endpoints"), 3),
            max_requests_per_endpoint=_number(sandbox.get("max_requests_per_endpoint"), 25),
            max_requests=_number(sandbox.get("max_requests"), 100),
        ),
    )


def _claim_attempt(block: Any, registration_id: str | None = None) -> ClaimAttempt:
    data = _object(block)
    return ClaimAttempt(
        user_code=_string(data, "user_code"),
        verification_uri=_string(data, "verification_uri"),
        expires_at=_seconds_from_now(data.get("expires_in"), 0),
        interval=_number(data.get("interval"), 5),
        registration_id=registration_id,
    )


def register_anonymous(
    *,
    client_name: str | None = None,
    base_url: str | None = None,
    timeout: Duration | None = None,
    http_client: httpx.Client | None = None,
) -> AnonymousRegistration:
    """Register anonymously: fetch a challenge, solve it and register.

    Retries once with the fresh challenge the server sends when it refuses the
    first (it expired while solving, for example). ``client_name`` (at most 64
    characters) is shown to the human as self-reported. Each IP address may
    register 5 times an hour.
    """
    with _session(http_client) as http:
        current = challenge(base_url=base_url, timeout=timeout, http_client=http)
        for attempt in range(2):
            nonces = solve_challenge(current)
            payload: dict[str, Any] = {
                "type": "anonymous",
                "proof_of_work": {"challenge": current.challenge, "nonces": nonces},
            }
            if client_name:
                payload["client_name"] = client_name
            status, body, headers = _call(
                http, base_url, "/api/agent/identity", timeout, json=payload
            )
            if status == 200:
                return _anonymous_registration(body)
            fresh = isinstance(body.get("challenge"), str) and body.get("error") in (
                "invalid_challenge",
                "proof_of_work_required",
            )
            if attempt == 0 and fresh:
                current = PowChallenge.from_dict(body)
                continue
            raise _fail(status, body, headers)
    raise AssertionError("unreachable")  # pragma: no cover


def register_service_auth(
    email: str,
    *,
    client_name: str | None = None,
    base_url: str | None = None,
    timeout: Duration | None = None,
    http_client: httpx.Client | None = None,
) -> ServiceAuthRegistration:
    """Register for a human you know by email (service_auth). No proof of work, and
    nothing works until that human signs in and enters the code in ``claim``."""
    payload: dict[str, Any] = {"type": "service_auth", "login_hint": email}
    if client_name:
        payload["client_name"] = client_name
    with _session(http_client) as http:
        status, body, headers = _call(http, base_url, "/api/agent/identity", timeout, json=payload)
    if status != 200:
        raise _fail(status, body, headers)
    registration_id = _string(body, "registration_id")
    return ServiceAuthRegistration(
        registration_id=registration_id,
        claim_token=_string(body, "claim_token"),
        claim_token_expires=_time(body, "claim_token_expires"),
        post_claim_scopes=_strings(body.get("post_claim_scopes")),
        claim=_claim_attempt(body.get("claim"), registration_id),
    )


# --- tokens -------------------------------------------------------------------------


def _access_token(body: Mapping[str, Any]) -> AccessToken:
    return AccessToken(
        access_token=_string(body, "access_token"),
        scope=str(body.get("scope") or ""),
        expires_at=_seconds_from_now(body.get("expires_in"), 3600),
    )


def exchange(
    assertion: str,
    *,
    base_url: str | None = None,
    timeout: Duration | None = None,
    http_client: httpx.Client | None = None,
) -> AccessToken:
    """Exchange an identity assertion for an access token (auth.md Step 5).

    ``invalid_grant`` means the registration expired, was revoked or was claimed.
    """
    form = {"grant_type": JWT_BEARER_GRANT, "assertion": assertion}
    with _session(http_client) as http:
        status, body, headers = _call(http, base_url, "/api/oauth2/token", timeout, form=form)
    if status != 200:
        raise _fail(status, body, headers)
    return _access_token(body)


def revoke(
    token: str,
    *,
    base_url: str | None = None,
    timeout: Duration | None = None,
    http_client: httpx.Client | None = None,
) -> None:
    """Drop one access token (RFC 7009). The assertion keeps working."""
    form = {"token": token, "token_type_hint": "access_token"}
    with _session(http_client) as http:
        status, body, headers = _call(http, base_url, "/api/oauth2/revoke", timeout, form=form)
    if status != 200:
        raise _fail(status, body, headers)


# --- claim ceremony -----------------------------------------------------------------


def start_claim(
    claim_token: str,
    *,
    email: str | None = None,
    base_url: str | None = None,
    timeout: Duration | None = None,
    http_client: httpx.Client | None = None,
) -> ClaimAttempt:
    """Start a claim attempt (auth.md Step 4a).

    ``email`` names the only person who may complete it; a service_auth
    registration may leave it out. Starting again replaces the previous attempt.
    """
    payload: dict[str, Any] = {"claim_token": claim_token}
    if email:
        payload["email"] = email
    with _session(http_client) as http:
        status, body, headers = _call(
            http, base_url, "/api/agent/identity/claim", timeout, json=payload
        )
    if status != 200:
        raise _fail(status, body, headers)
    return _claim_attempt(body.get("claim_attempt"), _string(body, "registration_id"))


def poll_claim(
    claim_token: str,
    *,
    base_url: str | None = None,
    timeout: Duration | None = None,
    http_client: httpx.Client | None = None,
) -> ClaimPoll:
    """One poll of the claim grant (auth.md Step 4c)."""
    form = {"grant_type": CLAIM_GRANT, "claim_token": claim_token}
    with _session(http_client) as http:
        status, body, headers = _call(http, base_url, "/api/oauth2/token", timeout, form=form)
    if status == 200:
        return ClaimPoll(
            "claimed",
            ClaimedAgent(
                token=_access_token(body),
                identity_assertion=_string(body, "identity_assertion"),
                assertion_expires=_time(body, "assertion_expires"),
            ),
        )
    error = body.get("error")
    if error == "authorization_pending":
        return ClaimPoll("pending")
    if error == "slow_down":
        return ClaimPoll("slow_down")
    if error == "expired_token":
        return ClaimPoll("expired")
    if error == "access_denied":
        return ClaimPoll("denied")
    raise _fail(status, body, headers)


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def wait_for_claim(
    claim_token: str,
    *,
    interval: float = 5,
    timeout: Duration = _DEFAULT_CLAIM_TIMEOUT_MS,
    base_url: str | None = None,
    request_timeout: Duration | None = None,
    http_client: httpx.Client | None = None,
) -> ClaimedAgent:
    """Poll until the human connects the agent.

    ``interval`` is in seconds, like :attr:`ClaimAttempt.interval`; ``timeout``
    (default 15 minutes, one code's lifetime) is a duration. Raises
    :class:`AgentAuthError` ``expired_token`` (start a new attempt),
    ``access_denied`` or ``timeout``.
    """
    pause = max(0.0, float(interval))
    deadline = time.monotonic() + parse_duration(timeout) / 1000
    with _session(http_client) as http:
        while True:
            result = poll_claim(
                claim_token, base_url=base_url, timeout=request_timeout, http_client=http
            )
            if result.claimed is not None:
                return result.claimed
            if result.status == "expired":
                raise AgentAuthError("expired_token", 400, "The code expired. Start a new claim.")
            if result.status == "denied":
                raise AgentAuthError("access_denied", 400, "The human declined.")
            if result.status == "slow_down":
                pause += _SLOW_DOWN_SECONDS
            if time.monotonic() + pause > deadline:
                raise AgentAuthError("timeout", 0, "The human did not connect the agent in time.")
            _sleep(pause)
