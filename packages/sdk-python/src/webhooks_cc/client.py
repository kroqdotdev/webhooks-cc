"""The webhooks.cc API client.

.. code-block:: python

    from webhooks_cc import WebhooksCC, match_body_path

    with WebhooksCC() as client:  # reads WHK_API_KEY
        endpoint = client.endpoints.create(name="checkout test")
        request = client.requests.wait_for(
            endpoint.slug, timeout="30s", match=match_body_path("type", "invoice.paid")
        )
"""

from __future__ import annotations

import base64
import binascii
import builtins
import json
import os
import re
import socket
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx

from . import __version__
from ._crypto import json_body
from ._sentinel import UNSET
from ._sse import parse_sse
from .durations import Duration, parse_duration
from .email import DEFAULT_EMAIL_DOMAIN, email_address, is_valid_email_tag
from .errors import (
    NotFoundError,
    RateLimitError,
    TimeoutError,
    UnauthorizedError,
    WebhooksCCError,
)
from .matchers import Matcher, is_email_request, match_email
from .models import (
    BuiltRequest,
    Endpoint,
    Request,
    RequestKind,
    RequestPage,
    SendTestEmailResult,
    UsageInfo,
)
from .templates import TEMPLATE_METADATA, build_template_request

DEFAULT_BASE_URL = "https://webhooks.cc"
DEFAULT_WEBHOOK_URL = "https://go.webhooks.cc"
API_KEY_ENV = "WHK_API_KEY"
"""The environment variable the client reads its API key from when none is passed."""
BASE_URL_ENV = "WHK_BASE_URL"
WEBHOOK_URL_ENV = "WHK_WEBHOOK_URL"

_DEFAULT_TIMEOUT_MS = 30_000
_WAIT_FOR_LOOKBACK_MS = 5 * 60 * 1000
_MIN_POLL_INTERVAL_MS = 10
_MAX_POLL_INTERVAL_MS = 60_000
_MAX_WAIT_ITERATIONS = 10_000
_STREAM_CONNECT_TIMEOUT_S = 30.0
_STREAM_DEDUP_WINDOW = 1000
_STREAM_RAPID_ROTATION_MS = 5000
_STREAM_RAPID_ROTATION_LIMIT = 2

_SAFE_SEGMENT = re.compile(r"^[a-zA-Z0-9_-]+$")
_ALLOWED_METHODS = ("GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS")
# Not replayed: hop-by-hop headers, credentials, and headers our proxies added.
_REPLAY_SKIPPED_HEADERS = frozenset(
    {
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "keep-alive",
        "te",
        "trailer",
        "upgrade",
        "authorization",
        "cookie",
        "proxy-authorization",
        "set-cookie",
        "cdn-loop",
        "cf-connecting-ip",
        "cf-ipcountry",
        "cf-ray",
        "cf-visitor",
        "via",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
        "true-client-ip",
    }
)


@dataclass(frozen=True)
class RetryOptions:
    """How API calls are retried. By default they are not (``max_attempts=1``).

    A retry waits ``backoff`` doubled for each attempt, or what a 429's
    ``Retry-After`` says.
    """

    max_attempts: int = 1
    backoff: Duration = 1000
    retry_on: Sequence[int] = (429, 500, 502, 503, 504)


def _now_ms() -> float:
    return time.time() * 1000


def _sleep_ms(ms: float) -> None:
    if ms > 0:
        time.sleep(ms / 1000)


def _validate_segment(value: str, name: str) -> None:
    if not isinstance(value, str) or not _SAFE_SEGMENT.fullmatch(value):
        raise ValueError(
            f"Invalid {name}: must contain only alphanumeric characters, hyphens, and underscores"
        )


def _validate_url(url: str, name: str = "URL") -> None:
    try:
        parts = urlsplit(url)
    except ValueError as error:
        raise ValueError(f'Invalid {name}: "{url}" is not a valid URL') from error
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError(f"Invalid {name}: only http and https URLs are supported")


def _int_header(headers: httpx.Headers, name: str) -> int | None:
    value = headers.get(name)
    if value is None:
        return None
    match = re.match(r"^\s*(\d+)", value)
    return int(match.group(1)) if match else None


def _map_error(status: int, message: str, headers: httpx.Headers) -> WebhooksCCError:
    generic = len(message) < 30
    if status == 401:
        return UnauthorizedError(
            f"{message}. Get an API key at https://webhooks.cc/account/api-keys"
            if generic
            else message
        )
    if status == 404:
        return NotFoundError(
            f"{message}: use client.endpoints.list() to see your endpoints" if generic else message
        )
    if status == 429:
        limit = _int_header(headers, "x-ratelimit-limit")
        remaining = _int_header(headers, "x-ratelimit-remaining")
        reset = _int_header(headers, "x-ratelimit-reset")
        complete = None not in (limit, remaining, reset)
        return RateLimitError(
            _int_header(headers, "retry-after"),
            limit=limit if complete else None,
            remaining=remaining if complete else None,
            reset=reset if complete else None,
        )
    return WebhooksCCError(status, message)


