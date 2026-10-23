"""Provider templates: webhook requests signed the way each provider signs them.

A port of the TypeScript SDK's ``templates.ts``. ``build_template_request()``
gives the method, headers and body ``send_to()`` sends; without a ``body`` it
fills in a realistic sample payload for the chosen template. The conformance
vectors in ``packages/sdk/conformance/signing.json`` check the signatures.
"""

from __future__ import annotations

import json
import math
import secrets
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any
from urllib.parse import parse_qsl, quote_plus

from ._crypto import (
    adyen_hmac,
    build_twilio_signature_payload,
    decode_hubspot_uri,
    decode_standard_webhook_secret,
    hmac_digest,
    js_json,
    js_string,
    json_body,
    to_base64,
    to_base64url,
    to_hex,
    utf8,
)
from .models import BuiltRequest

__all__ = [
    "TEMPLATE_METADATA",
    "TEMPLATE_PROVIDERS",
    "VERIFY_PROVIDERS",
    "TemplateProviderInfo",
    "build_template_request",
]

DEFAULT_TEMPLATE_BY_PROVIDER: Mapping[str, str] = MappingProxyType(
    {
        "stripe": "payment_intent.succeeded",
        "github": "push",
        "shopify": "orders/create",
        "twilio": "messaging.inbound",
        "slack": "event_callback",
        "paddle": "transaction.completed",
        "linear": "issue.create",
        "sendgrid": "delivered",
        "clerk": "user.created",
        "discord": "interaction_create",
        "vercel": "deployment.created",
        "gitlab": "push",
        "typeform": "form_response",
        "meta": "whatsapp.messages",
        "lemonsqueezy": "order_created",
        "coinbase-commerce": "charge:confirmed",
        "razorpay": "payment.captured",
        "cal": "BOOKING_CREATED",
        "intercom": "conversation.user.created",
        "telegram": "message",
        "square": "payment.created",
        "hubspot": "contact.creation",
        "mailgun": "delivered",
        "calendly": "invitee.created",
        "mux": "video.asset.created",
        "sentry": "issue.created",
        "bitbucket": "repo:push",
        "docusign": "envelope-completed",
        "adyen": "AUTHORISATION",
        "paypal": "PAYMENT.CAPTURE.COMPLETED",
        "plaid": "TRANSACTIONS",
        "resend": "email.sent",
        "workos": "user.created",
    }
)

PROVIDER_TEMPLATES: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        "stripe": ("payment_intent.succeeded", "checkout.session.completed", "invoice.paid"),
        "github": ("push", "pull_request.opened", "ping"),
        "shopify": ("orders/create", "orders/paid", "products/update", "app/uninstalled"),
        "twilio": ("messaging.inbound", "messaging.status_callback", "voice.incoming_call"),
        "slack": ("event_callback", "slash_command", "url_verification"),
        "paddle": ("transaction.completed", "subscription.created", "subscription.updated"),
        "linear": ("issue.create", "issue.update", "comment.create"),
        "sendgrid": ("delivered", "open", "bounce", "spam_report"),
        "clerk": ("user.created", "user.updated", "user.deleted", "session.created"),
        "discord": ("interaction_create", "message_component", "ping"),
        "vercel": ("deployment.created", "deployment.succeeded", "deployment.error"),
        "gitlab": ("push", "merge_request"),
        "typeform": ("form_response", "partial_response", "payment"),
        "meta": ("whatsapp.messages", "page.messages", "instagram.comments"),
        "lemonsqueezy": ("order_created", "subscription_created", "subscription_payment_success"),
        "coinbase-commerce": ("charge:confirmed", "charge:failed", "charge:pending"),
        "razorpay": ("payment.captured", "payment.failed", "order.paid"),
        "cal": ("BOOKING_CREATED", "BOOKING_CANCELLED", "BOOKING_RESCHEDULED"),
        "intercom": ("conversation.user.created", "conversation.admin.replied", "contact.created"),
        "telegram": ("message", "callback_query", "edited_message"),
        "square": ("payment.created", "payment.updated", "refund.created"),
        "hubspot": ("contact.creation", "contact.propertyChange", "deal.creation"),
        "mailgun": ("delivered", "failed", "opened"),
        "calendly": ("invitee.created", "invitee.canceled", "routing_form_submission.created"),
        "mux": ("video.asset.created", "video.asset.ready", "video.upload.asset_created"),
        "sentry": ("issue.created", "issue.resolved", "error.created"),
        "bitbucket": ("repo:push", "pullrequest:created", "pullrequest:fulfilled"),
        "docusign": ("envelope-completed", "envelope-declined", "recipient-completed"),
        "adyen": ("AUTHORISATION", "CAPTURE", "REFUND"),
        "paypal": (
            "PAYMENT.CAPTURE.COMPLETED",
            "CHECKOUT.ORDER.APPROVED",
            "BILLING.SUBSCRIPTION.CREATED",
        ),
        "plaid": ("TRANSACTIONS", "ITEM", "AUTH"),
        "resend": (
            "email.sent",
            "email.delivered",
            "email.bounced",
            "email.clicked",
            "contact.created",
        ),
        "workos": (
            "user.created",
            "dsync.user.created",
            "connection.activated",
            "session.created",
            "organization.created",
        ),
    }
)

TEMPLATE_PROVIDERS: tuple[str, ...] = (
    "stripe",
    "github",
    "shopify",
    "twilio",
    "slack",
    "paddle",
    "linear",
    "sendgrid",
    "clerk",
    "discord",
    "vercel",
    "gitlab",
    "typeform",
    "standard-webhooks",
    "meta",
    "lemonsqueezy",
    "coinbase-commerce",
    "razorpay",
    "cal",
    "intercom",
    "telegram",
    "square",
    "hubspot",
    "mailgun",
    "calendly",
    "mux",
    "sentry",
    "bitbucket",
    "docusign",
    "adyen",
    "paypal",
    "plaid",
    "resend",
    "workos",
)
"""Every provider ``build_template_request()`` and ``send_to()`` can imitate."""

VERIFY_PROVIDERS: tuple[str, ...] = (
    "stripe",
    "github",
    "shopify",
    "twilio",
    "slack",
    "paddle",
    "linear",
    "clerk",
    "discord",
    "vercel",
    "gitlab",
    "typeform",
    "standard-webhooks",
    "meta",
    "lemonsqueezy",
    "coinbase-commerce",
    "razorpay",
    "cal",
    "intercom",
    "telegram",
    "square",
    "hubspot",
    "mailgun",
    "calendly",
    "mux",
    "sentry",
    "bitbucket",
    "docusign",
    "adyen",
    "paypal",
    "resend",
    "workos",
)
"""Every provider whose signatures ``verify_signature()`` checks (all but SendGrid and Plaid)."""


@dataclass(frozen=True)
class TemplateProviderInfo:
    """What a provider's templates offer and how its requests are signed."""

    provider: str
    templates: tuple[str, ...]
    """The template presets the provider supports."""
    default_template: str | None
    """The preset used when ``template`` is not given."""
    secret_required: bool
    """Whether signing needs a shared secret."""
    signature_header: str | None
    """The header that carries the signature (``None`` when it travels in the body)."""
    signature_algorithm: str | None


def _info(
    provider: str,
    *,
    secret_required: bool = True,
    signature_header: str | None = None,
    signature_algorithm: str | None = None,
) -> TemplateProviderInfo:
    return TemplateProviderInfo(
        provider=provider,
        templates=PROVIDER_TEMPLATES.get(provider, ()),
        default_template=DEFAULT_TEMPLATE_BY_PROVIDER.get(provider),
        secret_required=secret_required,
        signature_header=signature_header,
        signature_algorithm=signature_algorithm,
    )


