"""Verify webhook signatures: the providers' own, and webhooks.cc's forwarding signatures.

A port of ``packages/sdk/src/verify.ts``; ``packages/sdk/conformance/verify.json``
and ``forwarding.json`` check that both give the same verdicts.

Pass bodies as the exact bytes (or text) you received, before any JSON
parsing. Headers may be a dict, any mapping (Django, Starlette, Werkzeug,
httpx), or a list of name and value pairs; names match in any case.
"""

from __future__ import annotations

import hmac
import json
import math
import re
import threading
import time
import zlib
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, TypeAlias
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

import httpx

from ._crypto import (
    adyen_hmac,
    build_twilio_signature_payload,
    decode_hubspot_uri,
    decode_standard_webhook_secret,
    from_base64,
    hmac_digest,
    js_string,
    to_base64,
    to_hex,
)
from .errors import WebhookVerificationError

HeadersInput: TypeAlias = Mapping[Any, Any] | Iterable[tuple[Any, Any]]
"""Request headers: a mapping, or name and value pairs. Names match in any case."""

BodyInput: TypeAlias = str | bytes | bytearray | memoryview | None
"""A request body as received: text or the exact bytes."""

CertificateFetcher: TypeAlias = Callable[[str], str]
"""Returns the PEM a PayPal certificate URL serves."""

__all__ = [
    "BodyInput",
    "CertificateFetcher",
    "HeadersInput",
    "RelayedRequestInfo",
    "build_paypal_transmission_message",
    "verify_adyen_signature",
    "verify_bitbucket_signature",
    "verify_cal_signature",
    "verify_calendly_signature",
    "verify_clerk_signature",
    "verify_coinbase_commerce_signature",
    "verify_discord_signature",
    "verify_docusign_signature",
    "verify_forwarded_email",
    "verify_forwarded_request",
    "verify_github_signature",
    "verify_gitlab_signature",
    "verify_hubspot_signature",
    "verify_intercom_signature",
    "verify_lemon_squeezy_signature",
    "verify_linear_signature",
    "verify_mailgun_signature",
    "verify_meta_signature",
    "verify_mux_signature",
    "verify_paddle_signature",
    "verify_paypal_signature",
    "verify_razorpay_signature",
    "verify_relayed_request",
    "verify_resend_signature",
    "verify_sentry_signature",
    "verify_shopify_signature",
    "verify_signature",
    "verify_slack_signature",
    "verify_square_signature",
    "verify_standard_webhook_signature",
    "verify_stripe_signature",
    "verify_telegram_signature",
    "verify_twilio_signature",
    "verify_typeform_signature",
    "verify_vercel_signature",
    "verify_workos_signature",
]

_CRYPTO_MISSING = (
    'Discord and PayPal signatures need the cryptography package: pip install "webhooks-cc[crypto]"'
)

_PAYPAL_CERTIFICATE_CACHE: dict[str, str] = {}
_PAYPAL_CERTIFICATE_CACHE_LOCK = threading.Lock()
# PayPal rotates through very few live certificates; the URL path suffix is
# sender-controlled, so the cache must be bounded.
_PAYPAL_CERTIFICATE_CACHE_MAX = 16
# Give up on a stalled certificate download instead of hanging verification.
_PAYPAL_CERTIFICATE_FETCH_TIMEOUT_S = 10.0
_PAYPAL_CERTIFICATE_MAX_REDIRECTS = 5
_PAYPAL_CERTIFICATE_HOSTS = frozenset(
    {"api.paypal.com", "api-m.paypal.com", "api.sandbox.paypal.com", "api-m.sandbox.paypal.com"}
)


# --- inputs ---------------------------------------------------------------------------


def _require_secret(secret: Any, function_name: str) -> None:
    if not isinstance(secret, str) or not secret:
        raise ValueError(f"{function_name} requires a non-empty secret")


def _header_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("latin-1")
    if isinstance(value, (list, tuple)):
        parts = [_header_text(item) for item in value]
        return ", ".join(part for part in parts if part is not None)
    return None


def _header_entries(headers: HeadersInput) -> Iterable[tuple[Any, Any]]:
    items = getattr(headers, "items", None)
    if callable(items):
        return items()  # type: ignore[no-any-return]
    return headers


def _get_header(headers: HeadersInput, name: str) -> str | None:
    target = name.lower()
    for key, value in _header_entries(headers):
        key_text = _header_text(key)
        if key_text is not None and key_text.lower() == target:
            return _header_text(value)
    return None


def _encode_text(text: str) -> bytes:
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError:
        # Lone surrogates become U+FFFD, as JavaScript's TextEncoder does.
        return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def _body_bytes(body: BodyInput) -> bytes:
    if body is None:
        return b""
    if isinstance(body, str):
        return _encode_text(body)
    return bytes(body)


def _body_text(body: BodyInput) -> str:
    """The body as text; bytes are decoded as JavaScript's TextDecoder does (BOM dropped)."""
    if body is None:
        return ""
    if isinstance(body, str):
        return body
    return bytes(body).decode("utf-8-sig", "replace")


def _safe_equal(left: str, right: str) -> bool:
    return hmac.compare_digest(_encode_text(left), _encode_text(right))


def _hmac_hex(algorithm: str, secret: str, payload: bytes) -> str:
    return to_hex(hmac_digest("sha256" if algorithm == "sha256" else "sha1", secret, payload))


def _hmac_base64(algorithm: str, secret: str | bytes, payload: bytes) -> str:
    return to_base64(hmac_digest("sha256" if algorithm == "sha256" else "sha1", secret, payload))


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def _parse_json(text: str) -> Any:
    """``json.loads`` without the NaN and Infinity that JavaScript's ``JSON.parse`` refuses."""
    return json.loads(text, parse_constant=_reject_constant)