def _error_from_response(response: httpx.Response) -> WebhooksCCError:
    text = response.text
    return _map_error(
        response.status_code, text[:200] + "..." if len(text) > 200 else text, response.headers
    )


class _RecentIds:
    """The last ``capacity`` ids seen, oldest evicted first."""

    def __init__(self, capacity: int) -> None:
        self._ids: OrderedDict[str, None] = OrderedDict()
        self._capacity = max(1, capacity)

    def __contains__(self, request_id: object) -> bool:
        return request_id in self._ids

    def add(self, request_id: str) -> None:
        if request_id in self._ids:
            return
        self._ids[request_id] = None
        if len(self._ids) > self._capacity:
            self._ids.popitem(last=False)


def _stream_request(data: str) -> Request | None:
    try:
        parsed = json.loads(data)
    except ValueError:
        return None
    if (
        not isinstance(parsed, dict)
        or not isinstance(parsed.get("endpointId"), str)
        or not isinstance(parsed.get("method"), str)
        or isinstance(parsed.get("receivedAt"), bool)
        or not isinstance(parsed.get("receivedAt"), (int, float))
        or not isinstance(parsed.get("headers"), dict)
    ):
        return None
    return Request.from_dict(parsed)


def _server_date_ms(headers: httpx.Headers) -> float | None:
    raw = headers.get("date")
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw).timestamp() * 1000
    except (TypeError, ValueError):
        return None


def _decode_base64(value: str) -> bytes | None:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None


def _body_bytes_or_text(body: Any) -> str | bytes:
    """A body to send as it is: bytes and strings unchanged, anything else as JSON."""
    if isinstance(body, (bytes, bytearray, memoryview)):
        return bytes(body)
    return json_body(body)


