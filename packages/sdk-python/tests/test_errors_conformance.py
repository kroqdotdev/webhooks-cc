"""Error messages made from API answers, against the shared vectors."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tests.conformance import load, vector_id
from webhooks_cc import WebhooksCC, errors
from webhooks_cc.client import _error_code, _plain_error_text

VECTORS = load("errors")["vectors"]

# Where this SDK differs from the TypeScript one on purpose, by vector name.

# Python counts code points for the 30-character hint threshold, TypeScript
# UTF-16 units, so 20 emoji (40 units) are short here and get a hint.
HINT_DIFFERS = {
    "404 20 emoji": "20 code points are under 30 here; TypeScript counts 40 UTF-16 units",
}

# Python reads a code only from ``error``, wherever it is in the body and
# whatever it holds; TypeScript only from a leading ``error`` that is a code,
# or a ``code`` field.
CODE_DIFFERS = {
    "502 a code field beside a sentence": "the code field is not read",
    "429 search_busy as a code field": "the code field is not read",
    "400 message before invalid_cursor": "error is read wherever it is in the body",
    "429 a sentence": "RateLimitError.code is the error as sent, a sentence included",
}


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
    name = vector["name"]
    code_agrees = (
        (expected["code"] is None or _error_code(body) == expected["code"])
        and cursor == (status == 400 and expected["code"] == "invalid_cursor")
        and (not isinstance(error, errors.RateLimitError) or error.code == expected["code"])
    )
    # A listed difference that no longer differs fails too, so the list stays true.
    assert code_agrees == (name not in CODE_DIFFERS)

    # 429 and an invalid cursor have messages of their own.
    if status == 429 or cursor:
        return
    hinted = status in (401, 404) and error.message != plain
    if name in HINT_DIFFERS:
        assert hinted != expected["hinted"]
        return
    assert hinted == expected["hinted"]
    if hinted:
        assert error.message.startswith(plain)
    else:
        assert error.message == plain


def test_the_lists_of_differences_name_real_vectors() -> None:
    names = {vector["name"] for vector in VECTORS}
    assert set(HINT_DIFFERS) <= names
    assert set(CODE_DIFFERS) <= names
