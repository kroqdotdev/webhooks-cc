"""The agent sandbox: webhook capture without an account, and connecting an agent to one.

:meth:`WebhooksCC.sandbox() <webhooks_cc.WebhooksCC.sandbox>` registers
anonymously (with a few seconds of proof of work), or reuses the sandbox in
the shared agent credential file, and returns a :class:`SandboxClient`: up to
3 endpoints, 25 captured requests each and 100 in all, gone after 24 hours.
:meth:`SandboxClient.claim` and :meth:`SandboxClient.wait_for_claim` connect
the agent to a human's account and return a full ``WebhooksCC`` client.
:meth:`WebhooksCC.connect() <webhooks_cc.WebhooksCC.connect>` does the same
without a sandbox.
"""

from __future__ import annotations

import builtins
import json
import os
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any

import httpx

from . import __version__
from ._agent_tokens import AgentTokens, SlotBinding, cached_token
from .agent import (
    DEFAULT_CLIENT_NAME,
    AgentAuthError,
    ClaimAttempt,
    ClaimedAgent,
    register_anonymous,
    register_service_auth,
    resolve_base_url,
    revoke,
    start_claim,
    wait_for_claim,
)
from .client import (
    _DEFAULT_TIMEOUT_MS,
    DEFAULT_WEBHOOK_URL,
    WEBHOOK_URL_ENV,
    WebhooksCC,
    _collect,
    _map_error,
    _validate_segment,
    _wait_list_limit,
)
from .credentials import AgentCredentialStore, AgentSlot, format_timestamp, parse_timestamp
from .durations import Duration, parse_duration
from .errors import TimeoutError, WebhooksCCError
from .matchers import Matcher
from .models import Request, SandboxEndpoint

SANDBOX_REQUESTS_PER_ENDPOINT = 25
"""Captures one sandbox endpoint takes before its capture URL answers 429."""
_SANDBOX_MAX_LIST = 100
_DEFAULT_CLAIM_TIMEOUT_MS = 15 * 60 * 1000


class SandboxError(WebhooksCCError):
    """A refused sandbox call. ``code`` is the server's: ``sandbox_endpoint_limit``,
    ``sandbox_full``, ``sandbox_closed``, ``not_found``, ...

    A :class:`~webhooks_cc.errors.WebhooksCCError`, so ``requests.wait_for()`` stops
    at a refusal instead of polling until it times out.
    """

    def __init__(self, code: str, status: int, message: str) -> None:
        super().__init__(status, message)
        self.code = code


@dataclass(frozen=True)
class SandboxClaim(ClaimAttempt):
    """A claim attempt for a sandbox. When ``moves_endpoints`` is true, the sandbox
    endpoints and what they captured move into the account; otherwise (a sandbox
    another process registered, whose claim token only that process held) the
    agent is connected to the account and the endpoints stay in the sandbox until
    they expire."""

    moves_endpoints: bool = True


@dataclass(frozen=True)
class _Claim:
    claim_token: str = field(repr=False)
    claim_token_expires: datetime
    registration_id: str
    email: str
    interval: int
    moves_endpoints: bool


def _now_iso() -> str:
    return format_timestamp(datetime.now(timezone.utc))


def _normalize_email(email: str) -> str:
    # As the server compares it: one address, however it was typed.
    return email.strip().lower()


def _claimed_slot(
    claimed: ClaimedAgent, *, registration_id: str, email: str, client_name: str
) -> dict[str, str]:
    return {
        "registration_id": registration_id,
        "identity_assertion": claimed.identity_assertion,
        "assertion_expires": format_timestamp(claimed.assertion_expires),
        "scope": claimed.token.scope,
        "email": email,
        "client_name": client_name,
        "saved_at": _now_iso(),
        "access_token": claimed.token.access_token,
        "access_token_expires": format_timestamp(claimed.token.expires_at),
    }