class WebhooksCC:
    """Client for the webhooks.cc API.

    ``api_key``, ``base_url`` and ``webhook_url`` default to the ``WHK_API_KEY``,
    ``WHK_BASE_URL`` and ``WHK_WEBHOOK_URL`` environment variables. Use the
    client as a context manager, or call :meth:`close`, to release its
    connections. Durations (``timeout``, ``poll_interval``) take ``"30s"``,
    ``"500ms"``, ``"5m"``, a ``timedelta``, or a number of milliseconds.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        webhook_url: str | None = None,
        timeout: Duration = _DEFAULT_TIMEOUT_MS,
        retry: RetryOptions | None = None,
        email_domain: str = DEFAULT_EMAIL_DOMAIN,
        http_client: httpx.Client | None = None,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get(API_KEY_ENV)
        if not key:
            raise ValueError(
                f"Missing API key: pass api_key or set {API_KEY_ENV}. "
                "Get one at https://webhooks.cc/account/api-keys"
            )
        self._api_key = key
        self._base_url = (base_url or os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL).rstrip("/")
        self._webhook_url = (
            webhook_url or os.environ.get(WEBHOOK_URL_ENV) or DEFAULT_WEBHOOK_URL
        ).rstrip("/")
        self._timeout_ms = parse_duration(timeout)
        self._retry = retry or RetryOptions()
        self._backoff_ms = parse_duration(self._retry.backoff)
        self._email_domain = email_domain
        self._owns_http = http_client is None
        self._http = http_client or httpx.Client(
            headers={"User-Agent": f"webhooks-cc-python/{__version__}"}
        )
        self.endpoints = Endpoints(self)
        self.requests = Requests(self)
        self.emails = Emails(self)
        self.forwarding = Forwarding(self)

    def __enter__(self) -> WebhooksCC:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        """Close the HTTP connections (only those of a client the SDK created)."""
        if self._owns_http:
            self._http.close()

    # --- plumbing ---------------------------------------------------------------------

    @property
    def _timeout_s(self) -> float:
        return self._timeout_ms / 1000

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    def _api(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: Mapping[str, str] | None = None,
    ) -> Any:
        url = f"{self._base_url}/api{path}"
        attempts = max(1, int(self._retry.max_attempts))
        attempt = 0
        while True:
            attempt += 1
            backoff = self._backoff_ms * 2 ** (attempt - 1)
            try:
                response = self._http.request(
                    method,
                    url,
                    params=params,
                    content=json.dumps(body) if body is not None else None,
                    headers={**self._auth(), "Content-Type": "application/json"},
                    timeout=self._timeout_s,
                )
            except httpx.TimeoutException:
                if attempt < attempts:
                    _sleep_ms(backoff)
                    continue
                raise TimeoutError(self._timeout_ms) from None
            except httpx.TransportError:
                if attempt < attempts:
                    _sleep_ms(backoff)
                    continue
                raise

            if response.status_code >= 400:
                error = _error_from_response(response)
                if attempt < attempts and response.status_code in self._retry.retry_on:
                    retry_after = error.retry_after if isinstance(error, RateLimitError) else None
                    _sleep_ms(retry_after * 1000 if retry_after is not None else backoff)
                    continue
                raise error

            if response.status_code == 204 or response.headers.get("content-length") == "0":
                return None
            content_type = response.headers.get("content-type")
            if content_type and "application/json" not in content_type:
                raise WebhooksCCError(
                    response.status_code, f"Unexpected content type: {content_type}"
                )
            return response.json()

    def _send(
        self, method: str, url: str, headers: Mapping[str, str], body: str | bytes | None
    ) -> httpx.Response:
        try:
            return self._http.request(
                method,
                url,
                headers=dict(headers),
                content=body,
                timeout=self._timeout_s,
            )
        except httpx.TimeoutException:
            raise TimeoutError(self._timeout_ms) from None

    # --- top-level operations ----------------------------------------------------------

    def usage(self) -> UsageInfo:
        """Requests used and left in the current period."""
        return UsageInfo.from_dict(self._api("GET", "/usage"))

    def build_request(
        self,
        url: str,
        *,
        provider: str | None = None,
        secret: str | None = None,
        body: Any = None,
        headers: Mapping[str, str] | None = None,
        method: str | None = None,
        template: str | None = None,
        event: str | None = None,
        timestamp: int | None = None,
        message_id: str | None = None,
    ) -> BuiltRequest:
        """What :meth:`send_to` would send, signatures included, without sending it.

        With ``provider``, the request is signed like that provider signs its
        webhooks (``secret`` required unless the provider does not sign), and
        ``body=None`` sends the provider's template payload. ``timestamp``
        (seconds) and ``message_id`` make signatures repeatable in tests.

        ``body`` may be a string or bytes, sent as they are, or anything else,
        sent as JSON. Redirects are not followed, so signature headers never
        travel to a host you did not name.
        """
        _validate_url(url)
        if provider is not None:
            info = TEMPLATE_METADATA.get(provider)
            if (info is None or info.secret_required) and not secret:
                raise ValueError(
                    f'build_request with provider "{provider}" requires a non-empty secret'
                )
            return build_template_request(
                url,
                provider=provider,
                secret=secret,
                template=template,
                event=event,
                body=body,
                method=method,
                headers=headers,
                timestamp=timestamp,
                message_id=message_id,
            )
        upper = (method or "POST").upper()
        if upper not in _ALLOWED_METHODS:
            raise ValueError(
                f'Invalid HTTP method: "{method}". Must be one of: {", ".join(_ALLOWED_METHODS)}'
            )
        out_headers = dict(headers or {})
        if body is not None and not any(key.lower() == "content-type" for key in out_headers):
            out_headers["Content-Type"] = "application/json"
        return BuiltRequest(
            method=upper,
            url=url,
            headers=out_headers,
            body=_body_bytes_or_text(body) if body is not None else None,
        )

    def send_to(
        self,
        url: str,
        *,
        provider: str | None = None,
        secret: str | None = None,
        body: Any = None,
        headers: Mapping[str, str] | None = None,
        method: str | None = None,
        template: str | None = None,
        event: str | None = None,
        timestamp: int | None = None,
        message_id: str | None = None,
    ) -> httpx.Response:
        """Send a webhook straight to any URL, signed like ``provider`` signs them.

        For testing your own handler, on localhost or anywhere else, without
        going through webhooks.cc. Takes the same arguments as :meth:`build_request`.
        """
        built = self.build_request(
            url,
            provider=provider,
            secret=secret,
            body=body,
            headers=headers,
            method=method,
            template=template,
            event=event,
            timestamp=timestamp,
            message_id=message_id,
        )
        return self._send(built.method, built.url, built.headers, built.body)


class Endpoints:
    """Create, read, change and delete endpoints, and send test webhooks to them."""

    def __init__(self, client: WebhooksCC) -> None:
        self._client = client

    def create(
        self,
        name: str | None = None,
        *,
        ephemeral: bool = False,
        expires_in: Duration | None = None,
        mock_response: Mapping[str, Any] | None = None,
        notification_url: str | None = None,
        response_rules: Sequence[Mapping[str, Any]] | None = None,
    ) -> Endpoint:
        """Create an endpoint. ``expires_in`` (or ``ephemeral=True``) makes it temporary."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if mock_response is not None:
            body["mockResponse"] = dict(mock_response)
        if notification_url is not None:
            body["notificationUrl"] = notification_url
        if response_rules is not None:
            body["responseRules"] = [dict(rule) for rule in response_rules]
        if ephemeral or expires_in is not None:
            body["isEphemeral"] = True
        if expires_in is not None:
            ms = parse_duration(expires_in)
            if ms <= 0:
                raise ValueError("expires_in must be greater than 0")
            body["expiresAt"] = int(_now_ms() + ms)
        return Endpoint.from_dict(self._client._api("POST", "/endpoints", body=body))

    def list(self) -> builtins.list[Endpoint]:
        """Your endpoints, then those shared with you through teams."""
        response = self._client._api("GET", "/endpoints")
        return [
            Endpoint.from_dict(item)
            for item in [*(response.get("owned") or []), *(response.get("shared") or [])]
        ]

    def get(self, slug: str) -> Endpoint:
        _validate_segment(slug, "slug")
        return Endpoint.from_dict(self._client._api("GET", f"/endpoints/{slug}"))

    def update(
        self,
        slug: str,
        *,
        name: str | None = UNSET,
        mock_response: Mapping[str, Any] | None = UNSET,
        notification_url: str | None = UNSET,
        response_rules: Sequence[Mapping[str, Any]] | None = UNSET,
        signing_provider: str | None = UNSET,
        signing_secret: str | None = UNSET,
        signing_header: str | None = UNSET,
        show_email_extracts: bool = UNSET,
        forward_enabled: bool = UNSET,
        forward_url: str | None = UNSET,
    ) -> Endpoint:
        """Change an endpoint's settings.

        Only the arguments you pass change; ``None`` clears a setting.
        """
        _validate_segment(slug, "slug")
        fields: dict[str, Any] = {
            "name": name,
            "mockResponse": dict(mock_response)
            if isinstance(mock_response, Mapping)
            else mock_response,
            "notificationUrl": notification_url,
            "responseRules": [dict(rule) for rule in response_rules]
            if response_rules
            else response_rules,
            "signingProvider": signing_provider,
            "signingSecret": signing_secret,
            "signingHeader": signing_header,
            "showEmailExtracts": show_email_extracts,
            "forwardEnabled": forward_enabled,
            "forwardUrl": forward_url,
        }
        body = {key: value for key, value in fields.items() if value is not UNSET}
        return Endpoint.from_dict(self._client._api("PATCH", f"/endpoints/{slug}", body=body))

    def delete(self, slug: str) -> None:
        """Delete an endpoint and everything it captured."""
        _validate_segment(slug, "slug")
        self._client._api("DELETE", f"/endpoints/{slug}")

    def send(
        self,
        slug: str,
        *,
        method: str = "POST",
        headers: Mapping[str, str] | None = None,
        body: Any = None,
    ) -> httpx.Response:
        """Send a test request to an endpoint's capture URL."""
        _validate_segment(slug, "slug")
        upper = method.upper()
        if upper not in _ALLOWED_METHODS:
            raise ValueError(
                f'Invalid HTTP method: "{method}". Must be one of: {", ".join(_ALLOWED_METHODS)}'
            )
        out_headers = dict(headers or {})
        if body is not None and not any(key.lower() == "content-type" for key in out_headers):
            out_headers["Content-Type"] = "application/json"
        return self._client._send(
            upper,
            f"{self._client._webhook_url}/w/{slug}",
            out_headers,
            _body_bytes_or_text(body) if body is not None else None,
        )

    def send_template(
        self,
        slug: str,
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
    ) -> httpx.Response:
        """Send a provider's template webhook to an endpoint, signed with ``secret``."""
        _validate_segment(slug, "slug")
        info = TEMPLATE_METADATA.get(provider)
        if (info is None or info.secret_required) and not secret:
            raise ValueError(f'send_template requires a non-empty secret for provider "{provider}"')
        built = build_template_request(
            f"{self._client._webhook_url}/w/{slug}",
            provider=provider,
            secret=secret,
            template=template,
            event=event,
            body=body,
            method=method,
            headers=headers,
            timestamp=timestamp,
            message_id=message_id,
        )
        return self._client._send(built.method, built.url, built.headers, built.body)


