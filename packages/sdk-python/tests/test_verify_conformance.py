"""Signature verification against the shared vectors, plus what the vectors leave out."""

from __future__ import annotations

import base64
from typing import Any

import pytest

from tests.conformance import load, vector_id
from webhooks_cc import verify as verify_module
from webhooks_cc._crypto import hmac_digest, to_base64
from webhooks_cc.errors import WebhookVerificationError
from webhooks_cc.verify import (
    RelayedRequestInfo,
    build_paypal_transmission_message,
    verify_forwarded_email,
    verify_forwarded_request,
    verify_relayed_request,
    verify_signature,
    verify_stripe_signature,
    verify_twilio_signature,
)

VERIFY = load("verify")["vectors"]
FORWARDING = load("forwarding")["vectors"]


@pytest.mark.parametrize("vector", VERIFY, ids=vector_id)
def test_verify_vector(vector: dict[str, Any]) -> None:
    certificate = vector.get("certificate")
    valid = verify_signature(
        vector["provider"],
        body=vector["body"],
        headers=vector["headers"],
        secret=vector.get("secret"),
        public_key=vector.get("publicKey"),
        url=vector["url"],
        method=vector["method"],
        now=vector["now"],
        fetch_certificate=(lambda _url: certificate) if certificate else None,
    )
    assert valid is vector["expected"]


def _run_forwarding(vector: dict[str, Any]) -> dict[str, Any]:
    body: str | bytes = (
        base64.b64decode(vector["bodyBase64"]) if "bodyBase64" in vector else vector["body"]
    )
    try:
        if vector["function"] == "verifyForwardedEmail":
            verify_forwarded_email(body, vector["headers"], vector["secret"], now=vector["now"])
        elif vector["function"] == "verifyForwardedRequest":
            verify_forwarded_request(body, vector["headers"], vector["secret"], now=vector["now"])
        else:
            assert vector["function"] == "verifyRelayedRequest"
            verify_relayed_request(body, vector["headers"], vector["secret"])
    except WebhookVerificationError as error:
        return {"error": error.code}
    return {"ok": True}


@pytest.mark.parametrize("vector", FORWARDING, ids=vector_id)
def test_forwarding_vector(vector: dict[str, Any]) -> None:
    assert _run_forwarding(vector) == vector["expected"]


def _vector(vectors: list[dict[str, Any]], name: str) -> dict[str, Any]:
    return next(vector for vector in vectors if vector["name"] == name)


def test_bytes_bodies_verify_like_text() -> None:
    stripe = _vector(VERIFY, "stripe")
    body = stripe["body"].encode("utf-8")
    assert verify_signature("stripe", body=body, headers=stripe["headers"], secret=stripe["secret"])
    assert verify_signature(
        "stripe", body=bytearray(body), headers=stripe["headers"], secret=stripe["secret"]
    )


def test_headers_in_any_shape() -> None:
    stripe = _vector(VERIFY, "stripe")
    (name, value), *_ = stripe["headers"].items()
    for headers in (
        {name.upper(): value},
        [(name.title(), value)],
        [(name.encode(), value.encode())],
        {name: [value]},
    ):
        assert verify_signature(
            "stripe", body=stripe["body"], headers=headers, secret=stripe["secret"]
        ), headers


def test_forwarded_email_returns_the_event() -> None:
    vector = _vector(FORWARDING, "forwarded email")
    event = verify_forwarded_email(
        vector["body"], vector["headers"], vector["secret"], now=vector["now"]
    )
    assert event["type"] == "email.received"
    assert event["data"]["address"].endswith("@mailhooks.cc")


def test_forwarded_email_tolerance_is_adjustable() -> None:
    vector = _vector(FORWARDING, "forwarded email, timestamp more than 300 seconds old")
    event = verify_forwarded_email(
        vector["body"],
        vector["headers"],
        vector["secret"],
        now=vector["now"],
        tolerance_seconds=3600,
    )
    assert event["type"] == "email.received"


def test_relayed_request_returns_the_metadata() -> None:
    vector = _vector(FORWARDING, "relayed request")
    info = verify_relayed_request(vector["body"], vector["headers"], vector["secret"])
    assert isinstance(info, RelayedRequestInfo)
    headers = {key.lower(): value for key, value in vector["headers"].items()}
    assert info.request_id == headers["webhooks-cc-request-id"]
    assert info.received_at == headers["webhooks-cc-received-at"]
    assert info.endpoint == headers.get("webhooks-cc-endpoint")
    expected_attempt = (
        int(headers["webhooks-cc-attempt"]) if "webhooks-cc-attempt" in headers else None
    )
    assert info.attempt == expected_attempt