TEMPLATE_METADATA: Mapping[str, TemplateProviderInfo] = MappingProxyType(
    {
        "stripe": _info(
            "stripe", signature_header="stripe-signature", signature_algorithm="hmac-sha256"
        ),
        "github": _info(
            "github", signature_header="x-hub-signature-256", signature_algorithm="hmac-sha256"
        ),
        "shopify": _info(
            "shopify", signature_header="x-shopify-hmac-sha256", signature_algorithm="hmac-sha256"
        ),
        "twilio": _info(
            "twilio", signature_header="x-twilio-signature", signature_algorithm="hmac-sha1"
        ),
        "slack": _info(
            "slack", signature_header="x-slack-signature", signature_algorithm="hmac-sha256"
        ),
        "paddle": _info(
            "paddle", signature_header="paddle-signature", signature_algorithm="hmac-sha256"
        ),
        "linear": _info(
            "linear", signature_header="linear-signature", signature_algorithm="hmac-sha256"
        ),
        "sendgrid": _info("sendgrid", secret_required=False),
        "clerk": _info(
            "clerk", signature_header="webhook-signature", signature_algorithm="hmac-sha256"
        ),
        "discord": _info("discord", secret_required=False),
        "vercel": _info(
            "vercel", signature_header="x-vercel-signature", signature_algorithm="hmac-sha1"
        ),
        "gitlab": _info("gitlab", signature_header="x-gitlab-token", signature_algorithm="token"),
        "typeform": _info(
            "typeform", signature_header="typeform-signature", signature_algorithm="hmac-sha256"
        ),
        "standard-webhooks": TemplateProviderInfo(
            provider="standard-webhooks",
            templates=(),
            default_template=None,
            secret_required=True,
            signature_header="webhook-signature",
            signature_algorithm="hmac-sha256",
        ),
        "meta": _info(
            "meta", signature_header="x-hub-signature-256", signature_algorithm="hmac-sha256"
        ),
        "lemonsqueezy": _info(
            "lemonsqueezy", signature_header="x-signature", signature_algorithm="hmac-sha256"
        ),
        "coinbase-commerce": _info(
            "coinbase-commerce",
            signature_header="x-cc-webhook-signature",
            signature_algorithm="hmac-sha256",
        ),
        "razorpay": _info(
            "razorpay", signature_header="x-razorpay-signature", signature_algorithm="hmac-sha256"
        ),
        "cal": _info(
            "cal", signature_header="x-cal-signature-256", signature_algorithm="hmac-sha256"
        ),
        "intercom": _info(
            "intercom", signature_header="x-hub-signature", signature_algorithm="hmac-sha1"
        ),
        "telegram": _info(
            "telegram",
            signature_header="x-telegram-bot-api-secret-token",
            signature_algorithm="token",
        ),
        "square": _info(
            "square",
            signature_header="x-square-hmacsha256-signature",
            signature_algorithm="hmac-sha256",
        ),
        "hubspot": _info(
            "hubspot", signature_header="x-hubspot-signature-v3", signature_algorithm="hmac-sha256"
        ),
        # Mailgun signs fields in the body (signature.{timestamp,token,signature}); no header.
        "mailgun": _info("mailgun", signature_algorithm="hmac-sha256"),
        "calendly": _info(
            "calendly",
            signature_header="calendly-webhook-signature",
            signature_algorithm="hmac-sha256",
        ),
        "mux": _info("mux", signature_header="mux-signature", signature_algorithm="hmac-sha256"),
        "sentry": _info(
            "sentry", signature_header="sentry-hook-signature", signature_algorithm="hmac-sha256"
        ),
        "bitbucket": _info(
            "bitbucket", signature_header="x-hub-signature", signature_algorithm="hmac-sha256"
        ),
        "docusign": _info(
            "docusign", signature_header="x-docusign-signature-1", signature_algorithm="hmac-sha256"
        ),
        # Adyen standard notifications carry additionalData.hmacSignature in the body.
        "adyen": _info("adyen", signature_algorithm="hmac-sha256"),
        "paypal": _info(
            "paypal", signature_header="paypal-transmission-sig", signature_algorithm="rsa-sha256"
        ),
        "plaid": _info(
            "plaid",
            secret_required=False,
            signature_header="plaid-verification",
            signature_algorithm="jwt-es256",
        ),
        # Resend delivers through Svix and sends only the svix-* headers.
        "resend": _info(
            "resend", signature_header="svix-signature", signature_algorithm="hmac-sha256"
        ),
        "workos": _info(
            "workos", signature_header="workos-signature", signature_algorithm="hmac-sha256"
        ),
    }
)
"""Static metadata for every provider in ``TEMPLATE_PROVIDERS``."""

_JSON = "application/json"
_FORM = "application/x-www-form-urlencoded"
_SAFE_INTEGER = 2**53 - 1


# --- Random values and dates, as the TypeScript SDK makes them -------------------------


def _random_hex(length: int) -> str:
    return secrets.token_hex((length + 1) // 2)[:length]


def _random_token(prefix: str) -> str:
    return f"{prefix}_{_random_hex(8)}"


def _random_digits(length: int) -> str:
    return "".join(str(byte % 10) for byte in secrets.token_bytes(length))


def _random_number(digits: int) -> int:
    return int(_random_digits(digits))


def _random_sid(prefix: str) -> str:
    return f"{prefix}{_random_hex(32)}"


def _random_uuid() -> str:
    return str(uuid.uuid4())


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _now_seconds() -> int:
    return _now_ms() // 1000


def _iso(ms: int) -> str:
    """``new Date(ms).toISOString()``: UTC with milliseconds and a ``Z``."""
    seconds, millis = divmod(ms, 1000)
    moment = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{millis:03d}Z"


# --- JavaScript value conversions -------------------------------------------------------


def _js_str(value: Any) -> str:
    """``String(value)``, as a template literal interpolates it."""
    if isinstance(value, list):
        return ",".join("" if item is None else _js_str(item) for item in value)
    if isinstance(value, Mapping):
        return "[object Object]"
    return js_string(value)


def _usv(value: str) -> str:
    """Replace lone surrogates with U+FFFD, as JavaScript does for URL and text encoding."""
    return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")


def _form_component(value: str) -> str:
    # URLSearchParams leaves only alphanumerics and *-._ unescaped, and writes a space as +.
    return quote_plus(_usv(value), safe="*").replace("~", "%7E")


def _form_encode(params: Mapping[str, str]) -> str:
    """``new URLSearchParams(params).toString()``."""
    return "&".join(
        f"{_form_component(key)}={_form_component(value)}" for key, value in params.items()
    )


def _form_decode(body: str) -> list[tuple[str, str]]:
    """The entries of ``new URLSearchParams(body)``, repeats and order kept."""
    if body.startswith("?"):
        body = body[1:]
    return parse_qsl(body, keep_blank_values=True)


def _as_string_record(value: Any) -> dict[str, str] | None:
    if not isinstance(value, Mapping):
        return None
    return {str(key): "" if item is None else _js_str(item) for key, item in value.items()}


def _js_int(text: str) -> int | float:
    # JSON.parse reads every number as a double; large integers lose precision as they do there.
    number = int(text)
    return number if abs(number) <= _SAFE_INTEGER else float(text)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"Unexpected token {name} in JSON")


def _parse_json(text: str) -> Any:
    return json.loads(text, parse_int=_js_int, parse_constant=_reject_constant)


# --- Template payloads ------------------------------------------------------------------


@dataclass
class _Built:
    body: str
    content_type: str
    headers: dict[str, str]
    twilio_params: list[tuple[str, str]] | None = None


def _payload(override: Any, default: Any) -> str:
    return json_body(default if override is None else override)


def _repository() -> dict[str, Any]:
    return {
        "id": _random_number(9),
        "name": "demo-repo",
        "full_name": "webhooks-cc/demo-repo",
        "private": False,
        "default_branch": "main",
        "html_url": "https://github.com/webhooks-cc/demo-repo",
    }


def _github_sender() -> dict[str, Any]:
    return {"login": "webhooks-cc-bot", "id": 987654, "type": "Bot"}


def _ensure_template(provider: str, template: str | None) -> str:
    resolved = template if template is not None else DEFAULT_TEMPLATE_BY_PROVIDER[provider]
    supported = PROVIDER_TEMPLATES[provider]
    if resolved not in supported:
        raise ValueError(
            f'Unsupported template "{resolved}" for provider "{provider}". '
            f"Supported templates: {', '.join(supported)}"
        )
    return resolved


def _default_event(provider: str, template: str) -> str:
    if provider == "github" and template == "pull_request.opened":
        return "pull_request"
    if provider == "typeform" and template == "payment":
        return "form_response"
    return template


def _stripe(template: str, event: str, now_sec: int, override: Any) -> _Built:
    payment_intent_id = _random_token("pi")
    checkout_session_id = f"cs_test_{_random_hex(24)}"

    def envelope(obj: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": _random_token("evt"),
            "object": "event",
            "api_version": "2025-01-27.acacia",
            "created": now_sec,
            "data": {"object": obj},
            "livemode": False,
            "pending_webhooks": 1,
            "request": {"id": f"req_{_random_hex(24)}", "idempotency_key": None},
            "type": event,
        }

    payloads = {
        "payment_intent.succeeded": envelope(
            {
                "id": payment_intent_id,
                "object": "payment_intent",
                "amount": 2000,
                "amount_received": 2000,
                "currency": "usd",
                "status": "succeeded",
                "created": now_sec,
                "metadata": {"order_id": _random_token("order")},
            }
        ),
        "checkout.session.completed": envelope(
            {
                "id": checkout_session_id,
                "object": "checkout.session",
                "mode": "payment",
                "payment_status": "paid",
                "amount_total": 2000,
                "amount_subtotal": 2000,
                "currency": "usd",
                "customer": f"cus_{_random_hex(14)}",
                "payment_intent": payment_intent_id,
                "status": "complete",
                "success_url": "https://example.com/success",
                "cancel_url": "https://example.com/cancel",
                "created": now_sec,
            }
        ),
        "invoice.paid": envelope(
            {
                "id": f"in_{_random_hex(14)}",
                "object": "invoice",
                "account_country": "US",
                "account_name": "webhooks.cc demo",
                "amount_due": 2000,
                "amount_paid": 2000,
                "amount_remaining": 0,
                "billing_reason": "subscription_cycle",
                "currency": "usd",
                "customer": f"cus_{_random_hex(14)}",
                "paid": True,
                "status": "paid",
                "hosted_invoice_url": "https://invoice.stripe.com/demo",
                "created": now_sec,
            }
        ),
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={"user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)"},
    )


