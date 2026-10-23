"""A secret that decodes to an empty key is refused, never accepted as a verdict.

An HMAC keyed with nothing is one anyone can compute; WebCrypto refuses such
a key in the TypeScript SDK, so the ports must too.
"""

from __future__ import annotations

import base64
import hashlib
import hmac

import pytest

from webhooks_cc import (
    build_template_request,
    verify_forwarded_email,
    verify_forwarded_request,
    verify_relayed_request,
    verify_signature,
)

BODY = b'{"type":"email.received","timestamp":"2026-01-01T00:00:00.000Z","data":{}}'
EMPTY_SECRETS = ["whsec_", " ", "whsec_\n", "\t\n"]


def _forged(prefix: bytes) -> str:
    return "v1," + base64.b64encode(hmac.new(b"", prefix + BODY, hashlib.sha256).digest()).decode()


HEADERS = {
    "webhook-id": "msg_1",
    "webhook-timestamp": "1767225600",
    "webhook-signature": _forged(b"msg_1.1767225600."),
    "svix-id": "msg_1",
    "svix-timestamp": "1767225600",
    "svix-signature": _forged(b"msg_1.1767225600."),
    "webhooks-cc-request-id": "req_1",
    "webhooks-cc-received-at": "2026-01-01T00:00:00.000Z",
    "webhooks-cc-signature": _forged(b"req_1.2026-01-01T00:00:00.000Z."),
}


@pytest.mark.parametrize("secret", EMPTY_SECRETS)
@pytest.mark.parametrize("provider", ["standard-webhooks", "clerk", "resend"])
def test_verify_signature_refuses_an_empty_key(provider: str, secret: str) -> None:
    with pytest.raises(ValueError, match="empty key"):
        verify_signature(provider, body=BODY, headers=HEADERS, secret=secret)


@pytest.mark.parametrize("secret", EMPTY_SECRETS)
def test_forwarding_checks_refuse_an_empty_key(secret: str) -> None:
    with pytest.raises(ValueError, match="empty key"):
        verify_forwarded_email(BODY, HEADERS, secret, now=1767225600000)
    with pytest.raises(ValueError, match="empty key"):
        verify_forwarded_request(BODY, HEADERS, secret, now=1767225600000)
    with pytest.raises(ValueError, match="empty key"):
        verify_relayed_request(BODY, HEADERS, secret)


@pytest.mark.parametrize("provider", ["standard-webhooks", "clerk", "resend"])
def test_signing_refuses_an_empty_key(provider: str) -> None:
    with pytest.raises(ValueError, match="empty key"):
        build_template_request("https://example.com/hook", provider=provider, secret="whsec_")


def test_a_real_secret_still_verifies() -> None:
    secret = "whsec_cm91bmR0cmlwLXNlY3JldA=="
    built = build_template_request(
        "https://example.com/hook", provider="standard-webhooks", secret=secret
    )
    assert verify_signature(
        "standard-webhooks", body=built.body, headers=built.headers, secret=secret
    )
