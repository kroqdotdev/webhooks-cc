"""Errors raised by the webhooks.cc SDK."""

from __future__ import annotations

import builtins
from typing import Any, Literal


class WebhooksCCError(Exception):
    """Base class for API errors. ``status_code`` is the HTTP status (0 for timeouts)."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message

    def __reduce__(self) -> tuple[Any, ...]:
        # Rebuild from the attributes, so errors survive pickling (multiprocessing).
        return (_rebuild, (type(self), self.__dict__.copy()))


class UnauthorizedError(WebhooksCCError):
    """The API key is invalid or missing (401)."""

    def __init__(self, message: str = "Invalid or missing API key") -> None:
        super().__init__(401, message)


class NotFoundError(WebhooksCCError):
    """The endpoint, request or other resource does not exist (404)."""

    def __init__(self, message: str = "Resource not found") -> None:
        super().__init__(404, message)


class TimeoutError(WebhooksCCError, builtins.TimeoutError):
    """A request timed out, a wait ran out of time, or a stream went idle.

    Also a built-in ``TimeoutError``, so ``except TimeoutError`` catches it either way.
    """

    def __init__(self, timeout_ms: float, message: str | None = None) -> None:
        super().__init__(0, message or f"Request timed out after {_format_ms(timeout_ms)}ms")
        self.timeout_ms = timeout_ms


class RateLimitError(WebhooksCCError):
    """The API answered 429. ``retry_after`` is in seconds when the server said."""

    def __init__(
        self,
        retry_after: int | None = None,
        *,
        limit: int | None = None,
        remaining: int | None = None,
        reset: int | None = None,
    ) -> None:
        message = (
            f"Rate limited, retry after {retry_after}s"
            if retry_after is not None
            else "Rate limited"
        )
        super().__init__(429, message)
        self.retry_after = retry_after
        self.limit = limit
        self.remaining = remaining
        self.reset = reset


WebhookVerificationErrorCode = Literal[
    "missing_headers", "timestamp_out_of_range", "invalid_signature", "invalid_payload"
]


class WebhookVerificationError(Exception):
    """A request is not a genuine delivery from webhooks.cc forwarding.

    Raised by ``verify_forwarded_email()``, ``verify_forwarded_request()`` and
    ``verify_relayed_request()``. Answer it with 401, or 400 for ``invalid_payload``.
    """

    def __init__(self, code: WebhookVerificationErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: WebhookVerificationErrorCode = code
        self.message = message

    def __reduce__(self) -> tuple[Any, ...]:
        return (_rebuild, (type(self), self.__dict__.copy()))


def _rebuild(cls: type[Exception], state: dict[str, Any]) -> Exception:
    error = cls.__new__(cls)
    Exception.__init__(error, state.get("message", ""))
    error.__dict__.update(state)
    return error


def _format_ms(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)
