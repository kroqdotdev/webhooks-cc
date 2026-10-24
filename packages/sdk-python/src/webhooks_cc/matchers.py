"""Request matchers for ``wait_for()``, ``wait_for_all()`` and your own filtering.

A matcher is a function that takes a :class:`~webhooks_cc.models.Request`
and returns ``True`` when it matches; combine them with :func:`match_all`
and :func:`match_any`, or pass any callable of your own.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from ._js import js_trim, json_parse
from ._sentinel import UNSET
from .models import EmailAddress, Request

Matcher = Callable[[Request], bool]


def _parse_json(request: Request) -> Any:
    if not request.body:
        return _NO_JSON
    try:
        return json_parse(request.body)
    except ValueError:
        return _NO_JSON


_NO_JSON = object()


def _glob(pattern: str) -> re.Pattern[str]:
    source: list[str] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if pattern[index + 1 : index + 2] == "*":
                source.append(".*")
                index += 1
            else:
                source.append("[^/]*")
        else:
            source.append(re.escape(char))
        index += 1
    return re.compile("".join(source))


def _same(expected: Any, actual: Any) -> bool:
    # JSON values compare like JavaScript's Object.is: no 1 == True, no 1 == 1.0 surprises.
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return float(expected) == float(actual)
    if isinstance(expected, (dict, list)) or isinstance(actual, (dict, list)):
        return False
    return type(expected) is type(actual) and expected == actual


def _is_subset(expected: Any, actual: Any) -> bool:
    if isinstance(expected, (list, tuple)):
        return (
            isinstance(actual, list)
            and len(expected) <= len(actual)
            and all(_is_subset(value, actual[index]) for index, value in enumerate(expected))
        )
    if isinstance(expected, Mapping):
        if not isinstance(actual, dict):
            return False
        return all(
            key in actual and _is_subset(value, actual[key]) for key, value in expected.items()
        )
    return _same(expected, actual)


def match_method(method: str) -> Matcher:
    """The HTTP method, in any case."""
    upper = method.upper()
    return lambda request: request.method.upper() == upper


def match_header(name: str, value: str | None = None) -> Matcher:
    """A header is present (name in any case), and equals ``value`` exactly when given."""

    def matches(request: Request) -> bool:
        actual = request.header(name)
        if actual is None:
            return False
        return value is None or actual == value

    return matches


def match_path(pattern: str) -> Matcher:
    """The path matches a glob: ``*`` within one segment, ``**`` across segments."""
    regex = _glob(pattern)
    return lambda request: regex.fullmatch(request.path) is not None


def match_query_param(key: str, value: str | None = None) -> Matcher:
    """A query parameter is present, and equals ``value`` exactly when given."""

    def matches(request: Request) -> bool:
        if key not in request.query_params:
            return False
        return value is None or request.query_params[key] == value

    return matches


def match_body_path(path: str, value: Any) -> Matcher:
    """The JSON body has ``value`` at a dot-separated path; numeric segments index arrays.

    ``match_body_path("data.object.id", "obj_123")``, ``match_body_path("items.0.sku", "A")``.
    """
    keys = path.split(".")

    def matches(request: Request) -> bool:
        current = _parse_json(request)
        if not isinstance(current, (dict, list)):
            return False
        for key in keys:
            if isinstance(current, list):
                if not key.isascii() or not key.isdigit():
                    return False
                index = int(key)
                if index >= len(current):
                    return False
                current = current[index]
            elif isinstance(current, dict):
                if key not in current:
                    return False
                current = current[key]
            else:
                return False
        return _same(value, current)

    return matches


def match_body_subset(subset: Mapping[str, Any]) -> Matcher:
    """The JSON body contains ``subset``: objects may have more keys, arrays match by position."""
    return lambda request: _is_subset(subset, _parse_json(request))


def match_content_type(content_type: str) -> Matcher:
    """The content type, ignoring parameters such as ``charset``."""
    expected = js_trim(content_type).lower()

    def matches(request: Request) -> bool:
        raw = request.content_type or request.header("content-type")
        if not raw:
            return False
        normalized = js_trim(raw).lower()
        return normalized == expected or normalized.startswith(f"{expected};")

    return matches


def match_all(first: Matcher, *rest: Matcher) -> Matcher:
    """Every matcher matches."""
    matchers = (first, *rest)
    return lambda request: all(matcher(request) for matcher in matchers)


def match_any(first: Matcher, *rest: Matcher) -> Matcher:
    """At least one matcher matches."""
    matchers = (first, *rest)
    return lambda request: any(matcher(request) for matcher in matchers)


def match_verified() -> Matcher:
    """webhooks.cc checked the request's signature and it was valid."""
    return lambda request: request.signature_verified is True


def match_unverified() -> Matcher:
    """webhooks.cc checked the request's signature and it was not valid."""
    return lambda request: request.signature_verified is False


def is_email_request(request: Request) -> bool:
    """A captured email that carries its parsed message.

    Requests from ``requests.subscribe()`` have none; read the whole email
    with ``emails.get(request.id)``.
    """
    return request.is_email and request.email is not None


def _search(pattern: re.Pattern[str], value: str) -> bool:
    return pattern.search(value) is not None


def _matches_address(addresses: Sequence[EmailAddress], pattern: str | re.Pattern[str]) -> bool:
    for entry in addresses:
        address = entry.address or ""
        if isinstance(pattern, str):
            if address.lower() == pattern.lower():
                return True
        elif _search(pattern, f"{entry.name} <{address}>" if entry.name else address):
            return True
    return False


def match_email(
    *,
    tag: str | None = UNSET,
    subject: str | re.Pattern[str] | None = None,
    from_: str | re.Pattern[str] | None = None,
    to: str | re.Pattern[str] | None = None,
) -> Matcher:
    """Captured emails by tag, subject, sender or recipient.

    - ``tag``: the address's ``+tag``, exactly; ``None`` for untagged mail only.
    - ``subject``: a substring (case-sensitive), or a compiled regular expression.
    - ``from_``: an address in any case, or a regular expression searched in ``"Name <address>"``.
    - ``to``: an address in To or Cc or the one it was delivered to, or a regular expression.
    """

    def matches(request: Request) -> bool:
        if not is_email_request(request):
            return False
        email = request.email
        assert email is not None
        if tag is not UNSET and email.tag != tag:
            return False
        if subject is not None:
            text = email.subject or ""
            if isinstance(subject, str):
                if subject not in text:
                    return False
            elif not _search(subject, text):
                return False
        if from_ is not None and not _matches_address(email.from_, from_):
            return False
        return to is None or _matches_address(
            [*email.to, *email.cc, EmailAddress(name=None, address=request.path)], to
        )

    return matches