_JS_WHITESPACE = "".join(
    chr(code)
    for code in (
        *(0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680),
        *range(0x2000, 0x200B),
        *(0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF),
    )
)
_JS_DECIMAL = re.compile(r"[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)")
_JS_RADIX = re.compile(r"0([xXoObB])([0-9a-zA-Z]+)")


def _js_to_number(value: str | None) -> float:
    """JavaScript's ``Number(value)`` for a header value: NaN when it is not a number."""
    if value is None:
        return math.nan
    text = value.strip(_JS_WHITESPACE)
    if text == "":
        return 0.0
    if _JS_DECIMAL.fullmatch(text):
        return float(text.replace("Infinity", "inf"))
    radix_match = _JS_RADIX.fullmatch(text)
    if radix_match:
        base = {"x": 16, "o": 8, "b": 2}[radix_match.group(1).lower()]
        try:
            return float(int(radix_match.group(2), base))
        except ValueError:
            return math.nan
    return math.nan


# --- header formats -------------------------------------------------------------------


def _parse_stripe_header(header: str | None) -> tuple[str, list[str]] | None:
    """``t=<timestamp>,v1=<hex>[,v1=<hex>]``, as Stripe, Calendly, Mux and WorkOS send."""
    if not header:
        return None
    timestamp: str | None = None
    signatures: list[str] = []
    for part in header.split(","):
        trimmed = part.strip()
        if not trimmed or "=" not in trimmed:
            continue
        key, _, value = trimmed.partition("=")
        key = key.strip()
        value = value.strip()
        if not value:
            continue
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value.lower())
    if not timestamp or not signatures:
        return None
    return timestamp, signatures


_STANDARD_SIGNATURE = re.compile(r"v1,([A-Za-z0-9+/=]+)")


def _parse_standard_signatures(header: str | None) -> list[str]:
    """The base64 signatures of a space-separated ``v1,<base64>`` list."""
    if not header:
        return []
    matches = _STANDARD_SIGNATURE.findall(header)
    if matches:
        return matches
    parts = header.split(",")[:2]
    if len(parts) == 2 and parts[0].strip() == "v1" and parts[1].strip():
        return [parts[1].strip()]
    return []


def _parse_paddle_signature(header: str | None) -> tuple[str, list[str]] | None:
    """``ts=<timestamp>;h1=<hex>``."""
    if not header:
        return None
    timestamp: str | None = None
    signatures: list[str] = []
    for part in re.split(r"[;,]", header):
        trimmed = part.strip()
        if not trimmed or "=" not in trimmed:
            continue
        key, _, value = trimmed.partition("=")
        key = key.strip().lower()
        value = value.strip()
        if not value:
            continue
        if key == "ts":
            timestamp = value
        elif key == "h1":
            signatures.append(value.lower())
    if not timestamp or not signatures:
        return None
    return timestamp, signatures


def _url_search_params(text: str) -> list[tuple[str, str]]:
    """Form parameters as the WHATWG URLSearchParams parser reads them."""
    if text.startswith("?"):
        text = text[1:]
    params: list[tuple[str, str]] = []
    for piece in text.split("&"):
        if not piece:
            continue
        name, _, value = piece.partition("=")
        params.append(
            (
                unquote(name.replace("+", " "), errors="replace"),
                unquote(value.replace("+", " "), errors="replace"),
            )
        )
    return params


def _twilio_params(body: BodyInput | Mapping[str, Any]) -> list[tuple[str, str]]:
    if body is None:
        return []
    if isinstance(body, Mapping):
        return [(str(key), js_string(value)) for key, value in body.items()]
    return _url_search_params(_body_text(body))


# --- per-provider checks ---------------------------------------------------------------


def verify_stripe_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Stripe: ``stripe-signature`` is ``t=<timestamp>,v1=<hex HMAC-SHA256 of "t.body">``."""
    _require_secret(secret, "verify_stripe_signature")
    return _verify_timestamped_hex(body, signature_header, secret)


def _verify_timestamped_hex(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    parsed = _parse_stripe_header(signature_header)
    if not parsed:
        return False
    timestamp, signatures = parsed
    expected = _hmac_hex("sha256", secret, timestamp.encode() + b"." + _body_bytes(body))
    return any(_safe_equal(signature, expected) for signature in signatures)


def verify_github_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """GitHub: ``x-hub-signature-256`` is ``sha256=<hex HMAC-SHA256 of the body>``."""
    _require_secret(secret, "verify_github_signature")
    if not signature_header:
        return False
    match = re.fullmatch(r"sha256=(.+)", signature_header.strip(), re.IGNORECASE | re.DOTALL)
    if not match:
        return False
    expected = _hmac_hex("sha256", secret, _body_bytes(body))
    return _safe_equal(match.group(1).lower(), expected)


def verify_shopify_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Shopify: ``x-shopify-hmac-sha256`` is the base64 HMAC-SHA256 of the body."""
    _require_secret(secret, "verify_shopify_signature")
    if not signature_header:
        return False
    expected = _hmac_base64("sha256", secret, _body_bytes(body))
    return _safe_equal(signature_header.strip(), expected)


def verify_twilio_signature(
    url: str,
    body: BodyInput | Mapping[str, Any],
    signature_header: str | None,
    secret: str,
) -> bool:
    """Twilio: base64 HMAC-SHA1 of the URL followed by the form parameters, sorted."""
    _require_secret(secret, "verify_twilio_signature")
    if not url:
        raise ValueError("verify_twilio_signature requires the signed URL")
    if not signature_header:
        return False
    payload = build_twilio_signature_payload(url, _twilio_params(body))
    expected = _hmac_base64("sha1", secret, _encode_text(payload))
    return _safe_equal(signature_header.strip(), expected)


