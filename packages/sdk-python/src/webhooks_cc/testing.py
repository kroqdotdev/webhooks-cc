"""Helpers for tests: temporary endpoints, and capturing what a piece of code sends."""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager, suppress
from typing import TYPE_CHECKING, Any

from ._sentinel import UNSET
from .durations import Duration, parse_duration
from .errors import NotFoundError, TimeoutError
from .matchers import Matcher
from .models import Endpoint, Request

if TYPE_CHECKING:
    from .client import WebhooksCC

_MIN_POLL_INTERVAL_MS = 10
_CAPTURE_LIMIT = 100


@contextmanager
def temporary_endpoint(
    client: WebhooksCC,
    name: str | None = None,
    *,
    ephemeral: bool = False,
    expires_in: Duration | None = None,
    mock_response: Mapping[str, Any] | None = None,
    response_rules: Sequence[Mapping[str, Any]] | None = None,
) -> Iterator[Endpoint]:
    """An endpoint that is deleted when the ``with`` block ends, however it ends.

    .. code-block:: python

        with temporary_endpoint(client, name="checkout test") as endpoint:
            trigger_checkout(endpoint.url)
            request = client.requests.wait_for(endpoint.slug, timeout="30s")
    """
    endpoint = client.endpoints.create(
        name,
        ephemeral=ephemeral,
        expires_in=expires_in,
        mock_response=mock_response,
        response_rules=response_rules,
    )
    try:
        yield endpoint
    finally:
        with suppress(NotFoundError):
            client.endpoints.delete(endpoint.slug)


def capture_during(
    client: WebhooksCC,
    action: Callable[[Endpoint], object],
    *,
    timeout: Duration = 30_000,
    poll_interval: Duration = 200,
    count: int = 1,
    match: Matcher | None = None,
    name: str | None = None,
) -> list[Request]:
    """Run ``action`` with a temporary endpoint and return the requests it sent there.

    Waits until ``count`` requests (matching ``match``, if given) have
    arrived, returns them oldest first, and deletes the endpoint.

    .. code-block:: python

        [request] = capture_during(client, lambda endpoint: notify(endpoint.url))
        assert request.json()["event"] == "order.paid"
    """
    timeout_ms = parse_duration(timeout)
    poll_ms = max(_MIN_POLL_INTERVAL_MS, parse_duration(poll_interval))
    wanted = max(1, int(count))
    limit = max(_CAPTURE_LIMIT, wanted * 5)

    with temporary_endpoint(client, name) as endpoint:
        started = time.monotonic()
        action(endpoint)
        while (time.monotonic() - started) * 1000 < timeout_ms:
            requests = client.requests.list(endpoint.slug, limit=limit)
            matched = sorted(
                (request for request in requests if match is None or match(request)),
                key=lambda request: request.received_at,
            )
            if len(matched) >= wanted:
                return matched[:wanted]
            time.sleep(poll_ms / 1000)
        raise TimeoutError(timeout_ms)


def capture_email_during(
    client: WebhooksCC,
    action: Callable[[str, Endpoint], object],
    *,
    tag: str | None = UNSET,
    subject: str | re.Pattern[str] | None = None,
    from_: str | re.Pattern[str] | None = None,
    to: str | re.Pattern[str] | None = None,
    timeout: Duration = 60_000,
    poll_interval: Duration = 1000,
    count: int = 1,
    match: Matcher | None = None,
    name: str | None = None,
) -> list[Request]:
    """Run ``action`` with a temporary endpoint's email address and return the email it sent.

    With ``tag``, the address carries it and only mail to that tag counts.

    .. code-block:: python

        [email] = capture_email_during(
            client, lambda address, endpoint: sign_up(address), subject="Confirm your email"
        )
        assert extract_code(email)
    """
    with temporary_endpoint(client, name) as endpoint:
        action(client.emails.address(endpoint, tag if isinstance(tag, str) else None), endpoint)
        return client.emails.wait_for_all(
            endpoint.slug,
            count=count,
            tag=tag,
            subject=subject,
            from_=from_,
            to=to,
            timeout=timeout,
            poll_interval=poll_interval,
            # A new endpoint: everything it received counts, measured on the server's clock.
            since=endpoint.created_at,
            match=match,
        )
