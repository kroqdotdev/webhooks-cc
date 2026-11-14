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
    AttachmentDownload,
    Destination,
    DestinationFilter,
    DestinationPreview,
    DestinationTestResult,
    EmailField,
    Endpoint,
    Layout,
    LineItemColumn,
    LineItemsSpec,
    ParsedSheet,
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


def test_endpoint_site_is_sent_and_read() -> None:
    bodies: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        bodies.append(body)
        return httpx.Response(
            200,
            json={"id": "e1", "slug": "acme", "createdAt": 1, "site": body.get("site", "both")},
        )

    client = make_client(handler)
    assert client.endpoints.create("orders", site="mailhooks").site == "mailhooks"
    assert bodies[0]["site"] == "mailhooks"
    assert client.endpoints.create("hooks").site == "both"
    assert "site" not in bodies[1]
    assert client.endpoints.update("acme", site="webhooks").site == "webhooks"
    assert bodies[2] == {"site": "webhooks"}


def test_endpoint_favorite_is_read_where_the_api_sends_it() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "e3", "slug": "fresh", "createdAt": 3})
        if request.url.path == "/api/endpoints/acme":
            return httpx.Response(
                200, json={"id": "e1", "slug": "acme", "createdAt": 1, "favorite": True}
            )
        return httpx.Response(
            200,
            json={
                "owned": [{"id": "e1", "slug": "acme", "createdAt": 1, "favorite": True}],
                "shared": [{"id": "e2", "slug": "team", "createdAt": 2, "favorite": False}],
            },
        )

    client = make_client(handler)
    assert [item.favorite for item in client.endpoints.list()] == [True, False]
    assert client.endpoints.get("acme").favorite is True
    assert client.endpoints.create("ci").favorite is None
    assert Endpoint.from_dict({"id": "e1", "slug": "acme", "favorite": "yes"}).favorite is None


def test_favorite_and_unfavorite_call_the_favorite_route() -> None:
    calls: list[tuple[str, str, bytes]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, request.content))
        return httpx.Response(200, json={"favorite": request.method == "PUT"})

    client = make_client(handler)
    assert client.endpoints.favorite("acme") is True
    assert client.endpoints.unfavorite("acme") is False
    assert calls == [
        ("PUT", "/api/endpoints/acme/favorite", b""),
        ("DELETE", "/api/endpoints/acme/favorite", b""),
    ]
    with pytest.raises(ValueError, match="slug"):
        client.endpoints.favorite("../admin")
    with pytest.raises(ValueError, match="slug"):
        client.endpoints.unfavorite("a/b")
    assert len(calls) == 2


@pytest.mark.parametrize(
    ("status", "error_type"),
    [
        (404, errors.NotFoundError),
        (403, errors.WebhooksCCError),
        (429, errors.RateLimitError),
    ],
)
def test_favorite_errors_are_typed(status: int, error_type: type[Exception]) -> None:
    client = make_client(
        lambda request: httpx.Response(status, json={"error": "Endpoint not found"})
    )
    with pytest.raises(error_type) as caught:
        client.endpoints.favorite("acme")
    assert isinstance(caught.value, errors.WebhooksCCError)
    assert caught.value.status_code == status


def test_a_favorite_is_repeated_after_a_network_error() -> None:
    attempts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request.method)
        if len(attempts) == 1:
            raise httpx.ConnectError("reset", request=request)
        return httpx.Response(200, json={"favorite": True})

    client = make_client(handler, retry=RetryOptions(max_attempts=2, backoff=1))
    assert client.endpoints.favorite("acme") is True
    assert attempts == ["PUT", "PUT"]


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
    assert destination.attachments == "links"

    plain = Destination.from_dict(destination_record(filter=None, role="forward"))
    assert plain.filter is None and plain.summary is None and plain.role == "forward"
    assert Destination.from_dict(destination_record(attachments="inline")).attachments == "inline"


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
    destinations.update("acme", DESTINATION_ID, attachments="inline")
    assert bodies[-1] == {"attachments": "inline"}
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


def test_live_response_is_read_when_present() -> None:
    request = Request.from_dict(
        captured(
            "r1",
            liveResponse={
                "status": 201,
                "headers": {"content-type": "application/json"},
                "body": '{"ok":true}',
                "bodyTruncated": False,
                "bodyEncoding": "utf8",
                "ms": 12,
            },
        )
    )
    assert request.live_response is not None
    assert request.live_response.status == 201
    assert request.live_response.headers == {"content-type": "application/json"}
    assert request.live_response.body == '{"ok":true}'
    assert request.live_response.body_truncated is False
    assert request.live_response.body_encoding == "utf8"
    assert request.live_response.ms == 12
    assert Request.from_dict(captured("r2")).live_response is None


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


