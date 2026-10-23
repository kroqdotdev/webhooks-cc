"""pytest fixtures, loaded automatically when the package is installed.

- ``webhooks_cc``: a :class:`~webhooks_cc.WebhooksCC` client for the session,
  configured from ``WHK_API_KEY`` (and ``WHK_BASE_URL``, ``WHK_WEBHOOK_URL``).
  Tests that use it are skipped when ``WHK_API_KEY`` is not set.
- ``webhooks_cc_endpoint``: a new endpoint for each test, deleted afterwards.

.. code-block:: python

    def test_checkout_sends_a_webhook(webhooks_cc, webhooks_cc_endpoint):
        checkout(webhook_url=webhooks_cc_endpoint.url)
        request = webhooks_cc.requests.wait_for(webhooks_cc_endpoint.slug, timeout="30s")
        assert request.json()["type"] == "checkout.session.completed"
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

from .client import API_KEY_ENV, WebhooksCC
from .models import Endpoint
from .testing import temporary_endpoint


@pytest.fixture(scope="session")
def webhooks_cc() -> Iterator[WebhooksCC]:
    """A webhooks.cc client configured from the environment."""
    if not os.environ.get(API_KEY_ENV):
        pytest.skip(f"{API_KEY_ENV} is not set")
    with WebhooksCC() as client:
        yield client


@pytest.fixture
def webhooks_cc_endpoint(
    webhooks_cc: WebhooksCC, request: pytest.FixtureRequest
) -> Iterator[Endpoint]:
    """A new endpoint named after the test, deleted when the test ends."""
    with temporary_endpoint(webhooks_cc, request.node.name[:100]) as endpoint:
        yield endpoint