class SandboxClient:
    """A client for an agent sandbox. Use :meth:`WebhooksCC.sandbox()
    <webhooks_cc.WebhooksCC.sandbox>` to get one.

    Its access token renews itself from the registration's identity assertion. Use
    it as a context manager, or call :meth:`close`, to release its connections.
    """

    def __init__(
        self,
        *,
        base_url: str,
        webhook_url: str,
        timeout_ms: float,
        http: httpx.Client,
        owns_http: bool,
        shared_http: httpx.Client | None,
        slot: AgentSlot,
        claim_token: str | None,
        claim_token_expires: datetime | None,
        client_name: str,
        store: AgentCredentialStore | None,
    ) -> None:
        self._base_url = base_url
        self._webhook_url = webhook_url
        self._timeout_ms = timeout_ms
        self._http = http
        self._owns_http = owns_http
        self._shared_http = shared_http
        self._registration_id = slot.registration_id
        self._assertion = slot.identity_assertion
        self._expires_at = slot.assertion_expires
        self._claim_token = claim_token
        self._claim_token_expires = claim_token_expires or self.expires_at
        self._client_name = client_name
        self._store = store
        self._claim: _Claim | None = None
        self._closed = False
        self._tokens = AgentTokens(
            base_url=base_url,
            assertion=slot.identity_assertion,
            http=http,
            timeout_ms=timeout_ms,
            token=cached_token(slot),
            binding=SlotBinding(store, base_url, "sandbox", slot.registration_id)
            if store is not None
            else None,
        )
        self.endpoints = SandboxEndpoints(self)
        self.requests = SandboxRequests(self)

    def __enter__(self) -> SandboxClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        """Close the HTTP connections (only those of a client the SDK created)."""
        if self._owns_http:
            self._http.close()

    @property
    def registration_id(self) -> str:
        """The registration id, for logs; the server never asks for it."""
        return self._registration_id

    @property
    def expires_at(self) -> datetime:
        """When the sandbox, its endpoints and its captures are deleted."""
        millis = parse_timestamp(self._expires_at) or 0
        return datetime.fromtimestamp(millis / 1000, tz=timezone.utc)

    # --- plumbing ---------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: dict[str, str] | None = None,
    ) -> Any:
        if self._closed:
            raise SandboxError(
                "sandbox_closed",
                403,
                "This sandbox was claimed; use the client wait_for_claim() returned.",
            )
        for attempt in range(2):
            token = self._tokens.get(force_refresh=attempt > 0)
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
            if body is not None:
                headers["Content-Type"] = "application/json"
            try:
                response = self._http.request(
                    method,
                    f"{self._base_url}/api/agent/sandbox{path}",
                    params=params,
                    content=json.dumps(body) if body is not None else None,
                    headers=headers,
                    timeout=self._timeout_ms / 1000,
                )
            except httpx.TimeoutException:
                raise TimeoutError(self._timeout_ms) from None
            # A 401 means the token expired or was revoked: exchange once more.
            if response.status_code == 401 and attempt == 0:
                continue
            if response.status_code == 204:
                return None
            parsed: Any = {}
            if response.content:
                try:
                    parsed = response.json()
                except ValueError:
                    # A proxy's HTML error page: the status still says what happened.
                    if response.is_success:
                        raise SandboxError(
                            "invalid_response", response.status_code, "Not JSON"
                        ) from None
            # A rate limit is worth waiting out, like the rest of the SDK does.
            if response.status_code == 429:
                raise _map_error(429, "Rate limited", response.headers)
            if not response.is_success:
                error = parsed if isinstance(parsed, dict) else {}
                code = str(error.get("error") or f"http_{response.status_code}")
                # Claimed, revoked or expired elsewhere: this registration is done.
                if code == "sandbox_closed":
                    self._tokens.forget_slot()
                raise SandboxError(
                    code,
                    response.status_code,
                    str(
                        error.get("error_description")
                        or f"Sandbox request failed (HTTP {response.status_code})"
                    ),
                )
            return parsed
        raise SandboxError("unauthorized", 401, "The sandbox token was refused.")

    def _endpoint(self, data: Any) -> SandboxEndpoint:
        endpoint = SandboxEndpoint.from_dict(data if isinstance(data, dict) else {})
        if not endpoint.url and endpoint.slug:
            return replace(endpoint, url=f"{self._webhook_url}/w/{endpoint.slug}")
        return endpoint

    # --- claiming ---------------------------------------------------------------------

    def claim(self, email: str) -> SandboxClaim:
        """Start connecting this agent to a human's account.

        Show the human ``verification_uri`` and ``user_code`` together; only
        someone signed in as ``email`` can complete it. Calling again replaces the
        previous code. The process that registered the sandbox moves its endpoints
        into the account; a sandbox reused from the credential file starts a
        service_auth registration for ``email`` instead (``moves_endpoints`` is
        false), because the claim token never leaves the process that registered.
        """
        email = _normalize_email(email)
        if self._claim_token is not None:
            attempt = start_claim(
                self._claim_token,
                email=email,
                base_url=self._base_url,
                timeout=self._timeout_ms,
                http_client=self._http,
            )
            claim = _Claim(
                self._claim_token,
                self._claim_token_expires,
                self._registration_id,
                email,
                attempt.interval,
                True,
            )
        else:
            renewed = self._renew_claim(email)
            if renewed is not None:
                claim, attempt = renewed
            else:
                registration = register_service_auth(
                    email,
                    client_name=self._client_name,
                    base_url=self._base_url,
                    timeout=self._timeout_ms,
                    http_client=self._http,
                )
                attempt = registration.claim
                claim = _Claim(
                    registration.claim_token,
                    registration.claim_token_expires,
                    registration.registration_id,
                    email,
                    attempt.interval,
                    False,
                )
        self._claim = claim
        return SandboxClaim(
            user_code=attempt.user_code,
            verification_uri=attempt.verification_uri,
            expires_at=attempt.expires_at,
            interval=attempt.interval,
            registration_id=claim.registration_id,
            moves_endpoints=claim.moves_endpoints,
        )

    def _renew_claim(self, email: str) -> tuple[_Claim, ClaimAttempt] | None:
        """A new code for the service_auth registration already started for ``email``,
        or ``None`` when there is none still usable."""
        pending = self._claim
        if (
            pending is None
            or pending.email != email
            or pending.claim_token_expires <= datetime.now(timezone.utc)
        ):
            return None
        try:
            attempt = start_claim(
                pending.claim_token,
                email=email,
                base_url=self._base_url,
                timeout=self._timeout_ms,
                http_client=self._http,
            )
        except AgentAuthError as error:
            # Expired, out of attempts or revoked: the caller registers again. A rate
            # limit passes, and so does a registration the human already approved,
            # which wait_for_claim() still collects.
            if not 400 <= error.status < 500 or error.code in (
                "rate_limited",
                "claimed_or_in_flight",
            ):
                raise
            return None
        return replace(pending, interval=attempt.interval), attempt

    def wait_for_claim(self, *, timeout: Duration = _DEFAULT_CLAIM_TIMEOUT_MS) -> WebhooksCC:
        """Wait until the human enters the code, then return a ``WebhooksCC`` client
        acting for their account.

        Its token renews itself from the claimed assertion, which is saved in the
        credential file (so :meth:`WebhooksCC.connected` finds it later). When the
        endpoints moved, they are now that account's endpoints and this sandbox
        client stops working. Raises :class:`~webhooks_cc.agent.AgentAuthError`
        ``expired_token`` (call :meth:`claim` again), ``access_denied`` or ``timeout``.
        """
        claim = self._claim
        if claim is None:
            raise RuntimeError("Start a claim with claim(email) first.")
        claimed = wait_for_claim(
            claim.claim_token,
            interval=claim.interval,
            timeout=timeout,
            base_url=self._base_url,
            request_timeout=self._timeout_ms,
            http_client=self._http,
        )
        self._claim = None
        binding: SlotBinding | None = None
        if self._store is not None:
            self._store.save(
                self._base_url,
                "claimed",
                _claimed_slot(
                    claimed,
                    registration_id=claim.registration_id,
                    email=claim.email,
                    client_name=self._client_name,
                ),
            )
            binding = SlotBinding(self._store, self._base_url, "claimed", claim.registration_id)
        if claim.moves_endpoints:
            self._closed = True
            self._claim_token = None
            if self._store is not None:
                self._store.remove(self._base_url, "sandbox", registration_id=self._registration_id)
        return WebhooksCC._for_agent(
            assertion=claimed.identity_assertion,
            token=claimed.token,
            binding=binding,
            base_url=self._base_url,
            webhook_url=self._webhook_url,
            timeout=self._timeout_ms,
            http_client=self._shared_http,
        )

    def revoke_token(self) -> None:
        """Drop the current access token. A later call exchanges a new one."""
        token = self._tokens.peek()
        if token is None:
            return
        revoke(token, base_url=self._base_url, timeout=self._timeout_ms, http_client=self._http)
        self._tokens.drop()