def _github(template: str, now_iso: str, override: Any) -> _Built:
    before = _random_hex(40)
    after = _random_hex(40)
    repo = _repository()
    full_name = repo["full_name"]

    def commit() -> dict[str, Any]:
        return {
            "id": after,
            "message": "Update webhook integration tests",
            "timestamp": now_iso,
            "url": f"https://github.com/{full_name}/commit/{after}",
            "author": {"name": "webhooks-cc-bot", "email": "bot@webhooks.cc"},
            "committer": {"name": "webhooks-cc-bot", "email": "bot@webhooks.cc"},
            "added": [],
            "removed": [],
            "modified": ["src/webhooks.ts"],
        }

    payloads = {
        "push": {
            "ref": "refs/heads/main",
            "before": before,
            "after": after,
            "repository": repo,
            "pusher": {"name": "webhooks-cc-bot", "email": "bot@webhooks.cc"},
            "sender": _github_sender(),
            "created": False,
            "deleted": False,
            "forced": False,
            "compare": f"https://github.com/{full_name}/compare/{before}...{after}",
            "commits": [commit()],
            "head_commit": commit(),
        },
        "pull_request.opened": {
            "action": "opened",
            "number": 42,
            "pull_request": {
                "id": _random_number(9),
                "number": 42,
                "state": "open",
                "title": "Add webhook retry logic",
                "body": "This PR improves retry handling for inbound webhooks.",
                "created_at": now_iso,
                "updated_at": now_iso,
                "html_url": f"https://github.com/{full_name}/pull/42",
                "user": {"login": "webhooks-cc-bot", "id": 987654, "type": "Bot"},
                "draft": False,
                "head": {
                    "label": "webhooks-cc:feature/webhook-retries",
                    "ref": "feature/webhook-retries",
                    "sha": _random_hex(40),
                    "repo": repo,
                },
                "base": {
                    "label": "webhooks-cc:main",
                    "ref": "main",
                    "sha": _random_hex(40),
                    "repo": repo,
                },
            },
            "repository": repo,
            "sender": _github_sender(),
        },
        "ping": {
            "zen": "Keep it logically awesome.",
            "hook_id": _random_number(7),
            "hook": {
                "type": "Repository",
                "id": _random_number(7),
                "name": "web",
                "active": True,
                "events": ["push", "pull_request"],
                "config": {
                    "content_type": "json",
                    "insecure_ssl": "0",
                    "url": "https://go.webhooks.cc/w/demo",
                },
            },
            "repository": repo,
            "sender": _github_sender(),
        },
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={"user-agent": "GitHub-Hookshot/8f03f6d"},
    )


def _shopify(template: str, now_iso: str, override: Any) -> _Built:
    def order(status: str, price: str, title: str, sku: str) -> dict[str, Any]:
        return {
            "id": _random_number(10),
            "admin_graphql_api_id": f"gid://shopify/Order/{_random_digits(10)}",
            "email": "customer@example.com",
            "created_at": now_iso,
            "updated_at": now_iso,
            "currency": "USD",
            "financial_status": status,
            "fulfillment_status": None,
            "total_price": price,
            "subtotal_price": price,
            "total_tax": "0.00",
            "line_items": [
                {
                    "id": _random_number(10),
                    "admin_graphql_api_id": f"gid://shopify/LineItem/{_random_digits(10)}",
                    "title": title,
                    "quantity": 1,
                    "sku": sku,
                    "price": price,
                }
            ],
        }

    payloads = {
        "orders/create": order("pending", "19.99", "Demo Item", "DEMO-001"),
        "orders/paid": order("paid", "49.00", "Webhook Pro Plan", "WHK-PRO"),
        "products/update": {
            "id": _random_number(10),
            "admin_graphql_api_id": f"gid://shopify/Product/{_random_digits(10)}",
            "title": "Webhook Tester Hoodie",
            "body_html": "<strong>Updated product details</strong>",
            "vendor": "webhooks.cc",
            "product_type": "Apparel",
            "handle": "webhook-tester-hoodie",
            "status": "active",
            "created_at": now_iso,
            "updated_at": now_iso,
            "variants": [
                {
                    "id": _random_number(10),
                    "product_id": _random_number(10),
                    "title": "Default Title",
                    "price": "39.00",
                    "sku": "WHK-HOODIE",
                    "position": 1,
                    "inventory_policy": "deny",
                    "fulfillment_service": "manual",
                    "inventory_management": "shopify",
                }
            ],
        },
        "app/uninstalled": {
            "id": _random_number(10),
            "name": "Demo Shop",
            "email": "owner@example.com",
            "domain": "demo-shop.myshopify.com",
            "myshopify_domain": "demo-shop.myshopify.com",
            "country_name": "United States",
            "currency": "USD",
            "plan_name": "basic",
            "created_at": now_iso,
            "updated_at": now_iso,
        },
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={
            "x-shopify-shop-domain": "demo-shop.myshopify.com",
            "x-shopify-api-version": "2025-10",
            "x-shopify-webhook-id": _random_uuid(),
            "x-shopify-event-id": _random_uuid(),
            "x-shopify-triggered-at": now_iso,
        },
    )


def _meta(template: str, now_sec: int, override: Any) -> _Built:
    payloads = {
        "whatsapp.messages": {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "id": _random_digits(15),
                    "changes": [
                        {
                            "field": "messages",
                            "value": {
                                "messaging_product": "whatsapp",
                                "metadata": {
                                    "display_phone_number": "15550100",
                                    "phone_number_id": _random_digits(15),
                                },
                                "contacts": [{"profile": {"name": "Ada"}, "wa_id": "15551234567"}],
                                "messages": [
                                    {
                                        "from": "15551234567",
                                        "id": f"wamid.{_random_hex(20)}",
                                        "timestamp": str(now_sec),
                                        "type": "text",
                                        "text": {"body": "Hello from webhooks.cc"},
                                    }
                                ],
                            },
                        }
                    ],
                }
            ],
        },
        "page.messages": {
            "object": "page",
            "entry": [
                {
                    "id": _random_digits(15),
                    "time": now_sec,
                    "messaging": [
                        {
                            "sender": {"id": _random_digits(15)},
                            "recipient": {"id": _random_digits(15)},
                            "timestamp": now_sec * 1000,
                            "message": {"mid": f"m_{_random_hex(20)}", "text": "hi"},
                        }
                    ],
                }
            ],
        },
        "instagram.comments": {
            "object": "instagram",
            "entry": [
                {
                    "id": _random_digits(15),
                    "time": now_sec,
                    "changes": [
                        {"field": "comments", "value": {"id": _random_digits(15), "text": "nice!"}}
                    ],
                }
            ],
        },
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={"user-agent": "facebookplatform/1.0 (+http://www.facebook.com/platform)"},
    )


def _lemonsqueezy(template: str, event: str, override: Any) -> _Built:
    data_by_template: dict[str, dict[str, Any]] = {
        "order_created": {
            "type": "orders",
            "id": _random_digits(6),
            "attributes": {
                "status": "paid",
                "total": 1999,
                "currency": "USD",
                "user_email": "customer@example.com",
                "product_name": "Pro Plan",
            },
        },
        "subscription_created": {
            "type": "subscriptions",
            "id": _random_digits(6),
            "attributes": {
                "status": "active",
                "product_name": "Pro Plan",
                "variant_name": "Monthly",
                "user_email": "customer@example.com",
            },
        },
        "subscription_payment_success": {
            "type": "subscription-invoices",
            "id": _random_digits(6),
            "attributes": {
                "status": "paid",
                "total": 1999,
                "currency": "USD",
                "billing_reason": "renewal",
            },
        },
    }
    default = {
        "meta": {"event_name": event, "custom_data": {}},
        "data": data_by_template.get(template, data_by_template["order_created"]),
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "Lemon Squeezy Webhooks"},
    )


def _coinbase(event: str, now_iso: str, override: Any) -> _Built:
    default = {
        "event": {
            "id": _random_uuid(),
            "type": event,
            "api_version": "2018-03-22",
            "created_at": now_iso,
            "data": {
                "code": _random_hex(8).upper(),
                "name": "Order",
                "description": "webhooks.cc test charge",
                "pricing": {"local": {"amount": "19.99", "currency": "USD"}},
                "metadata": {},
                "timeline": [{"time": now_iso, "status": "NEW"}],
            },
        }
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "weipay-webhooks"},
    )


def _razorpay(event: str, now_sec: int, override: Any) -> _Built:
    default = {
        "entity": "event",
        "account_id": f"acc_{_random_hex(14)}",
        "event": event,
        "contains": ["payment"],
        "payload": {
            "payment": {
                "entity": {
                    "id": f"pay_{_random_hex(14)}",
                    "entity": "payment",
                    "amount": 5000,
                    "currency": "INR",
                    "status": "captured",
                    "order_id": f"order_{_random_hex(14)}",
                    "method": "card",
                    "email": "customer@example.com",
                }
            }
        },
        "created_at": now_sec,
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "Razorpay-Webhook/1.0"},
    )


def _cal(event: str, now_iso: str, override: Any) -> _Built:
    default = {
        "triggerEvent": event,
        "createdAt": now_iso,
        "payload": {
            "type": "30min",
            "title": "30min between Ada and webhooks.cc",
            "startTime": now_iso,
            "endTime": now_iso,
            "organizer": {"email": "ada@example.com", "name": "Ada", "timeZone": "UTC"},
            "attendees": [{"email": "guest@example.com", "name": "Guest", "timeZone": "UTC"}],
            "uid": _random_hex(16),
        },
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "Cal.com Webhook"},
    )


def _intercom(event: str, now_sec: int, override: Any) -> _Built:
    default = {
        "type": "notification_event",
        "id": f"notif_{_random_hex(12)}",
        "topic": event,
        "app_id": _random_hex(8),
        "created_at": now_sec,
        "data": {
            "type": "notification_event_data",
            "item": {"type": "conversation", "id": _random_digits(10), "created_at": now_sec},
        },
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "Intercom-Webhook/1.1"},
    )