def verify_slack_signature(body: BodyInput, headers: HeadersInput, secret: str) -> bool:
    """Slack: ``x-slack-signature`` is ``v0=<hex HMAC-SHA256 of "v0:timestamp:body">``."""
    _require_secret(secret, "verify_slack_signature")
    signature_header = _get_header(headers, "x-slack-signature")
    timestamp = _get_header(headers, "x-slack-request-timestamp")
    if not signature_header or not timestamp:
        return False
    match = re.fullmatch(r"v0=(.+)", signature_header.strip(), re.IGNORECASE | re.DOTALL)
    if not match:
        return False
    payload = b"v0:" + _encode_text(timestamp) + b":" + _body_bytes(body)
    expected = _hmac_hex("sha256", secret, payload)
    return _safe_equal(match.group(1).lower(), expected)


def verify_paddle_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Paddle: ``paddle-signature`` is ``ts=<timestamp>;h1=<hex HMAC-SHA256 of "ts:body">``."""
    _require_secret(secret, "verify_paddle_signature")
    parsed = _parse_paddle_signature(signature_header)
    if not parsed:
        return False
    timestamp, signatures = parsed
    expected = _hmac_hex("sha256", secret, _encode_text(timestamp) + b":" + _body_bytes(body))
    return any(_safe_equal(signature, expected) for signature in signatures)


def verify_linear_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Linear: ``linear-signature`` is the hex HMAC-SHA256 of the body, ``sha256=`` optional."""
    _require_secret(secret, "verify_linear_signature")
    if not signature_header:
        return False
    match = re.fullmatch(r"(?:sha256=)?(.+)", signature_header.strip(), re.IGNORECASE | re.DOTALL)
    if not match:
        return False
    expected = _hmac_hex("sha256", secret, _body_bytes(body))
    return _safe_equal(match.group(1).lower(), expected)


def _hmac_sha256_hex_matches(
    body: BodyInput, signature_header: str | None, secret: str, function_name: str
) -> bool:
    """A raw hex HMAC-SHA256 of the body, optionally as ``prefix=<hex>``."""
    _require_secret(secret, function_name)
    if not signature_header:
        return False
    received = signature_header.strip()
    signature = received[received.index("=") + 1 :] if "=" in received else received
    if not signature:
        return False
    expected = _hmac_hex("sha256", secret, _body_bytes(body))
    return _safe_equal(signature.lower(), expected)


def verify_meta_signature(body: BodyInput, signature_header: str | None, app_secret: str) -> bool:
    """Meta (WhatsApp, Messenger, Instagram): the GitHub scheme, keyed with the app secret."""
    return verify_github_signature(body, signature_header, app_secret)


def verify_lemon_squeezy_signature(
    body: BodyInput, signature_header: str | None, secret: str
) -> bool:
    """Lemon Squeezy: ``x-signature`` is the hex HMAC-SHA256 of the body."""
    return _hmac_sha256_hex_matches(
        body, signature_header, secret, "verify_lemon_squeezy_signature"
    )


def verify_coinbase_commerce_signature(
    body: BodyInput, signature_header: str | None, secret: str
) -> bool:
    """Coinbase Commerce: ``x-cc-webhook-signature`` is the hex HMAC-SHA256 of the body."""
    return _hmac_sha256_hex_matches(
        body, signature_header, secret, "verify_coinbase_commerce_signature"
    )


def verify_razorpay_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Razorpay: ``x-razorpay-signature`` is the hex HMAC-SHA256 of the body."""
    return _hmac_sha256_hex_matches(body, signature_header, secret, "verify_razorpay_signature")


def verify_cal_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Cal.com: ``x-cal-signature-256`` is the hex HMAC-SHA256 of the body."""
    return _hmac_sha256_hex_matches(body, signature_header, secret, "verify_cal_signature")


def verify_intercom_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Intercom: ``x-hub-signature`` is ``sha1=<hex HMAC-SHA1 of the body>``."""
    _require_secret(secret, "verify_intercom_signature")
    if not signature_header:
        return False
    match = re.fullmatch(r"sha1=(.+)", signature_header.strip(), re.IGNORECASE | re.DOTALL)
    if not match:
        return False
    expected = _hmac_hex("sha1", secret, _body_bytes(body))
    return _safe_equal(match.group(1).lower(), expected)


def verify_telegram_signature(body: BodyInput, token_header: str | None, secret: str) -> bool:
    """Telegram: ``x-telegram-bot-api-secret-token`` carries the secret itself."""
    _require_secret(secret, "verify_telegram_signature")
    if not token_header:
        return False
    return _safe_equal(token_header, secret)


def verify_square_signature(
    url: str, body: BodyInput, signature_header: str | None, signature_key: str
) -> bool:
    """Square: base64 HMAC-SHA256 of the notification URL followed by the body."""
    _require_secret(signature_key, "verify_square_signature")
    if not url:
        raise ValueError("verify_square_signature requires the notification URL")
    if not signature_header:
        return False
    expected = _hmac_base64("sha256", signature_key, _encode_text(url) + _body_bytes(body))
    return _safe_equal(signature_header.strip(), expected)


def verify_hubspot_signature(
    method: str,
    url: str,
    body: BodyInput,
    signature_header: str | None,
    timestamp: str | None,
    secret: str,
    max_age_ms: float = 5 * 60 * 1000,
    *,
    now: float | None = None,
) -> bool:
    """HubSpot v3: base64 HMAC-SHA256 of method, URL, body and the millisecond timestamp.

    The URL has HubSpot's reserved escapes decoded first. A timestamp more
    than ``max_age_ms`` from ``now`` (milliseconds, default the clock) fails.
    """
    _require_secret(secret, "verify_hubspot_signature")
    if not signature_header or not timestamp:
        return False
    clock = time.time() * 1000 if now is None else now
    ts = _js_to_number(timestamp)
    if not math.isfinite(ts) or abs(clock - ts) > max_age_ms:
        return False
    base = (
        _encode_text(method.upper() + decode_hubspot_uri(url))
        + _body_bytes(body)
        + _encode_text(timestamp)
    )
    expected = _hmac_base64("sha256", secret, base)
    return _safe_equal(signature_header.strip(), expected)


def verify_mailgun_signature(body: BodyInput, secret: str) -> bool:
    """Mailgun: the body's ``signature`` object signs its ``timestamp`` and ``token``.

    Malformed bodies return ``False``; this never raises on bad input.
    """
    _require_secret(secret, "verify_mailgun_signature")
    if not body:
        return False
    try:
        parsed = _parse_json(_body_text(body))
    except ValueError:
        return False
    if not isinstance(parsed, dict):
        return False
    signature_object = parsed.get("signature")
    if not isinstance(signature_object, dict):
        return False
    timestamp = signature_object.get("timestamp")
    token = signature_object.get("token")
    signature = signature_object.get("signature")
    if not (
        isinstance(timestamp, str)
        and isinstance(token, str)
        and isinstance(signature, str)
        and timestamp
        and token
        and signature
    ):
        return False
    expected = _hmac_hex("sha256", secret, _encode_text(timestamp + token))
    return _safe_equal(signature.lower(), expected)


def verify_calendly_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Calendly: ``calendly-webhook-signature`` in the Stripe format."""
    _require_secret(secret, "verify_calendly_signature")
    return _verify_timestamped_hex(body, signature_header, secret)