class SandboxEndpoints:
    """Create, list, read and delete sandbox endpoints."""

    def __init__(self, client: SandboxClient) -> None:
        self._client = client

    def create(self) -> SandboxEndpoint:
        """Create a capture endpoint. Raises :class:`SandboxError`
        ``sandbox_endpoint_limit`` at 3 live endpoints, or ``sandbox_full`` when the
        shared pool is full."""
        return self._client._endpoint(self._client._request("POST", "/endpoints", body={}))

    def list(self) -> builtins.list[SandboxEndpoint]:
        """This sandbox's live endpoints, newest first."""
        result = self._client._request("GET", "/endpoints")
        items = result.get("endpoints") if isinstance(result, dict) else None
        return [self._client._endpoint(item) for item in items or []]

    def get(self, slug: str) -> SandboxEndpoint:
        _validate_segment(slug, "slug")
        return self._client._endpoint(self._client._request("GET", f"/endpoints/{slug}"))

    def delete(self, slug: str) -> None:
        """Free a slot. The sandbox's request budget is not refunded."""
        _validate_segment(slug, "slug")
        self._client._request("DELETE", f"/endpoints/{slug}")


class SandboxRequests:
    """Requests a sandbox endpoint captured: list, read and wait for them."""

    def __init__(self, client: SandboxClient) -> None:
        self._client = client

    def list(
        self, slug: str, *, since: float | None = None, limit: int | None = None
    ) -> builtins.list[Request]:
        """Captured requests, newest first (at most 100). ``since`` is in ms since the
        epoch."""
        _validate_segment(slug, "slug")
        params: dict[str, str] = {}
        if since is not None:
            params["since"] = str(int(since))
        if limit is not None:
            params["limit"] = str(int(limit))
        items = self._client._request("GET", f"/endpoints/{slug}/requests", params=params)
        return [Request.from_dict(item) for item in items or [] if isinstance(item, dict)]

    def get(self, request_id: str) -> Request:
        _validate_segment(request_id, "request id")
        result = self._client._request("GET", f"/requests/{request_id}")
        return Request.from_dict(result if isinstance(result, dict) else {})

    def wait_for(
        self,
        slug: str,
        *,
        timeout: Duration = _DEFAULT_TIMEOUT_MS,
        poll_interval: Duration = 500,
        match: Matcher | None = None,
        since: float | None = None,
    ) -> Request:
        """Poll until a request (matching ``match``, if given) arrives, as
        :meth:`WebhooksCC.requests.wait_for <webhooks_cc.client.Requests.wait_for>` does."""
        return self.wait_for_all(
            slug, count=1, timeout=timeout, poll_interval=poll_interval, match=match, since=since
        )[0]

    def wait_for_all(
        self,
        slug: str,
        *,
        count: int,
        timeout: Duration = _DEFAULT_TIMEOUT_MS,
        poll_interval: Duration = 500,
        match: Matcher | None = None,
        since: float | None = None,
    ) -> builtins.list[Request]:
        """Poll until ``count`` matching requests have arrived; returns them oldest first.

        A sandbox endpoint captures at most 25 requests, so a larger ``count`` is
        refused with ``ValueError`` rather than left to time out.
        """
        _validate_segment(slug, "slug")
        if int(count) > SANDBOX_REQUESTS_PER_ENDPOINT:
            raise ValueError(
                f"A sandbox endpoint captures at most {SANDBOX_REQUESTS_PER_ENDPOINT} requests, "
                f"so count must be at most {SANDBOX_REQUESTS_PER_ENDPOINT}."
            )
        limit = min(_SANDBOX_MAX_LIST, _wait_list_limit(count))
        return _collect(
            lambda start: self.list(slug, since=start, limit=limit),
            count=count,
            timeout=timeout,
            poll_interval=poll_interval,
            match=match,
            since=since,
        )


