"""pytest fixtures, loaded automatically when the package is installed.

- ``webhooks_cc``: a :class:`~webhooks_cc.WebhooksCC` client for the session,
  configured from ``WHK_API_KEY`` (and ``WHK_BASE_URL``, ``WHK_WEBHOOK_URL``).
  Tests that use it are skipped when ``WHK_API_KEY`` is not set.
- ``webhooks_cc_endpoint``: a new endpoint for each test, deleted afterwards.
- ``webhooks_cc_session_endpoint``: one endpoint for the whole run, shared by
  every test that asks for it, deleted when the run ends.

.. code-block:: python

    def test_checkout_sends_a_webhook(webhooks_cc, webhooks_cc_endpoint):
        checkout(webhook_url=webhooks_cc_endpoint.url)
        request = webhooks_cc.requests.wait_for(webhooks_cc_endpoint.slug, timeout="30s")
        assert request.json()["type"] == "checkout.session.completed"

The API allows 30 new endpoints per account in 10 minutes by default. When a
suite uses them up, ``webhooks_cc_endpoint`` waits as the API's Retry-After
asks, for up to a minute, and otherwise fails the test with one line rather
than a traceback. A suite with more tests than that can use
``webhooks_cc_session_endpoint``: its tests share the endpoint, so each one
waits only for what it sent (a ``match``, or a ``since`` taken before it
acts), as ``requests.wait_for`` looks back only five minutes by default.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import AbstractContextManager

import pytest

from .client import API_KEY_ENV, WebhooksCC
from .errors import RateLimitError
from .models import Endpoint
from .testing import temporary_endpoint


@pytest.fixture(scope="session")
def webhooks_cc() -> Iterator[WebhooksCC]:
    """A webhooks.cc client configured from the environment."""
    if not os.environ.get(API_KEY_ENV):
        pytest.skip(f"{API_KEY_ENV} is not set")
    with WebhooksCC() as client:
        yield client


def _endpoint(client: WebhooksCC, name: str) -> Iterator[Endpoint]:
    """A temporary endpoint; a rate limit fails the test with its one-line message."""
    created: AbstractContextManager[Endpoint] = temporary_endpoint(client, name[:100])
    try:
        endpoint = created.__enter__()
    except RateLimitError as error:
        pytest.fail(error.message, pytrace=False)
    try:
        yield endpoint
    finally:
        created.__exit__(None, None, None)


@pytest.fixture
def webhooks_cc_endpoint(
    webhooks_cc: WebhooksCC, request: pytest.FixtureRequest
) -> Iterator[Endpoint]:
    """A new endpoint named after the test, deleted when the test ends."""
    yield from _endpoint(webhooks_cc, request.node.name)


@pytest.fixture(scope="session")
def webhooks_cc_session_endpoint(webhooks_cc: WebhooksCC) -> Iterator[Endpoint]:
    """One endpoint for the whole run, shared by the tests that ask for it."""
    yield from _endpoint(webhooks_cc, "pytest session")