def verify_mux_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Mux: ``mux-signature`` in the Stripe format."""
    _require_secret(secret, "verify_mux_signature")
    return _verify_timestamped_hex(body, signature_header, secret)


def verify_workos_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """WorkOS: ``workos-signature`` is ``t=<ms>, v1=<hex>``, keyed with the secret as it is."""
    _require_secret(secret, "verify_workos_signature")
    return _verify_timestamped_hex(body, signature_header, secret)


def verify_sentry_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Sentry: ``sentry-hook-signature`` is the hex HMAC-SHA256 of the body."""
    return _hmac_sha256_hex_matches(body, signature_header, secret, "verify_sentry_signature")


def verify_bitbucket_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Bitbucket: ``x-hub-signature`` in the GitHub ``sha256=<hex>`` format."""
    return verify_github_signature(body, signature_header, secret)


def verify_docusign_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Docusign Connect: ``x-docusign-signature-1`` is the base64 HMAC-SHA256 of the body."""
    _require_secret(secret, "verify_docusign_signature")
    if not signature_header:
        return False
    expected = _hmac_base64("sha256", secret, _body_bytes(body))
    return _safe_equal(signature_header.strip(), expected)


def verify_adyen_signature(body: BodyInput, hmac_key: str) -> bool:
    """Adyen: every notification item carries a valid ``additionalData.hmacSignature``."""
    _require_secret(hmac_key, "verify_adyen_signature")
    if not body:
        return False
    try:
        parsed = _parse_json(_body_text(body))
    except ValueError:
        return False
    if not isinstance(parsed, dict):
        return False
    notification_items = parsed.get("notificationItems")
    if not isinstance(notification_items, list) or not notification_items:
        return False

    # Every notification item must carry its own valid signature: one genuine
    # item must not vouch for forged or unsigned siblings in the same batch.
    signed_items = 0
    for notification in notification_items:
        item = (
            notification.get("NotificationRequestItem") if isinstance(notification, dict) else None
        )
        if isinstance(item, list):
            return False  # an object, but without the signature
        if not isinstance(item, dict):
            continue
        additional = item.get("additionalData")
        signature = additional.get("hmacSignature") if isinstance(additional, dict) else None
        if not isinstance(signature, str) or not signature:
            return False
        try:
            expected = adyen_hmac(item, hmac_key)
        except ValueError:
            return False
        if not _safe_equal(signature, expected):
            return False
        signed_items += 1
    return signed_items > 0


def build_paypal_transmission_message(
    body: BodyInput, transmission_id: str, transmission_time: str, webhook_id: str
) -> str:
    """What PayPal signs: ``id|time|webhook id|CRC-32 of the body as a decimal number``."""
    crc = zlib.crc32(_body_bytes(body)) & 0xFFFFFFFF
    return f"{transmission_id}|{transmission_time}|{webhook_id}|{crc}"


def _remove_dot_segments(path: str) -> str:
    output: list[str] = []
    segments = path.split("/")
    for index, segment in enumerate(segments):
        lowered = segment.lower()
        is_last = index == len(segments) - 1
        if lowered in (".", "%2e"):
            if is_last:
                output.append("")
            continue
        if lowered in ("..", ".%2e", "%2e.", "%2e%2e"):
            if len(output) > 1:
                output.pop()
            if is_last:
                output.append("")
            continue
        output.append(segment)
    return "/".join(output)


_PAYPAL_CERTIFICATE_PATH = "/v1/notifications/certs/"


def _canonical_paypal_certificate_url(cert_url: str) -> str | None:
    """The URL to download a PayPal certificate from, or ``None`` when it is not allowed.

    Allowed: https on a PayPal API host, with a path under
    ``/v1/notifications/certs/``. The URL is read the way browsers (and the
    TypeScript SDK) read it, then rebuilt without user info, and only the
    rebuilt URL may be fetched: httpx parses a raw URL differently (it does
    not read ``\\`` as ``/``), so fetching the raw string could reach a host
    the check never saw.
    """
    # Browsers drop tabs and newlines and trim spaces and control characters before parsing.
    cleaned = re.sub(r"[\t\n\r]", "", cert_url).strip(_C0_AND_SPACE)
    cleaned = cleaned.replace("\\", "/")
    try:
        parts = urlsplit(cleaned)
        hostname = parts.hostname
        port = parts.port  # raises ValueError for a port that is not a number
    except ValueError:
        return None
    if parts.scheme.lower() != "https" or not hostname:
        return None
    host = hostname.lower()
    path = _remove_dot_segments(parts.path or "/")
    if host not in _PAYPAL_CERTIFICATE_HOSTS or not path.startswith(_PAYPAL_CERTIFICATE_PATH):
        return None
    canonical = urlunsplit(
        ("https", host if port is None else f"{host}:{port}", path, parts.query, "")
    )
    try:
        fetched = httpx.URL(canonical)
    except httpx.InvalidURL:
        return None
    if fetched.scheme != "https" or fetched.host != host:
        return None
    return canonical