def test_usage_reads_the_other_allowances() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "used": 0,
                "limit": 50,
                "remaining": 50,
                "plan": "free",
                "parsedPages": {
                    "used": 3,
                    "limit": 20,
                    "creditPages": 0,
                    "overage": {"active": False, "used": 0, "max": 0},
                    "resetsAt": None,
                },
                "previewData": {
                    "bytes": 1024,
                    "limitBytes": 1073741824,
                    "over": False,
                    "resetsAt": "2026-12-01T00:00:00.000Z",
                },
                "aiAssists": None,
            },
        )

    usage = make_client(handler).usage()
    assert usage.parsed_pages is not None
    assert (usage.parsed_pages.used, usage.parsed_pages.limit) == (3, 20)
    assert usage.parsed_pages.resets_at is None
    assert usage.preview_data is not None
    assert usage.preview_data.limit_bytes == 1073741824
    assert usage.preview_data.resets_at == "2026-12-01T00:00:00.000Z"
    assert usage.ai_assists is None


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


def test_a_destination_test_may_take_ninety_seconds() -> None:
    timeouts: dict[str, float] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        timeouts[request.url.path.rsplit("/", 1)[-1]] = request.extensions["timeout"]["read"]
        if request.url.path.endswith("/test"):
            return httpx.Response(200, json={"delivered": True})
        return httpx.Response(200, json={"request": {}, "format": "json"})

    client = make_client(handler, timeout="30s")
    client.destinations.test("acme", DESTINATION_ID)
    client.destinations.preview("acme", destination_id=DESTINATION_ID)
    # A file drop's test has a minute on the server; other calls keep the client's.
    assert timeouts == {"test": 90.0, "preview": 30.0}
    make_client(handler, timeout="2m").destinations.test("acme", DESTINATION_ID)
    assert timeouts["test"] == 120.0


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


def test_update_sends_retention_and_layouts_and_reads_them_back() -> None:
    bodies: list[Any] = []
    layout = {
        "id": "orders",
        "name": "Orders",
        "match": {
            "conditions": [
                {"field": "email", "name": "subject", "op": "contains", "value": "Order"}
            ]
        },
        "lineItems": {"from": "attachment", "attachment": "*.csv"},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "e1",
                "slug": "acme",
                "createdAt": 1,
                "retentionDays": 3,
                "retentionCapDays": 31,
                "deleteAfterDelivery": False,
                "layouts": [layout],
                "layoutsCap": 2,
            },
        )

    endpoint = make_client(handler).endpoints.update(
        "acme", retention_days=3, delete_after_delivery=False, layouts=[layout]
    )
    assert bodies == [{"retentionDays": 3, "deleteAfterDelivery": False, "layouts": [layout]}]
    assert endpoint.retention_days == 3
    assert endpoint.retention_cap_days == 31
    assert endpoint.layouts is not None
    [read] = endpoint.layouts
    assert read.id == "orders" and read.enabled is None and read.parse_attachments is False
    assert read.match is not None and read.match.conditions[0]["value"] == "Order"
    assert read.line_items == LineItemsSpec(from_="attachment", attachment="*.csv")
    assert endpoint.layouts_cap == 2


def test_preview_layouts_reads_the_parsed_result() -> None:
    calls: list[tuple[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.url.path, json.loads(request.content)))
        return httpx.Response(
            200,
            json={
                "problems": [],
                "layoutsCap": 2,
                "request": {"id": "r1", "subject": "Order 1", "receivedAt": 1},
                "parsed": {
                    "status": "matched",
                    "layout": {"id": "orders", "name": "Orders"},
                    "fields": {"order": "1", "total": None},
                    "lineItems": [{"sku": "A-1", "qty": "2"}],
                    "lineItemColumns": ["sku", "qty"],
                    "attachments": [
                        {
                            "index": 0,
                            "filename": "o.csv",
                            "format": "csv",
                            "pages": 1,
                            "sheets": [
                                {
                                    "name": None,
                                    "rows": [["sku", "qty"], ["A-1", None]],
                                    "rowCount": 2,
                                    "truncated": False,
                                }
                            ],
                        },
                        {
                            "index": 1,
                            "filename": "b.pdf",
                            "format": "pdf",
                            "pages": 0,
                            "error": "limit",
                        },
                    ],
                    "pages": 1,
                    "truncated": True,
                },
            },
        )

    preview = make_client(handler).endpoints.preview_layouts("acme", request_id="r1")
    assert calls == [("/api/endpoints/acme/layouts/preview", {"requestId": "r1"})]
    assert preview.request_id == "r1"
    assert preview.request_subject == "Order 1"
    assert preview.request_received_at == 1
    parsed = preview.parsed
    assert parsed is not None
    assert parsed.status == "matched"
    assert parsed.layout == {"id": "orders", "name": "Orders"}
    assert parsed.fields == {"order": "1", "total": None}
    assert parsed.line_items == [{"sku": "A-1", "qty": "2"}]
    assert parsed.line_item_columns == ["sku", "qty"]
    assert [item.error for item in parsed.attachments] == [None, "limit"]
    assert parsed.attachments[0].sheets == [
        ParsedSheet(name=None, rows=[["sku", "qty"], ["A-1", ""]], row_count=2, truncated=False)
    ]
    assert parsed.attachments[1].sheets is None
    assert parsed.truncated is True and parsed.partial is False


