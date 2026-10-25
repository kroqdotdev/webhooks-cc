"""The client against a mocked API."""

from __future__ import annotations

import base64
import json
import re
import time
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import httpx
import pytest

from webhooks_cc import errors
from webhooks_cc.client import RetryOptions, WebhooksCC
from webhooks_cc.email import (
    email_address,
    email_field_issues,
    extract_code,
    extract_link,
    is_valid_email_tag,
)
from webhooks_cc.matchers import match_body_path, match_email, match_path
from webhooks_cc.models import (
    Destination,
    DestinationPreview,
    DestinationTestResult,
    EmailField,
    Endpoint,
    Request,
)
from webhooks_cc.testing import capture_during, temporary_endpoint
from webhooks_cc.verify import verify_signature

Handler = Callable[[httpx.Request], httpx.Response]
NOW_MS = int(time.time() * 1000)


def make_client(handler: Handler, **options: Any) -> WebhooksCC:
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return WebhooksCC("whcc_test", http_client=http, **options)


def captured(request_id: str, **fields: Any) -> dict[str, Any]:
    return {
        "id": request_id,
        "endpointId": "e1",
        "method": "POST",
        "path": "/",
        "headers": {"content-type": "application/json"},
        "body": "{}",
        "queryParams": {},
        "ip": "203.0.113.7",
        "size": 2,
        "receivedAt": NOW_MS,
        "kind": "http",
        **fields,
    }


def email_record(request_id: str, tag: str | None, subject: str) -> dict[str, Any]:
    return captured(
        request_id,
        method="EMAIL",
        path=f"acme+{tag}@mailhooks.cc" if tag else "acme@mailhooks.cc",
        kind="email",
        email={
            "subject": subject,
            "from": [{"name": "Acme", "address": "no-reply@acme.test"}],
            "to": [{"name": None, "address": "acme@mailhooks.cc"}],
            "cc": [],
            "replyTo": [],
            "sender": [],
            "date": None,
            "messageId": None,
            "inReplyTo": [],
            "tag": tag,
            "text": "Your code is 482913",
            "html": None,
            "textFromHtml": False,
            "attachments": [],
            "auth": None,
            "smtp": None,
            "parseError": False,
            "truncated": {},
        },
        extracts={
            "codes": ["482913"],
            "links": [{"url": "https://acme.test/confirm", "label": "Confirm", "action": True}],
        },
    )


def test_api_key_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WHK_API_KEY", raising=False)
    with pytest.raises(ValueError, match="WHK_API_KEY"):
        WebhooksCC()
    monkeypatch.setenv("WHK_API_KEY", "whcc_env")
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["authorization"])
        return httpx.Response(200, json={"used": 1, "limit": 50, "remaining": 49, "plan": "free"})

    client = WebhooksCC(http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert client.usage().remaining == 49
    assert seen == ["Bearer whcc_env"]


def test_base_url_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WHK_BASE_URL", "http://localhost:3000/")
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        return httpx.Response(200, json={"owned": [], "shared": []})

    make_client(handler).endpoints.list()
    assert urls == ["http://localhost:3000/api/endpoints"]


def test_endpoints_create_and_list() -> None:
    bodies: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            bodies.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "e1", "slug": "acme", "createdAt": NOW_MS})
        return httpx.Response(
            200,
            json={
                "owned": [{"id": "e1", "slug": "acme", "createdAt": 1}],
                "shared": [
                    {
                        "id": "e2",
                        "slug": "team",
                        "createdAt": 2,
                        "fromTeam": {"teamId": "t1", "teamName": "Acme"},
                    }
                ],
            },
        )

    client = make_client(handler)
    endpoint = client.endpoints.create("ci", expires_in="1h")
    assert endpoint.slug == "acme"
    assert bodies[0]["name"] == "ci"
    assert bodies[0]["isEphemeral"] is True
    assert abs(bodies[0]["expiresAt"] - (NOW_MS + 3_600_000)) < 60_000
    listed = client.endpoints.list()
    assert [item.slug for item in listed] == ["acme", "team"]
    assert listed[1].from_teams[0].team_name == "Acme"


def test_update_sends_only_given_fields() -> None:
    bodies: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "e1", "slug": "acme", "createdAt": 1})

    make_client(handler).endpoints.update("acme", name="renamed", forward_url=None)
    assert bodies == [{"name": "renamed", "forwardUrl": None}]


def test_update_sends_email_fields_and_refuses_a_bad_list() -> None:
    bodies: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "e1",
                "slug": "acme",
                "createdAt": 1,
                "emailFields": [
                    {"name": "invoice", "from": "subject", "pattern": r"(INV-\d+)"},
                    {"name": "mailer", "from": "header", "header": "X-Mailer", "pattern": ".+"},
                ],
            },
        )

    endpoints = make_client(handler).endpoints
    endpoint = endpoints.update(
        "acme",
        email_fields=[
            {"name": "invoice", "from": "subject", "pattern": r"(INV-\d+)"},
            EmailField(name="mailer", from_="header", header="X-Mailer", pattern=".+"),
        ],
    )
    assert bodies[-1] == {
        "emailFields": [
            {"name": "invoice", "from": "subject", "pattern": r"(INV-\d+)"},
            {"name": "mailer", "from": "header", "header": "X-Mailer", "pattern": ".+"},
        ]
    }
    assert endpoint.email_fields == [
        EmailField(name="invoice", from_="subject", pattern=r"(INV-\d+)"),
        EmailField(name="mailer", from_="header", header="X-Mailer", pattern=".+"),
    ]
    # What was read can be sent back.
    endpoints.update("acme", email_fields=endpoint.email_fields)
    assert bodies[-1] == bodies[0]
    endpoints.update("acme", email_fields=None)
    assert bodies[-1] == {"emailFields": None}

    with pytest.raises(ValueError, match="email_fields: field 1: name"):
        endpoints.update("acme", email_fields=[{"name": "1x", "from": "subject", "pattern": "x"}])
    with pytest.raises(ValueError, match="list"):
        endpoints.update("acme", email_fields="invoice")  # type: ignore[arg-type]
    assert len(bodies) == 3
    assert Endpoint.from_dict({"id": "e1", "slug": "acme", "createdAt": 1}).email_fields is None


