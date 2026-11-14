"""Checkout links: client.billing."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from webhooks_cc import CheckoutExpiredError, CheckoutLink, TimeoutError
from webhooks_cc.client import WebhooksCC

ID = "11111111-2222-4333-8444-555555555555"


def link(status: str) -> dict[str, Any]:
    return {
        "checkout": {
            "id": ID,
            "status": status,
            "kind": "plan",
            "summary": "The Pro plan, billed monthly.",
            "item": {"kind": "plan", "plan": "pro", "interval": "month"},
            "teamId": None,
            "url": "https://polar.sh/checkout/polar_c_x" if status == "open" else None,
            "createdAt": "2026-11-14T12:00:00.000Z",
            "expiresAt": "2026-11-14T13:00:00.000Z",
            "paidAt": "2026-11-14T12:05:00.000Z" if status == "paid" else None,
        }
    }


class Api:
    """Answers each call from a list, in order, and records it."""

    def __init__(self, answers: list[tuple[int, Any]]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, body))
        status, payload = self.answers.pop(0) if self.answers else (404, {"error": "Not found"})
        return httpx.Response(status, json=payload)


def client_for(api: Api) -> WebhooksCC:
    return WebhooksCC(
        "whcc_test",
        base_url="https://api.test",
        http_client=httpx.Client(transport=httpx.MockTransport(api)),
    )


def test_create_checkout_sends_only_what_is_given() -> None:
    api = Api([(201, link("open"))])
    checkout = client_for(api).billing.create_checkout(
        "team_plan", team_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", seats=3
    )
    assert isinstance(checkout, CheckoutLink)
    assert checkout.url == "https://polar.sh/checkout/polar_c_x"
    assert checkout.summary == "The Pro plan, billed monthly."
    assert api.calls == [
        (
            "POST",
            "/api/billing/checkouts",
            {"kind": "team_plan", "seats": 3, "teamId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"},
        )
    ]


def test_wait_for_checkout_returns_once_paid(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("webhooks_cc.client._sleep_ms", lambda ms: None)
    api = Api([(200, link("open")), (200, link("paid"))])
    paid = client_for(api).billing.wait_for_checkout(ID, poll_interval=1000)
    assert paid.status == "paid" and paid.url is None and paid.paid_at
    assert [call[1] for call in api.calls] == [f"/api/billing/checkouts/{ID}"] * 2


def test_wait_for_checkout_raises_when_it_expires_or_runs_out() -> None:
    with pytest.raises(CheckoutExpiredError) as expired:
        client_for(Api([(200, link("expired"))])).billing.wait_for_checkout(ID)
    assert expired.value.checkout_id == ID
    with pytest.raises(TimeoutError):
        client_for(Api([(200, link("open"))])).billing.wait_for_checkout(ID, timeout=0)


def test_get_checkout_refuses_an_id_that_is_not_a_segment() -> None:
    api = Api([])
    with pytest.raises(ValueError):
        client_for(api).billing.get_checkout("../approvals")
    assert api.calls == []