def test_requests_carry_the_parse_and_stored_attachments() -> None:
    from webhooks_cc.models import Request

    request = Request.from_dict(
        {
            "id": "r1",
            "endpointId": "e1",
            "method": "EMAIL",
            "path": "acme@mailhooks.cc",
            "headers": {},
            "queryParams": {},
            "ip": "192.0.2.1",
            "size": 10,
            "receivedAt": 1,
            "kind": "email",
            "email": {
                "subject": "Order 1",
                "stored": True,
                "attachments": [
                    {
                        "filename": "o.csv",
                        "contentType": "text/csv",
                        "size": 3,
                        "url": "https://x/a",
                    }
                ],
            },
            "parsed": {"status": "no_layout", "layout": None, "fields": {}, "lineItems": []},
        }
    )
    assert request.email is not None and request.email.stored
    assert request.email.attachments[0].url == "https://x/a"
    assert request.parsed is not None and request.parsed.status == "no_layout"
    assert request.parsed.line_item_columns == []
    assert request.parsed.partial is False


def test_layouts_round_trip_and_are_sent_as_the_api_takes_them() -> None:
    wire = {
        "id": "orders",
        "name": "Orders",
        "enabled": False,
        "match": {
            "logic": "or",
            "conditions": [
                {"field": "email", "name": "from", "op": "contains", "value": "acme.test"}
            ],
        },
        "fields": [{"name": "order", "from": "subject", "pattern": r"Order (\d+)"}],
        "lineItems": {
            "from": "attachment",
            "attachment": "*.xlsx",
            "sheet": "Items",
            "columns": [{"name": "sku", "column": "A"}, {"name": "qty", "column": "Quantity"}],
        },
        "parseAttachments": True,
    }
    layout = Layout.from_dict(wire)
    assert layout.enabled is False and layout.parse_attachments is True
    assert layout.fields == [EmailField(name="order", from_="subject", pattern=r"Order (\d+)")]
    assert layout.line_items is not None
    assert layout.line_items.columns == [
        LineItemColumn(name="sku", column="A"),
        LineItemColumn(name="qty", column="Quantity"),
    ]
    assert layout.to_dict() == wire

    text_items = Layout(
        id="receipts",
        name="Receipts",
        match=DestinationFilter(conditions=[]),
        line_items=LineItemsSpec(
            from_="text", pattern=r"(?P<sku>[A-Z]+-\d+)\s+(?P<qty>\d+)", start="Items"
        ),
    )
    bodies: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        if request.url.path.endswith("/layouts/preview"):
            return httpx.Response(200, json={"problems": [], "layoutsCap": 2, "request": None})
        return httpx.Response(200, json={"id": "e1", "slug": "acme", "createdAt": 1})

    client = make_client(handler)
    client.endpoints.update("acme", layouts=[text_items, wire])
    preview = client.endpoints.preview_layouts("acme", layouts=[text_items])
    sent_text = {
        "id": "receipts",
        "name": "Receipts",
        "match": {"logic": "and", "conditions": []},
        "lineItems": {
            "from": "text",
            "pattern": r"(?P<sku>[A-Z]+-\d+)\s+(?P<qty>\d+)",
            "start": "Items",
        },
    }
    assert bodies == [{"layouts": [sent_text, wire]}, {"layouts": [sent_text]}]
    assert preview.request_id is None and preview.request_subject is None
    with pytest.raises(ValueError, match="list of layouts"):
        client.endpoints.update("acme", layouts=wire)  # type: ignore[arg-type]
    assert len(bodies) == 2


STORED_BYTES = b"Subject: Order 1\r\n\r\n\x00\xff\xfe not UTF-8\r\n"


def test_requests_decode_partial_flag() -> None:
    from webhooks_cc.models import Request

    request = Request.from_dict(
        {
            "id": "r1",
            "endpointId": "e1",
            "method": "EMAIL",
            "path": "acme@mailhooks.cc",
            "headers": {},
            "queryParams": {},
            "ip": "192.0.2.1",
            "size": 10,
            "receivedAt": 1,
            "kind": "email",
            "parsed": {
                "status": "matched",
                "layout": {"id": "orders", "name": "Orders"},
                "fields": {},
                "lineItems": [],
                "partial": True,
            },
        }
    )
    assert request.parsed is not None and request.parsed.partial is True


def test_raw_returns_the_message_bytes_unchanged() -> None:
    seen: list[tuple[str, str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.headers["authorization"]))
        return httpx.Response(
            200,
            content=STORED_BYTES,
            headers={
                "content-type": "message/rfc822",
                "content-disposition": 'attachment; filename="email-6f1c0a2b.eml"',
            },
        )

    assert make_client(handler).requests.raw("r1") == STORED_BYTES
    assert seen == [("GET", "/api/requests/r1/raw", "Bearer whcc_test")]