class Requests:
    """Captured requests: list, wait for, stream, replay and delete them."""

    def __init__(self, client: WebhooksCC) -> None:
        self._client = client

    def list(
        self,
        slug: str,
        *,
        limit: int | None = None,
        since: float | None = None,
        kind: RequestKind | None = None,
    ) -> builtins.list[Request]:
        """Requests an endpoint captured, newest first. ``since`` is in ms since the epoch."""
        _validate_segment(slug, "endpoint slug")
        params = {"extracts": "true"}
        if limit is not None:
            params["limit"] = str(int(limit))
        if since is not None:
            params["since"] = str(int(since))
        if kind is not None:
            params["kind"] = kind
        items = self._client._api("GET", f"/endpoints/{slug}/requests", params=params)
        return [Request.from_dict(item) for item in items or []]

    def list_paginated(
        self,
        slug: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        kind: RequestKind | None = None,
    ) -> RequestPage:
        """One page of captured requests; pass the returned ``cursor`` for the next."""
        _validate_segment(slug, "endpoint slug")
        params = {"extracts": "true"}
        if limit is not None:
            params["limit"] = str(int(limit))
        if cursor is not None:
            params["cursor"] = cursor
        if kind is not None:
            params["kind"] = kind
        page = self._client._api("GET", f"/endpoints/{slug}/requests/paginated", params=params)
        return RequestPage(
            items=[Request.from_dict(item) for item in page.get("items") or []],
            cursor=page.get("cursor") if isinstance(page.get("cursor"), str) else None,
            has_more=page.get("hasMore") is True,
        )

    def get(self, request_id: str) -> Request:
        _validate_segment(request_id, "request id")
        return Request.from_dict(
            self._client._api("GET", f"/requests/{request_id}", params={"extracts": "true"})
        )

    def wait_for(
        self,
        slug: str,
        *,
        timeout: Duration = _DEFAULT_TIMEOUT_MS,
        poll_interval: Duration = 500,
        match: Matcher | None = None,
        since: float | None = None,
    ) -> Request:
        """Poll until a request (matching ``match``, if given) arrives.

        Looks back five minutes unless ``since`` (ms since the epoch) is
        given, so a request that arrived just before waiting began counts.
        Raises :class:`~webhooks_cc.errors.TimeoutError` when time runs out.
        """
        return self.wait_for_all(
            slug, count=1, timeout=timeout, poll_interval=poll_interval, match=match, since=since
        )[0]

    def wait_for_all(
        self,
        slug: str,
        *,
        count: int,
        timeout: Duration = _DEFAULT_TIMEOUT_MS,
        poll_interval: Duration = 500,
        match: Matcher | None = None,
        since: float | None = None,
    ) -> builtins.list[Request]:
        """Poll until ``count`` matching requests have arrived; returns them oldest first."""
        _validate_segment(slug, "endpoint slug")
        limit = _wait_list_limit(count)
        return _collect(
            lambda start: self.list(slug, since=start, limit=limit),
            count=count,
            timeout=timeout,
            poll_interval=poll_interval,
            match=match,
            since=since,
        )

    def search(
        self,
        *,
        slug: str | None = None,
        method: str | None = None,
        kind: RequestKind | None = None,
        q: str | None = None,
        from_: float | str | None = None,
        to: float | str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        order: Literal["asc", "desc"] | None = None,
    ) -> builtins.list[Request]:
        """Search retained requests across path, body and headers.

        ``from_`` and ``to`` take ms since the epoch, or a duration ago (``"1h"``).
        """
        params = _search_params(slug, method, kind, q, from_, to)
        if limit is not None:
            params["limit"] = str(int(limit))
        if offset is not None:
            params["offset"] = str(int(offset))
        if order is not None:
            params["order"] = order
        return [
            Request.from_dict(item)
            for item in self._client._api("GET", "/search/requests", params=params) or []
        ]

    def count(
        self,
        *,
        slug: str | None = None,
        method: str | None = None,
        kind: RequestKind | None = None,
        q: str | None = None,
        from_: float | str | None = None,
        to: float | str | None = None,
    ) -> int:
        """How many retained requests match the search."""
        params = _search_params(slug, method, kind, q, from_, to)
        return int(self._client._api("GET", "/search/requests/count", params=params)["count"])

    def clear(self, slug: str, *, before: float | str | None = None) -> None:
        """Delete an endpoint's requests: all of them, or those ``before`` a time.

        ``before`` takes ms since the epoch, or a duration ago (``"1h"``).
        """
        _validate_segment(slug, "endpoint slug")
        params = {}
        if before is not None:
            params["before"] = str(int(_resolve_time(before)))
        self._client._api("DELETE", f"/endpoints/{slug}/requests", params=params)

    def replay(self, request_id: str, target_url: str) -> httpx.Response:
        """Send a captured request again, to any URL, with its method, headers and exact body.

        Hop-by-hop headers, credentials and headers added by proxies are left out.
        """
        _validate_segment(request_id, "request id")
        _validate_url(target_url, "target_url")
        captured = self.get(request_id)
        if captured.is_email:
            raise ValueError(
                f"Request {request_id} is a captured email, which cannot be replayed as an "
                "HTTP request. Turn on forwarding to deliver emails to a URL."
            )
        headers = {
            key: value
            for key, value in captured.headers.items()
            if key.lower() not in _REPLAY_SKIPPED_HEADERS
        }
        body: str | bytes | None = None
        if captured.method.upper() not in ("GET", "HEAD"):
            raw = _decode_base64(captured.body_raw) if captured.body_raw else None
            body = raw if raw is not None else captured.body
        return self._client._send(captured.method, target_url, headers, body)

    def subscribe(
        self,
        slug: str,
        *,
        timeout: Duration | None = None,
        reconnect: bool = False,
        max_reconnect_attempts: int = 5,
        reconnect_backoff: Duration = 1000,
        idle_timeout: Duration = 90_000,
        on_reconnect: Callable[[int], None] | None = None,
    ) -> Iterator[Request]:
        """Requests as they arrive, over a server-sent event stream.

        .. code-block:: python

            for request in client.requests.subscribe(slug, timeout="5m", reconnect=True):
                print(request.method, request.path)

        The iterator ends at ``timeout``, when the endpoint is deleted, or when
        you stop iterating. The server rotates every connection after 30
        minutes; with ``reconnect=True`` the stream follows, resuming after
        the last request so none is missed, and also recovers from dropped
        connections (``max_reconnect_attempts`` in a row, backing off from
        ``reconnect_backoff``). Without it, the iterator ends at the first
        rotation. ``idle_timeout`` (default 90 s, three keepalives) drops a
        connection that went silent; without ``reconnect`` that raises
        :class:`~webhooks_cc.errors.TimeoutError`.

        Streamed requests carry no parsed email; read it with ``client.emails.get(request.id)``.
        """
        _validate_segment(slug, "slug")
        return _subscribe(
            self._client,
            slug,
            timeout_ms=parse_duration(timeout) if timeout is not None else None,
            reconnect=reconnect,
            max_attempts=max(0, int(max_reconnect_attempts)),
            backoff_ms=parse_duration(reconnect_backoff),
            idle_ms=parse_duration(idle_timeout),
            on_reconnect=on_reconnect,
        )