def _telegram(template: str, now_sec: int, override: Any) -> _Built:
    update_id = _random_number(9)
    from_user = {"id": 42, "is_bot": False, "first_name": "Ada", "username": "ada"}
    chat = {"id": 42, "type": "private", "first_name": "Ada", "username": "ada"}
    payloads = {
        "message": {
            "update_id": update_id,
            "message": {
                "message_id": 1,
                "from": from_user,
                "chat": chat,
                "date": now_sec,
                "text": "hi",
            },
        },
        "callback_query": {
            "update_id": update_id,
            "callback_query": {
                "id": _random_digits(12),
                "from": from_user,
                "chat_instance": _random_digits(18),
                "data": "button_1",
            },
        },
        "edited_message": {
            "update_id": update_id,
            "edited_message": {
                "message_id": 1,
                "from": from_user,
                "chat": chat,
                "date": now_sec,
                "edit_date": now_sec,
                "text": "edited",
            },
        },
    }
    return _Built(body=_payload(override, payloads.get(template)), content_type=_JSON, headers={})


def _square(template: str, now_iso: str, override: Any) -> _Built:
    payloads = {
        "payment.created": {
            "merchant_id": _random_hex(13).upper(),
            "type": "payment.created",
            "event_id": _random_uuid(),
            "created_at": now_iso,
            "data": {
                "type": "payment",
                "id": _random_hex(22),
                "object": {
                    "payment": {
                        "id": _random_hex(22),
                        "amount_money": {"amount": 2000, "currency": "USD"},
                        "status": "APPROVED",
                    }
                },
            },
        },
        "payment.updated": {
            "merchant_id": _random_hex(13).upper(),
            "type": "payment.updated",
            "event_id": _random_uuid(),
            "created_at": now_iso,
            "data": {
                "type": "payment",
                "id": _random_hex(22),
                "object": {"payment": {"id": _random_hex(22), "status": "COMPLETED"}},
            },
        },
        "refund.created": {
            "merchant_id": _random_hex(13).upper(),
            "type": "refund.created",
            "event_id": _random_uuid(),
            "created_at": now_iso,
            "data": {
                "type": "refund",
                "id": _random_hex(22),
                "object": {
                    "refund": {
                        "id": _random_hex(22),
                        "amount_money": {"amount": 500, "currency": "USD"},
                        "status": "PENDING",
                    }
                },
            },
        },
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={"user-agent": "Square-Webhooks/1.0"},
    )


def _hubspot(event: str, now_sec: int, override: Any) -> _Built:
    # HubSpot delivers an array of subscription notifications.
    default = [
        {
            "eventId": _random_number(9),
            "subscriptionId": 1,
            "portalId": 123,
            "occurredAt": now_sec * 1000,
            "subscriptionType": event,
            "attemptNumber": 0,
            "objectId": 1,
            "propertyName": None,
            "propertyValue": None,
        }
    ]
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "HubSpot-Webhooks/1.0"},
    )


def _mailgun(event: str, now_sec: int, override: Any) -> _Built:
    # The signature is a placeholder; build_template_request() signs timestamp + token
    # and patches the body's signature object.
    default = {
        "signature": {"timestamp": str(now_sec), "token": _random_hex(50), "signature": ""},
        "event-data": {
            "event": event,
            "id": _random_hex(22),
            "timestamp": now_sec,
            "recipient": "user@example.com",
            "message": {"headers": {"message-id": f"{_random_hex(20)}@example.com"}},
        },
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "Mailgun-Webhooks/1.0"},
    )


def _calendly(event: str, now_iso: str, override: Any) -> _Built:
    default = {
        "event": event,
        "created_at": now_iso,
        "payload": {
            "email": "ada@example.com",
            "name": "Ada",
            "scheduled_event": {
                "start_time": now_iso,
                "end_time": now_iso,
                "name": "30 Minute Meeting",
            },
        },
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "Calendly-Webhooks/1.0"},
    )


def _mux(event: str, now_iso: str, override: Any) -> _Built:
    default = {
        "type": event,
        "object": {"type": "asset", "id": _random_hex(20)},
        "id": _random_uuid(),
        "created_at": now_iso,
        "data": {"status": "preparing", "id": _random_hex(20)},
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "Mux-Webhooks/1.0"},
    )


def _resend(template: str, event: str, now_iso: str, override: Any) -> _Built:
    # Resend events are { type, created_at, data } with no top-level id: the delivery
    # id travels in the svix-id header. Shapes follow Resend's webhook event docs.
    email = {
        "created_at": now_iso,
        "email_id": _random_uuid(),
        "message_id": f"<{_random_uuid()}@email.example.com>",
        "from": "Acme <onboarding@resend.dev>",
        "to": ["delivered@resend.dev"],
        "subject": "Sending this example",
        "tags": {"category": "confirm_email"},
    }
    data_by_template: dict[str, Any] = {
        "email.sent": email,
        "email.delivered": email,
        "email.bounced": {
            **email,
            "bounce": {
                "message": (
                    "The recipient's email address is on the suppression list because it has "
                    "a recent history of producing hard bounces."
                ),
                "subType": "Suppressed",
                "type": "Permanent",
            },
        },
        "email.clicked": {
            **email,
            "click": {
                "ipAddress": "122.115.53.11",
                "link": "https://resend.com",
                "timestamp": now_iso,
                "userAgent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
                    "(KHTML, like Gecko) Version/16.1 Safari/605.1.15"
                ),
            },
        },
        "contact.created": {
            "id": _random_uuid(),
            "audience_id": _random_uuid(),
            "segment_ids": [],
            "created_at": now_iso,
            "updated_at": now_iso,
            "email": "ada@example.com",
            "first_name": None,
            "last_name": None,
            "unsubscribed": False,
        },
    }
    default = {"type": event, "created_at": now_iso, "data": data_by_template.get(template)}
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "Svix-Webhooks/1.0"},
    )


def _workos(template: str, event: str, now_iso: str, override: Any) -> _Built:
    # WorkOS events are { event, id, data, created_at, context }. IDs are prefixed
    # ULIDs; uppercase hex is a subset of the ULID alphabet.
    def ulid() -> str:
        return f"01{_random_hex(24).upper()}"

    organization_id = f"org_{ulid()}"
    user_id = f"user_{ulid()}"
    user_agent = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36"
    )
    data_by_template: dict[str, Any] = {
        "user.created": {
            "object": "user",
            "id": user_id,
            "email": "todd@example.com",
            "first_name": "Todd",
            "last_name": "Rundgren",
            "email_verified": False,
            "profile_picture_url": None,
            "last_sign_in_at": None,
            "external_id": None,
            "metadata": {},
            "created_at": now_iso,
            "updated_at": now_iso,
        },
        "dsync.user.created": {
            "id": f"directory_user_{ulid()}",
            "directory_id": f"directory_{ulid()}",
            "organization_id": organization_id,
            "idp_id": _random_digits(4),
            "email": "lela.block@example.com",
            "first_name": "Lela",
            "last_name": "Block",
            "state": "active",
            "created_at": now_iso,
            "updated_at": now_iso,
            "custom_attributes": {
                "department": "Engineering",
                "job_title": "Software Engineer",
                "username": "lela.block@example.com",
            },
            "role": {"slug": "member"},
            "roles": [{"slug": "member"}],
        },
        "connection.activated": {
            "object": "connection",
            "id": f"conn_{ulid()}",
            "organization_id": organization_id,
            "state": "active",
            "connection_type": "OktaSAML",
            "name": "Foo Corp's Connection",
            "created_at": now_iso,
            "updated_at": now_iso,
            "domains": [
                {
                    "id": f"org_domain_{ulid()}",
                    "object": "connection_domain",
                    "domain": "foo-corp.com",
                }
            ],
        },
        "session.created": {
            "object": "session",
            "id": f"session_{ulid()}",
            "user_id": user_id,
            "organization_id": organization_id,
            "ip_address": "192.0.2.1",
            "user_agent": user_agent,
            "created_at": now_iso,
            "updated_at": now_iso,
        },
        "organization.created": {
            "object": "organization",
            "id": organization_id,
            "name": "Foo Corp",
            "external_id": None,
            "domains": [
                {
                    "object": "organization_domain",
                    "id": f"org_domain_{ulid()}",
                    "organization_id": organization_id,
                    "domain": "foo-corp.com",
                    "state": "verified",
                    "verification_strategy": "manual",
                    "created_at": now_iso,
                    "updated_at": now_iso,
                }
            ],
            "created_at": now_iso,
            "updated_at": now_iso,
        },
    }
    default: dict[str, Any] = {
        "event": event,
        "id": f"event_{ulid()}",
        "data": data_by_template.get(template),
        "created_at": now_iso,
        "context": {},
    }
    return _Built(body=_payload(override, default), content_type=_JSON, headers={})


def _sentry(template: str, override: Any) -> _Built:
    # The body's resource (issue or error) and action must agree with the
    # sentry-hook-resource header and the selected template.
    issue_data = {
        "issue": {
            "id": _random_digits(10),
            "title": "TypeError: undefined is not a function",
            "culprit": "app/main",
            "level": "error",
        }
    }
    payloads = {
        "issue.created": {
            "action": "created",
            "installation": {"uuid": _random_uuid()},
            "data": issue_data,
            "actor": {"type": "application", "id": "sentry"},
        },
        "issue.resolved": {
            "action": "resolved",
            "installation": {"uuid": _random_uuid()},
            "data": issue_data,
            "actor": {"type": "user", "id": _random_digits(7), "name": "webhooks-cc-bot"},
        },
        "error.created": {
            "action": "created",
            "installation": {"uuid": _random_uuid()},
            "data": {
                "error": {
                    "event_id": _random_hex(32),
                    "title": "TypeError: undefined is not a function",
                    "level": "error",
                    "culprit": "app/main",
                }
            },
            "actor": {"type": "application", "id": "sentry"},
        },
    }
    return _Built(
        body=_payload(override, payloads.get(template, payloads["issue.created"])),
        content_type=_JSON,
        headers={"user-agent": "Sentry-Webhooks/1.0"},
    )


