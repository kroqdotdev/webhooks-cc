"""Error messages made from API answers, against the shared vectors."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tests.conformance import load, vector_id
from webhooks_cc import WebhooksCC, errors
from webhooks_cc.client import _error_code, _plain_error_text

VECTORS = load("errors")["vectors"]

# Where this SDK differs from the TypeScript one, and why, by vector name.
# Python reads a code only from ``error``, never from a ``code`` field.
CODE_DIFFERS = {
    "502 a code field beside a sentence": "the code field is not read",
    "429 search_busy as a code field": "the code field is not read",
}
# Not compared at all: a 429's message is this SDK's own rate-limit text, and
# InvalidCursorError's message is its own.


def _raise(vector: dict[str, Any]) -> errors.WebhooksCCError:
    status, body = vector["status"], vector["body"]
    client = WebhooksCC(
        "whcc_conformance",
        http_client=httpx.Client(
            transport=httpx.MockTransport(lambda request: httpx.Response(status, text=body))
        ),
    )
    with pytest.raises(errors.WebhooksCCError) as caught:
        client.endpoints.get("acme")
    return caught.value


@pytest.mark.parametrize("vector", VECTORS, ids=vector_id)
def test_error_vector(vector: dict[str, Any]) -> None:
    status, body, expected = vector["status"], vector["body"], vector["expected"]
    plain = _plain_error_text(status, body)
    assert plain == expected["message"]

    error = _raise(vector)
    assert error.status_code == status
    cursor = isinstance(error, errors.InvalidCursorError)
    code = _error_code(body)
    code_agrees = (
        code == expected["code"]
        and cursor == (status == 400 and code == "invalid_cursor")
        and (not isinstance(error, errors.RateLimitError) or error.code == code)
    )
    # A listed difference that no longer differs fails too, so the list stays true.
    assert code_agrees == (vector["name"] not in CODE_DIFFERS)

    if status == 429 or cursor:
        return
    hinted = status in (401, 404) and error.message != plain
    assert hinted == expected["hinted"]
    if hinted:
        assert error.message.startswith(plain)
    else:
        assert error.message == plain


def test_the_list_of_differences_names_real_vectors() -> None:
    assert set(CODE_DIFFERS) <= {vector["name"] for vector in VECTORS}