class Emails:
    """Email captured at ``{slug}@mailhooks.cc`` and ``{slug}+{tag}@mailhooks.cc``.

    Use a fresh tag per test run to find your own email:

    .. code-block:: python

        run = f"signup-{uuid.uuid4().hex[:8]}"
        sign_up(client.emails.address(slug, run))
        email = client.emails.wait_for(slug, tag=run)
        code = extract_code(email)
    """

    def __init__(self, client: WebhooksCC) -> None:
        self._client = client

    def address(self, endpoint: str | Endpoint, tag: str | None = None) -> str:
        """The address an endpoint receives email at, optionally with a tag.

        Pass the :class:`Endpoint` to use the address the server reports; a
        slug uses the client's ``email_domain``.
        """
        if isinstance(endpoint, Endpoint) and endpoint.email_address:
            if tag is None:
                return endpoint.email_address
            local, _, domain = endpoint.email_address.rpartition("@")
            if not is_valid_email_tag(tag, local):
                raise ValueError(f'Invalid email tag: "{tag}"')
            return f"{local}+{tag}@{domain}"
        slug = endpoint.slug if isinstance(endpoint, Endpoint) else endpoint
        return email_address(slug, tag, self._client._email_domain)

    def list(
        self,
        slug: str,
        *,
        tag: str | None = UNSET,
        subject: str | re.Pattern[str] | None = None,
        from_: str | re.Pattern[str] | None = None,
        to: str | re.Pattern[str] | None = None,
        limit: int = 50,
        since: float | None = None,
    ) -> builtins.list[Request]:
        """Emails an endpoint captured, newest first, filtered like :func:`match_email`."""
        matches = match_email(tag=tag, subject=subject, from_=from_, to=to)
        return [
            request
            for request in self._client.requests.list(slug, kind="email", limit=limit, since=since)
            if matches(request)
        ]

    def get(self, request_id: str) -> Request:
        """One captured email. Raises :class:`NotFoundError` for anything else."""
        request = self._client.requests.get(request_id)
        if not is_email_request(request):
            raise NotFoundError(f"Request {request_id} is not a captured email")
        return request

    def latest(
        self,
        slug: str,
        *,
        tag: str | None = UNSET,
        subject: str | re.Pattern[str] | None = None,
        from_: str | re.Pattern[str] | None = None,
        to: str | re.Pattern[str] | None = None,
    ) -> Request | None:
        """The newest email matching the criteria, or ``None``."""
        emails = self.list(slug, tag=tag, subject=subject, from_=from_, to=to, limit=100)
        return max(emails, key=lambda email: email.received_at, default=None)

    def wait_for(
        self,
        slug: str,
        *,
        tag: str | None = UNSET,
        subject: str | re.Pattern[str] | None = None,
        from_: str | re.Pattern[str] | None = None,
        to: str | re.Pattern[str] | None = None,
        timeout: Duration = 60_000,
        poll_interval: Duration = 1000,
        since: float | None = None,
        match: Matcher | None = None,
    ) -> Request:
        """Poll until an email matching the criteria arrives (default timeout 60 s).

        Looks back five minutes unless ``since`` is given.
        """
        return self.wait_for_all(
            slug,
            count=1,
            tag=tag,
            subject=subject,
            from_=from_,
            to=to,
            timeout=timeout,
            poll_interval=poll_interval,
            since=since,
            match=match,
        )[0]

    def wait_for_all(
        self,
        slug: str,
        *,
        count: int,
        tag: str | None = UNSET,
        subject: str | re.Pattern[str] | None = None,
        from_: str | re.Pattern[str] | None = None,
        to: str | re.Pattern[str] | None = None,
        timeout: Duration = 60_000,
        poll_interval: Duration = 1000,
        since: float | None = None,
        match: Matcher | None = None,
    ) -> builtins.list[Request]:
        """Poll until ``count`` matching emails have arrived; returns them oldest first."""
        _validate_segment(slug, "endpoint slug")
        criteria = match_email(tag=tag, subject=subject, from_=from_, to=to)
        limit = _wait_list_limit(count)
        return _collect(
            lambda start: self._client.requests.list(slug, since=start, limit=limit, kind="email"),
            count=count,
            timeout=timeout,
            poll_interval=poll_interval,
            match=lambda request: criteria(request) and (match is None or match(request)),
            since=since,
        )

    def send_test(self, slug: str, *, tag: str | None = None) -> SendTestEmailResult:
        """Deliver a sample email (with a code and a link) to an endpoint.

        It is captured and counted like any other email, but does not travel
        over SMTP, so no sender checks run on it.
        """
        _validate_segment(slug, "endpoint slug")
        if tag is not None and not is_valid_email_tag(tag, slug):
            raise ValueError(f'Invalid email tag: "{tag}"')
        body: dict[str, Any] = {"slug": slug}
        if tag is not None:
            body["tag"] = tag
        result = self._client._api("POST", "/send-test-email", body=body)
        return SendTestEmailResult(
            status=str(result.get("status") or ""),
            request_id=result.get("requestId")
            if isinstance(result.get("requestId"), str)
            else None,
            raw=dict(result),
        )