def _bitbucket(template: str, override: Any) -> _Built:
    # repo:push and pullrequest:* events have different shapes; emit the one the
    # template names so PR consumers get a pullrequest object.
    repository = {"name": "demo-repo", "full_name": "webhooks-cc/demo-repo"}
    actor = {"display_name": "webhooks-cc-bot"}

    def pull_request(state: str) -> dict[str, Any]:
        return {
            "pullrequest": {
                "id": _random_number(4),
                "title": "Add tier-2 webhook providers",
                "state": state,
                "source": {"branch": {"name": "feature/tier-2"}},
                "destination": {"branch": {"name": "main"}},
                "author": actor,
            },
            "repository": repository,
            "actor": actor,
        }

    payloads = {
        "repo:push": {
            "push": {"changes": [{"new": {"name": "main", "type": "branch"}}]},
            "repository": repository,
            "actor": actor,
        },
        "pullrequest:created": pull_request("OPEN"),
        "pullrequest:fulfilled": pull_request("MERGED"),
    }
    return _Built(
        body=_payload(override, payloads.get(template, payloads["repo:push"])),
        content_type=_JSON,
        headers={"user-agent": "Bitbucket-Webhooks/1.0"},
    )


def _docusign(template: str, event: str, now_iso: str, override: Any) -> _Built:
    status_by_template = {
        "envelope-completed": "completed",
        "envelope-declined": "declined",
        "recipient-completed": "completed",
    }
    data: dict[str, Any] = {
        "accountId": _random_digits(8),
        "envelopeId": _random_uuid(),
        "status": status_by_template.get(template, "completed"),
        "statusChangedDateTime": now_iso,
    }
    if template == "recipient-completed":
        data["recipientId"] = "1"
    default = {
        "event": event,
        "apiVersion": "v2.1",
        "uri": f"/restapi/v2.1/accounts/{_random_digits(8)}/envelopes/{_random_uuid()}",
        "retryCount": 0,
        "configurationId": _random_uuid(),
        "generatedDateTime": now_iso,
        "data": data,
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "DocuSign Connect"},
    )


def _adyen(event: str, now_iso: str, override: Any) -> _Built:
    item = {
        "additionalData": {"hmacSignature": ""},
        "amount": {"value": 500 if event == "REFUND" else 1130, "currency": "EUR"},
        "pspReference": _random_digits(16),
        "originalReference": "" if event == "AUTHORISATION" else _random_digits(16),
        "eventCode": event,
        "eventDate": now_iso,
        "merchantAccountCode": "TestMerchant",
        "merchantReference": f"TestPayment-{_random_digits(13)}",
        "paymentMethod": "visa",
        "success": "true",
    }
    default = {"live": "false", "notificationItems": [{"NotificationRequestItem": item}]}
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "Adyen-Webhooks/1.0"},
    )


def _paypal(event: str, now_iso: str, override: Any) -> _Built:
    resource_type_by_template = {
        "PAYMENT.CAPTURE.COMPLETED": "capture",
        "CHECKOUT.ORDER.APPROVED": "checkout-order",
        "BILLING.SUBSCRIPTION.CREATED": "subscription",
    }
    default = {
        "id": f"WH-{_random_hex(8).upper()}",
        "event_version": "1.0",
        "create_time": now_iso,
        "resource_type": resource_type_by_template.get(event, "resource"),
        "event_type": event,
        "summary": f"Mock PayPal {event} event",
        "resource": {
            "id": _random_hex(16).upper(),
            "status": "COMPLETED" if event.endswith("COMPLETED") else "APPROVED",
            "amount": {"currency_code": "USD", "value": "10.00"},
        },
        "links": [],
    }
    return _Built(
        body=_payload(override, default),
        content_type=_JSON,
        headers={"user-agent": "PayPal/AUHD-214.0-56782998"},
    )


def _slack(template: str, now_sec: int, override: Any) -> _Built:
    user_agent = {"user-agent": "Slackbot 1.0 (+https://api.slack.com/robots)"}
    event_callback = {
        "token": _random_hex(24),
        "team_id": f"T{_random_hex(8).upper()}",
        "api_app_id": f"A{_random_hex(8).upper()}",
        "type": "event_callback",
        "event": {
            "type": "app_mention",
            "user": f"U{_random_hex(8).upper()}",
            "text": "hello from webhooks.cc",
            "ts": f"{now_sec}.000100",
            "channel": f"C{_random_hex(8).upper()}",
            "event_ts": f"{now_sec}.000100",
        },
        "event_id": f"Ev{_random_hex(12)}",
        "event_time": now_sec,
        "authed_users": [f"U{_random_hex(8).upper()}"],
    }
    verification = {
        "token": _random_hex(24),
        "challenge": _random_hex(16),
        "type": "url_verification",
    }
    slash_command = {
        "token": _random_hex(24),
        "team_id": f"T{_random_hex(8).upper()}",
        "team_domain": "webhooks-cc",
        "channel_id": f"C{_random_hex(8).upper()}",
        "channel_name": "general",
        "user_id": f"U{_random_hex(8).upper()}",
        "user_name": "webhooks-bot",
        "command": "/webhook-test",
        "text": "hello world",
        "response_url": "https://hooks.slack.com/commands/demo",
        "trigger_id": _random_hex(12),
    }

    if template == "slash_command":
        if override is None:
            body = _form_encode(slash_command)
        elif isinstance(override, str):
            body = override
        else:
            params = _as_string_record(override)
            if params is None:
                raise ValueError("Slack slash_command body override must be a string or an object")
            body = _form_encode(params)
        return _Built(body=body, content_type=_FORM, headers=user_agent)

    default = verification if template == "url_verification" else event_callback
    return _Built(body=_payload(override, default), content_type=_JSON, headers=user_agent)


def _paddle(template: str, now_iso: str, override: Any) -> _Built:
    def event(kind: str, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "event_id": _random_uuid(),
            "event_type": kind,
            "occurred_at": now_iso,
            "notification_id": _random_uuid(),
            "data": data,
        }

    payloads = {
        "transaction.completed": event(
            "transaction.completed",
            {
                "id": f"txn_{_random_hex(12)}",
                "status": "completed",
                "customer_id": f"ctm_{_random_hex(12)}",
                "currency_code": "USD",
                "total": "49.00",
            },
        ),
        "subscription.created": event(
            "subscription.created",
            {
                "id": f"sub_{_random_hex(12)}",
                "status": "active",
                "customer_id": f"ctm_{_random_hex(12)}",
                "next_billed_at": now_iso,
            },
        ),
        "subscription.updated": event(
            "subscription.updated",
            {
                "id": f"sub_{_random_hex(12)}",
                "status": "past_due",
                "customer_id": f"ctm_{_random_hex(12)}",
                "next_billed_at": now_iso,
            },
        ),
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={"user-agent": "Paddle/1.0"},
    )


def _linear(template: str, now_iso: str, override: Any) -> _Built:
    issue_id = _random_uuid()
    issue_url = f"https://linear.app/webhooks-cc/issue/ENG-42/{issue_id}"
    payloads = {
        "issue.create": {
            "action": "create",
            "type": "Issue",
            "webhookTimestamp": now_iso,
            "data": {
                "id": issue_id,
                "identifier": "ENG-42",
                "title": "Investigate webhook retry regression",
                "description": "Created from the webhooks.cc Linear template",
                "url": issue_url,
            },
        },
        "issue.update": {
            "action": "update",
            "type": "Issue",
            "webhookTimestamp": now_iso,
            "data": {
                "id": issue_id,
                "identifier": "ENG-42",
                "title": "Investigate webhook retry regression",
                "state": {"name": "In Progress"},
                "url": issue_url,
            },
        },
        "comment.create": {
            "action": "create",
            "type": "Comment",
            "webhookTimestamp": now_iso,
            "data": {
                "id": _random_uuid(),
                "body": "Looks good from the webhook sandbox.",
                "issue": {
                    "id": issue_id,
                    "identifier": "ENG-42",
                    "title": "Investigate webhook retry regression",
                },
                "user": {"id": _random_uuid(), "name": "webhooks.cc bot"},
            },
        },
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={"user-agent": "Linear/1.0"},
    )


def _clerk(template: str, now_sec: int, override: Any) -> _Built:
    user_id = f"user_{_random_hex(24)}"
    now_ms = now_sec * 1000

    def user(last_name: str) -> dict[str, Any]:
        return {
            "id": user_id,
            "object": "user",
            "email_addresses": [
                {
                    "id": f"idn_{_random_hex(24)}",
                    "email_address": "user@example.com",
                    "verification": {"status": "verified", "strategy": "email_code"},
                }
            ],
            "first_name": "Jane",
            "last_name": last_name,
            "created_at": now_ms,
            "updated_at": now_ms,
        }

    def event(kind: str, data: dict[str, Any]) -> dict[str, Any]:
        return {"data": data, "object": "event", "type": kind, "timestamp": now_ms}

    payloads = {
        "user.created": event("user.created", user("Doe")),
        "user.updated": event("user.updated", user("Smith")),
        "user.deleted": event("user.deleted", {"id": user_id, "object": "user", "deleted": True}),
        "session.created": event(
            "session.created",
            {
                "id": f"sess_{_random_hex(24)}",
                "object": "session",
                "user_id": user_id,
                "status": "active",
                "created_at": now_ms,
                "updated_at": now_ms,
                "expire_at": (now_sec + 86400) * 1000,
            },
        ),
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={"user-agent": "Svix-Webhooks/1.0"},
    )


