"""Email addresses of endpoints, and the codes and links found in captured email."""

from __future__ import annotations

import re

from .models import Request

DEFAULT_EMAIL_DOMAIN = "mailhooks.cc"
"""The domain endpoints receive email on."""

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