def test_email_field_issues() -> None:
    assert email_field_issues([]) == []
    assert (
        email_field_issues(
            [
                {"name": "invoice", "from": "subject", "pattern": r"(INV-\d+)"},
                {"name": "mailer", "from": "header", "header": "X-Mailer", "pattern": ".+"},
            ]
        )
        == []
    )
    assert email_field_issues(
        [
            {"name": "invoice", "from": "subject", "pattern": "x"},
            {"name": "invoice", "from": "body", "pattern": ""},
            {"name": "a" * 41, "from": "header", "pattern": "x"},
            {"name": "total", "from": "text", "header": "X-Total", "pattern": "x" * 301},
            {"name": "astral", "from": "text", "pattern": "\U0001f600" * 151},
            "subject",
        ]
    ) == [
        'field 2: the name "invoice" is used twice',
        "field 2: from must be one of subject, text, html, from, to, header",
        "field 2: pattern is required",
        "field 3: name must be letters, digits and _, start with a letter, at most 40 characters",
        "field 3: header must be a header name",
        'field 4: header is only for from "header"',
        "field 4: pattern is longer than 300 characters",
        "field 5: pattern is longer than 300 characters",
        "field 6: must be a dict",
    ]
    assert email_field_issues([{"name": "invoice\n", "from": "subject", "pattern": "x"}]) == [
        "field 1: name must be letters, digits and _, start with a letter, at most 40 characters"
    ]
    many = [{"name": f"f{index}", "from": "subject", "pattern": "x"} for index in range(21)]
    assert email_field_issues(many) == ["at most 20 fields"]
    assert email_field_issues(None) == ["must be a list of fields"]


def test_preview_response_sends_only_given_settings() -> None:
    calls: list[tuple[str, str, Any]] = []
    preview = {
        "rule": {"index": 1, "name": "pings"},
        "response": {
            "status": 202,
            "headers": {"x-id": "evt_1"},
            "body": '{"id":"evt_1"}',
            "delay": 250,
        },
        "unknownPlaceholders": ["json.nope"],
        "email": False,
        "request": {
            "id": "4f0e7c1a-0000-4000-8000-000000000002",
            "method": "POST",
            "path": "/hooks",
            "receivedAt": NOW_MS,
            "sample": False,
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(200, json=preview)

    client = make_client(handler)
    result = client.endpoints.preview_response("acme")
    assert calls[-1] == ("POST", "/api/endpoints/acme/responses/preview", {})
    assert result.rule is not None and result.rule.index == 1 and result.rule.name == "pings"
    assert result.response is not None
    assert result.response.status == 202
    assert result.response.headers == {"x-id": "evt_1"}
    assert result.response.body == '{"id":"evt_1"}'
    assert result.response.delay == 250
    assert result.unknown_placeholders == ["json.nope"]
    assert result.email is False
    assert result.request.id == "4f0e7c1a-0000-4000-8000-000000000002"
    assert result.request.path == "/hooks"
    assert result.request.received_at == NOW_MS
    assert result.request.sample is False

    rule = {
        "conditions": [{"field": "size", "op": "gt", "value": "1024"}],
        "response": {"status": 413, "body": "", "headers": {}},
    }
    client.endpoints.preview_response(
        "acme",
        request_id="4f0e7c1a-0000-4000-8000-000000000002",
        mock_response=None,
        response_rules=[rule],
    )
    assert calls[-1][2] == {
        "requestId": "4f0e7c1a-0000-4000-8000-000000000002",
        "mockResponse": None,
        "responseRules": [rule],
    }

    client.endpoints.preview_response("acme", response_rules=None)
    assert calls[-1][2] == {"responseRules": None}

    with pytest.raises(ValueError, match="slug"):
        client.endpoints.preview_response("../admin")
    assert len(calls) == 3


def test_preview_response_reads_a_sample_and_the_plain_200() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "rule": None,
                "response": None,
                "unknownPlaceholders": [],
                "email": False,
                "request": {
                    "id": None,
                    "method": "POST",
                    "path": "/",
                    "receivedAt": 1,
                    "sample": True,
                },
            },
        )

    result = make_client(handler).endpoints.preview_response("acme")
    assert result.rule is None
    assert result.response is None
    assert result.request.id is None
    assert result.request.sample is True


DESTINATION_ID = "4f0e7c1a-0000-4000-8000-000000000010"