def _is_allowed_paypal_certificate_url(cert_url: str) -> bool:
    """An https URL on a PayPal API host whose path starts with ``/v1/notifications/certs/``."""
    return _canonical_paypal_certificate_url(cert_url) is not None


_C0_AND_SPACE = "".join(chr(code) for code in range(0x21))
_PEM_PATTERN = "-----BEGIN {label}-----([\\s\\S]+?)-----END {label}-----"


def _pem_to_der(pem: str, label: str) -> bytes | None:
    match = re.search(_PEM_PATTERN.format(label=label), pem, re.IGNORECASE)
    if not match:
        return None
    try:
        return from_base64(re.sub(r"\s+", "", match.group(1)))
    except ValueError:
        return None


def _read_der_tlv(data: bytes, offset: int) -> tuple[int, int, int, int] | None:
    """(tag, start, value start, end) of the DER element at ``offset``."""
    if offset >= len(data):
        return None
    start = offset
    tag = data[offset]
    offset += 1
    if offset >= len(data):
        return None
    length = data[offset]
    offset += 1
    if length & 0x80:
        length_bytes = length & 0x7F
        if length_bytes == 0 or length_bytes > 4 or offset + length_bytes > len(data):
            return None
        length = int.from_bytes(data[offset : offset + length_bytes], "big")
        offset += length_bytes
    value_start = offset
    end = value_start + length
    if end > len(data):
        return None
    return tag, start, value_start, end


def _subject_public_key_info(cert_der: bytes) -> bytes | None:
    """The SubjectPublicKeyInfo of an X.509 certificate, without checking its chain or dates."""
    cert = _read_der_tlv(cert_der, 0)
    if not cert or cert[0] != 0x30:
        return None
    tbs = _read_der_tlv(cert_der, cert[2])
    if not tbs or tbs[0] != 0x30:
        return None
    cursor = tbs[2]
    first = _read_der_tlv(cert_der, cursor)
    if not first:
        return None
    if first[0] == 0xA0:  # explicit version
        cursor = first[3]
    # serialNumber, signature, issuer, validity, subject
    for _ in range(5):
        part = _read_der_tlv(cert_der, cursor)
        if not part:
            return None
        cursor = part[3]
    spki = _read_der_tlv(cert_der, cursor)
    if not spki or spki[0] != 0x30:
        return None
    return cert_der[spki[1] : spki[3]]


def _public_key_der_from_pem(pem: str) -> bytes | None:
    public_key = _pem_to_der(pem, "PUBLIC KEY")
    if public_key:
        return public_key
    certificate = _pem_to_der(pem, "CERTIFICATE")
    if not certificate:
        return None
    return _subject_public_key_info(certificate)


def _http_get(url: str) -> tuple[int, dict[str, str], str]:
    """(status, headers, text) of a GET without following redirects."""
    response = httpx.get(url, timeout=_PAYPAL_CERTIFICATE_FETCH_TIMEOUT_S, follow_redirects=False)
    return response.status_code, dict(response.headers), response.text


def _download_paypal_certificate(cert_url: str) -> str:
    url = cert_url
    for _ in range(_PAYPAL_CERTIFICATE_MAX_REDIRECTS + 1):
        status, headers, text = _http_get(url)
        location = next(
            (value for key, value in headers.items() if key.lower() == "location"), None
        )
        if 300 <= status < 400 and location:
            # Follow PayPal's own redirects only: a certificate is trusted by where it comes from.
            target = urljoin(url, location)
            canonical = _canonical_paypal_certificate_url(target)
            if canonical is None:
                raise RuntimeError(f"redirected outside PayPal's certificate URLs to {target}")
            url = canonical
            continue
        if not 200 <= status < 300:
            raise RuntimeError(f"HTTP {status}")
        return text
    raise RuntimeError("too many redirects")


def _fetch_paypal_certificate(cert_url: str, fetch_certificate: CertificateFetcher | None) -> str:
    # A custom fetcher owns its own transport and caching: sharing the module
    # cache across fetchers would let one fetcher's result leak into another's.
    if fetch_certificate is not None:
        try:
            return fetch_certificate(cert_url)
        except Exception as error:
            raise RuntimeError(
                f"Unable to download the PayPal certificate from {cert_url}: {error}"
            ) from error

    with _PAYPAL_CERTIFICATE_CACHE_LOCK:
        cached = _PAYPAL_CERTIFICATE_CACHE.get(cert_url)
    if cached:
        return cached

    try:
        certificate = _download_paypal_certificate(cert_url)
    except Exception as error:
        raise RuntimeError(
            f"Unable to download the PayPal certificate from {cert_url}: {error}. "
            "Pass fetch_certificate to supply it another way."
        ) from error

    # Only parseable certificates enter the bounded cache: an error page must
    # not poison it, and the sender-controlled URL suffix must not grow it.
    if _public_key_der_from_pem(certificate):
        with _PAYPAL_CERTIFICATE_CACHE_LOCK:
            if len(_PAYPAL_CERTIFICATE_CACHE) < _PAYPAL_CERTIFICATE_CACHE_MAX:
                _PAYPAL_CERTIFICATE_CACHE[cert_url] = certificate
    return certificate


