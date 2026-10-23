"""webhooks.cc SDK for Python.

Capture webhooks and email in tests, wait for them, send signed webhooks to
your own handlers, and verify provider and forwarding signatures.

.. code-block:: python

    from webhooks_cc import WebhooksCC, match_body_path

    with WebhooksCC() as client:  # reads WHK_API_KEY
        endpoint = client.endpoints.create(name="checkout test")
        request = client.requests.wait_for(
            endpoint.slug, timeout="30s", match=match_body_path("type", "invoice.paid")
        )

Every signature check for each provider is in :mod:`webhooks_cc.verify`.
"""

__version__ = "0.1.1"

from .client import Emails, Endpoints, Forwarding, Requests, RetryOptions, WebhooksCC
from .durations import Duration, parse_duration
from .email import (
    DEFAULT_EMAIL_DOMAIN,
    email_address,
    extract_code,
    extract_link,
    is_valid_email_tag,
)
from .errors import (
    NotFoundError,
    RateLimitError,
    TimeoutError,
    UnauthorizedError,
    WebhooksCCError,
    WebhookVerificationError,
)
from .matchers import (
    Matcher,
    is_email_request,
    match_all,
    match_any,
    match_body_path,
    match_body_subset,
    match_content_type,
    match_email,
    match_header,
    match_method,
    match_path,
    match_query_param,
    match_unverified,
    match_verified,
)
from .models import (
    BuiltRequest,
    EmailAddress,
    EmailAttachment,
    EmailCapture,
    EmailExtracts,
    Endpoint,
    ExtractedLink,
    Request,
    RequestPage,
    SendTestEmailResult,
    TeamShare,
    UsageInfo,
)
from .templates import (
    TEMPLATE_METADATA,
    TEMPLATE_PROVIDERS,
    VERIFY_PROVIDERS,
    TemplateProviderInfo,
    build_template_request,
)
from .testing import capture_during, capture_email_during, temporary_endpoint
from .verify import (
    RelayedRequestInfo,
    verify_forwarded_email,
    verify_forwarded_request,
    verify_relayed_request,
    verify_signature,
)

__all__ = [
    "DEFAULT_EMAIL_DOMAIN",
    "TEMPLATE_METADATA",
    "TEMPLATE_PROVIDERS",
    "VERIFY_PROVIDERS",
    "BuiltRequest",
    "Duration",
    "EmailAddress",
    "EmailAttachment",
    "EmailCapture",
    "EmailExtracts",
    "Emails",
    "Endpoint",
    "Endpoints",
    "ExtractedLink",
    "Forwarding",
    "Matcher",
    "NotFoundError",
    "RateLimitError",
    "RelayedRequestInfo",
    "Request",
    "RequestPage",
    "Requests",
    "RetryOptions",
    "SendTestEmailResult",
    "TeamShare",
    "TemplateProviderInfo",
    "TimeoutError",
    "UnauthorizedError",
    "UsageInfo",
    "WebhookVerificationError",
    "WebhooksCC",
    "WebhooksCCError",
    "__version__",
    "build_template_request",
    "capture_during",
    "capture_email_during",
    "email_address",
    "extract_code",
    "extract_link",
    "is_email_request",
    "is_valid_email_tag",
    "match_all",
    "match_any",
    "match_body_path",
    "match_body_subset",
    "match_content_type",
    "match_email",
    "match_header",
    "match_method",
    "match_path",
    "match_query_param",
    "match_unverified",
    "match_verified",
    "parse_duration",
    "temporary_endpoint",
    "verify_forwarded_email",
    "verify_forwarded_request",
    "verify_relayed_request",
    "verify_signature",
]