def destination_record(**fields: Any) -> dict[str, Any]:
    return {
        "id": DESTINATION_ID,
        "endpointId": "e1",
        "position": 1,
        "name": "Invoices",
        "enabled": True,
        "url": "https://hooks.acme.test/invoices",
        "hasSecret": True,
        "http": True,
        "email": False,
        "format": "template",
        "filter": {
            "logic": "or",
            "conditions": [
                {"field": "body_path", "path": "type", "op": "eq", "value": "invoice.paid"},
                {"field": "signature", "op": "eq", "value": "verified"},
            ],
        },
        "bodyTemplate": {"invoice": "{{ json.data.object.id }}"},
        "messageTemplate": None,
        "headers": [{"name": "x-env", "value": "\u2022\u2022\u2022\u2022"}],
        "appendPath": True,
        "retrySeconds": 3600,
        "keepOrder": False,
        "sentField": None,
        "throttleSeconds": 60,
        "delaySeconds": 0,
        "role": None,
        "createdAt": NOW_MS - 1000,
        "updatedAt": NOW_MS,
        **fields,
    }


def test_destinations_call_their_routes() -> None:
    calls: list[tuple[str, str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        target = request.url.path + (f"?{request.url.query.decode()}" if request.url.query else "")
        calls.append((request.method, target, body))
        path = request.url.path
        if path.endswith("/secret"):
            return httpx.Response(200, json={"secret": "whsec_c2VjcmV0"})
        if path.endswith("/test"):
            return httpx.Response(200, json={"status": 204, "durationMs": 12, "delivered": True})
        if path.endswith("/preview"):
            return httpx.Response(200, json={"request": {}, "format": "json"})
        if request.method == "DELETE":
            return httpx.Response(200, json={"deleted": True})
        if path.endswith("/destinations") or path.endswith("/order"):
            if request.method == "POST":
                return httpx.Response(201, json=destination_record())
            return httpx.Response(200, json=[destination_record()])
        return httpx.Response(200, json=destination_record())

    destinations = make_client(handler).destinations
    base = "/api/endpoints/acme/destinations"
    one = f"{base}/{DESTINATION_ID}"

    assert [item.id for item in destinations.list("acme")] == [DESTINATION_ID]
    destinations.list("acme", summary=True)
    destinations.get("acme", DESTINATION_ID)
    destinations.create(
        "acme",
        url="https://hooks.acme.test/invoices",
        email=False,
        filter={"conditions": [{"field": "kind", "op": "eq", "value": "http"}]},
        format="template",
        body_template={"invoice": "{{ json.id }}"},
        headers=[{"name": "x-env", "value": "test"}],
        retry_seconds=3600,
        throttle_seconds=60,
        delay_seconds=30,
    )
    destinations.update(
        "acme", DESTINATION_ID, name=None, enabled=False, headers=[{"name": "x-env", "value": None}]
    )
    destinations.delete("acme", DESTINATION_ID)
    destinations.reorder("acme", [DESTINATION_ID, "4f0e7c1a-0000-4000-8000-000000000011"])
    assert destinations.secret("acme", DESTINATION_ID) == "whsec_c2VjcmV0"
    destinations.rotate_secret("acme", DESTINATION_ID)
    destinations.test("acme", DESTINATION_ID)
    destinations.test("acme", DESTINATION_ID, kind="email", request_id="r1")
    destinations.preview(
        "acme",
        destination_id=DESTINATION_ID,
        destination={"format": "json", "filter": None, "append_path": False},
        request_id="r1",
    )
    destinations.preview("acme", destination={"url": "https://hooks.acme.test/new"})

    assert calls == [
        ("GET", base, None),
        ("GET", f"{base}?summary=true", None),
        ("GET", one, None),
        (
            "POST",
            base,
            {
                "url": "https://hooks.acme.test/invoices",
                "email": False,
                "format": "template",
                "filter": {"conditions": [{"field": "kind", "op": "eq", "value": "http"}]},
                "bodyTemplate": {"invoice": "{{ json.id }}"},
                "headers": [{"name": "x-env", "value": "test"}],
                "retrySeconds": 3600,
                "throttleSeconds": 60,
                "delaySeconds": 30,
            },
        ),
        (
            "PATCH",
            one,
            {"name": None, "enabled": False, "headers": [{"name": "x-env", "value": None}]},
        ),
        ("DELETE", one, None),
        ("PUT", f"{base}/order", {"ids": [DESTINATION_ID, "4f0e7c1a-0000-4000-8000-000000000011"]}),
        ("GET", f"{one}/secret", None),
        ("POST", f"{one}/secret", None),
        ("POST", f"{one}/test", {}),
        ("POST", f"{one}/test", {"kind": "email", "requestId": "r1"}),
        (
            "POST",
            f"{base}/preview",
            {
                "destinationId": DESTINATION_ID,
                "destination": {"format": "json", "filter": None, "appendPath": False},
                "requestId": "r1",
            },
        ),
        ("POST", f"{base}/preview", {"destination": {"url": "https://hooks.acme.test/new"}}),
    ]


def test_destinations_are_parsed() -> None:
    record = destination_record(
        summary={"last24h": {"delivered": 3, "failed": 1, "skipped": 2}, "pending": 4}
    )
    client = make_client(lambda request: httpx.Response(200, json=[record]))
    [destination] = client.destinations.list("acme", summary=True)
    assert destination.id == DESTINATION_ID
    assert destination.position == 1
    assert destination.name == "Invoices"
    assert destination.enabled is True and destination.has_secret is True
    assert destination.http is True and destination.email is False
    assert destination.format == "template"
    assert destination.filter is not None
    assert destination.filter.logic == "or"
    assert destination.filter.conditions[1] == {
        "field": "signature",
        "op": "eq",
        "value": "verified",
    }
    assert destination.body_template == {"invoice": "{{ json.data.object.id }}"}
    assert destination.message_template is None
    assert destination.headers[0].name == "x-env"
    assert destination.append_path is True and destination.keep_order is False
    assert destination.retry_seconds == 3600
    assert destination.throttle_seconds == 60 and destination.delay_seconds == 0
    assert destination.role is None
    assert destination.updated_at == NOW_MS
    assert destination.summary is not None
    assert destination.summary.last_24h.delivered == 3
    assert destination.summary.last_24h.skipped == 2
    assert destination.summary.pending == 4
    assert destination.raw["endpointId"] == "e1"

    assert destination.has_mailgun_signing_key is False

    plain = Destination.from_dict(destination_record(filter=None, role="forward"))
    assert plain.filter is None and plain.summary is None and plain.role == "forward"


def test_destinations_take_the_inbound_shapes_and_a_mailgun_key() -> None:
    bodies: list[Any] = []
    record = destination_record(format="mailgun", email=True, hasMailgunSigningKey=True)

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=record)

    destinations = make_client(handler).destinations
    created = destinations.create(
        "acme",
        url="https://hooks.acme.test/inbound",
        http=False,
        format="mailgun",
        mailgun_signing_key="key-acme-test",
    )
    assert bodies[-1] == {
        "url": "https://hooks.acme.test/inbound",
        "http": False,
        "format": "mailgun",
        "mailgunSigningKey": "key-acme-test",
    }
    assert created.format == "mailgun" and created.has_mailgun_signing_key is True
    destinations.update("acme", DESTINATION_ID, mailgun_signing_key=None)
    assert bodies[-1] == {"mailgunSigningKey": None}
    destinations.preview("acme", destination={"format": "postmark"})
    assert bodies[-1] == {"destination": {"format": "postmark"}}


def test_a_saved_filter_can_be_sent_back() -> None:
    bodies: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=destination_record())

    client = make_client(handler)
    saved = Destination.from_dict(destination_record())
    client.destinations.update("acme", DESTINATION_ID, filter=saved.filter)
    assert bodies[0]["filter"] == destination_record()["filter"]