def create_sandbox(
    *,
    client_name: str | None = None,
    base_url: str | None = None,
    webhook_url: str | None = None,
    timeout: Duration | None = None,
    credentials_file: bool | str | os.PathLike[str] = True,
    http_client: httpx.Client | None = None,
) -> SandboxClient:
    """See :meth:`WebhooksCC.sandbox() <webhooks_cc.WebhooksCC.sandbox>`."""
    base = resolve_base_url(base_url)
    webhook = (webhook_url or os.environ.get(WEBHOOK_URL_ENV) or DEFAULT_WEBHOOK_URL).rstrip("/")
    timeout_ms = parse_duration(timeout) if timeout is not None else _DEFAULT_TIMEOUT_MS
    name = client_name or DEFAULT_CLIENT_NAME
    store = AgentCredentialStore.resolve(credentials_file)
    owns_http = http_client is None
    http = http_client or httpx.Client(headers={"User-Agent": f"webhooks-cc-python/{__version__}"})

    def client(
        slot: AgentSlot, claim_token: str | None, claim_token_expires: datetime | None
    ) -> SandboxClient:
        return SandboxClient(
            base_url=base,
            webhook_url=webhook,
            timeout_ms=timeout_ms,
            http=http,
            owns_http=owns_http,
            shared_http=http_client,
            slot=slot,
            claim_token=claim_token,
            claim_token_expires=claim_token_expires,
            client_name=name,
            store=store,
        )

    try:
        saved = store.load(base).sandbox if store is not None else None
        if saved is not None:
            reused = client(saved, None, None)
            try:
                # Fail early, with the server's reason, if the token cannot be had.
                reused._tokens.get()
                return reused
            except AgentAuthError as error:
                if error.code != "invalid_grant":
                    raise
                # It expired or was revoked, and its slot is gone: register a new one.

        registration = register_anonymous(
            client_name=name, base_url=base, timeout=timeout_ms, http_client=http
        )
        slot = AgentSlot(
            registration_id=registration.registration_id,
            identity_assertion=registration.identity_assertion,
            assertion_expires=format_timestamp(registration.assertion_expires),
            scope=" ".join(registration.pre_claim_scopes) or None,
            client_name=name,
            saved_at=_now_iso(),
        )
        if store is not None:
            store.save(base, "sandbox", slot)
        fresh = client(slot, registration.claim_token, registration.claim_token_expires)
        fresh._tokens.get()
        return fresh
    except BaseException:
        if owns_http:
            http.close()
        raise


