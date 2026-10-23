"""Request building and signing, checked against the shared vectors and the TypeScript catalog."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import parse_qsl

import pytest

from tests.conformance import CONFORMANCE_DIR, load, vector_id
from webhooks_cc._crypto import adyen_hmac, hmac_digest, to_base64, to_hex
from webhooks_cc.templates import (
    TEMPLATE_METADATA,
    TEMPLATE_PROVIDERS,
    VERIFY_PROVIDERS,
    build_template_request,
)

SIGNING = load("signing")
TEMPLATES_TS = (CONFORMANCE_DIR.parent / "src" / "templates.ts").read_text(encoding="utf-8")
ADYEN_KEY = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056"


@pytest.mark.parametrize("vector", SIGNING["vectors"], ids=vector_id)
def test_signing_vector(vector: dict[str, Any]) -> None:
    built = build_template_request(
        vector["url"],
        provider=vector["provider"],
        secret=vector["secret"],
        method=vector["method"],
        body=vector["body"],
        timestamp=vector["timestamp"],
        message_id=vector.get("messageId"),
    )
    for name, value in vector["expected"]["headers"].items():
        assert built.headers.get(name) == value, name
    assert built.body == vector["expected"]["body"]
    assert built.method == vector["method"].upper()
    assert built.url == vector["url"]


def _ts_list(name: str) -> list[str]:
    match = re.search(rf"export const {name} = \[(.*?)\] as const", TEMPLATES_TS, re.DOTALL)
    assert match, name
    return re.findall(r'"([^"]+)"', match.group(1))


def _ts_object(name: str) -> str:
    match = re.search(rf"const {name} = \{{(.*?)\n\}} as const;", TEMPLATES_TS, re.DOTALL)
    assert match, name
    return match.group(1)


def _key(raw: str) -> str:
    return raw.strip('"')


def test_provider_lists_match_typescript() -> None:
    assert list(TEMPLATE_PROVIDERS) == _ts_list("TEMPLATE_PROVIDERS")
    assert list(VERIFY_PROVIDERS) == _ts_list("VERIFY_PROVIDERS")
    assert set(TEMPLATE_METADATA) == set(TEMPLATE_PROVIDERS)


def test_templates_match_typescript() -> None:
    templates = {
        _key(key): re.findall(r'"([^"]+)"', values)
        for key, values in re.findall(
            r'^\s+("[\w-]+"|[\w]+): \[(.*?)\] as const',
            _ts_object("PROVIDER_TEMPLATES"),
            re.M | re.S,
        )
    }
    defaults = {
        _key(key): value
        for key, value in re.findall(
            r'^\s+("[\w-]+"|[\w]+): "([^"]+)",', _ts_object("DEFAULT_TEMPLATE_BY_PROVIDER"), re.M
        )
    }
    assert len(templates) == len(TEMPLATE_PROVIDERS) - 1  # standard-webhooks has none
    for provider, info in TEMPLATE_METADATA.items():
        assert list(info.templates) == templates.get(provider, []), provider
        assert info.default_template == defaults.get(provider), provider


def _template_cases() -> list[tuple[str, str | None]]:
    cases: list[tuple[str, str | None]] = []
    for provider in TEMPLATE_PROVIDERS:
        templates = TEMPLATE_METADATA[provider].templates
        cases.extend((provider, template) for template in templates or (None,))
    return cases


@pytest.mark.parametrize(("provider", "template"), _template_cases())
def test_every_template_builds(provider: str, template: str | None) -> None:
    secret = ADYEN_KEY if provider == "adyen" else "test_secret"
    built = build_template_request(
        "https://example.com/hooks", provider=provider, secret=secret, template=template
    )
    assert built.method == "POST"
    assert built.body
    if built.headers["content-type"] == "application/json":
        json.loads(built.body)
    else:
        assert built.headers["content-type"] == "application/x-www-form-urlencoded"
        assert parse_qsl(built.body)
    header = TEMPLATE_METADATA[provider].signature_header
    if header:
        assert built.headers.get(header), header
    if template is not None:
        assert built.headers["x-webhooks-cc-template-template"] == template


def test_secretless_providers_build_without_a_secret() -> None:
    for provider in ("sendgrid", "discord", "plaid"):
        assert not TEMPLATE_METADATA[provider].secret_required
        assert build_template_request("https://example.com/", provider=provider).body


def test_errors_match_typescript() -> None:
    with pytest.raises(ValueError, match='Provider "stripe" templates require a non-empty secret'):
        build_template_request("https://example.com/", provider="stripe")
    with pytest.raises(ValueError, match='Provider "stripe" templates require a non-empty secret'):
        build_template_request("https://example.com/", provider="stripe", secret="")
    with pytest.raises(
        ValueError,
        match=r'Unsupported template "nope" for provider "github"\. Supported templates: push, '
        r"pull_request\.opened, ping",
    ):
        build_template_request(
            "https://example.com/", provider="github", secret="s", template="nope"
        )
    with pytest.raises(ValueError, match="Unsupported provider: acme"):
        build_template_request("https://example.com/", provider="acme", secret="s")


def test_bodies_serialize_like_json_stringify() -> None:
    built = build_template_request(
        "https://example.com/",
        provider="github",
        secret="s",
        body={"amount": 20.0, "note": "café ✓ <b>", "items": [1, None, True]},
    )
    assert built.body == '{"amount":20,"note":"café ✓ <b>","items":[1,null,true]}'
    expected = to_hex(hmac_digest("sha256", "s", built.body))
    assert built.headers["x-hub-signature-256"] == f"sha256={expected}"


def test_headers_are_added_last_and_override() -> None:
    built = build_template_request(
        "https://example.com/",
        provider="stripe",
        secret="s",
        method="put",
        headers={"user-agent": "acme-test", "x-extra": "1"},
    )
    assert built.method == "PUT"
    assert built.headers["user-agent"] == "acme-test"
    assert built.headers["x-extra"] == "1"


def test_event_overrides_the_template_event() -> None:
    built = build_template_request(
        "https://example.com/", provider="github", secret="s", template="pull_request.opened"
    )
    assert built.headers["x-github-event"] == "pull_request"
    built = build_template_request(
        "https://example.com/", provider="stripe", secret="s", event="charge.refunded"
    )
    assert json.loads(built.body or "")["type"] == "charge.refunded"
    assert built.headers["x-webhooks-cc-template-event"] == "charge.refunded"


def test_standard_webhooks_message_ids() -> None:
    built = build_template_request(
        "https://example.com/",
        provider="standard-webhooks",
        secret="whsec_dGVzdA==",
        event="order.paid",
    )
    assert re.fullmatch(r"msg_order\.paid_[0-9a-f]{8}", built.headers["webhook-id"])
    assert built.body == "{}"
    built = build_template_request("https://example.com/", provider="standard-webhooks", secret="x")
    assert re.fullmatch(r"msg_[0-9a-f]{16}", built.headers["webhook-id"])


def test_slack_slash_command_is_form_encoded_like_url_search_params() -> None:
    built = build_template_request(
        "https://example.com/",
        provider="slack",
        secret="s",
        template="slash_command",
        body={"text": "a b~*'!", "count": 1, "empty": None, "flag": False, "list": [1, None, "x"]},
        timestamp=1767225600,
    )
    assert built.headers["content-type"] == "application/x-www-form-urlencoded"
    assert built.body == "text=a+b%7E*%27%21&count=1&empty=&flag=false&list=1%2C%2Cx"
    digest = to_hex(hmac_digest("sha256", "s", f"v0:1767225600:{built.body}"))
    assert built.headers["x-slack-signature"] == f"v0={digest}"
    with pytest.raises(
        ValueError, match="slash_command body override must be a string or an object"
    ):
        build_template_request(
            "https://example.com/", provider="slack", secret="s", template="slash_command", body=[1]
        )


def test_twilio_signs_object_overrides_by_sorted_parameters() -> None:
    url = "https://example.com/sms"
    built = build_template_request(
        url, provider="twilio", secret="s", body={"To": "+1 555", "Body": "Hi"}
    )
    assert built.body == "To=%2B1+555&Body=Hi"
    expected = hmac_digest("sha1", "s", f"{url}BodyHiTo+1 555")
    assert built.headers["x-twilio-signature"] == to_base64(expected)
    with pytest.raises(
        ValueError, match="Twilio template body override must be a string or an object"
    ):
        build_template_request(url, provider="twilio", secret="s", body=5)


def test_mailgun_template_signs_its_own_timestamp_and_token() -> None:
    built = build_template_request("https://example.com/", provider="mailgun", secret="key")
    signature = json.loads(built.body or "")["signature"]
    expected = to_hex(hmac_digest("sha256", "key", signature["timestamp"] + signature["token"]))
    assert signature["signature"] == expected
    assert len(signature["token"]) == 50


def test_mailgun_body_without_a_signature_gets_one() -> None:
    built = build_template_request(
        "https://example.com/",
        provider="mailgun",
        secret="key",
        body={"a": 1},
        timestamp=1700000000,
    )
    parsed = json.loads(built.body or "")
    assert list(parsed) == ["a", "signature"]
    assert parsed["signature"]["timestamp"] == "1700000000"


def test_adyen_signs_every_item() -> None:
    body = {
        "live": "false",
        "notificationItems": [
            {"NotificationRequestItem": {"pspReference": "1", "success": "true"}},
            {
                "NotificationRequestItem": {
                    "pspReference": "2",
                    "additionalData": {"hmacSignature": "old", "other": "x"},
                    "amount": {"value": 500, "currency": "EUR"},
                }
            },
        ],
    }
    built = build_template_request(
        "https://example.com/", provider="adyen", secret=ADYEN_KEY, body=body
    )
    items = [
        wrapper["NotificationRequestItem"]
        for wrapper in json.loads(built.body or "")["notificationItems"]
    ]
    for item in items:
        assert item["additionalData"]["hmacSignature"] == adyen_hmac(item, ADYEN_KEY)
    assert list(items[1]["additionalData"]) == ["hmacSignature", "other"]
    with pytest.raises(ValueError, match="hex"):
        build_template_request("https://example.com/", provider="adyen", secret="not-hex")


def test_hubspot_and_workos_use_milliseconds() -> None:
    built = build_template_request(
        "https://example.com/", provider="hubspot", secret="s", timestamp=1767225600
    )
    assert built.headers["x-hubspot-request-timestamp"] == "1767225600000"
    built = build_template_request(
        "https://example.com/", provider="workos", secret="s", timestamp=1767225600
    )
    assert built.headers["workos-signature"].startswith("t=1767225600000, v1=")


def test_paypal_placeholder_headers() -> None:
    built = build_template_request(
        "https://example.com/", provider="paypal", secret="WH-1", timestamp=1767225600
    )
    assert built.headers["paypal-transmission-time"] == "2026-01-01T00:00:00.000Z"
    assert built.headers["paypal-auth-algo"] == "SHA256withRSA"
    assert built.headers["paypal-cert-url"].startswith(
        "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-"
    )