def _vercel(template: str, now_sec: int, override: Any) -> _Built:
    deployment_id = f"dpl_{_random_hex(20)}"
    project = {"id": f"prj_{_random_hex(20)}", "name": "webhooks-cc-web"}
    team = {"id": f"team_{_random_hex(20)}", "name": "webhooks-cc"}

    def event(kind: str, deployment: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": _random_uuid(),
            "type": kind,
            "createdAt": now_sec * 1000,
            "payload": {"deployment": deployment, "project": project, "team": team},
        }

    def deployment_url() -> str:
        return f"webhooks-cc-web-{_random_hex(8)}.vercel.app"

    payloads = {
        "deployment.created": event(
            "deployment.created",
            {
                "id": deployment_id,
                "name": "webhooks-cc-web",
                "url": deployment_url(),
                "meta": {
                    "githubCommitRef": "main",
                    "githubCommitSha": _random_hex(40),
                    "githubCommitMessage": "Update webhook templates",
                },
            },
        ),
        "deployment.succeeded": event(
            "deployment.succeeded",
            {
                "id": deployment_id,
                "name": "webhooks-cc-web",
                "url": deployment_url(),
                "readyState": "READY",
            },
        ),
        "deployment.error": event(
            "deployment.error",
            {
                "id": deployment_id,
                "name": "webhooks-cc-web",
                "url": deployment_url(),
                "readyState": "ERROR",
                "errorMessage": "Build failed: exit code 1",
            },
        ),
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={"user-agent": "Vercel/1.0"},
    )


def _gitlab(template: str, now_iso: str, override: Any) -> _Built:
    project_id = _random_number(7)
    project = {
        "id": project_id,
        "name": "demo-repo",
        "web_url": "https://gitlab.com/webhooks-cc/demo-repo",
        "namespace": "webhooks-cc",
        "default_branch": "main",
    }
    payloads = {
        "push": {
            "object_kind": "push",
            "event_name": "push",
            "before": _random_hex(40),
            "after": _random_hex(40),
            "ref": "refs/heads/main",
            "checkout_sha": _random_hex(40),
            "user_id": _random_number(5),
            "user_name": "webhooks-cc-bot",
            "user_email": "bot@webhooks.cc",
            "project_id": project_id,
            "project": project,
            "commits": [
                {
                    "id": _random_hex(40),
                    "message": "Update webhook integration tests",
                    "title": "Update webhook integration tests",
                    "timestamp": now_iso,
                    "url": f"https://gitlab.com/webhooks-cc/demo-repo/-/commit/{_random_hex(40)}",
                    "author": {"name": "webhooks-cc-bot", "email": "bot@webhooks.cc"},
                    "added": [],
                    "modified": ["src/webhooks.ts"],
                    "removed": [],
                }
            ],
            "total_commits_count": 1,
        },
        "merge_request": {
            "object_kind": "merge_request",
            "event_type": "merge_request",
            "user": {
                "id": _random_number(5),
                "name": "webhooks-cc-bot",
                "username": "webhooks-cc-bot",
                "email": "bot@webhooks.cc",
            },
            "project": project,
            "object_attributes": {
                "id": _random_number(7),
                "iid": 42,
                "title": "Add webhook retry logic",
                "description": "This MR improves retry handling for inbound webhooks.",
                "state": "opened",
                "action": "open",
                "source_branch": "feature/webhook-retries",
                "target_branch": "main",
                "created_at": now_iso,
                "updated_at": now_iso,
                "url": "https://gitlab.com/webhooks-cc/demo-repo/-/merge_requests/42",
            },
        },
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={
            "x-gitlab-event": "Merge Request Hook" if template == "merge_request" else "Push Hook",
            "user-agent": "GitLab/1.0",
        },
    )


def _typeform(template: str, event: str, now_iso: str, override: Any) -> _Built:
    form_id = _random_hex(6).upper()
    token = _random_token("token")
    event_type = "form_response" if template == "payment" else event

    def field(field_id: str, ref: str, kind: str) -> dict[str, Any]:
        return {"id": field_id, "ref": ref, "type": kind}

    payloads = {
        "form_response": {
            "event_id": _random_uuid(),
            "event_type": event_type,
            "form_response": {
                "form_id": form_id,
                "token": token,
                "landed_at": now_iso,
                "submitted_at": now_iso,
                "hidden": {"source": "webhooks-cc"},
                "definition": {
                    "id": form_id,
                    "title": "Webhook test form",
                    "fields": [
                        {
                            **field("field_name", "name", "short_text"),
                            "title": "What is your name?",
                        },
                        {**field("field_email", "email", "email"), "title": "What is your email?"},
                    ],
                },
                "answers": [
                    {
                        "type": "text",
                        "text": "Ada Lovelace",
                        "field": field("field_name", "name", "short_text"),
                    },
                    {
                        "type": "email",
                        "email": "ada@example.com",
                        "field": field("field_email", "email", "email"),
                    },
                ],
            },
        },
        "partial_response": {
            "event_id": _random_uuid(),
            "event_type": event_type,
            "form_response": {
                "form_id": form_id,
                "token": token,
                "landed_at": now_iso,
                "submitted_at": None,
                "definition": {
                    "id": form_id,
                    "title": "Webhook test form",
                    "fields": [
                        {**field("field_email", "email", "email"), "title": "What is your email?"}
                    ],
                },
                "answers": [
                    {
                        "type": "email",
                        "email": "partial@example.com",
                        "field": field("field_email", "email", "email"),
                    }
                ],
            },
        },
        "payment": {
            "event_id": _random_uuid(),
            "event_type": event_type,
            "form_response": {
                "form_id": form_id,
                "token": token,
                "landed_at": now_iso,
                "submitted_at": now_iso,
                "definition": {
                    "id": form_id,
                    "title": "Order form",
                    "fields": [
                        {**field("field_payment", "payment", "payment"), "title": "Payment"}
                    ],
                },
                "answers": [
                    {
                        "type": "payment",
                        "payment": {
                            "amount": "1999",
                            "last4": "4242",
                            "name": "Ada Lovelace",
                            "success": True,
                        },
                        "field": field("field_payment", "payment", "payment"),
                    }
                ],
            },
        },
    }
    return _Built(
        body=_payload(override, payloads.get(template)),
        content_type=_JSON,
        headers={"user-agent": "Typeform Webhooks"},
    )


def _twilio(template: str, override: Any) -> _Built:
    headers = {"user-agent": "TwilioProxy/1.1"}
    if override is not None:
        if isinstance(override, str):
            return _Built(
                body=override,
                content_type=_FORM,
                headers=headers,
                twilio_params=_form_decode(override),
            )
        params = _as_string_record(override)
        if params is None:
            raise ValueError("Twilio template body override must be a string or an object")
    else:
        params = _default_twilio_params(template)
    return _Built(
        body=_form_encode(params),
        content_type=_FORM,
        headers=headers,
        twilio_params=list(params.items()),
    )


def _default_twilio_params(template: str) -> dict[str, str]:
    if template == "messaging.status_callback":
        return {
            "AccountSid": _random_sid("AC"),
            "ApiVersion": "2010-04-01",
            "MessageSid": _random_sid("SM"),
            "SmsSid": _random_sid("SM"),
            "MessageStatus": "delivered",
            "SmsStatus": "delivered",
            "To": "+14155559876",
            "From": "+14155550123",
            "ErrorCode": "",
        }
    if template == "voice.incoming_call":
        return {
            "AccountSid": _random_sid("AC"),
            "ApiVersion": "2010-04-01",
            "CallSid": _random_sid("CA"),
            "CallStatus": "ringing",
            "Direction": "inbound",
            "From": "+14155550123",
            "To": "+14155559876",
            "CallerCity": "SAN FRANCISCO",
            "CallerState": "CA",
            "CallerCountry": "US",
            "CallerZip": "94105",
            "CalledCity": "",
            "CalledState": "",
            "CalledCountry": "US",
            "CalledZip": "",
        }
    return {
        "AccountSid": _random_sid("AC"),
        "ApiVersion": "2010-04-01",
        "MessageSid": _random_sid("SM"),
        "SmsSid": _random_sid("SM"),
        "SmsMessageSid": _random_sid("SM"),
        "From": "+14155550123",
        "To": "+14155559876",
        "Body": "Hello from webhooks.cc",
        "NumMedia": "0",
        "NumSegments": "1",
        "MessageStatus": "received",
        "SmsStatus": "received",
        "FromCity": "SAN FRANCISCO",
        "FromState": "CA",
        "FromCountry": "US",
        "FromZip": "94105",
        "ToCity": "",
        "ToState": "",
        "ToCountry": "US",
        "ToZip": "",
    }