class Forwarding:
    """The signing secret of an endpoint's forwarding, for verifying what it delivers."""

    def __init__(self, client: WebhooksCC) -> None:
        self._client = client

    def secret(self, slug: str) -> str:
        """The endpoint's ``whsec_`` signing secret.

        Raises :class:`NotFoundError` until a forwarding URL was saved.
        """
        _validate_segment(slug, "endpoint slug")
        return str(self._client._api("GET", f"/endpoints/{slug}/forwarding")["secret"])

    def rotate_secret(self, slug: str) -> str:
        """Replace the signing secret.

        Every delivery from now on, retries included, uses the new one.
        """
        _validate_segment(slug, "endpoint slug")
        return str(self._client._api("POST", f"/endpoints/{slug}/forwarding")["secret"])


# --- waiting ---------------------------------------------------------------------------


def _wait_list_limit(count: int) -> int:
    """The page size a wait polls with: twice the count, between 100 and 1000."""
    return min(1000, max(100, max(1, int(count)) * 2))


def _collect(
    fetch: Callable[[float], list[Request]],
    *,
    count: int,
    timeout: Duration,
    poll_interval: Duration,
    match: Matcher | None,
    since: float | None,
) -> list[Request]:
    timeout_ms = parse_duration(timeout)
    poll_ms = min(_MAX_POLL_INTERVAL_MS, max(_MIN_POLL_INTERVAL_MS, parse_duration(poll_interval)))
    wanted = max(1, int(count))
    start = _now_ms()
    last_checked = since if since is not None else start - _WAIT_FOR_LOOKBACK_MS
    collected: list[Request] = []
    seen: set[str] = set()
    iterations = 0

    while _now_ms() - start < timeout_ms and iterations < _MAX_WAIT_ITERATIONS:
        iterations += 1
        check_time = _now_ms()
        requests: list[Request] = []
        try:
            requests = sorted(fetch(last_checked), key=lambda request: request.received_at)
            last_checked = check_time
        except (UnauthorizedError, NotFoundError):
            raise
        except RateLimitError:
            pass
        except WebhooksCCError as error:
            if error.status_code < 500:
                raise
        except httpx.TransportError:
            pass  # a network blip: try again at the next poll

        for request in requests:
            if request.id in seen:
                continue
            seen.add(request.id)
            if match is not None and not match(request):
                continue
            collected.append(request)
            if len(collected) >= wanted:
                return collected[:wanted]

        remaining = timeout_ms - (_now_ms() - start)
        _sleep_ms(min(poll_ms, max(0.0, remaining)))

    raise TimeoutError(timeout_ms)