@pytest.mark.parametrize(
    ("attempt", "expected"), [("2", 2), ("0", None), ("1.5", None), ("x", None)]
)
def test_relayed_request_attempt(attempt: str, expected: int | None) -> None:
    vector = _vector(FORWARDING, "relayed request")
    headers = {**vector["headers"], "webhooks-cc-attempt": attempt}
    assert verify_relayed_request(vector["body"], headers, vector["secret"]).attempt == expected


def test_twilio_accepts_form_fields_as_a_mapping() -> None:
    secret = "twilio_secret"
    url = "https://example.com/sms"
    params = {"To": "+15551234567", "Body": "Hi there", "From": "+15557654321"}
    payload = url + "".join(f"{key}{params[key]}" for key in sorted(params))
    signature = to_base64(hmac_digest("sha1", secret, payload))
    assert verify_twilio_signature(url, params, signature, secret)
    form = "To=%2B15551234567&Body=Hi+there&From=%2B15557654321"
    assert verify_twilio_signature(url, form, signature, secret)
    assert verify_twilio_signature(url, "?" + form, signature, secret)


def test_required_options() -> None:
    with pytest.raises(ValueError, match="non-empty secret"):
        verify_stripe_signature("{}", "t=1,v1=00", "")
    with pytest.raises(ValueError, match="requires url"):
        verify_signature("twilio", body="", headers={}, secret="s")
    with pytest.raises(ValueError, match="non-empty public key"):
        verify_signature("discord", body="", headers={})
    with pytest.raises(ValueError, match="SendGrid"):
        verify_signature("sendgrid", body="", headers={}, secret="s")
    with pytest.raises(ValueError, match="Plaid"):
        verify_signature("plaid", body="", headers={}, secret="s")
    with pytest.raises(ValueError, match="Unknown provider"):
        verify_signature("acme", body="", headers={}, secret="s")


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://api.paypal.com/v1/notifications/certs/CERT-360caa42", True),
        ("https://API-M.PayPal.com:443/v1/notifications/certs/x", True),
        ("https://api.sandbox.paypal.com/v1/notifications/certs/x", True),
        ("http://api.paypal.com/v1/notifications/certs/x", False),
        ("https://api.paypal.com.evil.test/v1/notifications/certs/x", False),
        ("https://api.paypal.com@evil.test/v1/notifications/certs/x", False),
        ("https://api.paypal.com/v1/notifications/certs/../../oauth2/token", False),
        ("https://api.paypal.com/v1/notifications/certs/%2e%2e/x", False),
        ("https://api.paypal.com\\@evil.test/v1/notifications/certs/x", False),
        ("https://api.paypal.com/v1/other", False),
        ("not a url", False),
    ],
)
def test_paypal_certificate_urls(url: str, allowed: bool) -> None:
    assert verify_module._is_allowed_paypal_certificate_url(url) is allowed


def _paypal_vector() -> dict[str, Any]:
    return _vector(VERIFY, "paypal")


def test_paypal_downloads_and_caches_the_certificate(monkeypatch: pytest.MonkeyPatch) -> None:
    vector = _paypal_vector()
    calls: list[str] = []

    def fake_get(url: str) -> tuple[int, dict[str, str], str]:
        calls.append(url)
        return 200, {}, vector["certificate"]

    monkeypatch.setattr(verify_module, "_http_get", fake_get)
    monkeypatch.setattr(verify_module, "_PAYPAL_CERTIFICATE_CACHE", {})
    for _ in range(2):
        assert verify_signature(
            "paypal", body=vector["body"], headers=vector["headers"], secret=vector["secret"]
        )
    assert len(calls) == 1


def test_paypal_follows_only_paypal_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    vector = _paypal_vector()

    def redirect_away(url: str) -> tuple[int, dict[str, str], str]:
        return 302, {"Location": "https://evil.test/cert.pem"}, ""

    monkeypatch.setattr(verify_module, "_http_get", redirect_away)
    monkeypatch.setattr(verify_module, "_PAYPAL_CERTIFICATE_CACHE", {})
    with pytest.raises(RuntimeError, match="redirected outside PayPal"):
        verify_signature(
            "paypal", body=vector["body"], headers=vector["headers"], secret=vector["secret"]
        )


def test_paypal_fetcher_failure_is_not_a_verdict() -> None:
    vector = _paypal_vector()

    def broken(_url: str) -> str:
        raise OSError("connection refused")

    with pytest.raises(RuntimeError, match="Unable to download the PayPal certificate"):
        verify_signature(
            "paypal",
            body=vector["body"],
            headers=vector["headers"],
            secret=vector["secret"],
            fetch_certificate=broken,
        )


def test_paypal_transmission_message() -> None:
    assert build_paypal_transmission_message("", "id", "time", "hook") == "id|time|hook|0"
    assert build_paypal_transmission_message(None, "id", "time", "hook") == "id|time|hook|0"
    # CRC-32 of "hello" is 0x3610A686.
    assert build_paypal_transmission_message(b"hello", "i", "t", "w") == "i|t|w|907060870"
