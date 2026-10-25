"""Typed views of what the webhooks.cc API returns.

Every model keeps the JSON it was built from in ``raw``, so fields this
version of the SDK does not know yet stay reachable.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, cast

RequestKind = Literal["http", "email"]

InboundEmailFormat = Literal["postmark", "sendgrid", "mailgun", "cloudmailin"]
"""The inbound mail providers whose shape an email can be sent or rendered in: Postmark's
inbound JSON, SendGrid's Inbound Parse form, a Mailgun route's form and CloudMailin's
JSON Normalized format."""

DestinationFormat = Literal[
    "auto",
    "as_received",
    "json",
    "template",
    "chat",
    "postmark",
    "sendgrid",
    "mailgun",
    "cloudmailin",
]
"""How a destination sends. ``"auto"`` picks from the URL: a chat message for Slack and
Discord, otherwise HTTP requests as received and emails as signed JSON. The
:data:`InboundEmailFormat` shapes apply to emails; HTTP requests to such a destination go
as received."""

EmailFieldSource = Literal["subject", "text", "html", "from", "to", "header"]
"""The part of an email a named field reads: ``"html"`` is the HTML as text, ``"to"`` the
To and Cc addresses, and ``"header"`` the header named in ``header``."""


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _str_map(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in value.items() if isinstance(item, str)}


def _number(value: Any, default: float = 0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return value


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


@dataclass(frozen=True)
class EmailAddress:
    name: str | None
    address: str | None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> EmailAddress:
        return cls(name=_str_or_none(data.get("name")), address=_str_or_none(data.get("address")))

    def __str__(self) -> str:
        address = self.address or ""
        return f"{self.name} <{address}>" if self.name else address


def _addresses(value: Any) -> list[EmailAddress]:
    if not isinstance(value, list):
        return []
    return [EmailAddress.from_dict(item) for item in value if isinstance(item, Mapping)]


@dataclass(frozen=True)
class EmailAttachment:
    filename: str | None
    content_type: str
    size: int
    content_id: str | None
    inline: bool

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> EmailAttachment:
        return cls(
            filename=_str_or_none(data.get("filename")),
            content_type=str(data.get("contentType") or "application/octet-stream"),
            size=int(_number(data.get("size"))),
            content_id=_str_or_none(data.get("contentId")),
            inline=data.get("inline") is True,
        )


@dataclass(frozen=True)
class EmailCapture:
    """A captured email, parsed: the ``email`` of a request whose ``kind`` is ``"email"``.

    ``auth`` (SPF, DKIM, DMARC), ``spam`` (rspamd's verdict), ``smtp`` and
    ``truncated`` are kept as the API sends them.
    """

    subject: str | None
    from_: list[EmailAddress]
    to: list[EmailAddress]
    cc: list[EmailAddress]
    reply_to: list[EmailAddress]
    sender: list[EmailAddress]
    date: str | None
    message_id: str | None
    in_reply_to: list[str]
    tag: str | None
    """The ``+tag`` of the address it was sent to, if any."""
    text: str | None
    html: str | None
    text_from_html: bool
    attachments: list[EmailAttachment]
    auth: dict[str, Any] | None
    spam: dict[str, Any] | None
    smtp: dict[str, Any] | None
    parse_error: bool
    truncated: dict[str, bool]
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> EmailCapture:
        in_reply_to = data.get("inReplyTo")
        attachments = data.get("attachments")
        truncated = data.get("truncated")
        return cls(
            subject=_str_or_none(data.get("subject")),
            from_=_addresses(data.get("from")),
            to=_addresses(data.get("to")),
            cc=_addresses(data.get("cc")),
            reply_to=_addresses(data.get("replyTo")),
            sender=_addresses(data.get("sender")),
            date=_str_or_none(data.get("date")),
            message_id=_str_or_none(data.get("messageId")),
            in_reply_to=[item for item in in_reply_to if isinstance(item, str)]
            if isinstance(in_reply_to, list)
            else [],
            tag=_str_or_none(data.get("tag")),
            text=_str_or_none(data.get("text")),
            html=_str_or_none(data.get("html")),
            text_from_html=data.get("textFromHtml") is True,
            attachments=[
                EmailAttachment.from_dict(item) for item in attachments if isinstance(item, Mapping)
            ]
            if isinstance(attachments, list)
            else [],
            auth=dict(data["auth"]) if isinstance(data.get("auth"), Mapping) else None,
            spam=dict(data["spam"]) if isinstance(data.get("spam"), Mapping) else None,
            smtp=dict(data["smtp"]) if isinstance(data.get("smtp"), Mapping) else None,
            parse_error=data.get("parseError") is True,
            truncated={str(key): value is True for key, value in truncated.items()}
            if isinstance(truncated, Mapping)
            else {},
            raw=dict(data),
        )


@dataclass(frozen=True)
class ExtractedLink:
    """A link found in an email."""

    url: str
    label: str | None
    """The link text, when the link came from HTML."""
    action: bool
    """Looks like what the email asks you to click (confirm, verify, reset, sign in)."""


@dataclass(frozen=True)
class EmailExtracts:
    """One-time codes and links found in an email, at most 20 of each.

    Codes are in order of appearance, subject first; links come best first.
    """

    codes: list[str]
    links: list[ExtractedLink]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> EmailExtracts:
        codes = data.get("codes")
        links = data.get("links")
        return cls(
            codes=[code for code in codes if isinstance(code, str)]
            if isinstance(codes, list)
            else [],
            links=[
                ExtractedLink(
                    url=link["url"],
                    label=_str_or_none(link.get("label")),
                    action=link.get("action") is True,
                )
                for link in links
                if isinstance(link, Mapping) and isinstance(link.get("url"), str)
            ]
            if isinstance(links, list)
            else [],
        )


@dataclass(frozen=True)
class EmailField:
    """A named field an endpoint picks out of every email it captures.

    ``pattern`` is a regular expression in RE2 syntax whose first group (or whole
    match, without a group) is the value. webhooks.cc runs it, so lookahead,
    lookbehind and backreferences are not available. The values arrive as
    :attr:`Request.email_fields`, and as ``fields`` in the email's JSON, where
    forwarding templates read them as ``{{ fields.invoice }}``.
    """

    name: str
    """Letters, digits and ``_``, starting with a letter, at most 40 characters."""
    from_: EmailFieldSource
    pattern: str
    """At most 1,000 characters."""
    header: str | None = None
    """The header's name, for ``from_="header"``."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> EmailField:
        source = data.get("from")
        return cls(
            name=str(data.get("name") or ""),
            from_=cast(EmailFieldSource, source if isinstance(source, str) else ""),
            pattern=str(data.get("pattern") or ""),
            header=_str_or_none(data.get("header")),
        )

    def to_dict(self) -> dict[str, Any]:
        """The field as the API takes it."""
        out: dict[str, Any] = {"name": self.name, "from": self.from_, "pattern": self.pattern}
        if self.header is not None:
            out["header"] = self.header
        return out


@dataclass(frozen=True)
class Request:
    """A captured request: an HTTP webhook, or an email when ``kind`` is ``"email"``.

    ``received_at`` is in milliseconds since the epoch. For emails the
    ``method`` is ``EMAIL`` and ``path`` is the address it was delivered to.
    """

    id: str
    endpoint_id: str
    method: str
    path: str
    headers: dict[str, str]
    body: str | None
    query_params: dict[str, str]
    ip: str
    size: int
    received_at: int
    content_type: str | None = None
    body_raw: str | None = None
    """The body's exact bytes, base64-encoded, when they are not valid UTF-8."""
    signature_verified: bool | None = None
    signature_error: str | None = None
    signing_provider: str | None = None
    kind: RequestKind | None = None
    email: EmailCapture | None = None
    extracts: EmailExtracts | None = None
    """Codes and links found in an email.

    Set on emails read through this client, unless the endpoint's "Show codes
    and links found in emails" setting is off.
    """
    email_fields: dict[str, str | None] | None = None
    """The endpoint's named fields (see :class:`EmailField`), by name: the text each
    pattern found, or ``None`` when it found nothing. ``None`` when the endpoint has
    none. Set on emails read through this client."""
    reply_text: str | None = None
    """The new text of a reply, without the quoted message and the signature; ``None``
    when the email quotes no earlier message. Set on emails read through this client."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Request:
        kind = data.get("kind")
        verified = data.get("signatureVerified")
        email = data.get("email")
        extracts = data.get("extracts")
        fields = data.get("emailFields")
        request_id = data.get("id")
        if not isinstance(request_id, str):
            legacy_id = data.get("_id")
            request_id = legacy_id if isinstance(legacy_id, str) else ""
        return cls(
            id=request_id,
            endpoint_id=str(data.get("endpointId") or ""),
            method=str(data.get("method") or ""),
            path=data["path"] if isinstance(data.get("path"), str) else "/",
            headers=_str_map(data.get("headers")),
            body=_str_or_none(data.get("body")),
            query_params=_str_map(data.get("queryParams")),
            ip=data["ip"] if isinstance(data.get("ip"), str) else "unknown",
            size=int(_number(data.get("size"))),
            received_at=int(_number(data.get("receivedAt"))),
            content_type=_str_or_none(data.get("contentType")),
            body_raw=_str_or_none(data.get("bodyRaw")),
            signature_verified=verified if isinstance(verified, bool) else None,
            signature_error=_str_or_none(data.get("signatureError")),
            signing_provider=_str_or_none(data.get("signingProvider")),
            kind=kind if kind in ("http", "email") else None,
            email=EmailCapture.from_dict(email) if isinstance(email, Mapping) else None,
            extracts=EmailExtracts.from_dict(extracts) if isinstance(extracts, Mapping) else None,
            email_fields={str(key): _str_or_none(value) for key, value in fields.items()}
            if isinstance(fields, Mapping)
            else None,
            reply_text=_str_or_none(data.get("replyText")),
            raw=dict(data),
        )

    def header(self, name: str) -> str | None:
        """A header's value, looked up in any case."""
        lower = name.lower()
        for key, value in self.headers.items():
            if key.lower() == lower:
                return value
        return None

    def json(self) -> Any:
        """The body parsed as JSON, or ``None`` when it is missing or not JSON."""
        if not self.body:
            return None
        try:
            return json.loads(self.body)
        except ValueError:
            return None

    @property
    def is_email(self) -> bool:
        """A captured email, whether or not it carries its parsed message."""
        return self.kind == "email" or (
            self.kind is None and self.method == "EMAIL" and not self.path.startswith("/")
        )


@dataclass(frozen=True)
class TeamShare:
    team_id: str
    team_name: str

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TeamShare:
        return cls(team_id=str(data.get("teamId") or ""), team_name=str(data.get("teamName") or ""))


@dataclass(frozen=True)
class Endpoint:
    """A webhook endpoint. Captures at ``url``; receives email at ``email_address``."""

    id: str
    slug: str
    created_at: int
    name: str | None = None
    url: str | None = None
    email_address: str | None = None
    is_ephemeral: bool = False
    expires_at: int | None = None
    notification_url: str | None = None
    mock_response: dict[str, Any] | None = None
    """What the endpoint answers instead of a plain 200 OK: ``status``, ``body``,
    ``headers`` and ``delay`` (milliseconds). The body and header values may hold
    ``{{ placeholders }}`` the receiver fills in from the request, such as
    ``{{ json.id }}``; see https://webhooks.cc/docs/mock-responses#placeholders."""
    response_rules: list[dict[str, Any]] | None = None
    """Ordered rules, first match wins: ``conditions`` (``logic`` ``"and"`` or
    ``"or"``) and the ``response`` to send. See :meth:`Endpoints.create
    <webhooks_cc.client.Endpoints.create>` for the conditions."""
    signing_provider: str | None = None
    has_signing_secret: bool = False
    show_email_extracts: bool | None = None
    email_fields: list[EmailField] | None = None
    """The named fields picked out of every email the endpoint captures (owner only)."""
    forward_enabled: bool | None = None
    forward_url: str | None = None
    shared_with: list[TeamShare] = field(default_factory=list)
    from_teams: list[TeamShare] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Endpoint:
        mock = data.get("mockResponse")
        rules = data.get("responseRules")
        email_fields = data.get("emailFields")
        shared = data.get("sharedWith")
        from_teams = data.get("fromTeams")
        if not isinstance(from_teams, list) and isinstance(data.get("fromTeam"), Mapping):
            from_teams = [data["fromTeam"]]
        return cls(
            id=str(data.get("id") or ""),
            slug=str(data.get("slug") or ""),
            created_at=int(_number(data.get("createdAt"))),
            name=_str_or_none(data.get("name")),
            url=_str_or_none(data.get("url")),
            email_address=_str_or_none(data.get("emailAddress")),
            is_ephemeral=data.get("isEphemeral") is True,
            expires_at=_int_or_none(data.get("expiresAt")),
            notification_url=_str_or_none(data.get("notificationUrl")),
            mock_response=dict(mock) if isinstance(mock, Mapping) else None,
            response_rules=[dict(rule) for rule in rules if isinstance(rule, Mapping)]
            if isinstance(rules, list)
            else None,
            signing_provider=_str_or_none(data.get("signingProvider")),
            has_signing_secret=data.get("hasSigningSecret") is True,
            show_email_extracts=data.get("showEmailExtracts")
            if isinstance(data.get("showEmailExtracts"), bool)
            else None,
            email_fields=[
                EmailField.from_dict(item) for item in email_fields if isinstance(item, Mapping)
            ]
            if isinstance(email_fields, list)
            else None,
            forward_enabled=data.get("forwardEnabled")
            if isinstance(data.get("forwardEnabled"), bool)
            else None,
            forward_url=_str_or_none(data.get("forwardUrl")),
            shared_with=[TeamShare.from_dict(item) for item in shared if isinstance(item, Mapping)]
            if isinstance(shared, list)
            else [],
            from_teams=[
                TeamShare.from_dict(item) for item in from_teams if isinstance(item, Mapping)
            ]
            if isinstance(from_teams, list)
            else [],
            raw=dict(data),
        )


@dataclass(frozen=True)
class PreviewRule:
    """The response rule that answers a preview."""

    index: int
    """Its position in the rules, from 0."""
    name: str | None


@dataclass(frozen=True)
class PreviewedResponse:
    """A response as the receiver would send it, placeholders filled in."""

    status: int
    headers: dict[str, str]
    body: str
    delay: int
    """Milliseconds the receiver waits before answering."""


@dataclass(frozen=True)
class PreviewRequest:
    """The request a preview ran against."""

    id: str | None
    """``None`` when no request was captured yet and a sample was used."""
    method: str
    path: str
    received_at: int
    """Milliseconds since the epoch."""
    sample: bool
    """No request was captured yet, so a sample was used."""


@dataclass(frozen=True)
class ResponsePreview:
    """What ``endpoints.preview_response()`` reports: what a sender would get back."""

    rule: PreviewRule | None
    """The rule that answers, or ``None`` when the default response does."""
    response: PreviewedResponse | None
    """The response with its placeholders filled in; ``None`` means the receiver's
    plain 200 OK."""
    unknown_placeholders: list[str]
    """Placeholders the request has no field for; they are sent as written."""
    email: bool
    """The request is an email: emails get a standard mail-server reply, never a
    mock response."""
    request: PreviewRequest
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ResponsePreview:
        rule = data.get("rule")
        response = data.get("response")
        request = data.get("request")
        if not isinstance(request, Mapping):
            request = {}
        placeholders = data.get("unknownPlaceholders")
        return cls(
            rule=PreviewRule(
                index=int(_number(rule.get("index"))), name=_str_or_none(rule.get("name"))
            )
            if isinstance(rule, Mapping)
            else None,
            response=PreviewedResponse(
                status=int(_number(response.get("status"))),
                headers=_str_map(response.get("headers")),
                body=_str_or_none(response.get("body")) or "",
                delay=int(_number(response.get("delay"))),
            )
            if isinstance(response, Mapping)
            else None,
            unknown_placeholders=[item for item in placeholders if isinstance(item, str)]
            if isinstance(placeholders, list)
            else [],
            email=data.get("email") is True,
            request=PreviewRequest(
                id=_str_or_none(request.get("id")),
                method=str(request.get("method") or ""),
                path=str(request.get("path") or ""),
                received_at=int(_number(request.get("receivedAt"))),
                sample=request.get("sample") is True,
            ),
            raw=dict(data),
        )


@dataclass(frozen=True)
class DestinationFilter:
    """Which captured requests a destination gets: its conditions, all of them or any.

    The conditions are dicts like those of response rules (see
    :meth:`Endpoints.create <webhooks_cc.client.Endpoints.create>`), and may also
    read ``kind`` (``eq``, ``neq``: ``"http"`` or ``"email"``), ``email`` (with
    ``name`` ``subject``, ``from``, ``to``, ``text`` or ``tag``), ``spam_score``
    (a number), ``email_auth`` (with ``name`` ``spf``, ``dkim`` or ``dmarc``:
    ``eq``, ``neq``) and ``signature`` (``eq``, ``neq``: ``"verified"``,
    ``"failed"`` or ``"missing"``).
    """

    conditions: list[dict[str, Any]]
    logic: Literal["and", "or"] = "and"

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> DestinationFilter:
        conditions = data.get("conditions")
        return cls(
            conditions=[dict(item) for item in conditions if isinstance(item, Mapping)]
            if isinstance(conditions, list)
            else [],
            logic="or" if data.get("logic") == "or" else "and",
        )


@dataclass(frozen=True)
class DestinationHeader:
    """One of a destination's own headers. Values are masked when read."""

    name: str
    value: str


@dataclass(frozen=True)
class DeliveryCounts:
    delivered: int
    failed: int
    skipped: int
    """Turned down by the destination's filter."""


@dataclass(frozen=True)
class DestinationSummary:
    """A destination's deliveries of the last 24 hours, and what is waiting now."""

    last_24h: DeliveryCounts
    pending: int


@dataclass(frozen=True)
class Destination:
    """Where an endpoint's captures go. An endpoint has up to 10.

    Every capture is queued once for each destination that is on and takes its
    kind, and the destination's ``filter`` decides whether it is sent.
    """

    id: str
    position: int
    """Its place in the list, also the order captures are queued in."""
    name: str | None
    enabled: bool
    url: str
    has_secret: bool
    """Whether it has a signing secret; ``destinations.secret()`` reveals it."""
    http: bool
    """Takes HTTP requests."""
    email: bool
    """Takes emails."""
    format: str
    """``"auto"``, ``"as_received"``, ``"json"``, ``"template"``, ``"chat"``, or an inbound
    mail provider's shape: ``"postmark"``, ``"sendgrid"``, ``"mailgun"`` or ``"cloudmailin"``."""
    filter: DestinationFilter | None
    """``None`` sends every capture of the kinds it takes."""
    body_template: Any
    """For format ``"template"``: the JSON body, with ``{{ placeholders }}`` filled in
    from each request."""
    message_template: str | None
    """For format ``"chat"``: the message text; ``None`` sends the standard message."""
    headers: list[DestinationHeader]
    append_path: bool
    """Adds the captured path to the URL, for requests sent as received."""
    retry_seconds: int
    """How long failed deliveries are retried: 86400, 3600 or 0 (one try)."""
    keep_order: bool
    """One delivery at a time, in capture order."""
    sent_field: str | None
    """A JSON body field with the sender's own timestamp."""
    throttle_seconds: int
    """At most one delivery every so many seconds (0: every capture); the rest are not sent."""
    delay_seconds: int
    """Seconds after the capture before the first try, like a callback."""
    role: str | None
    """``"forward"``: what the endpoint's ``forward_*`` settings stand for;
    ``"notify"``: its ``notification_url``."""
    created_at: int
    updated_at: int
    has_mailgun_signing_key: bool = False
    """For format ``"mailgun"``: whether a Mailgun signing key is saved. The key itself is
    never returned."""
    summary: DestinationSummary | None = None
    """Set by ``destinations.list(slug, summary=True)``."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Destination:
        filter_ = data.get("filter")
        headers = data.get("headers")
        summary = data.get("summary")
        role = data.get("role")
        return cls(
            id=str(data.get("id") or ""),
            position=int(_number(data.get("position"))),
            name=_str_or_none(data.get("name")),
            enabled=data.get("enabled") is True,
            url=str(data.get("url") or ""),
            has_secret=data.get("hasSecret") is True,
            http=data.get("http") is True,
            email=data.get("email") is True,
            format=str(data.get("format") or "auto"),
            filter=DestinationFilter.from_dict(filter_) if isinstance(filter_, Mapping) else None,
            body_template=data.get("bodyTemplate"),
            message_template=_str_or_none(data.get("messageTemplate")),
            headers=[
                DestinationHeader(name=item["name"], value=str(item.get("value") or ""))
                for item in headers
                if isinstance(item, Mapping) and isinstance(item.get("name"), str)
            ]
            if isinstance(headers, list)
            else [],
            append_path=data.get("appendPath") is True,
            retry_seconds=int(_number(data.get("retrySeconds"))),
            keep_order=data.get("keepOrder") is True,
            sent_field=_str_or_none(data.get("sentField")),
            throttle_seconds=int(_number(data.get("throttleSeconds"))),
            delay_seconds=int(_number(data.get("delaySeconds"))),
            role=role if role in ("forward", "notify") else None,
            created_at=int(_number(data.get("createdAt"))),
            updated_at=int(_number(data.get("updatedAt"))),
            has_mailgun_signing_key=data.get("hasMailgunSigningKey") is True,
            summary=_destination_summary(summary) if isinstance(summary, Mapping) else None,
            raw=dict(data),
        )


def _destination_summary(data: Mapping[str, Any]) -> DestinationSummary:
    counts = data.get("last24h")
    if not isinstance(counts, Mapping):
        counts = {}
    return DestinationSummary(
        last_24h=DeliveryCounts(
            delivered=int(_number(counts.get("delivered"))),
            failed=int(_number(counts.get("failed"))),
            skipped=int(_number(counts.get("skipped"))),
        ),
        pending=int(_number(data.get("pending"))),
    )


@dataclass(frozen=True)
class DestinationRequest:
    """The captured request a destination preview or test delivery used."""

    id: str | None
    """``None`` when nothing of the kind was captured yet and a sample was used."""
    kind: RequestKind | None
    method: str
    path: str
    subject: str | None
    """The email's subject, for emails."""
    received_at: int
    sample: bool

    @classmethod
    def from_dict(cls, data: Mapping[str, Any], outer: Mapping[str, Any]) -> DestinationRequest:
        """``outer`` is the result holding it, which carries ``kind`` and ``sample``
        for a test delivery."""
        kind = data.get("kind", outer.get("kind"))
        sample = data.get("sample", outer.get("sample"))
        return cls(
            id=_str_or_none(data.get("id")),
            kind=kind if kind in ("http", "email") else None,
            method=str(data.get("method") or ""),
            path=str(data.get("path") or ""),
            subject=_str_or_none(data.get("subject")),
            received_at=int(_number(data.get("receivedAt"))),
            sample=sample is True,
        )


@dataclass(frozen=True)
class PreviewedDelivery:
    """The request a destination would send. Header values it stores stay masked."""

    method: str
    url: str
    headers: dict[str, str]
    body: str | None
    """The body as text; ``None`` when there is none or it is not UTF-8."""
    body_base64: str | None
    """The body's bytes, base64-encoded, when they are not UTF-8."""


@dataclass(frozen=True)
class DestinationPreview:
    """What ``destinations.preview()`` reports: what a destination would send, unsent."""

    request: DestinationRequest
    takes_kind: bool
    """Whether the destination takes this kind of request at all."""
    filter_passes: bool
    """Whether its filter lets the request through."""
    format: str
    """How it would go out: ``"as_received"``, ``"json"``, ``"template"`` or ``"chat"``."""
    delivery: PreviewedDelivery | None
    """``None`` when nothing would be sent; ``error`` says why."""
    error: str | None
    """Why nothing would be sent, such as a template that cannot be filled in."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> DestinationPreview:
        request = data.get("request")
        delivery = data.get("delivery")
        return cls(
            request=DestinationRequest.from_dict(
                request if isinstance(request, Mapping) else {}, {}
            ),
            takes_kind=data.get("takesKind") is True,
            filter_passes=data.get("filterPasses") is True,
            format=str(data.get("format") or ""),
            delivery=PreviewedDelivery(
                method=str(delivery.get("method") or ""),
                url=str(delivery.get("url") or ""),
                headers=_str_map(delivery.get("headers")),
                body=_str_or_none(delivery.get("body")),
                body_base64=_str_or_none(delivery.get("bodyBase64")),
            )
            if isinstance(delivery, Mapping)
            else None,
            error=_str_or_none(data.get("error")),
            raw=dict(data),
        )


@dataclass(frozen=True)
class SenderTime:
    """The sender's own timestamp, as read from a request."""

    at: int
    """Milliseconds since the epoch."""
    source: str
    """Where it was read: the body field, or a header such as ``webhook-timestamp``."""
    whole_seconds: bool
    """The timestamp has whole seconds only."""


@dataclass(frozen=True)
class DestinationTestResult:
    """What ``destinations.test()`` reports: one delivery, sent now, and its answer."""

    status: int | None
    """The HTTP status the URL answered, or ``None`` when no answer arrived."""
    duration_ms: int
    excerpt: str | None
    """The start of the response body."""
    error: str | None
    """Why no answer arrived (a timeout, a refused connection, a TLS problem)."""
    delivered: bool
    """The URL answered with a 2xx status."""
    sample: bool
    """Nothing of the kind was captured yet, so a sample was sent."""
    filter_passes: bool
    """Whether the destination's filter would have let it through; a test sends either way."""
    kind: RequestKind | None
    format: str | None
    url: str | None
    """The URL it went to, path appended."""
    target: str | None
    """Host and path, as the delivery log records them."""
    request: DestinationRequest | None
    sender: SenderTime | None
    """The sender's own timestamp, when the request had one."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> DestinationTestResult:
        kind = data.get("kind")
        request = data.get("request")
        sender = data.get("sender")
        return cls(
            status=_int_or_none(data.get("status")),
            duration_ms=int(_number(data.get("durationMs"))),
            excerpt=_str_or_none(data.get("excerpt")),
            error=_str_or_none(data.get("error")),
            delivered=data.get("delivered") is True,
            sample=data.get("sample") is True,
            filter_passes=data.get("filterPasses") is True,
            kind=kind if kind in ("http", "email") else None,
            format=_str_or_none(data.get("format")),
            url=_str_or_none(data.get("url")),
            target=_str_or_none(data.get("target")),
            request=DestinationRequest.from_dict(request, data)
            if isinstance(request, Mapping)
            else None,
            sender=SenderTime(
                at=int(_number(sender.get("at"))),
                source=str(sender.get("source") or ""),
                whole_seconds=sender.get("wholeSeconds") is True,
            )
            if isinstance(sender, Mapping)
            else None,
            raw=dict(data),
        )


@dataclass(frozen=True)
class UsageInfo:
    used: int
    limit: int
    remaining: int
    plan: str
    period_end: int | None
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> UsageInfo:
        return cls(
            used=int(_number(data.get("used"))),
            limit=int(_number(data.get("limit"))),
            remaining=int(_number(data.get("remaining"))),
            plan=str(data.get("plan") or ""),
            period_end=_int_or_none(data.get("periodEnd")),
            raw=dict(data),
        )


@dataclass(frozen=True)
class RequestPage:
    """One page of ``requests.list_paginated()``; pass ``cursor`` to get the next."""

    items: list[Request]
    cursor: str | None
    has_more: bool


@dataclass(frozen=True)
class SendTestEmailResult:
    """The sample email ``emails.send_test()`` delivered."""

    status: str
    request_id: str | None
    """ID of the captured email (``None`` when the server could not tell)."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)


@dataclass(frozen=True)
class RenderedEmail:
    """A captured email in an inbound provider's shape, as ``emails.render()`` returns it:
    post ``body`` with ``headers`` to the handler you wrote for that provider."""

    format: str
    """``"json"``, or the provider: ``"postmark"``, ``"sendgrid"``, ``"mailgun"`` or
    ``"cloudmailin"``."""
    method: str
    """Always ``"POST"``."""
    headers: dict[str, str]
    """The ``content-type`` and ``user-agent`` to send it with."""
    body: str
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> RenderedEmail:
        return cls(
            format=str(data.get("format") or ""),
            method=str(data.get("method") or "POST"),
            headers=_str_map(data.get("headers")),
            body=_str_or_none(data.get("body")) or "",
            raw=dict(data),
        )


@dataclass(frozen=True)
class BuiltRequest:
    """A request built but not sent: what ``send_to()`` would send."""

    method: str
    url: str
    headers: dict[str, str]
    body: str | bytes | None