def verify_paypal_signature(
    body: BodyInput,
    headers: HeadersInput,
    webhook_id: str,
    *,
    fetch_certificate: CertificateFetcher | None = None,
) -> bool:
    """PayPal: RSA-SHA256 over ``id|time|webhook id|crc32(body)``, checked with the certificate
    at ``paypal-cert-url``.

    Only certificates on PayPal's API hosts under ``/v1/notifications/certs/``
    are fetched. Returns ``False`` for missing or invalid signature material
    and raises ``RuntimeError`` when the certificate cannot be downloaded: a
    transport failure is not a verdict. ``fetch_certificate(url)`` returning
    the PEM replaces the download (and its cache), for tests.
    """
    _require_secret(webhook_id, "verify_paypal_signature")
    transmission_id = _get_header(headers, "paypal-transmission-id")
    transmission_time = _get_header(headers, "paypal-transmission-time")
    cert_url = _get_header(headers, "paypal-cert-url")
    auth_algo = _get_header(headers, "paypal-auth-algo")
    signature_header = _get_header(headers, "paypal-transmission-sig")

    if not transmission_id or not transmission_time or not cert_url or not signature_header:
        return False
    if auth_algo and auth_algo.upper() != "SHA256WITHRSA":
        return False
    certificate_url = _canonical_paypal_certificate_url(cert_url)
    if certificate_url is None:
        return False

    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
    except ImportError as error:  # pragma: no cover - the dev environment has it
        raise ImportError(_CRYPTO_MISSING) from error

    certificate = _fetch_paypal_certificate(certificate_url, fetch_certificate)
    public_key_der = _public_key_der_from_pem(certificate)
    if not public_key_der:
        return False

    try:
        key = serialization.load_der_public_key(public_key_der)
        if not isinstance(key, rsa.RSAPublicKey):
            return False
        signature = from_base64(signature_header)
        message = build_paypal_transmission_message(
            body, transmission_id, transmission_time, webhook_id
        )
        key.verify(signature, _encode_text(message), padding.PKCS1v15(), hashes.SHA256())
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def verify_vercel_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Vercel: ``x-vercel-signature`` is the hex HMAC-SHA1 of the body."""
    _require_secret(secret, "verify_vercel_signature")
    if not signature_header:
        return False
    expected = _hmac_hex("sha1", secret, _body_bytes(body))
    return _safe_equal(signature_header.strip().lower(), expected)


def verify_gitlab_signature(body: BodyInput, token_header: str | None, secret: str) -> bool:
    """GitLab: ``x-gitlab-token`` carries the secret itself."""
    _require_secret(secret, "verify_gitlab_signature")
    if not token_header:
        return False
    return _safe_equal(token_header, secret)


def verify_typeform_signature(body: BodyInput, signature_header: str | None, secret: str) -> bool:
    """Typeform: ``typeform-signature`` is ``sha256=<base64 HMAC-SHA256 of the body>``."""
    _require_secret(secret, "verify_typeform_signature")
    if not signature_header:
        return False
    received = signature_header.strip()
    signature = received[len("sha256=") :] if received.startswith("sha256=") else received
    if not signature:
        return False
    expected = _hmac_base64("sha256", secret, _body_bytes(body))
    return _safe_equal(signature, expected)


def verify_clerk_signature(body: BodyInput, headers: HeadersInput, secret: str) -> bool:
    """Clerk: Standard Webhooks through Svix; ``svix-*`` headers stand in for ``webhook-*``."""
    normalized: list[tuple[Any, Any]] = list(_header_entries(headers))
    for name in ("id", "timestamp", "signature"):
        svix = _get_header(headers, f"svix-{name}")
        if svix and not _get_header(headers, f"webhook-{name}"):
            normalized.append((f"webhook-{name}", svix))
    return verify_standard_webhook_signature(body, normalized, secret)


def verify_resend_signature(body: BodyInput, headers: HeadersInput, secret: str) -> bool:
    """Resend: delivered through Svix, verified like Clerk."""
    return verify_clerk_signature(body, headers, secret)


def _discord_hex(value: str) -> bytes:
    normalized = value.strip().lower()
    if not re.fullmatch(r"[a-f0-9]+", normalized) or len(normalized) % 2 != 0:
        raise ValueError("Expected a hex-encoded value")
    return bytes.fromhex(normalized)


def verify_discord_signature(body: BodyInput, headers: HeadersInput, public_key: str) -> bool:
    """Discord: Ed25519 over ``timestamp + body`` with the application's hex public key."""
    if not isinstance(public_key, str) or not public_key:
        raise ValueError("verify_discord_signature requires a non-empty public key")
    signature_header = _get_header(headers, "x-signature-ed25519")
    timestamp = _get_header(headers, "x-signature-timestamp")
    if not signature_header or not timestamp:
        return False

    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as error:  # pragma: no cover - the dev environment has it
        raise ImportError(_CRYPTO_MISSING) from error

    try:
        key = Ed25519PublicKey.from_public_bytes(_discord_hex(public_key))
        key.verify(_discord_hex(signature_header), _encode_text(timestamp) + _body_bytes(body))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def verify_standard_webhook_signature(body: BodyInput, headers: HeadersInput, secret: str) -> bool:
    """Standard Webhooks: ``webhook-signature`` lists ``v1,<base64>`` signatures.

    Each is the HMAC-SHA256 of ``id.timestamp.body``.

    The key is the ``whsec_`` secret decoded from base64, or its UTF-8 bytes when it is not base64.
    """
    _require_secret(secret, "verify_standard_webhook_signature")
    key = decode_standard_webhook_secret(secret)
    message_id = _get_header(headers, "webhook-id")
    timestamp = _get_header(headers, "webhook-timestamp")
    signature_header = _get_header(headers, "webhook-signature")
    if not message_id or not timestamp or not signature_header:
        return False
    payload = _encode_text(f"{message_id}.{timestamp}.") + _body_bytes(body)
    expected = _hmac_base64("sha256", key, payload)
    return any(
        _safe_equal(signature, expected)
        for signature in _parse_standard_signatures(signature_header)
    )


