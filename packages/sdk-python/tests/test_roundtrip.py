"""What the SDK signs, the SDK verifies: every template of every verifiable provider."""

from __future__ import annotations

import time

import pytest

from webhooks_cc import (
    TEMPLATE_METADATA,
    VERIFY_PROVIDERS,
    build_template_request,
    verify_signature,
)

URL = "https://example.com/hooks/acme?source=roundtrip"
ADYEN_KEY = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056"
# Discord and PayPal sign with private keys a test does not hold.
SIGNABLE = [provider for provider in VERIFY_PROVIDERS if provider not in ("discord", "paypal")]
CASES = [
    (provider, template)
    for provider in SIGNABLE
    for template in (TEMPLATE_METADATA[provider].templates or (None,))
]


def secret_for(provider: str) -> str:
    if provider == "adyen":
        return ADYEN_KEY
    if provider in ("standard-webhooks", "clerk", "resend"):
        return "whsec_cm91bmR0cmlwLXNlY3JldA=="
    return "roundtrip_secret"


@pytest.mark.parametrize(("provider", "template"), CASES, ids=lambda value: str(value))
def test_signed_templates_verify(provider: str, template: str | None) -> None:
    secret = secret_for(provider)
    built = build_template_request(URL, provider=provider, secret=secret, template=template)
    common = {"body": built.body, "url": URL, "method": built.method, "now": time.time() * 1000}
    assert verify_signature(provider, headers=built.headers, secret=secret, **common)
    assert not verify_signature(provider, headers=built.headers, secret=secret + "x", **common)