def test_destination_preview_and_test_results_are_parsed() -> None:
    preview = DestinationPreview.from_dict(
        {
            "request": {
                "id": None,
                "kind": "email",
                "method": "EMAIL",
                "path": "acme@mailhooks.cc",
                "subject": "Invoice 42",
                "receivedAt": NOW_MS,
                "sample": True,
            },
            "takesKind": True,
            "filterPasses": False,
            "format": "template",
            "delivery": {
                "method": "POST",
                "url": "https://hooks.acme.test/invoices",
                "headers": {"content-type": "application/json"},
                "body": '{"invoice":"in_1"}',
                "bodyBase64": None,
            },
            "error": None,
        }
    )
    assert preview.request.id is None and preview.request.sample is True
    assert preview.request.kind == "email" and preview.request.subject == "Invoice 42"
    assert preview.takes_kind is True and preview.filter_passes is False
    assert preview.format == "template"
    assert preview.delivery is not None
    assert preview.delivery.body == '{"invoice":"in_1"}' and preview.delivery.body_base64 is None
    assert preview.delivery.headers == {"content-type": "application/json"}
    assert preview.error is None

    unsent = DestinationPreview.from_dict(
        {"request": {}, "format": "template", "delivery": None, "error": "json.nope is missing"}
    )
    assert unsent.delivery is None and unsent.error == "json.nope is missing"

    result = DestinationTestResult.from_dict(
        {
            "status": None,
            "durationMs": 10_000,
            "excerpt": None,
            "error": "timed out",
            "delivered": False,
            "url": "https://hooks.acme.test/invoices",
            "sample": False,
            "kind": "http",
            "format": "as_received",
            "target": "hooks.acme.test/invoices",
            "filterPasses": True,
            "request": {
                "id": "r1",
                "method": "POST",
                "path": "/stripe",
                "subject": None,
                "receivedAt": NOW_MS,
            },
            "sender": {"at": NOW_MS - 50, "source": "webhook-timestamp", "wholeSeconds": True},
        }
    )
    assert result.status is None and result.error == "timed out" and result.delivered is False
    assert result.duration_ms == 10_000
    assert result.filter_passes is True
    assert result.format == "as_received" and result.target == "hooks.acme.test/invoices"
    assert result.request is not None
    assert result.request.id == "r1" and result.request.kind == "http"
    assert result.request.sample is False and result.request.path == "/stripe"
    assert result.sender is not None and result.sender.whole_seconds is True


def test_destination_input_is_checked_before_sending() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=destination_record())

    destinations = make_client(handler).destinations
    with pytest.raises(ValueError, match="logic"):
        destinations.create(
            "acme", url="https://hooks.acme.test", filter={"logic": "xor", "conditions": []}
        )
    with pytest.raises(ValueError, match="conditions"):
        destinations.update("acme", DESTINATION_ID, filter={"logic": "and"})
    with pytest.raises(ValueError, match="filter"):
        destinations.update("acme", DESTINATION_ID, filter=[])  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="Unknown destination field"):
        destinations.preview("acme", destination={"bodyTemplate": {}})
    with pytest.raises(ValueError, match="destination id"):
        destinations.get("acme", "../secret")
    with pytest.raises(ValueError, match="slug"):
        destinations.list("../admin")
    with pytest.raises(ValueError, match="list"):
        destinations.reorder("acme", DESTINATION_ID)
    assert calls == []


