"""Typed views of what the webhooks.cc API returns.

Every model keeps the JSON it was built from in ``raw``, so fields this
version of the SDK does not know yet stay reachable.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from typing import Any, Literal, cast

RequestKind = Literal["http", "email"]

EndpointSite = Literal["webhooks", "mailhooks", "both"]
"""Which site's dashboard lists an endpoint. Only the listing: every endpoint
keeps its HTTP URL and email address and captures both."""

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
    "sheets",
    "file_drop",
]
"""How a destination sends. ``"auto"`` picks from the URL: a chat message for Slack and
Discord, otherwise HTTP requests as received and emails as signed JSON. The
:data:`InboundEmailFormat` shapes apply to emails; HTTP requests to such a destination go
as received. ``"sheets"`` (rows in a Google Sheet) and ``"file_drop"`` (files on an SFTP,
FTP or S3 server, Business) are set up in the dashboard."""

EmailFieldSource = Literal["subject", "text", "html", "from", "to", "header"]
"""The part of an email a named field reads: ``"html"`` is the HTML as text, ``"to"`` the
To and Cc addresses, and ``"header"`` the header named in ``header``."""

DestinationAttachments = Literal["links", "inline", "none"]
"""How a destination's deliveries carry the attachments of emails kept in storage:
``"links"`` (the default) gives each attachment a ``url``, a signed link that downloads it
while the email is kept; ``"inline"`` sends each one's ``content`` as base64 while a
delivery's attachments add up to 1 MB (larger ones get a ``url``); ``"none"`` sends names,
types and sizes only."""

LineItemSource = Literal["text", "html", "attachment"]
"""Where a layout's line items come from."""


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
    url: str | None = None
    """A signed download link, in deliveries whose destination sends links."""
    content: str | None = None
    """The contents, base64-encoded, in deliveries whose destination sends them inline."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> EmailAttachment:
        return cls(
            filename=_str_or_none(data.get("filename")),
            content_type=str(data.get("contentType") or "application/octet-stream"),
            size=int(_number(data.get("size"))),
            content_id=_str_or_none(data.get("contentId")),
            inline=data.get("inline") is True,
            url=_str_or_none(data.get("url")),
            content=_str_or_none(data.get("content")),
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
    stored: bool = False
    """The exact message and the attachments' contents are kept: download them with
    ``requests.raw()`` and ``requests.attachment()``."""
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
            stored=data.get("stored") is True,
            raw=dict(data),
        )


@dataclass(frozen=True)
class ParsedSheet:
    """One sheet of a parsed spreadsheet."""

    name: str | None
    rows: list[list[str]]
    """The first 1,000 rows, each a list of cell texts."""
    row_count: int
    """How many rows the sheet has, those past the first 1,000 included."""
    truncated: bool

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ParsedSheet:
        rows = data.get("rows")
        return cls(
            name=_str_or_none(data.get("name")),
            rows=[
                [cell if isinstance(cell, str) else "" for cell in row]
                for row in rows
                if isinstance(row, list)
            ]
            if isinstance(rows, list)
            else [],
            row_count=int(_number(data.get("rowCount"))),
            truncated=data.get("truncated") is True,
        )


@dataclass(frozen=True)
class ParsedAttachment:
    """One attachment a layout parsed: its sheets' rows or its text, and the pages it used."""

    index: int
    filename: str | None
    format: str
    """``csv``, ``tsv``, ``xlsx``, ``xls``, ``ods``, ``pdf`` or ``text``."""
    pages: int
    """Billable pages this parse used (0 when an earlier parse was read again)."""
    sheets: list[ParsedSheet] | None
    """For spreadsheets: each sheet's name, its first 1,000 rows and its row count."""
    text: str | None
    """For PDFs and text: the text, cut at 256 KB."""
    truncated: bool
    """Stopped at the per-file page cap."""
    error: str | None
    """Why it was not parsed: ``limit`` (no pages left), ``not_kept`` (the email's
    attachments were not stored), ``not_parsed`` (a preview, which never parses),
    ``too_large``, ``malformed``, ``encrypted``, ``zip_bomb`` or ``empty``."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ParsedAttachment:
        sheets = data.get("sheets")
        return cls(
            index=int(_number(data.get("index"))),
            filename=_str_or_none(data.get("filename")),
            format=str(data.get("format") or ""),
            pages=int(_number(data.get("pages"))),
            sheets=[ParsedSheet.from_dict(sheet) for sheet in sheets if isinstance(sheet, Mapping)]
            if isinstance(sheets, list)
            else None,
            text=_str_or_none(data.get("text")),
            truncated=data.get("truncated") is True,
            error=_str_or_none(data.get("error")),
        )


@dataclass(frozen=True)
class ParsedEmail:
    """What an endpoint's layouts found in an email: ``parsed`` in its JSON.

    Layouts run only on webhooks.cc's servers, so this SDK reads the result and
    never parses itself. To read it from an email forwarded to you, pass
    ``event["data"]["parsed"]`` of :func:`~webhooks_cc.verify.verify_forwarded_email`
    to :meth:`from_dict`.
    """

    status: Literal["matched", "no_layout"]
    """``no_layout`` when no layout's conditions held (a parse failure)."""
    layout: dict[str, str] | None
    """The layout that applied: its ``id`` and ``name``."""
    fields: dict[str, str | None]
    line_items: list[dict[str, str | None]]
    line_item_columns: list[str]
    """The line items' columns in order."""
    attachments: list[ParsedAttachment]
    pages: int
    """Pages this email used."""
    truncated: bool = False
    """The result was cut to fit the email's JSON (about 1 MB): attachments' rows and
    text, then line items from the end. The full parse is kept."""
    partial: bool = False
    """Read from a request list, which leaves out line items and attachments; get the
    request (``requests.get()``) for all of it."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ParsedEmail:
        layout = data.get("layout")
        fields = data.get("fields")
        items = data.get("lineItems")
        columns = data.get("lineItemColumns")
        attachments = data.get("attachments")
        return cls(
            status="matched" if data.get("status") == "matched" else "no_layout",
            layout={str(key): str(value) for key, value in layout.items()}
            if isinstance(layout, Mapping)
            else None,
            fields={str(key): _str_or_none(value) for key, value in fields.items()}
            if isinstance(fields, Mapping)
            else {},
            line_items=[
                {str(key): _str_or_none(value) for key, value in item.items()}
                for item in items
                if isinstance(item, Mapping)
            ]
            if isinstance(items, list)
            else [],
            line_item_columns=[column for column in columns if isinstance(column, str)]
            if isinstance(columns, list)
            else [],
            attachments=[
                ParsedAttachment.from_dict(item)
                for item in attachments
                if isinstance(item, Mapping)
            ]
            if isinstance(attachments, list)
            else [],
            pages=int(_number(data.get("pages"))),
            truncated=data.get("truncated") is True,
            partial=data.get("partial") is True,
        )


@dataclass(frozen=True)
class LayoutsPreview:
    """What ``endpoints.preview_layouts()`` reports. No pages are used."""

    problems: list[str]
    """What is wrong with the layouts tried, if any."""
    layouts_cap: int
    request_id: str | None
    """The email it ran on; ``None`` when the endpoint has none yet."""
    parsed: ParsedEmail | None
    request_subject: str | None = None
    """The subject of the email it ran on."""
    request_received_at: int | None = None
    """When the email it ran on arrived, in ms since the epoch."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> LayoutsPreview:
        problems = data.get("problems")
        request = data.get("request")
        if not isinstance(request, Mapping):
            request = {}
        parsed = data.get("parsed")
        return cls(
            problems=[item for item in problems if isinstance(item, str)]
            if isinstance(problems, list)
            else [],
            layouts_cap=int(_number(data.get("layoutsCap"))),
            request_id=_str_or_none(request.get("id")),
            parsed=ParsedEmail.from_dict(parsed) if isinstance(parsed, Mapping) else None,
            request_subject=_str_or_none(request.get("subject")),
            request_received_at=_int_or_none(request.get("receivedAt")),
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
class LineItemColumn:
    """A spreadsheet column a layout keeps, as one field of each line item."""

    name: str
    """The line item field's name: letters, digits and ``_``."""
    column: str
    """The header's text (any case) or a column letter (``A``, ``B``, ...)."""


@dataclass(frozen=True)
class LineItemsSpec:
    """Where a layout's line items come from.

    For ``from_="text"`` or ``"html"``, ``pattern`` is an RE2 pattern with named groups,
    found again and again; each match is one row whose columns are the groups, such as
    ``r"(?P<sku>[A-Z]+-\\d+)\\s+(?P<qty>\\d+)"``. ``start`` and ``end`` limit the search
    to the text after the first match of ``start`` and before the first match of ``end``
    after it. For ``from_="attachment"``, ``attachment`` picks the file by name (``*`` and
    ``?`` wildcards, any case; the first parsed spreadsheet or CSV when ``None``),
    ``sheet`` the sheet by name (the first when ``None``), and ``columns`` the columns to
    keep (every column, by its header, when ``None``).
    """

    from_: LineItemSource
    pattern: str | None = None
    start: str | None = None
    end: str | None = None
    attachment: str | None = None
    sheet: str | None = None
    columns: list[LineItemColumn] | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> LineItemsSpec:
        source = data.get("from")
        columns = data.get("columns")
        return cls(
            from_=cast(LineItemSource, source if isinstance(source, str) else ""),
            pattern=_str_or_none(data.get("pattern")),
            start=_str_or_none(data.get("start")),
            end=_str_or_none(data.get("end")),
            attachment=_str_or_none(data.get("attachment")),
            sheet=_str_or_none(data.get("sheet")),
            columns=[
                LineItemColumn(
                    name=str(item.get("name") or ""), column=str(item.get("column") or "")
                )
                for item in columns
                if isinstance(item, Mapping)
            ]
            if isinstance(columns, list)
            else None,
        )

    def to_dict(self) -> dict[str, Any]:
        """The spec as the API takes it."""
        out: dict[str, Any] = {"from": self.from_}
        for key in ("pattern", "start", "end", "attachment", "sheet"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        if self.columns is not None:
            out["columns"] = [{"name": item.name, "column": item.column} for item in self.columns]
        return out


@dataclass(frozen=True)
class Layout:
    """How an endpoint reads the emails of one sender or kind.

    An endpoint has an ordered list; the first enabled layout whose ``match`` holds is
    the email's layout, and its fields, line items and attachment parsing apply. Layouts
    run only on webhooks.cc's servers (RE2, the sandboxed attachment parser), so this SDK
    describes them and reads their results (:class:`ParsedEmail`); it never parses. The
    server checks a list when it is saved. See https://webhooks.cc/docs/layouts.
    """

    id: str
    """1 to 40 letters, digits, ``-`` or ``_``; how alerts and the API refer to it."""
    name: str
    enabled: bool | None = None
    """``None`` means on; a layout that is off is kept but never matched."""
    match: DestinationFilter | None = None
    """When it applies, in the rule language of destination filters (the email's
    ``subject``, ``from``, ``to``, ``text`` and ``tag``, headers, ``email_auth``,
    ``spam_score``); ``None`` or no conditions: every email."""
    fields: list[EmailField] | None = None
    """Named values, as an endpoint's email fields."""
    line_items: LineItemsSpec | None = None
    parse_attachments: bool = False
    """Parse its attachments (CSV, TSV, XLSX, XLS, ODS, PDF text, plain text); each parsed
    page is metered."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Layout:
        enabled = data.get("enabled")
        match = data.get("match")
        layout_fields = data.get("fields")
        line_items = data.get("lineItems")
        return cls(
            id=str(data.get("id") or ""),
            name=str(data.get("name") or ""),
            enabled=enabled if isinstance(enabled, bool) else None,
            match=DestinationFilter.from_dict(match) if isinstance(match, Mapping) else None,
            fields=[
                EmailField.from_dict(item) for item in layout_fields if isinstance(item, Mapping)
            ]
            if isinstance(layout_fields, list)
            else None,
            line_items=LineItemsSpec.from_dict(line_items)
            if isinstance(line_items, Mapping)
            else None,
            parse_attachments=data.get("parseAttachments") is True,
        )

    def to_dict(self) -> dict[str, Any]:
        """The layout as the API takes it."""
        out: dict[str, Any] = {"id": self.id, "name": self.name}
        if self.enabled is not None:
            out["enabled"] = self.enabled
        if self.match is not None:
            out["match"] = {
                "logic": self.match.logic,
                "conditions": [dict(item) for item in self.match.conditions],
            }
        if self.fields is not None:
            out["fields"] = [item.to_dict() for item in self.fields]
        if self.line_items is not None:
            out["lineItems"] = self.line_items.to_dict()
        if self.parse_attachments:
            out["parseAttachments"] = True
        return out


@dataclass(frozen=True)
class LiveResponse:
    """The answer a local app gave a request relayed through ``whk tunnel --live``.

    The sender got this answer instead of the endpoint's mock response.
    ``body`` holds the start of the body (up to 64 KB), base64-encoded when
    ``body_encoding`` is ``"base64"``.
    """

    status: int | None
    headers: dict[str, str]
    body: str
    body_truncated: bool
    body_encoding: str
    ms: int | None
    #: ``"answered"``, or what the sender got instead: ``"offline"`` (502),
    #: ``"timeout"`` (504), ``"unreachable"`` (502), ``"busy"`` (503) or
    #: ``"refused"``: the answer was not passed back as it was. 400 when the
    #: path left the endpoint; 502 when the answer was refused (a download, a
    #: script or another type an API does not answer with, or a stated size
    #: over 1 MB); or the app's own status when the answer streamed past
    #: 1 MB and was cut off, so the sender got a broken stream.
    outcome: str = "answered"

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> LiveResponse:
        encoding = data.get("bodyEncoding")
        return cls(
            status=None if data.get("status") is None else int(_number(data.get("status"))),
            headers=_str_map(data.get("headers")),
            body=data["body"] if isinstance(data.get("body"), str) else "",
            body_truncated=data.get("bodyTruncated") is True,
            body_encoding=encoding if encoding in ("utf8", "base64") else "utf8",
            ms=None if data.get("ms") is None else int(_number(data.get("ms"))),
            outcome=data["outcome"] if isinstance(data.get("outcome"), str) else "answered",
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
    email_fields: dict[str, str | None] | None = None
    """The endpoint's named fields (see :class:`EmailField`), by name: the text each
    pattern found, or ``None`` when it found nothing. ``None`` when the endpoint has
    none. Set on emails read through this client."""
    reply_text: str | None = None
    """The new text of a reply, without the quoted message and the signature; ``None``
    when the email quotes no earlier message. Set on emails read through this client."""
    parsed: ParsedEmail | None = None
    """What the endpoint's layouts found, once the parse is done (emails on endpoints
    with layouts)."""
    live_response: LiveResponse | None = None
    """What the local app answered, for a request captured while ``whk tunnel --live``
    ran."""
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
            parsed=ParsedEmail.from_dict(data["parsed"])
            if isinstance(data.get("parsed"), Mapping)
            else None,
            live_response=LiveResponse.from_dict(data["liveResponse"])
            if isinstance(data.get("liveResponse"), Mapping)
            else None,
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
    site: EndpointSite | None = None
    """Which site's dashboard lists it: ``"webhooks"``, ``"mailhooks"`` or ``"both"``."""
    favorite: bool | None = None
    """Whether you marked it as a favourite: your own choice, not the endpoint's. Set
    by :meth:`Endpoints.list <webhooks_cc.client.Endpoints.list>` and :meth:`Endpoints.get
    <webhooks_cc.client.Endpoints.get>`; ``None`` where the response leaves it out
    (create and update)."""
    email_fields: list[EmailField] | None = None
    """The named fields picked out of every email the endpoint captures (owner only)."""
    retention_days: int | None = None
    """Days requests are kept here; ``None`` keeps them as long as the plan does."""
    retention_cap_days: int | None = None
    """The longest retention this endpoint may have: its plan's (owner only)."""
    delete_after_delivery: bool | None = None
    """Requests are deleted once every delivery is settled (owner only)."""
    layouts: list[Layout] | None = None
    """How the endpoint reads its emails; the first enabled one whose ``match`` holds
    applies (owner only)."""
    layouts_cap: int | None = None
    """Layouts the plan uses; later ones are kept but not used (owner only)."""
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
            site=cast(EndpointSite, data["site"])
            if data.get("site") in ("webhooks", "mailhooks", "both")
            else None,
            favorite=data.get("favorite") if isinstance(data.get("favorite"), bool) else None,
            email_fields=[
                EmailField.from_dict(item) for item in email_fields if isinstance(item, Mapping)
            ]
            if isinstance(email_fields, list)
            else None,
            retention_days=_int_or_none(data.get("retentionDays")),
            retention_cap_days=_int_or_none(data.get("retentionCapDays")),
            delete_after_delivery=data.get("deleteAfterDelivery")
            if isinstance(data.get("deleteAfterDelivery"), bool)
            else None,
            layouts=[
                Layout.from_dict(item) for item in data["layouts"] if isinstance(item, Mapping)
            ]
            if isinstance(data.get("layouts"), list)
            else None,
            layouts_cap=_int_or_none(data.get("layoutsCap")),
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
class SandboxLimits:
    """An agent sandbox's limits, shared by its endpoints: ``max_endpoints`` live at
    once, ``request_limit`` captures per endpoint, and ``budget_used`` of
    ``budget_limit`` captures across them. ``expires_at`` is in ms since the epoch."""

    expires_at: int | None
    max_endpoints: int
    request_limit: int
    budget_used: int
    budget_limit: int
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> SandboxLimits:
        budget = data.get("budget")
        budget = budget if isinstance(budget, Mapping) else {}
        return cls(
            expires_at=_int_or_none(data.get("expiresAt")),
            max_endpoints=int(_number(data.get("maxEndpoints"), 3)),
            request_limit=int(_number(data.get("requestLimit"), 25)),
            budget_used=int(_number(budget.get("used"))),
            budget_limit=int(_number(budget.get("limit"), 100)),
            raw=dict(data),
        )


@dataclass(frozen=True)
class SandboxEndpoint(Endpoint):
    """An agent sandbox endpoint: capture only, living as long as its registration.
    ``request_count`` is what it captured so far."""

    request_count: int = 0
    sandbox: SandboxLimits | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> SandboxEndpoint:
        base = Endpoint.from_dict(data)
        limits = data.get("sandbox")
        return cls(
            **{item.name: getattr(base, item.name) for item in fields(Endpoint)},
            request_count=int(_number(data.get("requestCount"))),
            sandbox=SandboxLimits.from_dict(limits) if isinstance(limits, Mapping) else None,
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
    attachments: str = "links"
    """How its deliveries carry the attachments of emails kept in storage: ``"links"``,
    ``"inline"`` or ``"none"`` (see :data:`DestinationAttachments`)."""
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
            attachments=_str_or_none(data.get("attachments")) or "links",
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
class PageOverage:
    """Page overage this window, while ``active``."""

    active: bool
    used: int
    max: int


@dataclass(frozen=True)
class ParsedPagesUsage:
    """Attachment pages parsed by layouts in the account's page window."""

    used: int
    limit: int
    """The window's pages: the plan's plus monthly page blocks."""
    credit_pages: int
    """One-time pages left, used once ``limit`` is gone."""
    overage: PageOverage
    resets_at: str | None
    """When the window ends (ISO 8601); ``None`` until a monthly window's first parse."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ParsedPagesUsage:
        overage = data.get("overage")
        overage = overage if isinstance(overage, Mapping) else {}
        return cls(
            used=int(_number(data.get("used"))),
            limit=int(_number(data.get("limit"))),
            credit_pages=int(_number(data.get("creditPages"))),
            overage=PageOverage(
                active=overage.get("active") is True,
                used=int(_number(overage.get("used"))),
                max=int(_number(overage.get("max"))),
            ),
            resets_at=_str_or_none(data.get("resetsAt")),
        )


@dataclass(frozen=True)
class PreviewDataUsage:
    """What visitors downloaded from ``whk share`` previews this UTC month."""

    bytes: int
    limit_bytes: int
    over: bool
    """``True`` once the month's data is used: previews pause until ``resets_at``."""
    resets_at: str

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> PreviewDataUsage:
        return cls(
            bytes=int(_number(data.get("bytes"))),
            limit_bytes=int(_number(data.get("limitBytes"))),
            over=data.get("over") is True,
            resets_at=str(data.get("resetsAt") or ""),
        )


@dataclass(frozen=True)
class AiAssistsUsage:
    """AI assists counted over a rolling 30 days, on endpoints no team pays for."""

    used: int
    allowed: int
    next_at: str | None
    """When the next counted assist stops counting (ISO 8601); ``None`` when none is."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> AiAssistsUsage:
        return cls(
            used=int(_number(data.get("used"))),
            allowed=int(_number(data.get("allowed"))),
            next_at=_str_or_none(data.get("nextAt")),
        )


@dataclass(frozen=True)
class UsageInfo:
    used: int
    limit: int
    remaining: int
    plan: str
    period_end: int | None
    parsed_pages: ParsedPagesUsage | None = None
    """``None`` when it could not be read, or from a server that does not report it."""
    preview_data: PreviewDataUsage | None = None
    """``None`` where sharing is not offered."""
    ai_assists: AiAssistsUsage | None = None
    """``None`` where AI assists are not offered."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> UsageInfo:
        parsed_pages = data.get("parsedPages")
        preview_data = data.get("previewData")
        ai_assists = data.get("aiAssists")
        return cls(
            used=int(_number(data.get("used"))),
            limit=int(_number(data.get("limit"))),
            remaining=int(_number(data.get("remaining"))),
            plan=str(data.get("plan") or ""),
            period_end=_int_or_none(data.get("periodEnd")),
            parsed_pages=ParsedPagesUsage.from_dict(parsed_pages)
            if isinstance(parsed_pages, Mapping)
            else None,
            preview_data=PreviewDataUsage.from_dict(preview_data)
            if isinstance(preview_data, Mapping)
            else None,
            ai_assists=AiAssistsUsage.from_dict(ai_assists)
            if isinstance(ai_assists, Mapping)
            else None,
            raw=dict(data),
        )


@dataclass(frozen=True)
class RequestPage:
    """One page of ``requests.list_paginated()``; pass ``cursor`` to get the next."""

    items: list[Request]
    cursor: str | None
    has_more: bool


@dataclass(frozen=True)
class SearchPage:
    """One page of ``requests.search_page()``.

    A search reads requests one stretch of time after another and answers within
    about two seconds, so a page can be short or empty without being the end.
    """

    requests: list[Request]
    """The matches this page found. Each ``id`` is the request's own id, the one
    ``requests.get()`` and the other request calls take; ``raw["slug"]`` is its
    endpoint's slug (search results carry no ``endpoint_id``)."""
    complete: bool
    """Whether the whole range was read. When ``False``, older requests (newer ones
    with ``order="asc"``) were not searched yet: pass ``cursor`` to read on."""
    searched_until: int | None
    """How far the search read, in milliseconds since the epoch; ``None`` when the
    server did not say."""
    cursor: str | None
    """Continues the search with the same filters; ``None`` once it is complete.
    Opaque: pass it back as it is."""


@dataclass(frozen=True)
class CountPage:
    """One answer of ``requests.count_page()``."""

    count: int
    """The matches counted by this call."""
    exact: bool
    """Whether the whole range was counted. When ``False``, ``count`` covers only
    the requests back to ``searched_until``: pass ``cursor`` to count the next
    stretch and add the counts up."""
    searched_until: int | None
    """How far the count read, in milliseconds since the epoch; ``None`` when the
    server did not say."""
    cursor: str | None
    """Continues the count with the same filters; ``None`` once it is exact."""


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
class AttachmentDownload:
    """An attachment of a stored email, downloaded with ``requests.attachment()``."""

    content: bytes = field(repr=False)
    """The attachment's bytes, exactly as they were kept."""
    filename: str | None
    """The name the server gave the download (the attachment's own, or a stand-in such as
    ``attachment-1``); ``None`` when it named none."""
    content_type: str
    """The attachment's declared type when it is a plain media type, otherwise
    ``application/octet-stream``."""


@dataclass(frozen=True)
class BuiltRequest:
    """A request built but not sent: what ``send_to()`` would send."""

    method: str
    url: str
    headers: dict[str, str]
    body: str | bytes | None


# --- sharing: whk share previews and whk tunnel --live sessions -------------------------


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


@dataclass(frozen=True)
class TunnelPerson:
    """Who started a teammate's share, or reserved a name: ``id`` and ``email``."""

    id: str
    email: str

    @classmethod
    def from_value(cls, value: Any) -> TunnelPerson | None:
        if isinstance(value, Mapping):
            return cls(id=str(value.get("id") or ""), email=str(value.get("email") or ""))
        if isinstance(value, str) and value:
            return cls(id="", email=value)
        return None


@dataclass(frozen=True)
class TunnelShare:
    """A ``whk share`` preview, or a ``whk tunnel --live`` session (``kind`` ``"live"``).

    Times are ISO 8601 strings, as the API sends them.
    """

    id: str
    kind: Literal["share", "live"]
    name: str | None
    """The preview's name, or ``None`` for a live session."""
    url: str | None
    """The preview's link, or the capture URL for a live session."""
    endpoint_slug: str | None
    """The endpoint, for a live session."""
    client: str
    """What it runs on: ``"laptop, macOS"``."""
    started_at: str
    ended_at: str | None
    """``None`` while it runs."""
    end_reason: str | None
    """Why it ended, in words."""
    expires_at: str | None
    """When the plan's session time runs out, or ``None`` without a limit."""
    bytes: int
    """Bytes visitors moved through a preview, both ways (downloads and uploads,
    WebSockets included). Live tunnels count captures instead."""
    requests: int
    password: bool
    """Whether visitors need a password."""
    notice: bool
    """Whether visitors see a short notice before the page."""
    mine: bool
    """``False`` for a teammate's share under a team name, or a teammate's live
    tunnel on your endpoint."""
    started_by: TunnelPerson | None
    """Who started it, for a teammate's share."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelShare:
        return cls(
            id=str(data.get("id") or ""),
            kind="live" if data.get("kind") == "live" else "share",
            name=_str_or_none(data.get("name")),
            url=_str_or_none(data.get("url")),
            endpoint_slug=_str_or_none(data.get("endpointSlug")),
            client=str(data.get("client") or ""),
            started_at=str(data.get("startedAt") or ""),
            ended_at=_str_or_none(data.get("endedAt")),
            end_reason=_str_or_none(data.get("endReason")),
            expires_at=_str_or_none(data.get("expiresAt")),
            bytes=int(_number(data.get("bytes"))),
            requests=int(_number(data.get("requests"))),
            password=data.get("password") is True,
            notice=data.get("notice") is True,
            mine=data.get("mine") is not False,
            started_by=TunnelPerson.from_value(data.get("startedBy")),
            raw=dict(data),
        )


@dataclass(frozen=True)
class TunnelUsage:
    """This month's shared data (UTC month)."""

    month: str
    """``"2026-11"``."""
    bytes: int
    limit_bytes: int
    over: bool
    """``True`` once the month's data is used: previews pause until ``resets_at``."""
    resets_at: str
    message: str | None = None
    """Why previews are paused and when they open again, while ``over``."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelUsage:
        return cls(
            month=str(data.get("month") or ""),
            bytes=int(_number(data.get("bytes"))),
            limit_bytes=int(_number(data.get("limitBytes"))),
            over=data.get("over") is True,
            resets_at=str(data.get("resetsAt") or ""),
            message=_str_or_none(data.get("message")),
        )


@dataclass(frozen=True)
class TunnelLimits:
    """What the account's plan allows for sharing."""

    plan: str
    shares: int
    """Previews at once."""
    reserved_names: int
    session_minutes: int | None
    """Minutes a preview may run, or ``None`` without a limit."""
    data_gb: int
    """Data a month, in GB."""
    passwords: bool
    notice: bool
    """Whether visitors see a short notice before the page."""
    label: str | None = None
    """The plan as people read it: ``"Pro"``, ``"Team Business"``."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelLimits:
        return cls(
            plan=str(data.get("plan") or ""),
            shares=int(_number(data.get("shares"))),
            reserved_names=int(_number(data.get("reservedNames"))),
            session_minutes=_int_or_none(data.get("sessionMinutes")),
            data_gb=int(_number(data.get("dataGb"))),
            passwords=data.get("passwords") is True,
            notice=data.get("notice") is True,
            label=_str_or_none(data.get("label")),
        )


@dataclass(frozen=True)
class TunnelNamesSummary:
    """Where the account stands on reserved names."""

    limit: int
    """Your own names (outside teams) the plan allows."""
    used: int
    """Your own names."""
    usable: int
    """Names you may share under now, your own and your teams'."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelNamesSummary:
        return cls(
            limit=int(_number(data.get("limit"))),
            used=int(_number(data.get("used"))),
            usable=int(_number(data.get("usable"))),
        )


@dataclass(frozen=True)
class TunnelShareList:
    """``shares.list()``: previews and live tunnels with the month's data and the limits.

    ``hints`` are next steps as ``whk`` commands, so an agent never needs the
    dashboard; ``suspended`` is set when staff suspended sharing on the account.
    """

    shares: list[TunnelShare]
    usage: TunnelUsage
    limits: TunnelLimits
    names: TunnelNamesSummary | None = None
    suspended: bool = False
    hints: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelShareList:
        shares = data.get("shares")
        usage = data.get("usage")
        limits = data.get("limits")
        names = data.get("names")
        return cls(
            shares=[TunnelShare.from_dict(s) for s in shares if isinstance(s, Mapping)]
            if isinstance(shares, list)
            else [],
            usage=TunnelUsage.from_dict(usage if isinstance(usage, Mapping) else {}),
            limits=TunnelLimits.from_dict(limits if isinstance(limits, Mapping) else {}),
            names=TunnelNamesSummary.from_dict(names) if isinstance(names, Mapping) else None,
            suspended=data.get("suspended") is True,
            hints=_str_list(data.get("hints")),
            raw=dict(data),
        )


@dataclass(frozen=True)
class TunnelStopResult:
    """What ``client.shares.stop()`` reports: ``stopped`` is False when it had
    already ended, ``edge_reached`` False when the edge could not be told at
    once (it ends at the next sync)."""

    ok: bool = True
    stopped: bool = True
    edge_reached: bool = True

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelStopResult:
        return cls(
            ok=data.get("ok") is not False,
            stopped=data.get("stopped") is not False,
            edge_reached=data.get("edgeReached") is not False,
        )


@dataclass(frozen=True)
class TunnelVisit:
    """One visitor request to a preview, from the edge's memory (no addresses)."""

    method: str
    path: str
    status: int
    ms: int
    bytes: int
    at: str
    country: str | None
    device: str
    """``"phone"``, ``"tablet"``, ``"computer"``, ``"bot"`` or ``"unknown"``."""
    visitor: int
    """1 for the first visitor seen, 2 for the next."""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelVisit:
        return cls(
            method=str(data.get("method") or ""),
            path=str(data.get("path") or ""),
            status=int(_number(data.get("status"))),
            ms=int(_number(data.get("ms"))),
            bytes=int(_number(data.get("bytes"))),
            at=str(data.get("at") or ""),
            country=_str_or_none(data.get("country")),
            device=str(data.get("device") or "unknown"),
            visitor=int(_number(data.get("visitor"))),
        )


@dataclass(frozen=True)
class TunnelVisits:
    """``shares.requests()``: the last visitor requests, newest first.

    ``available`` is ``False`` when the edge could not be asked just now.
    """

    available: bool
    requests: list[TunnelVisit]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelVisits:
        requests = data.get("requests")
        return cls(
            available=data.get("available") is not False,
            requests=[TunnelVisit.from_dict(r) for r in requests if isinstance(r, Mapping)]
            if isinstance(requests, list)
            else [],
        )


@dataclass(frozen=True)
class TunnelTeamRef:
    id: str
    name: str


@dataclass(frozen=True)
class TunnelName:
    """A reserved preview name: ``<name>.sharehooks.cc``."""

    name: str
    url: str | None
    team: TunnelTeamRef | None
    """The team it belongs to, so every member may share under it."""
    reserved_by: TunnelPerson | None
    mine: bool
    password: bool
    """Whether previews under it need a password."""
    live: bool
    """Whether a preview runs under it now."""
    usable: bool
    """Whether it can be shared under now: ``False`` for names past the plan's (or
    the team's) count and for names of a team whose subscription ended."""
    created_at: str
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelName:
        team = data.get("team")
        return cls(
            name=str(data.get("name") or ""),
            url=_str_or_none(data.get("url")),
            team=TunnelTeamRef(id=str(team.get("id") or ""), name=str(team.get("name") or ""))
            if isinstance(team, Mapping)
            else None,
            reserved_by=TunnelPerson.from_value(data.get("reservedBy")),
            mine=data.get("mine") is not False,
            password=data.get("password") is True,
            live=data.get("live") is True,
            usable=data.get("usable") is not False,
            created_at=str(data.get("createdAt") or ""),
            raw=dict(data),
        )


@dataclass(frozen=True)
class TunnelTeamNameCount:
    """One team's names against its cap (the plan's names per seat times its seats)."""

    id: str
    name: str
    active: bool
    """Whether the team's subscription is live; a lapsed team's names cannot be used."""
    limit: int
    used: int

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelTeamNameCount:
        return cls(
            id=str(data.get("id") or ""),
            name=str(data.get("name") or ""),
            active=data.get("active") is not False,
            limit=int(_number(data.get("limit"))),
            used=int(_number(data.get("used"))),
        )


@dataclass(frozen=True)
class TunnelNameList:
    """``names.list()``: your names and your teams' names, with the counts."""

    names: list[TunnelName]
    limit: int
    """Your own names (outside teams) the plan allows."""
    used: int
    """Your own names."""
    plan: str | None = None
    """The plan your sharing limits come from (``"pro"``, ``"team_business"``)."""
    teams: list[TunnelTeamNameCount] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TunnelNameList:
        names = data.get("names")
        teams = data.get("teams")
        return cls(
            names=[TunnelName.from_dict(n) for n in names if isinstance(n, Mapping)]
            if isinstance(names, list)
            else [],
            limit=int(_number(data.get("limit"))),
            used=int(_number(data.get("used"))),
            plan=_str_or_none(data.get("plan")),
            teams=[TunnelTeamNameCount.from_dict(t) for t in teams if isinstance(t, Mapping)]
            if isinstance(teams, list)
            else [],
            raw=dict(data),
        )