# --- searching -------------------------------------------------------------------------


def _resolve_time(value: float | str) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    text = str(value).strip()
    if not text:
        raise ValueError("Invalid timestamp filter: value cannot be empty")
    try:
        return float(text)
    except ValueError:
        return _now_ms() - parse_duration(text)


def _search_params(
    slug: str | None,
    method: str | None,
    kind: RequestKind | None,
    q: str | None,
    from_: float | str | None,
    to: float | str | None,
) -> dict[str, str]:
    params: dict[str, str] = {}
    if slug is not None:
        _validate_segment(slug, "slug")
        params["slug"] = slug
    if method is not None:
        params["method"] = method
    if kind is not None:
        params["kind"] = kind
    if q is not None:
        params["q"] = q
    if from_ is not None:
        params["from"] = str(int(_resolve_time(from_)))
    if to is not None:
        params["to"] = str(int(_resolve_time(to)))
    return params


# --- streaming -------------------------------------------------------------------------


def _end_stream_at(response: httpx.Response, seconds: float) -> threading.Timer:
    """End a stream after ``seconds``, even in the middle of a blocked read.

    Closing a socket from another thread does not wake a thread reading from
    it; shutting it down does, and the read then sees the end of the stream.
    """

    def stop() -> None:
        stream = response.extensions.get("network_stream")
        sock = stream.get_extra_info("socket") if stream is not None else None
        # On HTTP/2 the socket carries other requests too: leave it to the read timeout.
        if response.http_version in ("HTTP/1.0", "HTTP/1.1") and isinstance(sock, socket.socket):
            with suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)
        else:
            with suppress(Exception):
                response.close()

    timer = threading.Timer(max(0.0, seconds), stop)
    timer.daemon = True
    timer.start()
    return timer