def test_path_globs_cross_line_breaks() -> None:
    request = Request.from_dict(captured("r1", path="/a/b\nc/d"))
    assert match_path("/a/**")(request) is True
    assert match_path("/a/*/d")(request) is True
    assert match_path("/a/b?c/d")(request) is True


def test_slugs_are_validated() -> None:
    client = make_client(lambda request: httpx.Response(500))
    with pytest.raises(ValueError, match="slug"):
        client.endpoints.get("../admin")


@pytest.mark.parametrize(
    ("status", "error_type"),
    [
        (401, errors.UnauthorizedError),
        (404, errors.NotFoundError),
        (400, errors.WebhooksCCError),
        (503, errors.WebhooksCCError),
    ],
)
def test_errors_are_typed(status: int, error_type: type[Exception]) -> None:
    client = make_client(lambda request: httpx.Response(status, text="nope"))
    with pytest.raises(error_type) as caught:
        client.endpoints.get("acme")
    assert isinstance(caught.value, errors.WebhooksCCError)
    assert caught.value.status_code == status


def test_rate_limit_error_carries_the_headers() -> None:
    headers = {
        "retry-after": "7",
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1767225600",
    }
    client = make_client(lambda request: httpx.Response(429, headers=headers, text="slow down"))
    with pytest.raises(errors.RateLimitError) as caught:
        client.usage()
    assert (caught.value.retry_after, caught.value.limit, caught.value.reset) == (
        7,
        100,
        1767225600,
    )


def test_retries_follow_the_options() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, json={"used": 0, "limit": 1, "remaining": 1, "plan": "pro"})

    client = make_client(handler, retry=RetryOptions(max_attempts=3, backoff=1))
    assert client.usage().plan == "pro"
    assert len(calls) == 3


ENDPOINT = {"id": "e1", "slug": "acme", "createdAt": NOW_MS}