def test_a_redirect_is_an_error_for_api_calls_too() -> None:
    # A delete against a redirecting base URL must not read as done.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(301, headers={"location": "https://webhooks.cc/api/endpoints/x"})

    following = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
    with pytest.raises(errors.WebhooksCCError) as raised:
        WebhooksCC("whcc_test", http_client=following).endpoints.delete("acme-orders")
    assert raised.value.status_code == 301


def test_a_redirected_download_raises_instead_of_returning_the_page() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            301,
            content=b"<html>Moved</html>",
            headers={
                "location": "https://webhooks.cc/api/requests/r1/raw",
                "content-type": "text/html",
            },
        )

    # Even through a client that would follow it.
    following = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
    with pytest.raises(errors.WebhooksCCError):
        WebhooksCC("whcc_test", http_client=following).requests.raw("r1")
    client = make_client(handler)
    with pytest.raises(errors.WebhooksCCError) as raised:
        client.requests.raw("r1")
    assert raised.value.status_code == 301
    with pytest.raises(errors.WebhooksCCError):
        client.requests.attachment("r1", 0)


def test_attachment_returns_its_bytes_name_and_type_unchanged() -> None:
    responses: list[httpx.Response] = []
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        return responses.pop(0)

    responses.append(
        httpx.Response(
            200,
            content=STORED_BYTES,
            headers={
                "content-type": "text/csv",
                "content-disposition": (
                    "attachment; filename=\"r_sum_.csv\"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv"
                ),
            },
        )
    )
    client = make_client(handler)
    download = client.requests.attachment("r1", 2)
    assert download == AttachmentDownload(
        content=STORED_BYTES, filename="r\u00e9sum\u00e9.csv", content_type="text/csv"
    )
    assert paths == ["/api/requests/r1/attachments/2"]
    assert "content=" not in repr(download)

    # A name cut inside an escape keeps the plain one; no headers at all, the defaults.
    responses.append(
        httpx.Response(
            200,
            content=b"%PDF",
            headers={
                "content-disposition": 'attachment; filename="r_sum_.pdf"; '
                "filename*=UTF-8''r%C3%A"
            },
        )
    )
    responses.append(httpx.Response(200, content=b""))
    cut = client.requests.attachment("r1", 0)
    assert (cut.filename, cut.content_type) == ("r_sum_.pdf", "application/octet-stream")
    empty = client.requests.attachment("r1", 99)
    assert (empty.content, empty.filename) == (b"", None)


def test_downloads_raise_typed_errors_and_check_their_input() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/raw"):
            return httpx.Response(400, json={"error": "not_an_email"})
        return httpx.Response(
            404,
            json={
                "error": "not_kept",
                "message": "This email's attachment contents were not kept.",
            },
        )

    client = make_client(handler)
    with pytest.raises(errors.NotFoundError) as missing:
        client.requests.attachment("r1", 0)
    assert missing.value.status_code == 404 and "not_kept" in str(missing.value)
    with pytest.raises(errors.WebhooksCCError) as not_email:
        client.requests.raw("r1")
    assert not_email.value.status_code == 400

    for index in (-1, 100, True, 1.0):
        with pytest.raises(ValueError, match="index"):
            client.requests.attachment("r1", index)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="request id"):
        client.requests.raw("../r1")


def test_downloads_are_retried_like_other_reads() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, content=STORED_BYTES)

    client = make_client(handler, retry=RetryOptions(max_attempts=2, backoff=1))
    assert client.requests.raw("r1") == STORED_BYTES
    assert len(calls) == 2


# --- search ----------------------------------------------------------------------------


def search_response(
    ids: list[str],
    *,
    complete: bool,
    cursor: str | None = None,
    until: int | None = None,
) -> httpx.Response:
    headers = {"x-search-complete": "true" if complete else "false"}
    if cursor is not None:
        headers["x-search-cursor"] = cursor
    if until is not None:
        headers["x-search-searched-until"] = str(until)
    return httpx.Response(
        200, json=[captured(i, slug="acme", endpointId=None) for i in ids], headers=headers
    )