def _build_payload(provider: str, template: str, event: str, now_ms: int, override: Any) -> _Built:
    now_sec = now_ms // 1000
    now_iso = _iso(now_ms)
    if provider == "stripe":
        return _stripe(template, event, now_sec, override)
    if provider == "github":
        return _github(template, now_iso, override)
    if provider == "shopify":
        return _shopify(template, now_iso, override)
    if provider == "meta":
        return _meta(template, now_sec, override)
    if provider == "lemonsqueezy":
        return _lemonsqueezy(template, event, override)
    if provider == "coinbase-commerce":
        return _coinbase(event, now_iso, override)
    if provider == "razorpay":
        return _razorpay(event, now_sec, override)
    if provider == "cal":
        return _cal(event, now_iso, override)
    if provider == "intercom":
        return _intercom(event, now_sec, override)
    if provider == "telegram":
        return _telegram(template, now_sec, override)
    if provider == "square":
        return _square(template, now_iso, override)
    if provider == "hubspot":
        return _hubspot(event, now_sec, override)
    if provider == "mailgun":
        return _mailgun(event, now_sec, override)
    if provider == "calendly":
        return _calendly(event, now_iso, override)
    if provider == "mux":
        return _mux(event, now_iso, override)
    if provider == "resend":
        return _resend(template, event, now_iso, override)
    if provider == "workos":
        return _workos(template, event, now_iso, override)
    if provider == "sentry":
        return _sentry(template, override)
    if provider == "bitbucket":
        return _bitbucket(template, override)
    if provider == "docusign":
        return _docusign(template, event, now_iso, override)
    if provider == "adyen":
        return _adyen(event, now_iso, override)
    if provider == "paypal":
        return _paypal(event, now_iso, override)
    if provider == "slack":
        return _slack(template, now_sec, override)
    if provider == "paddle":
        return _paddle(template, now_iso, override)
    if provider == "linear":
        return _linear(template, now_iso, override)
    if provider == "clerk":
        return _clerk(template, now_sec, override)
    if provider == "vercel":
        return _vercel(template, now_sec, override)
    if provider == "gitlab":
        return _gitlab(template, now_iso, override)
    if provider == "typeform":
        return _typeform(template, event, now_iso, override)
    if provider == "twilio":
        return _twilio(template, override)
    raise ValueError(f"Unsupported provider: {provider}")


# --- Signing ----------------------------------------------------------------------------


def _hmac(algorithm: str, secret: str, payload: str) -> bytes:
    return hmac_digest("sha1" if algorithm == "sha1" else "sha256", secret, payload)


def _template_headers(provider: str, template: str) -> dict[str, str]:
    return {
        "x-webhooks-cc-template-provider": provider,
        "x-webhooks-cc-template-template": template,
        "x-webhooks-cc-template-event": template,
    }


def _sign_mailgun(body: str, secret: str, timestamp: float | None) -> str:
    """Sign the body's ``timestamp + token`` and write the signature object back into it."""
    parsed = _parse_json(body)
    if not isinstance(parsed, (dict, list)):
        raise ValueError("Mailgun template body must be a JSON object")
    signature = parsed.get("signature") if isinstance(parsed, dict) else None
    signed_timestamp = signature.get("timestamp") if isinstance(signature, dict) else None
    if signed_timestamp is None:
        signed_timestamp = js_string(timestamp if timestamp is not None else _now_seconds())
    token = signature.get("token") if isinstance(signature, dict) else None
    if token is None:
        token = _random_hex(50)
    digest = to_hex(_hmac("sha256", secret, f"{_js_str(signed_timestamp)}{_js_str(token)}"))
    if isinstance(parsed, dict):
        # An array keeps its items: JSON.stringify drops a property set on an array.
        parsed["signature"] = {"timestamp": signed_timestamp, "token": token, "signature": digest}
    return js_json(parsed)


def _spread(value: Any) -> dict[str, Any]:
    """``{...value}`` for the values JSON can hold."""
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, (list, str)):
        return {str(index): item for index, item in enumerate(value)}
    return {}


def _sign_adyen(body: str, secret: str) -> str:
    """Sign every notification item in the body; each must carry its own signature."""
    parsed = _parse_json(body)
    if parsed is None:
        raise ValueError("Adyen template body must be a JSON object")
    items = parsed.get("notificationItems") if isinstance(parsed, dict) else None
    if items is None or isinstance(items, str):
        return body
    if not isinstance(items, list):
        raise ValueError("Adyen notificationItems must be an array")
    signed_any = False
    for wrapper in items:
        item = wrapper.get("NotificationRequestItem") if isinstance(wrapper, dict) else None
        if isinstance(item, list):
            # JSON.stringify drops the property TS sets on an array; the key is still checked.
            adyen_hmac({}, secret)
            signed_any = True
            continue
        if not isinstance(item, dict):
            continue
        signature = adyen_hmac(item, secret)
        item["additionalData"] = {**_spread(item.get("additionalData")), "hmacSignature": signature}
        signed_any = True
    return js_json(parsed) if signed_any else body


def _paypal_time(timestamp: float | None) -> str:
    if timestamp:
        return _iso(math.trunc(timestamp * 1000))
    return _iso(_now_ms())