def _connect_error(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("refused", request=request)


def _read_timeout(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("slow", request=request)


@pytest.mark.parametrize(
    "fail",
    [lambda request: httpx.Response(503, text="busy"), _connect_error, _read_timeout],
    ids=["5xx", "network error", "timeout"],
)
def test_a_post_is_not_repeated_after_a_5xx_a_network_error_or_a_timeout(fail: Handler) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return fail(request)

    client = make_client(handler, retry=RetryOptions(max_attempts=3, backoff=1))
    with pytest.raises((errors.WebhooksCCError, httpx.TransportError)):
        client.endpoints.create("acme")
    assert calls == ["POST"]


def test_a_post_is_repeated_after_a_429() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if len(calls) == 1:
            return httpx.Response(429, text="slow down")
        return httpx.Response(200, json=ENDPOINT)

    client = make_client(handler, retry=RetryOptions(max_attempts=2, backoff=1))
    assert client.endpoints.create("acme").slug == "acme"
    assert calls == ["POST", "POST"]


@pytest.mark.parametrize("method", ["GET", "DELETE"])
def test_a_get_or_a_delete_is_repeated_after_a_network_error(method: str) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if len(calls) == 1:
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(204) if method == "DELETE" else httpx.Response(200, json=ENDPOINT)

    client = make_client(handler, retry=RetryOptions(max_attempts=2, backoff=1))
    if method == "DELETE":
        client.endpoints.delete("acme")
    else:
        client.endpoints.get("acme")
    assert calls == [method, method]


@pytest.mark.parametrize(("before", "sent"), [(None, 1), (1000, 2)])
def test_clear_is_repeated_only_with_a_before_time(before: int | None, sent: int) -> None:
    # Without ``before`` the server clears up to its own clock: a repeat would
    # delete what arrived after a clear that went through.
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if len(calls) == 1:
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(200, json={"deleted": 1, "complete": True})

    client = make_client(handler, retry=RetryOptions(max_attempts=2, backoff=1))
    if sent == 1:
        with pytest.raises(httpx.ConnectError):
            client.requests.clear("acme", before=before)
    else:
        client.requests.clear("acme", before=before)
    assert len(calls) == sent


def test_timeouts_raise_the_sdk_timeout_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    client = make_client(handler, timeout="2s")
    with pytest.raises(TimeoutError) as caught:  # the built-in name catches it too
        client.usage()
    assert isinstance(caught.value, errors.TimeoutError)
    assert caught.value.timeout_ms == 2000


def test_requests_list_asks_for_extracts() -> None:
    params: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        params.append(dict(request.url.params))
        return httpx.Response(200, json=[captured("r1")])

    [request] = make_client(handler).requests.list("acme", limit=5, since=10, kind="http")
    assert params == [{"extracts": "true", "limit": "5", "since": "10", "kind": "http"}]
    assert request.received_at == NOW_MS
    assert request.json() == {}


def test_wait_for_polls_until_a_match_arrives() -> None:
    polls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        polls.append(request.url.params["since"])
        if len(polls) == 1:
            return httpx.Response(200, json=[captured("r1", body='{"type":"a"}')])
        if len(polls) == 2:
            return httpx.Response(503, text="blip")
        return httpx.Response(
            200,
            json=[
                captured("r1", body='{"type":"a"}'),
                captured("r2", body='{"type":"b"}', receivedAt=NOW_MS + 1),
            ],
        )

    client = make_client(handler)
    request = client.requests.wait_for(
        "acme", timeout="5s", poll_interval=10, match=match_body_path("type", "b")
    )
    assert request.id == "r2"
    assert len(polls) == 3
    # Looks back five minutes on the first poll.
    assert NOW_MS - int(polls[0]) >= 5 * 60 * 1000 - 1000


def test_wait_for_all_returns_them_oldest_first() -> None:
    newer = captured("new", receivedAt=NOW_MS + 5)
    older = captured("old", receivedAt=NOW_MS)
    client = make_client(lambda request: httpx.Response(200, json=[newer, older]))
    assert [r.id for r in client.requests.wait_for_all("acme", count=2, timeout="1s")] == [
        "old",
        "new",
    ]


def test_wait_for_times_out() -> None:
    client = make_client(lambda request: httpx.Response(200, json=[]))
    with pytest.raises(errors.TimeoutError):
        client.requests.wait_for("acme", timeout=timedelta(milliseconds=50), poll_interval=10)


def test_wait_for_stops_on_errors_that_will_not_go_away() -> None:
    client = make_client(lambda request: httpx.Response(401, text="bad key"))
    with pytest.raises(errors.UnauthorizedError):
        client.requests.wait_for("acme", timeout="5s", poll_interval=10)


def test_wait_for_finds_a_request_when_the_local_clock_runs_ahead() -> None:
    # The server's clock is a minute behind: what arrives after the first poll
    # still carries a receivedAt before the local time of that poll.
    arrived: list[dict[str, Any]] = []
    polls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        polls.append(1)
        if len(polls) == 2:
            arrived.append(captured("r1", receivedAt=int(time.time() * 1000) - 60_000))
        since = int(request.url.params["since"])
        return httpx.Response(200, json=[r for r in arrived if r["receivedAt"] > since])

    request = make_client(handler).requests.wait_for("acme", timeout="2s", poll_interval=10)
    assert request.id == "r1"


def test_wait_for_keeps_polling_after_a_poll_times_out() -> None:
    polls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        polls.append(1)
        if len(polls) == 1:
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(200, json=[captured("r1")])

    request = make_client(handler).requests.wait_for("acme", timeout="2s", poll_interval=10)
    assert request.id == "r1"
    assert len(polls) == 2


def test_wait_for_polls_from_30_seconds_before_the_newest_request() -> None:
    received_at = int(time.time() * 1000) - 10_000
    sinces: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sinces.append(int(request.url.params["since"]))
        return httpx.Response(200, json=[captured("r1", method="GET", receivedAt=received_at)])

    with pytest.raises(errors.TimeoutError):
        make_client(handler).requests.wait_for(
            "acme",
            timeout=timedelta(milliseconds=100),
            poll_interval=10,
            match=lambda request: request.method == "POST",
        )
    assert len(sinces) > 1
    assert all(since == received_at - 30_000 for since in sinces[1:])


def test_emails_wait_for_filters_and_extracts() -> None:
    params: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        params.append(dict(request.url.params))
        return httpx.Response(
            200,
            json=[
                email_record("m1", "other-run", "Confirm your email"),
                email_record("m2", "run-42", "Confirm your email"),
            ],
        )

    client = make_client(handler)
    email = client.emails.wait_for("acme", tag="run-42", subject="Confirm", timeout="1s")
    assert email.id == "m2"
    assert params[0]["kind"] == "email"
    assert extract_code(email) == "482913"
    assert extract_link(email, action_only=True) == "https://acme.test/confirm"
    assert client.emails.latest("acme", tag=None) is None


def test_emails_carry_their_fields_and_reply_text() -> None:
    record = {
        **email_record("m1", None, "Re: Invoice INV-2041"),
        "emailFields": {"invoice": "INV-2041", "total": None},
        "replyText": "Thanks, paid.",
    }
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(f"{request.url.path}?{request.url.query.decode()}")
        return httpx.Response(200, json=record)

    email = make_client(handler).emails.get("m1")
    assert paths == ["/api/requests/m1?extracts=true"]
    assert email.email_fields == {"invoice": "INV-2041", "total": None}
    assert email.reply_text == "Thanks, paid."
    plain = Request.from_dict({**record, "emailFields": None, "replyText": None})
    assert plain.email_fields is None and plain.reply_text is None
    assert Request.from_dict(captured("r1")).email_fields is None


def test_emails_render_posts_the_format() -> None:
    calls: list[tuple[str, str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(
            200,
            json={
                "format": "postmark",
                "method": "POST",
                "headers": {"content-type": "application/json", "user-agent": "webhooks.cc"},
                "body": '{"Subject":"Hi"}',
            },
        )

    emails = make_client(handler).emails
    rendered = emails.render("m1", format="postmark")
    assert calls[-1] == ("POST", "/api/requests/m1/render", {"format": "postmark"})
    assert rendered.format == "postmark" and rendered.method == "POST"
    assert rendered.headers["content-type"] == "application/json"
    assert rendered.body == '{"Subject":"Hi"}'
    assert rendered.raw["format"] == "postmark"

    emails.render("m1", format="mailgun", mailgun_signing_key="key-acme-test")
    assert calls[-1][2] == {"format": "mailgun", "mailgunSigningKey": "key-acme-test"}
    emails.render("m1", format="json", mailgun_signing_key="")
    assert calls[-1][2] == {"format": "json"}

    with pytest.raises(ValueError, match="Unknown inbound format"):
        emails.render("m1", format="resend")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="request id"):
        emails.render("../m1", format="json")
    assert len(calls) == 3


def test_extract_code_needs_extracts() -> None:
    email = Request.from_dict({**email_record("m1", None, "Hi"), "extracts": None})
    with pytest.raises(ValueError, match="Show codes and links"):
        extract_code(email)
    with pytest.raises(ValueError, match="not a captured email"):
        extract_code(Request.from_dict(captured("r1")))


def test_email_addresses() -> None:
    assert email_address("Acme", "run-42") == "acme+run-42@mailhooks.cc"
    assert not is_valid_email_tag("has space")
    with pytest.raises(ValueError):
        email_address("acme", "a@b")
    client = make_client(lambda request: httpx.Response(500))
    endpoint = Endpoint.from_dict(
        {"id": "e1", "slug": "acme", "createdAt": 1, "emailAddress": "acme@example.test"}
    )
    assert client.emails.address(endpoint, "x") == "acme+x@example.test"
    assert client.emails.address("acme") == "acme@mailhooks.cc"


def test_email_matcher_uses_from_underscore() -> None:
    email = Request.from_dict(email_record("m1", None, "Hello"))
    assert match_email(from_="NO-REPLY@acme.test")(email)
    assert match_email(from_=re.compile(r"^Acme <"))(email)
    assert not match_email(tag="x")(email)


def test_replay_sends_the_exact_body_without_credentials() -> None:
    sent: list[httpx.Request] = []
    raw = bytes([0xFF, 0x00, 0x41])

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "webhooks.cc":
            return httpx.Response(
                200,
                json=captured(
                    "r1",
                    method="PUT",
                    headers={"Authorization": "secret", "X-Custom": "1", "Host": "go.webhooks.cc"},
                    body="ignored",
                    bodyRaw=base64.b64encode(raw).decode(),
                ),
            )
        sent.append(request)
        return httpx.Response(204)

    response = make_client(handler).requests.replay("r1", "http://localhost:8000/hook")
    assert response.status_code == 204
    assert sent[0].method == "PUT"
    assert sent[0].content == raw
    assert sent[0].headers["x-custom"] == "1"
    assert "authorization" not in sent[0].headers


def test_build_request_without_a_provider() -> None:
    client = make_client(lambda request: httpx.Response(500))
    built = client.build_request("http://localhost:8000/hook", body={"a": 1.0, "b": "é"})
    assert built.method == "POST"
    assert built.headers == {"Content-Type": "application/json"}
    assert built.body == '{"a":1,"b":"é"}'
    with pytest.raises(ValueError, match="http and https"):
        client.build_request("ftp://example.com")
    with pytest.raises(ValueError, match="secret"):
        client.build_request("http://localhost/hook", provider="stripe")


def stream_response(*frames: str, date: str | None = None) -> httpx.Response:
    headers = {"content-type": "text/event-stream"}
    if date:
        headers["date"] = date
    return httpx.Response(200, headers=headers, content="".join(frames).encode())


def request_frame(request_id: str, received_at: int) -> str:
    return f"event: request\ndata: {json.dumps(captured(request_id, receivedAt=received_at))}\n\n"


def test_subscribe_yields_requests_and_ends_when_the_endpoint_is_deleted() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/stream/acme"
        return stream_response(
            "event: connected\ndata: {}\n\n",
            ": keepalive\n\n",
            request_frame("r1", 1000),
            request_frame("r1", 1000),
            "event: request\ndata: not json\n\n",
            request_frame("r2", 2000),
            "event: endpoint_deleted\ndata: {}\n\n",
            request_frame("r3", 3000),
        )

    ids = [request.id for request in make_client(handler).requests.subscribe("acme")]
    assert ids == ["r1", "r2"]


def test_subscribe_without_reconnect_ends_at_a_rotation() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return stream_response(request_frame("r1", 1000), "event: timeout\ndata: {}\n\n")

    assert [r.id for r in make_client(handler).requests.subscribe("acme")] == ["r1"]
    assert len(calls) == 1


def test_subscribe_reconnects_after_the_last_request() -> None:
    sinces: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sinces.append(request.url.params.get("since"))
        if len(sinces) == 1:
            return stream_response(
                request_frame("r1", 1000),
                "event: timeout\ndata: {}\n\n",
                date="Thu, 01 Jan 2026 00:00:00 GMT",
            )
        if len(sinces) == 2:
            # A replay of r1 is skipped; then the connection drops.
            return stream_response(request_frame("r1", 1000), request_frame("r2", 2000))
        return stream_response(request_frame("r3", 3000), "event: endpoint_deleted\ndata: {}\n\n")

    reconnects: list[int] = []
    stream = make_client(handler).requests.subscribe(
        "acme", reconnect=True, reconnect_backoff=1, on_reconnect=reconnects.append
    )
    assert [r.id for r in stream] == ["r1", "r2", "r3"]
    assert sinces == [None, "999", "1999"]
    assert reconnects == [1]


def test_subscribe_stops_after_max_reconnect_attempts() -> None:
    client = make_client(lambda request: httpx.Response(503, text="down"))
    stream = client.requests.subscribe(
        "acme", reconnect=True, max_reconnect_attempts=2, reconnect_backoff=1
    )
    with pytest.raises(errors.WebhooksCCError) as caught:
        list(stream)
    assert caught.value.status_code == 503


def test_subscribe_does_not_retry_a_bad_key() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(401, text="bad key")

    with pytest.raises(errors.UnauthorizedError):
        list(make_client(handler).requests.subscribe("acme", reconnect=True))
    assert len(calls) == 1


def test_temporary_endpoint_and_capture_during() -> None:
    deleted: list[str] = []
    requests_seen = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests_seen
        if request.method == "POST":
            return httpx.Response(200, json={"id": "e1", "slug": "tmp", "createdAt": NOW_MS})
        if request.method == "DELETE":
            deleted.append(request.url.path)
            return httpx.Response(404, text="gone")  # already gone is fine
        requests_seen += 1
        return httpx.Response(200, json=[] if requests_seen == 1 else [captured("r1")])

    client = make_client(handler)
    with pytest.raises(RuntimeError), temporary_endpoint(client):
        raise RuntimeError("test failed")
    assert deleted == ["/api/endpoints/tmp"]

    actions: list[str] = []
    [request] = capture_during(
        client, lambda endpoint: actions.append(endpoint.slug), poll_interval=10, timeout="2s"
    )
    assert request.id == "r1"
    assert actions == ["tmp"]
    assert len(deleted) == 2


class _SlowStream:
    """A local SSE server: keepalives every ``interval`` seconds, then one request."""

    def __init__(self, keepalives: int, interval: float, header_delay: float = 0) -> None:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *args: object) -> None:
                pass

            def do_GET(self) -> None:
                time.sleep(outer.header_delay)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                try:
                    for _ in range(outer.keepalives):
                        time.sleep(outer.interval)
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    self.wfile.write(request_frame("late", NOW_MS).encode())
                    self.wfile.flush()
                    time.sleep(0.5)
                except OSError:
                    pass

        self.keepalives = keepalives
        self.interval = interval
        self.header_delay = header_delay
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        import threading

        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def client(self) -> WebhooksCC:
        return WebhooksCC("whcc_test", base_url=f"http://127.0.0.1:{self.server.server_port}")

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def test_subscribe_ends_at_its_timeout_while_keepalives_arrive() -> None:
    server = _SlowStream(keepalives=30, interval=0.05)  # the request comes after 1.5 s
    try:
        started = time.monotonic()
        with server.client() as client:
            got = list(client.requests.subscribe("acme", timeout="400ms"))
        elapsed = time.monotonic() - started
    finally:
        server.close()
    assert got == []
    assert 0.35 < elapsed < 1.0


def test_subscribe_raises_when_the_stream_goes_idle() -> None:
    server = _SlowStream(keepalives=1, interval=2.0)  # silent for 2 s
    try:
        with server.client() as client, pytest.raises(errors.TimeoutError, match="idle"):
            list(client.requests.subscribe("acme", idle_timeout="300ms"))
    finally:
        server.close()


def test_version_matches_pyproject() -> None:
    from pathlib import Path

    import webhooks_cc

    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    match = re.search(r'^version = "([^"]+)"', pyproject, re.MULTILINE)
    assert match is not None
    assert webhooks_cc.__version__ == match.group(1)


def test_bytes_bodies_are_sent_as_they_are() -> None:
    client = make_client(lambda request: httpx.Response(500))
    raw = b"a=1&b=%C3%A9"
    built = client.build_request(
        "http://localhost/hook",
        body=raw,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert built.body == raw
    signed = client.build_request(
        "http://localhost/hook", provider="github", secret="s", body=b'{"zen":"ok"}'
    )
    assert signed.body == '{"zen":"ok"}'
    assert verify_signature("github", body=signed.body, headers=signed.headers, secret="s")
    with pytest.raises(ValueError, match="UTF-8"):
        client.build_request("http://localhost/hook", provider="github", secret="s", body=b"\xff")


def test_a_trailing_newline_is_not_a_valid_slug() -> None:
    client = make_client(lambda request: httpx.Response(500))
    with pytest.raises(ValueError, match="slug"):
        client.endpoints.get("acme\n")


def test_errors_survive_pickling() -> None:
    import pickle

    for error in [
        errors.WebhooksCCError(503, "busy"),
        errors.TimeoutError(2000),
        errors.RateLimitError(5, limit=10, remaining=0, reset=1),
        errors.WebhookVerificationError("invalid_signature", "bad"),
    ]:
        back = pickle.loads(pickle.dumps(error))
        assert type(back) is type(error)
        assert str(back) == str(error)
        assert back.__dict__ == error.__dict__


def test_subscribe_timeout_covers_the_wait_for_headers() -> None:
    server = _SlowStream(keepalives=1, interval=0.05, header_delay=2.0)
    try:
        started = time.monotonic()
        with server.client() as client:
            assert list(client.requests.subscribe("acme", timeout="300ms")) == []
        assert time.monotonic() - started < 1.5
    finally:
        server.close()


def test_bytes_like_bodies_everywhere() -> None:
    from webhooks_cc import build_template_request

    client = make_client(lambda request: httpx.Response(500))
    assert client.build_request("http://localhost/", body=bytearray(b"x=1")).body == b"x=1"
    assert client.build_request("http://localhost/", body=memoryview(b"x=1")).body == b"x=1"
    built = build_template_request(
        "http://localhost/", provider="github", secret="s", body=bytearray(b'{"a":1}')
    )
    assert built.body == '{"a":1}'


def test_send_to_never_follows_redirects_even_with_a_client_that_would() -> None:
    hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        return httpx.Response(302, headers={"Location": "https://elsewhere.test/hook"})

    http = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
    client = WebhooksCC("whcc_test", http_client=http)
    response = client.send_to("https://handler.test/hook", provider="github", secret="s")
    assert response.status_code == 302
    assert hosts == ["handler.test"]