def test_search_page_reads_one_page_and_its_progress() -> None:
    seen: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/search/requests"
        seen.append(dict(request.url.params))
        return search_response(["r1", "r2"], complete=False, cursor="c1.mac", until=NOW_MS - 5000)

    client = make_client(handler)
    page = client.requests.search_page(
        slug="acme",
        q="invoice",
        method="POST",
        kind="http",
        from_=1000,
        to=2000,
        limit=20,
        offset=5,
        order="asc",
    )
    assert [r.id for r in page.requests] == ["r1", "r2"]
    assert page.requests[0].raw["slug"] == "acme"
    assert (page.complete, page.searched_until, page.cursor) == (False, NOW_MS - 5000, "c1.mac")
    assert seen[0] == {
        "slug": "acme",
        "q": "invoice",
        "method": "POST",
        "kind": "http",
        "from": "1000",
        "to": "2000",
        "limit": "20",
        "offset": "5",
        "order": "asc",
        "paged": "true",
    }

    # With a cursor, the offset is the cursor's to carry.
    client.requests.search_page(q="invoice", offset=5, cursor="c1.mac")
    assert seen[1] == {"q": "invoice", "paged": "true", "cursor": "c1.mac"}


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        ({"x-search-complete": "true"}, (True, None, None)),
        ({"x-search-complete": "false", "x-search-cursor": "c"}, (False, None, "c")),
        (
            {"x-search-complete": "TRUE", "x-search-searched-until": "1767225600000"},
            (True, 1767225600000, None),
        ),
        ({"x-search-complete": "false", "x-search-searched-until": "soon"}, (False, None, None)),
        # A server from before the cursor sends no progress: that answer is all there is.
        ({}, (True, None, None)),
    ],
)
def test_search_page_reads_the_progress_headers(
    headers: dict[str, str], expected: tuple[bool, int | None, str | None]
) -> None:
    client = make_client(lambda request: httpx.Response(200, json=[], headers=headers))
    page = client.requests.search_page(q="x")
    assert (page.complete, page.searched_until, page.cursor) == expected
    assert page.requests == []


def test_search_follows_the_cursor_until_it_has_the_limit() -> None:
    seen: list[dict[str, str]] = []
    pages = [
        search_response(["r1", "r2"], complete=False, cursor="c1"),
        search_response([], complete=False, cursor="c2"),
        search_response(["r3", "r4", "r5"], complete=False, cursor="c3"),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        return pages[len(seen) - 1]

    found = make_client(handler).requests.search(q="invoice", limit=4, offset=10)
    assert [r.id for r in found] == ["r1", "r2", "r3", "r4"]
    assert seen == [
        {"q": "invoice", "limit": "4", "offset": "10", "paged": "true"},
        {"q": "invoice", "limit": "2", "paged": "true", "cursor": "c1"},
        {"q": "invoice", "limit": "2", "paged": "true", "cursor": "c2"},
    ]


def test_search_stops_when_the_search_is_complete() -> None:
    seen: list[dict[str, str]] = []
    pages = [
        search_response(["r1"], complete=False, cursor="c1"),
        search_response(["r2"], complete=True),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        return pages[len(seen) - 1]

    found = make_client(handler).requests.search(slug="acme")
    assert [r.id for r in found] == ["r1", "r2"]
    # The default limit is the server's on the first page, and what is left of 50 after.
    assert seen == [
        {"slug": "acme", "paged": "true"},
        {"slug": "acme", "limit": "49", "paged": "true", "cursor": "c1"},
    ]


def test_search_stops_at_its_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_MS", 0)
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.params.get("cursor", ""))
        return search_response(["r1"], complete=False, cursor="more")

    client = make_client(handler)
    assert [r.id for r in client.requests.search(q="rare")] == ["r1"]
    assert calls == [""]


def test_count_adds_up_the_stretches() -> None:
    seen: list[dict[str, str]] = []
    answers: list[dict[str, Any]] = [
        {"count": 3, "exact": False, "searchedUntil": NOW_MS - 1000, "cursor": "c1"},
        {"count": 0, "exact": False, "searchedUntil": NOW_MS - 2000, "cursor": "c2"},
        {"count": 4, "exact": True, "searchedUntil": None, "cursor": None},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/search/requests/count"
        seen.append(dict(request.url.params))
        return httpx.Response(200, json=answers[len(seen) - 1])

    client = make_client(handler)
    assert client.requests.count(q="invoice", kind="email") == 7
    assert seen == [
        {"q": "invoice", "kind": "email", "paged": "true"},
        {"q": "invoice", "kind": "email", "paged": "true", "cursor": "c1"},
        {"q": "invoice", "kind": "email", "paged": "true", "cursor": "c2"},
    ]


def test_count_stops_at_its_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_MS", 0)
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.params.get("cursor", ""))
        return httpx.Response(
            200, json={"count": 2, "exact": False, "searchedUntil": 1, "cursor": "more"}
        )

    assert make_client(handler).requests.count(q="rare") == 2
    assert calls == [""]


def test_count_page_says_whether_the_count_is_exact() -> None:
    seen: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        if "cursor" in request.url.params:
            return httpx.Response(
                200, json={"count": 1, "exact": True, "searchedUntil": None, "cursor": None}
            )
        return httpx.Response(
            200,
            json={"count": 5, "exact": False, "searchedUntil": 1767225600000, "cursor": "c1"},
        )

    client = make_client(handler)
    first = client.requests.count_page(slug="acme", q="invoice")
    assert (first.count, first.exact, first.searched_until, first.cursor) == (
        5,
        False,
        1767225600000,
        "c1",
    )
    rest = client.requests.count_page(slug="acme", q="invoice", cursor=first.cursor)
    assert (rest.count, rest.exact, rest.searched_until, rest.cursor) == (1, True, None, None)
    assert seen[1] == {"slug": "acme", "q": "invoice", "paged": "true", "cursor": "c1"}
    # An answer from before the cursor is only a count.
    old = make_client(lambda request: httpx.Response(200, json={"count": 3}))
    assert old.requests.count_page() == old.requests.count_page()
    assert (old.requests.count_page().exact, old.requests.count()) == (True, 3)


def test_an_invalid_cursor_has_its_own_error() -> None:
    client = make_client(lambda request: httpx.Response(400, json={"error": "invalid_cursor"}))
    with pytest.raises(errors.InvalidCursorError) as caught:
        client.requests.search_page(q="x", cursor="tampered")
    assert caught.value.status_code == 400
    with pytest.raises(errors.InvalidCursorError):
        client.requests.count_page(q="x", cursor="tampered")
    # Another 400 stays a plain API error.
    other = make_client(lambda request: httpx.Response(400, json={"error": "invalid_q"}))
    with pytest.raises(errors.WebhooksCCError) as plain:
        other.requests.search_page(q="x")
    assert not isinstance(plain.value, errors.InvalidCursorError)
    assert "invalid_q" in plain.value.message


def test_a_busy_search_is_retried_after_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("webhooks_cc.client._sleep_ms", slept.append)
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, json={"error": "search_busy"}, headers={"retry-after": "2"})
        return search_response(["r1"], complete=True)

    client = make_client(handler, retry=RetryOptions(max_attempts=2, backoff=1))
    assert [r.id for r in client.requests.search(q="x")] == ["r1"]
    assert slept == [2000]
    # Without retries it is the rate-limit error, with the wait the server asked for.
    calls.clear()
    with pytest.raises(errors.RateLimitError) as caught:
        make_client(handler).requests.search_page(q="x")
    assert caught.value.retry_after == 2