# --- webhooks.cc forwarding -------------------------------------------------------------


@dataclass(frozen=True)
class RelayedRequestInfo:
    """The metadata of a request webhooks.cc forwarded as received."""

    request_id: str
    """The request's id in webhooks.cc, the same on every try and redelivery."""
    received_at: str
    """When webhooks.cc received it, RFC 3339 UTC with milliseconds."""
    endpoint: str | None
    """The endpoint's slug."""
    attempt: int | None
    """Which try this is, from 1."""


def _is_email_received_event(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("type") != "email.received" or not isinstance(value.get("timestamp"), str):
        return False
    data = value.get("data")
    return (
        isinstance(data, dict)
        and isinstance(data.get("id"), str)
        and isinstance(data.get("address"), str)
        and isinstance(data.get("headers"), (dict, list))
    )


def _is_request_received_event(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("type") != "request.received" or not isinstance(value.get("timestamp"), str):
        return False
    data = value.get("data")
    return (
        isinstance(data, dict)
        and isinstance(data.get("id"), str)
        and isinstance(data.get("method"), str)
        and isinstance(data.get("path"), str)
        and isinstance(data.get("headers"), (dict, list))
    )


def _verify_signed_forward(
    body: BodyInput,
    headers: HeadersInput,
    secret: str,
    tolerance_seconds: float,
    now: float | None,
    function_name: str,
) -> Any:
    _require_secret(secret, function_name)
    decode_standard_webhook_secret(secret)  # an empty key is a ValueError, never a verdict
    message_id = _get_header(headers, "webhook-id")
    timestamp_header = _get_header(headers, "webhook-timestamp")
    signature_header = _get_header(headers, "webhook-signature")
    if not message_id or not timestamp_header or not signature_header:
        raise WebhookVerificationError(
            "missing_headers", "Missing webhook-id, webhook-timestamp or webhook-signature header"
        )

    timestamp = _js_to_number(timestamp_header)
    clock = (time.time() * 1000 if now is None else now) / 1000
    if not math.isfinite(timestamp) or abs(clock - timestamp) > tolerance_seconds:
        raise WebhookVerificationError(
            "timestamp_out_of_range",
            f"webhook-timestamp is more than {_format_seconds(tolerance_seconds)} seconds from now",
        )

    if not verify_standard_webhook_signature(body, headers, secret):
        raise WebhookVerificationError(
            "invalid_signature", "The webhook-signature does not match the body and secret"
        )

    try:
        return _parse_json(_body_text(body))
    except ValueError:
        raise WebhookVerificationError("invalid_payload", "The body is not JSON") from None


def _format_seconds(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


def verify_forwarded_email(
    body: BodyInput,
    headers: HeadersInput,
    secret: str,
    *,
    tolerance_seconds: float = 300,
    now: float | None = None,
) -> dict[str, Any]:
    """Verify an email webhooks.cc forwarded to you; returns the ``email.received`` event.

    Checks ``webhook-id``, ``webhook-timestamp`` and ``webhook-signature``
    against the endpoint's ``whsec_`` secret and refuses a timestamp more than
    ``tolerance_seconds`` from ``now`` (milliseconds, default the clock). Pass
    the raw body, before any JSON parsing.

    Raises ``WebhookVerificationError`` with ``code`` ``missing_headers``,
    ``timestamp_out_of_range``, ``invalid_signature`` or ``invalid_payload``.
    """
    parsed = _verify_signed_forward(
        body, headers, secret, tolerance_seconds, now, "verify_forwarded_email"
    )
    if not _is_email_received_event(parsed):
        raise WebhookVerificationError("invalid_payload", "The body is not an email.received event")
    result: dict[str, Any] = parsed
    return result


def verify_forwarded_request(
    body: BodyInput,
    headers: HeadersInput,
    secret: str,
    *,
    tolerance_seconds: float = 300,
    now: float | None = None,
) -> dict[str, Any]:
    """Verify a request forwarded as signed JSON; returns the ``request.received`` event.

    The same checks as :func:`verify_forwarded_email`.
    """
    parsed = _verify_signed_forward(
        body, headers, secret, tolerance_seconds, now, "verify_forwarded_request"
    )
    if not _is_request_received_event(parsed):
        raise WebhookVerificationError(
            "invalid_payload", "The body is not a request.received event"
        )
    result: dict[str, Any] = parsed
    return result


def verify_relayed_request(
    body: BodyInput, headers: HeadersInput, secret: str
) -> RelayedRequestInfo:
    """Verify that a request reached you through webhooks.cc forwarding as received.

    ``webhooks-cc-signature`` is ``v1,`` and the base64 HMAC-SHA256, keyed with
    the endpoint's ``whsec_`` secret, of the request id, a dot, the received-at
    time, a dot, and the exact body bytes. There is no age limit: a retry a
    day later carries the original received-at time, so remember
    ``request_id`` to ignore repeats.

    Raises ``WebhookVerificationError`` with ``code`` ``missing_headers`` or ``invalid_signature``.
    """
    _require_secret(secret, "verify_relayed_request")
    key = decode_standard_webhook_secret(secret)
    request_id = _get_header(headers, "webhooks-cc-request-id")
    received_at = _get_header(headers, "webhooks-cc-received-at")
    signature_header = _get_header(headers, "webhooks-cc-signature")
    if not request_id or not received_at or not signature_header:
        raise WebhookVerificationError(
            "missing_headers",
            "Missing webhooks-cc-request-id, webhooks-cc-received-at "
            "or webhooks-cc-signature header",
        )
    payload = _encode_text(f"{request_id}.{received_at}.") + _body_bytes(body)
    expected = _hmac_base64("sha256", key, payload)
    if not any(
        _safe_equal(given, expected) for given in _parse_standard_signatures(signature_header)
    ):
        raise WebhookVerificationError(
            "invalid_signature", "The webhooks-cc-signature does not match the body and secret"
        )
    attempt = _js_to_number(_get_header(headers, "webhooks-cc-attempt"))
    return RelayedRequestInfo(
        request_id=request_id,
        received_at=received_at,
        endpoint=_get_header(headers, "webhooks-cc-endpoint"),
        attempt=int(attempt)
        if math.isfinite(attempt) and attempt.is_integer() and attempt > 0
        else None,
    )


# --- dispatch ---------------------------------------------------------------------------


def verify_signature(
    provider: str,
    *,
    body: BodyInput,
    headers: HeadersInput,
    secret: str | None = None,
    public_key: str | None = None,
    url: str | None = None,
    method: str | None = None,
    now: float | None = None,
    fetch_certificate: CertificateFetcher | None = None,
) -> bool:
    """Check a request's signature with the provider's scheme.

    ``secret`` is the signing secret (the webhook id for PayPal);
    ``public_key`` the application's hex Ed25519 key for Discord. Twilio,
    Square and HubSpot sign the URL, so they need ``url``; HubSpot also signs
    ``method`` (default POST) and is the only provider whose signatures expire
    (five minutes from ``now``, in milliseconds). ``fetch_certificate`` supplies
    PayPal's certificate instead of downloading it.
    """

    def header(name: str) -> str | None:
        return _get_header(headers, name)

    def need_secret() -> str:
        return secret  # type: ignore[return-value]  # each verifier checks it

    if provider == "stripe":
        return verify_stripe_signature(body, header("stripe-signature"), need_secret())
    if provider == "github":
        return verify_github_signature(body, header("x-hub-signature-256"), need_secret())
    if provider == "shopify":
        return verify_shopify_signature(body, header("x-shopify-hmac-sha256"), need_secret())
    if provider == "twilio":
        if not url:
            raise ValueError('verify_signature for provider "twilio" requires url')
        return verify_twilio_signature(url, body, header("x-twilio-signature"), need_secret())
    if provider == "slack":
        return verify_slack_signature(body, headers, need_secret())
    if provider == "paddle":
        return verify_paddle_signature(body, header("paddle-signature"), need_secret())
    if provider == "linear":
        return verify_linear_signature(body, header("linear-signature"), need_secret())
    if provider == "clerk":
        return verify_clerk_signature(body, headers, need_secret())
    if provider == "vercel":
        return verify_vercel_signature(body, header("x-vercel-signature"), need_secret())
    if provider == "gitlab":
        return verify_gitlab_signature(body, header("x-gitlab-token"), need_secret())
    if provider == "typeform":
        return verify_typeform_signature(body, header("typeform-signature"), need_secret())
    if provider == "sendgrid":
        raise ValueError(
            "SendGrid does not use signature verification. "
            "SendGrid webhooks are verified via IP allowlisting."
        )
    if provider == "discord":
        return verify_discord_signature(body, headers, public_key)  # type: ignore[arg-type]
    if provider == "standard-webhooks":
        return verify_standard_webhook_signature(body, headers, need_secret())
    if provider == "meta":
        return verify_meta_signature(body, header("x-hub-signature-256"), need_secret())
    if provider == "lemonsqueezy":
        return verify_lemon_squeezy_signature(body, header("x-signature"), need_secret())
    if provider == "coinbase-commerce":
        return verify_coinbase_commerce_signature(
            body, header("x-cc-webhook-signature"), need_secret()
        )
    if provider == "razorpay":
        return verify_razorpay_signature(body, header("x-razorpay-signature"), need_secret())
    if provider == "cal":
        return verify_cal_signature(body, header("x-cal-signature-256"), need_secret())
    if provider == "intercom":
        return verify_intercom_signature(body, header("x-hub-signature"), need_secret())
    if provider == "telegram":
        return verify_telegram_signature(
            body, header("x-telegram-bot-api-secret-token"), need_secret()
        )
    if provider == "square":
        if not url:
            raise ValueError('verify_signature for provider "square" requires url')
        return verify_square_signature(
            url, body, header("x-square-hmacsha256-signature"), need_secret()
        )
    if provider == "hubspot":
        if not url:
            raise ValueError('verify_signature for provider "hubspot" requires url')
        return verify_hubspot_signature(
            method or "POST",
            url,
            body,
            header("x-hubspot-signature-v3"),
            header("x-hubspot-request-timestamp"),
            need_secret(),
            now=now,
        )
    if provider == "mailgun":
        return verify_mailgun_signature(body, need_secret())
    if provider == "calendly":
        return verify_calendly_signature(body, header("calendly-webhook-signature"), need_secret())
    if provider == "mux":
        return verify_mux_signature(body, header("mux-signature"), need_secret())
    if provider == "sentry":
        return verify_sentry_signature(body, header("sentry-hook-signature"), need_secret())
    if provider == "bitbucket":
        return verify_bitbucket_signature(body, header("x-hub-signature"), need_secret())
    if provider == "docusign":
        return verify_docusign_signature(body, header("x-docusign-signature-1"), need_secret())
    if provider == "adyen":
        return verify_adyen_signature(body, need_secret())
    if provider == "paypal":
        return verify_paypal_signature(
            body, headers, need_secret(), fetch_certificate=fetch_certificate
        )
    if provider == "plaid":
        raise ValueError(
            "Plaid webhook verification requires Plaid JWT/JWK lookup credentials "
            "and is not supported by verify_signature yet."
        )
    if provider == "resend":
        return verify_resend_signature(body, headers, need_secret())
    if provider == "workos":
        return verify_workos_signature(body, header("workos-signature"), need_secret())
    raise ValueError(f'Unknown provider "{provider}"')
