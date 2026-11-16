"""Test helpers under the limit on new endpoints, and what a wait's timeout says."""

from __future__ import annotations

import time
from typing import Any

import httpx
import pytest

from webhooks_cc import errors, pytest_plugin, testing
from webhooks_cc.client import WebhooksCC

NOW_MS = int(time.time() * 1000)
LIMIT_HEADERS = {
    "Retry-After": "480",
    "X-RateLimit-Limit": "30",
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": "1767225660",
}
ENDPOINT = {"id": "e1", "slug": "tmp", "url": "https://go.webhooks.cc/w/tmp", "createdAt": NOW_MS}


def make_client(handler: Any) -> WebhooksCC:
    return WebhooksCC(
        "whcc_test",
        base_url="https://test.webhooks.cc",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_create_test_endpoint_waits_as_retry_after_asks(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr(testing.time, "sleep", slept.append)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, headers={"Retry-After": "2"}, json={"error": "x"})
        return httpx.Response(200, json=ENDPOINT)

    endpoint = testing.create_test_endpoint(make_client(handler), "t")
    assert endpoint.slug == "tmp"
    assert slept == [2.0]
    assert calls == 2


def test_create_test_endpoint_gives_up_with_one_line(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr(testing.time, "sleep", slept.append)
    client = make_client(lambda request: httpx.Response(429, headers=LIMIT_HEADERS, json={}))
    with pytest.raises(errors.RateLimitError) as caught:
        testing.create_test_endpoint(client)
    assert caught.value.retry_after == 480
    assert str(caught.value) == (
        "webhooks.cc: too many new endpoints: the limit is 30 in a rolling window; "
        "the next one is free in 480s. Share one endpoint between tests "
        "(the webhooks_cc_session_endpoint fixture), or run fewer tests that create one."
    )
    assert slept == []


def test_the_endpoint_fixture_fails_the_test_in_one_line() -> None:
    client = make_client(lambda request: httpx.Response(429, headers=LIMIT_HEADERS, json={}))
    fixture = pytest_plugin._endpoint(client, "test_x")
    with pytest.raises(pytest.fail.Exception) as caught:
        next(fixture)
    assert caught.value.pytrace is False
    assert caught.value.msg is not None
    assert caught.value.msg.startswith("webhooks.cc: too many new endpoints")
    assert "\n" not in caught.value.msg


def test_the_endpoint_fixture_deletes_its_endpoint() -> None:
    deleted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            deleted.append(request.url.path)
            return httpx.Response(204)
        return httpx.Response(200, json=ENDPOINT)

    fixture = pytest_plugin._endpoint(make_client(handler), "test_x")
    assert next(fixture).slug == "tmp"
    with pytest.raises(StopIteration):
        next(fixture)
    assert deleted == ["/api/endpoints/tmp"]


def test_a_wait_timeout_says_what_it_waited_for() -> None:
    arrived = [{"id": "r1", "method": "POST", "path": "/", "receivedAt": NOW_MS}]
    client = make_client(lambda request: httpx.Response(200, json=arrived))
    with pytest.raises(errors.TimeoutError) as caught:
        client.emails.wait_for("acme", subject="Confirm", tag="run1", timeout=50, poll_interval=10)
    assert str(caught.value) == (
        'Timed out after 50ms waiting for an email with tag "run1", subject "Confirm" '
        'on endpoint "acme" (1 did not match)'
    )
    with pytest.raises(errors.TimeoutError) as caught:
        client.requests.wait_for_all("acme", count=2, timeout=50, poll_interval=10)
    assert str(caught.value) == (
        'Timed out after 50ms waiting for 2 requests on endpoint "acme" (1 arrived)'
    )