def busy_response(retry_after: str | None = "3") -> httpx.Response:
    headers = {"retry-after": retry_after} if retry_after is not None else {}
    return httpx.Response(429, json={"error": "search_busy", "message": "busy"}, headers=headers)


def test_search_waits_out_a_busy_server_without_retry_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    slept: list[float] = []
    monkeypatch.setattr("webhooks_cc.client._sleep_ms", slept.append)
    seen: list[str] = []
    answers = [
        busy_response("3"),
        search_response(["r1"], complete=False, cursor="c1"),
        busy_response(None),
        search_response(["r2"], complete=True),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params.get("cursor", ""))
        return answers[len(seen) - 1]

    found = make_client(handler).requests.search(q="x")
    assert [r.id for r in found] == ["r1", "r2"]
    # The same page again each time; a second at least when the server names no wait.
    assert seen == ["", "", "c1", "c1"]
    assert slept == [3000, 1000]


def test_count_waits_out_a_busy_server(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("webhooks_cc.client._sleep_ms", slept.append)
    seen: list[str] = []
    answers = [
        httpx.Response(200, json={"count": 2, "exact": False, "cursor": "c1"}),
        busy_response("0"),
        httpx.Response(200, json={"count": 5, "exact": True, "cursor": None}),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params.get("cursor", ""))
        return answers[len(seen) - 1]

    assert make_client(handler).requests.count(q="x") == 7
    assert seen == ["", "c1", "c1"]
    assert slept == [1000]


def test_a_busy_wait_past_the_deadline_ends_the_search(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("webhooks_cc.client._sleep_ms", slept.append)

    def busy_after_first(request: httpx.Request) -> httpx.Response:
        if "cursor" in request.url.params:
            return busy_response("60")
        if request.url.path.endswith("/count"):
            return httpx.Response(200, json={"count": 2, "exact": False, "cursor": "c1"})
        return search_response(["r1"], complete=False, cursor="c1")

    # After the first page: what was found so far.
    client = make_client(busy_after_first)
    assert [r.id for r in client.requests.search(q="x")] == ["r1"]
    assert client.requests.count(q="x") == 2
    # On the first page: the error, with the wait the server asked for.
    always_busy = make_client(lambda request: busy_response("60"))
    with pytest.raises(errors.RateLimitError) as caught:
        always_busy.requests.search(q="x")
    assert (caught.value.retry_after, caught.value.code) == (60, "search_busy")
    with pytest.raises(errors.RateLimitError):
        always_busy.requests.count(q="x")
    assert slept == []


def test_an_ordinary_rate_limit_is_not_waited_out(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("webhooks_cc.client._sleep_ms", slept.append)
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(
            429, json={"error": "Too many requests"}, headers={"retry-after": "1"}
        )

    client = make_client(handler)
    with pytest.raises(errors.RateLimitError) as caught:
        client.requests.search(q="x")
    assert caught.value.code == "Too many requests"
    with pytest.raises(errors.RateLimitError):
        client.requests.count(q="x")
    assert (len(calls), slept) == (2, [])


def test_the_page_calls_leave_a_busy_server_to_the_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    slept: list[float] = []
    monkeypatch.setattr("webhooks_cc.client._sleep_ms", slept.append)
    client = make_client(lambda request: busy_response("2"))
    with pytest.raises(errors.RateLimitError) as caught:
        client.requests.search_page(q="x")
    assert (caught.value.retry_after, caught.value.code) == (2, "search_busy")
    with pytest.raises(errors.RateLimitError):
        client.requests.count_page(q="x")
    assert slept == []


def test_search_collects_more_than_a_page_holds() -> None:
    seen: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        start = 200 * (len(seen) - 1)
        return search_response(
            [f"r{start + i}" for i in range(200)], complete=False, cursor=f"c{len(seen)}"
        )

    found = make_client(handler).requests.search(q="x", limit=450)
    assert len(found) == 450 and len({r.id for r in found}) == 450
    assert [p["limit"] for p in seen] == ["450", "250", "50"]


@pytest.mark.parametrize("status", [429, 500])
def test_an_error_on_a_later_page_is_raised_not_returned_as_a_result(
    status: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    slept: list[float] = []
    monkeypatch.setattr("webhooks_cc.client._sleep_ms", slept.append)

    def handler(request: httpx.Request) -> httpx.Response:
        if "cursor" in request.url.params:
            return httpx.Response(
                status, json={"error": "Too many requests"}, headers={"retry-after": "1"}
            )
        if request.url.path.endswith("/count"):
            return httpx.Response(200, json={"count": 2, "exact": False, "cursor": "c1"})
        return search_response(["r1"], complete=False, cursor="c1")

    client = make_client(handler)
    expected = errors.RateLimitError if status == 429 else errors.WebhooksCCError
    with pytest.raises(expected) as caught:
        client.requests.search(q="x")
    assert caught.value.status_code == status
    with pytest.raises(expected):
        client.requests.count(q="x")
    assert slept == []


def test_an_invalid_cursor_on_a_later_page_is_raised() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "cursor" in request.url.params:
            return httpx.Response(400, json={"error": "invalid_cursor"})
        return search_response(["r1"], complete=False, cursor="c1")

    with pytest.raises(errors.InvalidCursorError):
        make_client(handler).requests.search(q="x")


def test_a_page_near_the_deadline_gets_a_shorter_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    timeouts: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        timeouts.append(request.extensions["timeout"]["read"])
        if request.url.path.endswith("/count"):
            return httpx.Response(200, json={"count": 1, "exact": True})
        return search_response([], complete=True)

    client = make_client(handler, timeout="30s")
    # Far from the deadline: the client's own timeout, when that is the shorter.
    make_client(handler, timeout="2s").requests.search(q="x")
    assert timeouts == [2.0]
    timeouts.clear()
    # 25 s to the deadline and 5 s of grace is no more than the client's 30 s.
    client.requests.search(q="x")
    client.requests.count(q="x")
    assert all(29.0 < timeout <= 30.0 for timeout in timeouts) and len(timeouts) == 2
    timeouts.clear()
    # With the deadline reached, a page gets the grace only.
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_MS", 0)
    client.requests.search(q="x")
    client.requests.count(q="x")
    assert all(4.5 < timeout <= 5.0 for timeout in timeouts) and len(timeouts) == 2
    timeouts.clear()
    # The page calls keep the client's timeout.
    client.requests.search_page(q="x")
    client.requests.count_page(q="x")
    assert timeouts == [30.0, 30.0]


def test_a_page_that_times_out_says_how_long_it_had(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_MS", 0)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(errors.TimeoutError) as caught:
        make_client(handler, timeout="30s").requests.search(q="x")
    assert 4500 < caught.value.timeout_ms <= 5000


def test_a_later_page_cut_short_by_the_deadline_ends_the_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_MS", 1000)
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_GRACE_MS", 0)

    def handler(request: httpx.Request) -> httpx.Response:
        if "cursor" in request.url.params:
            raise httpx.ReadTimeout("slow", request=request)
        if request.url.path.endswith("/count"):
            return httpx.Response(200, json={"count": 2, "exact": False, "cursor": "c1"})
        return search_response(["r1"], complete=False, cursor="c1")

    # The page had less than the client's 30 s: what was found so far.
    client = make_client(handler, timeout="30s")
    assert [r.id for r in client.requests.search(q="x")] == ["r1"]
    assert client.requests.count(q="x") == 2
    # The client's own timeout ran out: the error.
    own = make_client(handler, timeout="500ms")
    with pytest.raises(errors.TimeoutError) as caught:
        own.requests.search(q="x")
    assert caught.value.timeout_ms == 500
    with pytest.raises(errors.TimeoutError):
        own.requests.count(q="x")


def test_search_page_takes_an_empty_cursor_as_none() -> None:
    seen: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        if request.url.path.endswith("/count"):
            return httpx.Response(200, json={"count": 1, "exact": True})
        return search_response([], complete=True)

    client = make_client(handler)
    client.requests.search_page(q="x", offset=5, cursor="")
    client.requests.count_page(q="x", cursor="")
    assert seen == [{"q": "x", "offset": "5", "paged": "true"}, {"q": "x", "paged": "true"}]


def test_retries_inside_a_search_stay_within_its_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("webhooks_cc.client._sleep_ms", slept.append)
    retry = RetryOptions(max_attempts=5, backoff=1)

    def limited_later(code: str) -> Handler:
        def handler(request: httpx.Request) -> httpx.Response:
            if "cursor" in request.url.params or code.startswith("first:"):
                return httpx.Response(
                    429, json={"error": code.removeprefix("first:")}, headers={"retry-after": "60"}
                )
            if request.url.path.endswith("/count"):
                return httpx.Response(200, json={"count": 2, "exact": False, "cursor": "c1"})
            return search_response(["r1"], complete=False, cursor="c1")

        return handler

    # A wait of 60 s does not fit the 30 s a search has at most: it is never slept.
    # Busy after a page: what was found. An ordinary limit, or a first page: the error.
    busy = make_client(limited_later("search_busy"), retry=retry)
    assert [r.id for r in busy.requests.search(q="x")] == ["r1"]
    assert busy.requests.count(q="x") == 2
    for code in ("Too many requests", "first:search_busy"):
        client = make_client(limited_later(code), retry=retry)
        with pytest.raises(errors.RateLimitError) as caught:
            client.requests.search(q="x")
        assert caught.value.retry_after == 60
        with pytest.raises(errors.RateLimitError):
            client.requests.count(q="x")
    assert slept == []
    # The page calls, like every other call, wait as the retry options say.
    with pytest.raises(errors.RateLimitError):
        busy.requests.search_page(q="x", cursor="c1")
    assert slept == [60_000] * 4


def test_timeout_retries_inside_a_search_get_the_time_that_is_left(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_MS", 0)
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_GRACE_MS", 400)
    timeouts: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        timeouts.append(request.extensions["timeout"]["read"])
        time.sleep(0.15)
        raise httpx.ReadTimeout("slow", request=request)

    client = make_client(handler, timeout="30s", retry=RetryOptions(max_attempts=10, backoff=100))
    with pytest.raises(errors.TimeoutError):
        client.requests.search(q="x")
    # Each try had only what was left of the 400 ms, and no try began after them.
    assert timeouts == sorted(timeouts, reverse=True) and timeouts[0] <= 0.4
    assert 1 < len(timeouts) < 4


def test_a_slow_token_refresh_inside_a_search_ends_at_its_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_MS", 1000)
    monkeypatch.setattr("webhooks_cc.client._SEARCH_DEADLINE_GRACE_MS", 0)
    exchanges: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/oauth2/token":
            exchanges.append(request.extensions["timeout"]["read"])
            if len(exchanges) % 2 == 1:
                return httpx.Response(200, json={"access_token": "whcc_a", "expires_in": 3600})
            # The refresh a later page asked for never answers.
            raise httpx.ReadTimeout("slow", request=request)
        if "cursor" in request.url.params:
            return httpx.Response(401, json={"error": "Invalid token"})
        if request.url.path.endswith("/count"):
            return httpx.Response(200, json={"count": 2, "exact": False, "cursor": "c1"})
        return search_response(["r1"], complete=False, cursor="c1")

    def agent_client(timeout: str) -> WebhooksCC:
        return WebhooksCC._for_agent(
            assertion="assertion",
            token=None,
            binding=None,
            base_url="https://api.test",
            timeout=timeout,
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

    # The refresh had what was left of the search, not the client's 30 s, and running
    # out of it ends the search with what it has.
    client = agent_client("30s")
    assert [r.id for r in client.requests.search(q="x")] == ["r1"]
    assert exchanges[0] <= 1.0 and exchanges[1] <= 1.0
    client._tokens.drop()  # type: ignore[union-attr]
    assert client.requests.count(q="x") == 2
    assert exchanges[3] <= 1.0
    # Outside a search, and when the client's own timeout is the shorter, it is an error.
    client._tokens.drop()  # type: ignore[union-attr]
    exchanges.clear()
    with pytest.raises(errors.TimeoutError) as caught:
        client.requests.search_page(q="x", cursor="c1")
    assert (exchanges, caught.value.timeout_ms) == ([30.0, 30.0], 30_000)
    own = agent_client("500ms")
    with pytest.raises(errors.TimeoutError) as caught:
        own.requests.search(q="x")
    assert caught.value.timeout_ms == 500


def test_request_carries_endpoint_slug_when_read_by_id() -> None:
    from webhooks_cc.models import Request

    request = Request.from_dict(
        {"id": "r1", "endpointId": "e1", "endpointSlug": "acme", "method": "POST", "path": "/"}
    )
    assert request.endpoint_slug == "acme"
    assert Request.from_dict({"id": "r2", "endpointId": "e1"}).endpoint_slug is None