def build_template_request(
    url: str,
    *,
    provider: str,
    secret: str | None = None,
    template: str | None = None,
    event: str | None = None,
    body: Any = None,
    method: str | None = None,
    headers: Mapping[str, str] | None = None,
    timestamp: int | None = None,
    message_id: str | None = None,
) -> BuiltRequest:
    """Build a webhook request the way ``provider`` sends it, signed with ``secret``.

    ``body`` is sent as is when it is a string and as JSON otherwise; without
    it the template's sample payload is used. ``timestamp`` (Unix seconds) and
    ``message_id`` (Standard Webhooks, Clerk, Resend) make signatures
    repeatable in tests. ``headers`` are added last and override the built ones.

    Raises ``ValueError`` for an unknown provider or template, or a missing
    secret for a provider that signs with one.
    """
    if provider not in TEMPLATE_METADATA:
        raise ValueError(f"Unsupported provider: {provider}")
    extra = dict(headers or {})
    resolved_method = (method if method is not None else "POST").upper()

    def require_secret() -> str:
        if not secret:
            raise ValueError(f'Provider "{provider}" templates require a non-empty secret')
        return secret

    def seconds() -> float:
        return timestamp if timestamp is not None else _now_seconds()

    if provider == "standard-webhooks":
        payload = json_body({} if body is None else body)
        msg_id = message_id
        if msg_id is None:
            msg_id = f"msg_{event}_{_random_hex(8)}" if event else f"msg_{_random_hex(16)}"
        ts = js_string(seconds())
        key = decode_standard_webhook_secret(require_secret())
        signature = to_base64(hmac_digest("sha256", key, f"{msg_id}.{ts}.{payload}"))
        return BuiltRequest(
            method=resolved_method,
            url=url,
            headers={
                "content-type": _JSON,
                "webhook-id": msg_id,
                "webhook-timestamp": ts,
                "webhook-signature": f"v1,{signature}",
                **extra,
            },
            body=payload,
        )

    if provider == "sendgrid":
        resolved_template = _ensure_template(provider, template)
        now_sec = _now_seconds()

        def sendgrid_event(email: str, kind: str, **fields: Any) -> list[dict[str, Any]]:
            return [
                {
                    "sg_event_id": _random_hex(22),
                    "sg_message_id": f"{_random_hex(20)}.{_random_digits(4)}",
                    "email": email,
                    "timestamp": now_sec,
                    "event": kind,
                    **fields,
                }
            ]

        sendgrid_payloads = {
            "delivered": sendgrid_event(
                "recipient@example.com",
                "delivered",
                smtp_id=f"<{_random_hex(20)}@example.com>",
                ip="168.1.1.1",
                response="250 OK",
                category=["webhooks-cc-test"],
            ),
            "open": sendgrid_event(
                "recipient@example.com",
                "open",
                ip="72.14.199.28",
                useragent="Mozilla/5.0",
                category=["webhooks-cc-test"],
            ),
            "bounce": sendgrid_event(
                "bounced@example.com",
                "bounce",
                type="bounce",
                status="5.1.1",
                reason="550 5.1.1 The email account does not exist.",
                ip="168.1.1.1",
                category=["webhooks-cc-test"],
            ),
            "spam_report": sendgrid_event(
                "complainant@example.com", "spamreport", category=["webhooks-cc-test"]
            ),
        }
        return BuiltRequest(
            method=resolved_method,
            url=url,
            headers={
                "content-type": _JSON,
                "user-agent": "SendGrid/1.0",
                **_template_headers(provider, resolved_template),
                **extra,
            },
            body=_payload(body, sendgrid_payloads[resolved_template]),
        )

    if provider == "discord":
        resolved_template = _ensure_template(provider, template)
        ts = js_string(seconds())
        discord_payloads = {
            "interaction_create": {
                "id": _random_hex(18),
                "application_id": _random_hex(18),
                "type": 2,
                "data": {"id": _random_hex(18), "name": "webhook-test", "type": 1},
                "guild_id": _random_hex(18),
                "channel_id": _random_hex(18),
                "token": _random_hex(40),
                "version": 1,
            },
            "message_component": {
                "id": _random_hex(18),
                "application_id": _random_hex(18),
                "type": 3,
                "data": {"custom_id": "click_me", "component_type": 2},
                "guild_id": _random_hex(18),
                "channel_id": _random_hex(18),
                "token": _random_hex(40),
                "version": 1,
            },
            "ping": {
                "id": _random_hex(18),
                "application_id": _random_hex(18),
                "type": 1,
                "version": 1,
            },
        }
        return BuiltRequest(
            method=resolved_method,
            url=url,
            headers={
                "content-type": _JSON,
                "x-signature-timestamp": ts,
                **_template_headers(provider, resolved_template),
                **extra,
            },
            body=_payload(body, discord_payloads[resolved_template]),
        )

    if provider == "plaid":
        # Real Plaid verification fetches Plaid's JWK with API credentials, so
        # generated payloads carry a JWT-shaped placeholder and are not signed.
        resolved_template = _ensure_template(provider, template)
        plaid_payloads = {
            "TRANSACTIONS": {
                "webhook_type": "TRANSACTIONS",
                "webhook_code": "DEFAULT_UPDATE",
                "item_id": f"item_{_random_hex(8)}",
                "new_transactions": 1,
            },
            "ITEM": {
                "webhook_type": "ITEM",
                "webhook_code": "ERROR",
                "item_id": f"item_{_random_hex(8)}",
                "error": {
                    "error_type": "ITEM_ERROR",
                    "error_code": "WEBHOOK_UPDATE_ACKNOWLEDGED",
                },
            },
            "AUTH": {
                "webhook_type": "AUTH",
                "webhook_code": "AUTOMATICALLY_VERIFIED",
                "item_id": f"item_{_random_hex(8)}",
                "account_id": f"account_{_random_hex(8)}",
            },
        }
        payload = _payload(body, plaid_payloads[resolved_template])
        jwt_header = to_base64url(
            utf8(js_json({"alg": "ES256", "kid": f"mock-{_random_hex(8)}", "typ": "JWT"}))
        )
        jwt_payload = to_base64url(
            utf8(js_json({"iat": seconds(), "request_body_sha256": "mock-template-not-verifiable"}))
        )
        return BuiltRequest(
            method=resolved_method,
            url=url,
            headers={
                "content-type": _JSON,
                "plaid-verification": f"{jwt_header}.{jwt_payload}.mock-signature",
                **_template_headers(provider, resolved_template),
                **extra,
            },
            body=payload,
        )

    signing_secret = require_secret()
    resolved_template = _ensure_template(provider, template)
    resolved_event = event if event is not None else _default_event(provider, resolved_template)
    built = _build_payload(provider, resolved_template, resolved_event, _now_ms(), body)

    out: dict[str, str] = {
        "content-type": built.content_type,
        "x-webhooks-cc-template-provider": provider,
        "x-webhooks-cc-template-template": resolved_template,
        "x-webhooks-cc-template-event": resolved_event,
        **built.headers,
    }

    if provider == "stripe":
        ts = js_string(seconds())
        digest = to_hex(_hmac("sha256", signing_secret, f"{ts}.{built.body}"))
        out["stripe-signature"] = f"t={ts},v1={digest}"

    if provider == "github":
        out["x-github-event"] = resolved_event
        out["x-github-delivery"] = _random_uuid()
        out["x-hub-signature-256"] = f"sha256={to_hex(_hmac('sha256', signing_secret, built.body))}"

    if provider == "shopify":
        out["x-shopify-topic"] = resolved_event
        out["x-shopify-hmac-sha256"] = to_base64(_hmac("sha256", signing_secret, built.body))

    if provider == "twilio":
        signed = (
            build_twilio_signature_payload(url, built.twilio_params)
            if built.twilio_params is not None
            else f"{url}{built.body}"
        )
        out["x-twilio-signature"] = to_base64(_hmac("sha1", signing_secret, signed))

    if provider == "slack":
        ts = js_string(seconds())
        digest = to_hex(_hmac("sha256", signing_secret, f"v0:{ts}:{built.body}"))
        out["x-slack-request-timestamp"] = ts
        out["x-slack-signature"] = f"v0={digest}"

    if provider == "paddle":
        ts = js_string(seconds())
        digest = to_hex(_hmac("sha256", signing_secret, f"{ts}:{built.body}"))
        out["paddle-signature"] = f"ts={ts};h1={digest}"

    if provider == "linear":
        out["linear-signature"] = f"sha256={to_hex(_hmac('sha256', signing_secret, built.body))}"

    if provider == "clerk":
        msg_id = message_id if message_id is not None else f"msg_{_random_hex(16)}"
        ts = js_string(seconds())
        key = decode_standard_webhook_secret(signing_secret)
        signature = f"v1,{to_base64(hmac_digest('sha256', key, f'{msg_id}.{ts}.{built.body}'))}"
        out["webhook-id"] = msg_id
        out["webhook-timestamp"] = ts
        out["webhook-signature"] = signature
        out["svix-id"] = msg_id
        out["svix-timestamp"] = ts
        out["svix-signature"] = signature

    if provider == "vercel":
        out["x-vercel-signature"] = to_hex(_hmac("sha1", signing_secret, built.body))

    if provider == "gitlab":
        out["x-gitlab-token"] = signing_secret
        out["x-gitlab-event"] = (
            "Merge Request Hook" if resolved_template == "merge_request" else "Push Hook"
        )

    if provider == "typeform":
        out["typeform-signature"] = (
            f"sha256={to_base64(_hmac('sha256', signing_secret, built.body))}"
        )

    if provider == "meta":
        out["x-hub-signature-256"] = f"sha256={to_hex(_hmac('sha256', signing_secret, built.body))}"

    if provider == "lemonsqueezy":
        out["x-signature"] = to_hex(_hmac("sha256", signing_secret, built.body))

    if provider == "coinbase-commerce":
        out["x-cc-webhook-signature"] = to_hex(_hmac("sha256", signing_secret, built.body))

    if provider == "razorpay":
        out["x-razorpay-signature"] = to_hex(_hmac("sha256", signing_secret, built.body))

    if provider == "cal":
        out["x-cal-signature-256"] = to_hex(_hmac("sha256", signing_secret, built.body))

    if provider == "intercom":
        out["x-hub-signature"] = f"sha1={to_hex(_hmac('sha1', signing_secret, built.body))}"

    if provider == "telegram":
        out["x-telegram-bot-api-secret-token"] = signing_secret

    if provider == "square":
        # Square signs the notification URL followed by the raw body.
        out["x-square-hmacsha256-signature"] = to_base64(
            _hmac("sha256", signing_secret, f"{url}{built.body}")
        )

    if provider == "hubspot":
        # HubSpot v3 signs method + decoded URI + body + timestamp in milliseconds.
        ts = js_string(seconds() * 1000)
        base = f"{resolved_method}{decode_hubspot_uri(url)}{built.body}{ts}"
        out["x-hubspot-request-timestamp"] = ts
        out["x-hubspot-signature-v3"] = to_base64(_hmac("sha256", signing_secret, base))

    if provider == "mailgun":
        built.body = _sign_mailgun(built.body, signing_secret, timestamp)

    if provider == "calendly":
        ts = js_string(seconds())
        digest = to_hex(_hmac("sha256", signing_secret, f"{ts}.{built.body}"))
        out["calendly-webhook-signature"] = f"t={ts},v1={digest}"

    if provider == "mux":
        ts = js_string(seconds())
        digest = to_hex(_hmac("sha256", signing_secret, f"{ts}.{built.body}"))
        out["mux-signature"] = f"t={ts},v1={digest}"

    if provider == "resend":
        # Resend delivers through Svix and sends only the svix-* headers.
        msg_id = message_id if message_id is not None else f"msg_{_random_hex(24)}"
        ts = js_string(seconds())
        key = decode_standard_webhook_secret(signing_secret)
        digest = to_base64(hmac_digest("sha256", key, f"{msg_id}.{ts}.{built.body}"))
        out["svix-id"] = msg_id
        out["svix-timestamp"] = ts
        out["svix-signature"] = f"v1,{digest}"

    if provider == "workos":
        # WorkOS signs `${t}.${body}` with t in milliseconds, and the header puts a space
        # after the comma.
        ts = js_string(timestamp * 1000) if timestamp is not None else str(_now_ms())
        digest = to_hex(_hmac("sha256", signing_secret, f"{ts}.{built.body}"))
        out["workos-signature"] = f"t={ts}, v1={digest}"

    if provider == "sentry":
        out["sentry-hook-signature"] = to_hex(_hmac("sha256", signing_secret, built.body))
        out["sentry-hook-resource"] = resolved_event.split(".")[0]

    if provider == "bitbucket":
        out["x-event-key"] = resolved_event
        out["x-hub-signature"] = f"sha256={to_hex(_hmac('sha256', signing_secret, built.body))}"

    if provider == "docusign":
        out["x-docusign-signature-1"] = to_base64(_hmac("sha256", signing_secret, built.body))
        out["x-authorization-digest"] = "HMACSHA256"

    if provider == "adyen":
        built.body = _sign_adyen(built.body, signing_secret)

    if provider == "paypal":
        out["paypal-transmission-id"] = _random_uuid()
        out["paypal-transmission-time"] = _paypal_time(timestamp)
        out["paypal-cert-url"] = (
            f"https://api.sandbox.paypal.com/v1/notifications/certs/CERT-{_random_hex(16)}"
        )
        out["paypal-auth-algo"] = "SHA256withRSA"
        # PayPal signs with its own private key, which a test cannot hold. This
        # placeholder keeps generated requests provider-shaped for detection.
        out["paypal-transmission-sig"] = to_base64url(utf8(f"mock:{signing_secret}:{built.body}"))

    return BuiltRequest(method=resolved_method, url=url, headers={**out, **extra}, body=built.body)