class PendingConnection:
    """A connection the human has yet to approve. Use :meth:`WebhooksCC.connect()
    <webhooks_cc.WebhooksCC.connect>` to start one.

    Show the human ``verification_uri`` (the page they open and sign in on) and
    ``user_code`` (the code they type there) together, then call :meth:`wait`.
    ``expires_at`` is when the code runs out (:meth:`restart` gets a new one), and
    ``interval`` the seconds between polls.
    """

    def __init__(
        self,
        registration_id: str,
        claim_token: str,
        attempt: ClaimAttempt,
        *,
        email: str,
        client_name: str,
        base_url: str,
        webhook_url: str | None,
        timeout_ms: float,
        store: AgentCredentialStore | None,
        http_client: httpx.Client | None,
    ) -> None:
        self.registration_id = registration_id
        self._claim_token = claim_token
        self._email = email
        self._client_name = client_name
        self._base_url = base_url
        self._webhook_url = webhook_url
        self._timeout_ms = timeout_ms
        self._store = store
        self._http_client = http_client
        self._set_attempt(attempt)

    def _set_attempt(self, attempt: ClaimAttempt) -> None:
        self.user_code = attempt.user_code
        self.verification_uri = attempt.verification_uri
        self.expires_at = attempt.expires_at
        self.interval = attempt.interval

    @classmethod
    def _start(
        cls,
        email: str,
        *,
        client_name: str | None,
        base_url: str | None,
        webhook_url: str | None,
        timeout: Duration | None,
        credentials_file: bool | str | os.PathLike[str],
        http_client: httpx.Client | None,
    ) -> PendingConnection:
        base = resolve_base_url(base_url)
        timeout_ms = parse_duration(timeout) if timeout is not None else _DEFAULT_TIMEOUT_MS
        name = client_name or DEFAULT_CLIENT_NAME
        email = _normalize_email(email)
        registration = register_service_auth(
            email, client_name=name, base_url=base, timeout=timeout_ms, http_client=http_client
        )
        return cls(
            registration.registration_id,
            registration.claim_token,
            registration.claim,
            email=email,
            client_name=name,
            base_url=base,
            webhook_url=webhook_url,
            timeout_ms=timeout_ms,
            store=AgentCredentialStore.resolve(credentials_file),
            http_client=http_client,
        )

    def __repr__(self) -> str:
        return (
            f"PendingConnection(registration_id={self.registration_id!r}, "
            f"user_code={self.user_code!r}, verification_uri={self.verification_uri!r})"
        )

    def restart(self) -> PendingConnection:
        """Get a new code (after the old one ran out); the previous link stops working."""
        attempt = start_claim(
            self._claim_token,
            email=self._email,
            base_url=self._base_url,
            timeout=self._timeout_ms,
            http_client=self._http_client,
        )
        self._set_attempt(attempt)
        return self

    def wait(self, *, timeout: Duration = _DEFAULT_CLAIM_TIMEOUT_MS) -> WebhooksCC:
        """Wait until the human enters the code, then return a ``WebhooksCC`` client for
        their account and save the connection in the credential file.

        Raises :class:`~webhooks_cc.agent.AgentAuthError` ``expired_token`` (call
        :meth:`restart`), ``access_denied`` or ``timeout``.
        """
        claimed = wait_for_claim(
            self._claim_token,
            interval=self.interval,
            timeout=timeout,
            base_url=self._base_url,
            request_timeout=self._timeout_ms,
            http_client=self._http_client,
        )
        binding: SlotBinding | None = None
        if self._store is not None:
            self._store.save(
                self._base_url,
                "claimed",
                _claimed_slot(
                    claimed,
                    registration_id=self.registration_id,
                    email=self._email,
                    client_name=self._client_name,
                ),
            )
            binding = SlotBinding(self._store, self._base_url, "claimed", self.registration_id)
        return WebhooksCC._for_agent(
            assertion=claimed.identity_assertion,
            token=claimed.token,
            binding=binding,
            base_url=self._base_url,
            webhook_url=self._webhook_url,
            timeout=self._timeout_ms,
            http_client=self._http_client,
        )
