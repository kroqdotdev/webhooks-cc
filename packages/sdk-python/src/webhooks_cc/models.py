"""Typed views of what the webhooks.cc API returns.

Every model keeps the JSON it was built from in ``raw``, so fields this
version of the SDK does not know yet stay reachable.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

RequestKind = Literal["http", "email"]


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
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Request:
        kind = data.get("kind")
        verified = data.get("signatureVerified")
        email = data.get("email")
        extracts = data.get("extracts")
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
    forward_enabled: bool | None = None
    forward_url: str | None = None
    shared_with: list[TeamShare] = field(default_factory=list)
    from_teams: list[TeamShare] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Endpoint:
        mock = data.get("mockResponse")
        rules = data.get("responseRules")
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
class BuiltRequest:
    """A request built but not sent: what ``send_to()`` would send."""

    method: str
    url: str
    headers: dict[str, str]
    body: str | bytes | None
