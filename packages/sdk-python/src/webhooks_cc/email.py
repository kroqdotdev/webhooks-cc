"""Email addresses of endpoints, the codes and links found in captured email, and the
named fields an endpoint picks out of it."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from .models import EmailField, InboundEmailFormat, Request

DEFAULT_EMAIL_DOMAIN = "mailhooks.cc"
"""The domain endpoints receive email on."""

INBOUND_EMAIL_FORMATS: tuple[InboundEmailFormat, ...] = (
    "postmark",
    "sendgrid",
    "mailgun",
    "cloudmailin",
)
"""The inbound mail providers whose shape ``emails.render()`` and destinations take."""

EMAIL_FIELD_SOURCES = ("subject", "text", "html", "from", "to", "header")
"""What a named email field can read; see :data:`~webhooks_cc.models.EmailFieldSource`."""

_MAX_EMAIL_FIELDS = 20
_MAX_EMAIL_FIELD_PATTERN_CHARS = 300
_FIELD_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,39}")
_HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}")

_MAX_LOCAL_PART = 64
# Printable ASCII without the characters an unquoted local part cannot hold.
_TAG = re.compile(r"^[!#-'*+\-./0-9=?A-Z^-~]+$")
_SLUG = re.compile(r"^[a-zA-Z0-9_-]{1,50}$")


def is_valid_email_tag(tag: str, slug: str = "") -> bool:
    """Whether ``tag`` can follow the plus sign in an endpoint's address.

    Printable ASCII without spaces, quotes, brackets, ``@``, ``,``, ``;`` or
    ``:``, and a local part (slug, ``+``, tag) of at most 64 characters.
    """
    length = len(slug) + 1 + len(tag) if slug else len(tag)
    return bool(tag) and _TAG.fullmatch(tag) is not None and length <= _MAX_LOCAL_PART


def email_address(slug: str, tag: str | None = None, domain: str = DEFAULT_EMAIL_DOMAIN) -> str:
    """The address an endpoint receives email at: ``email_address("my-app", "run-42")``
    is ``my-app+run-42@mailhooks.cc``. Mail to a tagged address lands on the same
    endpoint and keeps its tag, so a test can find its own email.
    """
    if not _SLUG.fullmatch(slug):
        raise ValueError(f'Invalid endpoint slug: "{slug}"')
    if tag is not None and not is_valid_email_tag(tag, slug):
        raise ValueError(
            f'Invalid email tag: "{tag}". Use printable ASCII without spaces, quotes, brackets, '
            f"@ , ; or :, at most {_MAX_LOCAL_PART - len(slug) - 1} characters"
        )
    local = slug.lower() if tag is None else f"{slug.lower()}+{tag}"
    return f"{local}@{domain}"


def _extracts(email: Request) -> tuple[list[str], list[tuple[str, bool]]]:
    if not email.is_email:
        raise ValueError(f"Request {email.id} is not a captured email")
    if email.extracts is None:
        raise ValueError(
            f"Email {email.id} has no codes or links attached. Read emails through "
            "client.emails (which asks the API for them), and keep the endpoint's "
            '"Show codes and links found in emails" setting on.'
        )
    return email.extracts.codes, [(link.url, link.action) for link in email.extracts.links]


def extract_code(email: Request) -> str | None:
    """The first one-time code in an email (subject first), or ``None``.

    The codes are the ones the dashboard shows; webhooks.cc finds them and
    ``client.emails`` returns them with each email. Raises ``ValueError`` for
    an email read without them (see :attr:`Request.extracts`).
    """
    codes, _ = _extracts(email)
    return codes[0] if codes else None


def extract_link(email: Request, *, action_only: bool = False) -> str | None:
    """The link an email asks you to click (confirm, verify, reset, sign in) when it
    has one, otherwise the first link worth keeping; ``None`` when there is none.

    With ``action_only=True`` only such an action link counts. Raises
    ``ValueError`` like :func:`extract_code`.
    """
    _, links = _extracts(email)
    if not links:
        return None
    url, action = links[0]
    return None if action_only and not action else url


def _js_length(text: str) -> int:
    """The length JavaScript gives ``text``: characters outside the BMP count twice."""
    return len(text) + sum(1 for char in text if ord(char) > 0xFFFF)


def email_field_issues(fields: Any) -> list[str]:
    """What the API would refuse in a list of named email fields; empty when it is valid.

    Each field is an :class:`~webhooks_cc.models.EmailField` or a dict with ``name``,
    ``from``, ``pattern`` and, for ``"from": "header"``, ``header``. This checks the
    count (at most 20), the names, the sources, the headers and the pattern lengths;
    whether a pattern is valid RE2 is left to the server.
    """
    if isinstance(fields, (str, bytes)) or not isinstance(fields, Sequence):
        return ["must be a list of fields"]
    if len(fields) > _MAX_EMAIL_FIELDS:
        return [f"at most {_MAX_EMAIL_FIELDS} fields"]
    issues: list[str] = []
    names: set[str] = set()
    for index, item in enumerate(fields, 1):
        at = f"field {index}"
        field = item.to_dict() if isinstance(item, EmailField) else item
        if not isinstance(field, Mapping):
            issues.append(f"{at}: must be a dict")
            continue
        name = field.get("name")
        if not isinstance(name, str) or not _FIELD_NAME.fullmatch(name):
            issues.append(
                f"{at}: name must be letters, digits and _, start with a letter, "
                "at most 40 characters"
            )
        elif name in names:
            issues.append(f'{at}: the name "{name}" is used twice')
        else:
            names.add(name)
        source = field.get("from")
        header = field.get("header")
        if not isinstance(source, str) or source not in EMAIL_FIELD_SOURCES:
            issues.append(f"{at}: from must be one of {', '.join(EMAIL_FIELD_SOURCES)}")
        elif source == "header":
            if not isinstance(header, str) or not _HEADER_NAME.fullmatch(header):
                issues.append(f"{at}: header must be a header name")
        elif header is not None:
            issues.append(f'{at}: header is only for from "header"')
        pattern = field.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            issues.append(f"{at}: pattern is required")
        elif _js_length(pattern) > _MAX_EMAIL_FIELD_PATTERN_CHARS:
            issues.append(
                f"{at}: pattern is longer than {_MAX_EMAIL_FIELD_PATTERN_CHARS} characters"
            )
    return issues
