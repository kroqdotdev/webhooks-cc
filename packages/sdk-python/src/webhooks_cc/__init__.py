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

Without an API key, ``WebhooksCC.sandbox()`` gives an AI agent a sandbox for 24
hours, and ``WebhooksCC.connect(email)`` connects it to a human's account; see
:mod:`webhooks_cc.sandbox` and :mod:`webhooks_cc.agent`.

Every signature check for each provider is in :mod:`webhooks_cc.verify`.
"""

__version__ = "0.3.0"

from .agent import AgentAuthError, ClaimAttempt
from .client import (
    Destinations,
    Emails,
    Endpoints,
    Forwarding,
    Requests,
    RetryOptions,
    WebhooksCC,
)
from .credentials import agent_credentials_path
from .durations import Duration, parse_duration
from .email import (
    DEFAULT_EMAIL_DOMAIN,
    INBOUND_EMAIL_FORMATS,
    email_address,
    email_field_issues,
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
    AttachmentDownload,
    BuiltRequest,
    DeliveryCounts,
    Destination,
    DestinationAttachments,
    DestinationFilter,
    DestinationFormat,
    DestinationHeader,
    DestinationPreview,
    DestinationRequest,
    DestinationSummary,
    DestinationTestResult,
    EmailAddress,
    EmailAttachment,
    EmailCapture,
    EmailExtracts,
    EmailField,
    Endpoint,
    ExtractedLink,
    Layout,
    LayoutsPreview,
    LineItemColumn,
    LineItemsSpec,
    ParsedAttachment,
    ParsedEmail,
    ParsedSheet,
    PreviewedDelivery,
    PreviewedResponse,
    PreviewRequest,
    PreviewRule,
    RenderedEmail,
    Request,
    RequestPage,
    ResponsePreview,
    SandboxEndpoint,
    SandboxLimits,
    SenderTime,
    SendTestEmailResult,
    TeamShare,
    UsageInfo,
)
from .sandbox import PendingConnection, SandboxClaim, SandboxClient, SandboxError
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
    verify_forwarded_json,
    verify_forwarded_request,
    verify_relayed_request,
    verify_signature,
)

__all__ = [
    "DEFAULT_EMAIL_DOMAIN",
    "INBOUND_EMAIL_FORMATS",
    "TEMPLATE_METADATA",
    "TEMPLATE_PROVIDERS",
    "VERIFY_PROVIDERS",
    "AgentAuthError",
    "AttachmentDownload",
    "BuiltRequest",
    "ClaimAttempt",
    "DeliveryCounts",
    "Destination",
    "DestinationAttachments",
    "DestinationFilter",
    "DestinationFormat",
    "DestinationHeader",
    "DestinationPreview",
    "DestinationRequest",
    "DestinationSummary",
    "DestinationTestResult",
    "Destinations",
    "Duration",
    "EmailAddress",
    "EmailAttachment",
    "EmailCapture",
    "EmailExtracts",
    "EmailField",
    "Emails",
    "Endpoint",
    "Endpoints",
    "ExtractedLink",
    "Forwarding",
    "Layout",
    "LayoutsPreview",
    "LineItemColumn",
    "LineItemsSpec",
    "Matcher",
    "NotFoundError",
    "ParsedAttachment",
    "ParsedEmail",
    "ParsedSheet",
    "PendingConnection",
    "PreviewRequest",
    "PreviewRule",
    "PreviewedDelivery",
    "PreviewedResponse",
    "RateLimitError",
    "RelayedRequestInfo",
    "RenderedEmail",
    "Request",
    "RequestPage",
    "Requests",
    "ResponsePreview",
    "RetryOptions",
    "SandboxClaim",
    "SandboxClient",
    "SandboxEndpoint",
    "SandboxError",
    "SandboxLimits",
    "SendTestEmailResult",
    "SenderTime",
    "TeamShare",
    "TemplateProviderInfo",
    "TimeoutError",
    "UnauthorizedError",
    "UsageInfo",
    "WebhookVerificationError",
    "WebhooksCC",
    "WebhooksCCError",
    "__version__",
    "agent_credentials_path",
    "build_template_request",
    "capture_during",
    "capture_email_during",
    "email_address",
    "email_field_issues",
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
    "verify_forwarded_json",
    "verify_forwarded_request",
    "verify_relayed_request",
    "verify_signature",
]
