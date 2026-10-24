"""Text read the way JavaScript reads it, as the TypeScript SDK reads it.

Each expected value is what Node gives for the same input.
"""

from __future__ import annotations

import json
import math
import time

import httpx
import pytest

from webhooks_cc._crypto import js_json
from webhooks_cc._js import js_to_number, js_trim
from webhooks_cc.client import _int_header, _resolve_time
from webhooks_cc.durations import parse_duration
from webhooks_cc.matchers import match_content_type
from webhooks_cc.models import Request
from webhooks_cc.verify import _canonical_paypal_certificate_url


def test_json_puts_array_index_keys_first() -> None:
    # JSON.stringify(JSON.parse(...)): keys that are array indexes (up to 2**32 - 2)
    # come first, ascending; "01" and 4294967295 are ordinary keys.
    parsed = json.loads('{"b":1,"10":2,"2":3,"a":4,"01":5,"4294967295":6,"4294967294":7}')
    assert js_json(parsed) == '{"2":3,"10":2,"4294967294":7,"b":1,"a":4,"01":5,"4294967295":6}'
    assert js_json({"b": {"1": True, "0": None}}) == '{"b":{"0":null,"1":true}}'


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("\u0663", math.nan),  # an Arabic-Indic digit is not a digit to Number()
        ("\ufeff 12 ", 12.0),
        ("\x1c12", math.nan),
        ("\x85 1", math.nan),
        ("0x10", 16.0),
        ("", 0.0),
        ("1_0", math.nan),
    ],
)
def test_numbers_read_like_javascript(text: str, expected: float) -> None:
    number = js_to_number(text)
    assert (math.isnan(number) and math.isnan(expected)) or number == expected


def test_trim_takes_javascripts_whitespace() -> None:
    assert js_trim(" \ufeffa\x85") == "a\x85"
    assert js_trim("\x1ca\x1c") == "\x1ca\x1c"


def test_durations_take_javascripts_whitespace_and_ascii_digits() -> None:
    assert parse_duration("\ufeff5\ufeffs") == 5000
    for text in ("5\x85s", "\u0663s", "\x1c5s"):
        with pytest.raises(ValueError):
            parse_duration(text)


def test_header_numbers_take_ascii_digits_after_javascripts_whitespace() -> None:
    # parseInt(value, 10), on a header read as Latin-1
    def header(value: str) -> httpx.Headers:
        return httpx.Headers([(b"retry-after", value.encode("latin-1"))])

    assert _int_header(header("\xa07"), "retry-after") == 7
    assert _int_header(header("\x857"), "retry-after") is None


def test_timestamp_filters_read_numbers_like_javascript() -> None:
    assert _resolve_time("0x10") == 16
    assert abs(_resolve_time("\ufeff1h") - (time.time() * 1000 - 3_600_000)) < 5_000
    with pytest.raises(ValueError):
        _resolve_time("nan")  # NaN to Number(), and not a duration


def test_content_types_trim_like_javascript() -> None:
    request = Request.from_dict(
        {
            "id": "r1",
            "endpointId": "e1",
            "method": "POST",
            "path": "/",
            "headers": {"content-type": "\ufeffapplication/json; charset=utf-8"},
            "body": "{}",
            "queryParams": {},
            "ip": "203.0.113.7",
            "size": 2,
            "receivedAt": 0,
        }
    )
    assert match_content_type("application/json")(request)
    assert not match_content_type("\x1capplication/json")(request)


def test_paypal_urls_read_a_backslash_as_a_slash_only_before_the_query() -> None:
    # new URL(...).href, without the fragment
    assert (
        _canonical_paypal_certificate_url(
            "https://api.paypal.com\\v1\\notifications\\certs\\CERT-1?a=b\\c#x\\y"
        )
        == "https://api.paypal.com/v1/notifications/certs/CERT-1?a=b\\c"
    )
