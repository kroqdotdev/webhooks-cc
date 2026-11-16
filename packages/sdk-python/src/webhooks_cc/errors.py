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
        code: str | None = None,
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
        self.code = code
        """The server's error code when it sent one: ``"search_busy"`` when the
        account already runs two searches or the server is at its limit."""


class CheckoutExpiredError(WebhooksCCError):
    """A checkout link expired before the person paid. Make a new one if they still
    want it. Raised by ``billing.wait_for_checkout()``.

    ``reason`` is ``"unsettled"`` when it expired while Polar never said it was
    unpaid (a payment still being confirmed a day later, or Polar not answering):
    the person may have paid, a payment that lands still turns the link paid, and
    webhooks.cc has been alerted, so check billing before making a new link."""

    def __init__(
        self,
        checkout_id: str,
        message: str | None = None,
        *,
        reason: Literal["unsettled"] | None = None,
    ) -> None:
        if message is None:
            message = (
                "The checkout link expired before Polar confirmed a payment for it. "
                "If the person paid, it is still applied to the account once Polar "
                "confirms it, and webhooks.cc has been alerted; check billing before "
                "making a new link."
                if reason == "unsettled"
                else "The checkout link expired before it was paid. "
                "Make a new one if the person still wants it."
            )
        super().__init__(0, message)
        self.checkout_id = checkout_id
        self.reason = reason


class CheckoutSupersededError(CheckoutExpiredError):
    """A checkout link was paid, but the purchase was undone as a duplicate: the
    account already had that plan or add-on (or what it added to had ended), so
    its subscription was ended and a refund of what it charged is under review
    (monthly blocks bought twice stay as one-time blocks; a second overage
    subscription charged nothing). A :class:`CheckoutExpiredError` too, so code
    that handles a link that bought nothing handles this one. Raised by
    ``billing.wait_for_checkout()``."""

    def __init__(self, checkout_id: str) -> None:
        super().__init__(
            checkout_id,
            "By the time this checkout was paid, the account already had what it buys "
            "(or what it added to had ended), so the purchase was undone: its "
            "subscription was ended and a refund of what it charged is under review. "
            "Monthly blocks bought twice stay on the account as one-time blocks "
            "instead, and a second overage subscription was ended before it charged "
            "anything.",
        )


class InvalidCursorError(WebhooksCCError):
    """The search cursor is not one the server issued for this search (400).

    Raised by ``requests.search_page()`` and ``requests.count_page()`` for a cursor
    that was changed, or that came from a search in the other order. Start the
    search again without a cursor.
    """

    def __init__(self, message: str = "Invalid search cursor") -> None:
        super().__init__(400, message)


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


def wait_timeout_message(
    timeout_ms: float,
    *,
    noun: Literal["request", "email"],
    slug: str,
    wanted: int,
    matched: int,
    seen: int,
    criteria: str | None = None,
    filtered: bool = False,
) -> str:
    """A wait's timeout in words: ``Timed out after 30000ms waiting for 2 emails
    with subject "Confirm" on endpoint "acme" (1 arrived, 3 did not match)``."""
    article = "an" if noun == "email" else "a"
    what = f"{article} {noun}" if wanted == 1 else f"{wanted} {noun}s"
    if criteria:
        what += f" with {criteria}"
    if filtered:
        what += " accepted by match"
    notes: list[str] = []
    if matched > 0:
        notes.append(f"{matched} arrived")
    if seen - matched > 0:
        notes.append(f"{seen - matched} did not match")
    if seen == 0:
        notes.append("none arrived")
    return (
        f"Timed out after {_format_ms(timeout_ms)}ms waiting for {what} "
        f'on endpoint "{slug}" ({", ".join(notes)})'
    )


def _rebuild(cls: type[Exception], state: dict[str, Any]) -> Exception:
    error = cls.__new__(cls)
    Exception.__init__(error, state.get("message", ""))
    error.__dict__.update(state)
    return error


def _format_ms(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)
