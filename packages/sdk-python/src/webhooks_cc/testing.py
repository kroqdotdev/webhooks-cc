"""Helpers for tests: temporary endpoints, and capturing what a piece of code sends."""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager, suppress
from typing import TYPE_CHECKING, Any

from ._sentinel import UNSET
from .durations import Duration, parse_duration
from .errors import NotFoundError, RateLimitError, TimeoutError, wait_timeout_message
from .matchers import Matcher
from .models import Endpoint, Request

if TYPE_CHECKING:
    from .client import WebhooksCC

_MIN_POLL_INTERVAL_MS = 10
_CAPTURE_LIMIT = 100

#: How long, in all, the helpers wait out the limit on new endpoints.
DEFAULT_RATE_LIMIT_WAIT_MS = 60_000


def create_test_endpoint(
    client: WebhooksCC,
    name: str | None = None,
    *,
    rate_limit_wait: Duration = DEFAULT_RATE_LIMIT_WAIT_MS,
    **options: Any,
) -> Endpoint:
    """Create an endpoint for a test, waiting out the limit on new endpoints.

    The API allows 30 new endpoints per account in 10 minutes by default, so a
    suite that makes one per test can reach it. This waits as the API's
    Retry-After asks, for up to ``rate_limit_wait`` in all, and otherwise raises
    :class:`~webhooks_cc.errors.RateLimitError` with one line saying what to do.
    For large suites, share one endpoint between tests (the
    ``webhooks_cc_session_endpoint`` fixture) instead. ``options`` go to
    ``client.endpoints.create()``.
    """
    budget_ms = parse_duration(rate_limit_wait)
    started = time.monotonic()
    while True:
        try:
            return client.endpoints.create(name, **options)
        except RateLimitError as error:
            # A 429 without Retry-After is another limit (the site-wide cap
            # on demo endpoints), whose own message says what happened.
            if error.retry_after is None:
                if error.api_message:
                    passed_on = RateLimitError(
                        None,
                        limit=error.limit,
                        remaining=error.remaining,
                        reset=error.reset,
                        code=error.code,
                        api_message=error.api_message,
                    )
                    passed_on.message = f"webhooks.cc: {error.api_message}"
                    passed_on.args = (passed_on.message,)
                    raise passed_on from None
                raise
            wait_ms = error.retry_after * 1000
            if (time.monotonic() - started) * 1000 + wait_ms > budget_ms:
                raise _endpoint_rate_limit_error(error) from None
            time.sleep(wait_ms / 1000)


def _endpoint_rate_limit_error(error: RateLimitError) -> RateLimitError:
    """The 429 from creating an endpoint, saying what to do about it."""
    limited = RateLimitError(
        error.retry_after,
        limit=error.limit,
        remaining=error.remaining,
        reset=error.reset,
        code=error.code,
    )
    message = "webhooks.cc: too many new endpoints"
    if error.limit is not None:
        message += f": the limit is {error.limit} in a rolling window"
    if error.retry_after is not None:
        message += f"; the next one is free in {error.retry_after}s"
    message += (
        ". Share one endpoint between tests (the webhooks_cc_session_endpoint fixture), "
        "or run fewer tests that create one."
    )
    limited.message = message
    limited.args = (message,)
    return limited


@contextmanager
def temporary_endpoint(
    client: WebhooksCC,
    name: str | None = None,
    *,
    ephemeral: bool = False,
    expires_in: Duration | None = None,
    mock_response: Mapping[str, Any] | None = None,
    response_rules: Sequence[Mapping[str, Any]] | None = None,
    rate_limit_wait: Duration = DEFAULT_RATE_LIMIT_WAIT_MS,
) -> Iterator[Endpoint]:
    """An endpoint that is deleted when the ``with`` block ends, however it ends.

    When creating endpoints is rate limited it waits as the API asks, for up
    to ``rate_limit_wait`` in all (see :func:`create_test_endpoint`).

    .. code-block:: python

        with temporary_endpoint(client, name="checkout test") as endpoint:
            trigger_checkout(endpoint.url)
            request = client.requests.wait_for(endpoint.slug, timeout="30s")
    """
    endpoint = create_test_endpoint(
        client,
        name,
        rate_limit_wait=rate_limit_wait,
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
        seen = matched_count = 0
        while (time.monotonic() - started) * 1000 < timeout_ms:
            requests = client.requests.list(endpoint.slug, limit=limit)
            matched = sorted(
                (request for request in requests if match is None or match(request)),
                key=lambda request: request.received_at,
            )
            if len(matched) >= wanted:
                return matched[:wanted]
            seen, matched_count = len(requests), len(matched)
            time.sleep(poll_ms / 1000)
        raise TimeoutError(
            timeout_ms,
            wait_timeout_message(
                timeout_ms,
                noun="request",
                slug=endpoint.slug,
                wanted=wanted,
                matched=matched_count,
                seen=seen,
                filtered=match is not None,
            ),
        )


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