def _subscribe(
    client: WebhooksCC,
    slug: str,
    *,
    timeout_ms: float | None,
    reconnect: bool,
    max_attempts: int,
    backoff_ms: float,
    idle_ms: float,
    on_reconnect: Callable[[int], None] | None,
) -> Iterator[Request]:
    deadline = _now_ms() + timeout_ms if timeout_ms is not None else None
    attempts = 0
    last_received_at: float | None = None
    # Where a reconnect resumes before any request arrived: the server's clock at the
    # first connection, so the gap is replayed rather than skipped.
    resume_floor: float | None = None
    rapid_rotations = 0
    seen = _RecentIds(_STREAM_DEDUP_WINDOW)

    def expired() -> bool:
        return deadline is not None and _now_ms() >= deadline

    def back_off() -> bool:
        nonlocal attempts
        if not reconnect or attempts >= max_attempts or expired():
            return False
        attempts += 1
        if on_reconnect is not None:
            # A callback must not break the stream.
            with suppress(Exception):
                on_reconnect(attempts)
        delay = backoff_ms * 2 ** (attempts - 1)
        if deadline is not None:
            delay = min(delay, max(0.0, deadline - _now_ms()))
        _sleep_ms(delay)
        return not expired()

    while not expired():
        since = last_received_at - 1 if last_received_at is not None else resume_floor
        params = {"since": str(max(0, int(since)))} if since is not None else {}
        # Bounds the wait for headers and, where the deadline timer cannot (HTTP/2), each read.
        read_s: float | None = idle_ms / 1000 if idle_ms > 0 else None
        if deadline is not None:
            left = max(0.001, (deadline - _now_ms()) / 1000)
            read_s = left if read_s is None else min(read_s, left)
        connect_started = _now_ms()
        error: BaseException
        try:
            with client._http.stream(
                "GET",
                f"{client._base_url}/api/stream/{slug}",
                params=params,
                headers={**client._auth(), "Accept": "text/event-stream"},
                timeout=httpx.Timeout(_STREAM_CONNECT_TIMEOUT_S, read=read_s),
            ) as response:
                if response.status_code >= 400:
                    response.read()
                    raise _error_from_response(response)
                connected_at = _now_ms()
                if resume_floor is None:
                    resume_floor = _server_date_ms(response.headers) or connect_started - 1000
                # Keepalives reset httpx's read timeout, so the deadline needs a timer of its own.
                deadline_timer = (
                    _end_stream_at(response, (deadline - _now_ms()) / 1000)
                    if deadline is not None
                    else None
                )
                rotated = False
                try:
                    for frame in parse_sse(response.iter_lines()):
                        if expired():
                            return
                        if frame.event == "request":
                            request = _stream_request(frame.data)
                            if request is None:
                                continue
                            # A delivered request proves the stream healthy.
                            attempts = 0
                            if request.id and request.id in seen:
                                continue
                            if request.id:
                                seen.add(request.id)
                            last_received_at = (
                                request.received_at
                                if last_received_at is None
                                else max(last_received_at, request.received_at)
                            )
                            rapid_rotations = 0
                            yield request
                        elif frame.event == "timeout":
                            # The server's scheduled rotation (every 30 minutes): not a failure.
                            rapid = _now_ms() - connected_at < _STREAM_RAPID_ROTATION_MS
                            rapid_rotations = rapid_rotations + 1 if rapid else 0
                            rotated = True
                            break
                        elif frame.event == "endpoint_deleted":
                            return
                        elif frame.event == "comment":
                            attempts = 0  # a keepalive: the connection is healthy
                finally:
                    if deadline_timer is not None:
                        # Wait for a shutdown already under way before the connection is released.
                        deadline_timer.cancel()
                        deadline_timer.join()
            if expired():
                return
            if rotated:
                if not reconnect:
                    return
                if rapid_rotations >= _STREAM_RAPID_ROTATION_LIMIT and not back_off():
                    return
                continue
            # The stream ended without a terminal event (network drop, server restart).
            if back_off():
                continue
            return
        except (UnauthorizedError, NotFoundError):
            raise
        except (WebhooksCCError, httpx.TransportError) as caught:
            # The deadline timer ends a read with an error; that is the normal end.
            if expired():
                return
            if isinstance(caught, httpx.ReadTimeout):
                error = TimeoutError(
                    idle_ms, f"Stream idle for {idle_ms:g}ms: no data or keepalive received"
                )
            elif isinstance(caught, httpx.ConnectTimeout):
                error = TimeoutError(
                    _STREAM_CONNECT_TIMEOUT_S * 1000,
                    f"Stream connection timed out after {_STREAM_CONNECT_TIMEOUT_S * 1000:g}ms",
                )
            elif (
                isinstance(caught, WebhooksCCError)
                and caught.status_code != 429
                and caught.status_code < 500
            ):
                raise
            else:
                error = caught
        if back_off():
            continue
        if expired():
            return
        raise error
