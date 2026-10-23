"""Signing primitives shared by request building and signature verification.

These mirror the TypeScript SDK byte for byte; the conformance vectors in
``packages/sdk/conformance`` check that they do.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any, Literal

HashName = Literal["sha256", "sha1"]

_BASE64_ALPHABET = re.compile(r"^[A-Za-z0-9+/]*$")
_ASCII_WHITESPACE = re.compile(r"[\t\n\f\r ]")
_HEX = re.compile(r"^[a-fA-F0-9]+$")


def utf8(value: str | bytes) -> bytes:
    return value if isinstance(value, bytes) else value.encode("utf-8")


def hmac_digest(algorithm: HashName, key: str | bytes, payload: str | bytes) -> bytes:
    """HMAC of ``payload``; a ``str`` key or payload is taken as UTF-8."""
    digest = hashlib.sha256 if algorithm == "sha256" else hashlib.sha1
    return hmac.new(utf8(key), utf8(payload), digest).digest()


def to_hex(data: bytes) -> str:
    return data.hex()


def to_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def to_base64url(data: bytes) -> str:
    """Base64url without padding."""
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def from_base64(value: str) -> bytes:
    """Decode base64 the way browsers' ``atob`` does (WHATWG forgiving-base64).

    ASCII whitespace is ignored and padding is optional. Raises ``ValueError``
    for a character outside ``A-Z a-z 0-9 + /``, an ``=`` anywhere but as one
    or two final characters that make the length a multiple of 4, or 4n+1
    characters once padding is removed.
    """
    data = _ASCII_WHITESPACE.sub("", value)
    if len(data) % 4 == 0:
        if data.endswith("=="):
            data = data[:-2]
        elif data.endswith("="):
            data = data[:-1]
    if len(data) % 4 == 1 or not _BASE64_ALPHABET.match(data):
        raise ValueError("invalid base64")
    try:
        return base64.b64decode(data + "=" * (-len(data) % 4))
    except binascii.Error as error:  # pragma: no cover - excluded by the checks above
        raise ValueError("invalid base64") from error


def hex_to_bytes(value: str) -> bytes:
    normalized = value.strip()
    if not _HEX.match(normalized) or len(normalized) % 2 != 0:
        raise ValueError("Expected a hex-encoded value")
    return bytes.fromhex(normalized)


def decode_standard_webhook_secret(secret: str) -> bytes:
    """The HMAC key for a Standard Webhooks style secret.

    Standard Webhooks, Clerk, Resend and webhooks.cc forwarding use them.

    A leading ``whsec_`` is stripped and the rest decoded as base64. When that
    fails, the key is the UTF-8 bytes of the whole secret, prefix included.

    Raises ``ValueError`` when that leaves no key at all (``"whsec_"``, or only
    whitespace): an HMAC keyed with nothing is one anyone can compute, and
    WebCrypto refuses it in the TypeScript SDK too.
    """
    raw = secret[6:] if secret.startswith("whsec_") else secret
    try:
        key = from_base64(raw)
    except ValueError:
        key = secret.encode("utf-8")
    if not key:
        raise ValueError("The secret decodes to an empty key")
    return key


_HUBSPOT_ESCAPES = {
    "%3A": ":",
    "%2F": "/",
    "%3F": "?",
    "%40": "@",
    "%21": "!",
    "%24": "$",
    "%27": "'",
    "%28": "(",
    "%29": ")",
    "%2A": "*",
    "%2C": ",",
    "%3B": ";",
}
_HUBSPOT_ESCAPE_PATTERN = re.compile(r"%(?:3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)")


def decode_hubspot_uri(uri: str) -> str:
    """Decode exactly the escapes HubSpot decodes before signing, uppercase only."""
    return _HUBSPOT_ESCAPE_PATTERN.sub(lambda match: _HUBSPOT_ESCAPES[match.group(0)], uri)


def _utf16_key(value: str) -> bytes:
    # JavaScript compares strings by UTF-16 code unit; big-endian UTF-16 bytes sort the same way.
    return value.encode("utf-16-be", "surrogatepass")


def build_twilio_signature_payload(url: str, params: Sequence[tuple[str, str]]) -> str:
    """The URL followed by each parameter's name and value, sorted by name, then value."""
    ordered = sorted(params, key=lambda item: (_utf16_key(item[0]), _utf16_key(item[1])))
    return url + "".join(f"{key}{value}" for key, value in ordered)


def _adyen_field(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return js_string(value)


def adyen_data_to_sign(item: Mapping[str, Any]) -> str:
    """The fields of an Adyen notification item that its HMAC covers, joined with ``:``."""
    amount = item.get("amount")
    amount = amount if isinstance(amount, Mapping) else {}
    return ":".join(
        _adyen_field(value)
        for value in (
            item.get("pspReference"),
            item.get("originalReference"),
            item.get("merchantAccountCode"),
            item.get("merchantReference"),
            amount.get("value"),
            amount.get("currency"),
            item.get("eventCode"),
            item.get("success"),
        )
    )


def adyen_hmac(item: Mapping[str, Any], hex_key: str) -> str:
    """Base64 HMAC-SHA256 of an Adyen notification item, keyed with the hex HMAC key."""
    return to_base64(hmac_digest("sha256", hex_to_bytes(hex_key), adyen_data_to_sign(item)))


# --- JavaScript-compatible JSON -------------------------------------------------------


def js_number(value: float) -> str:
    """Format a number as JavaScript's ``String(number)`` does."""
    if isinstance(value, bool):
        raise TypeError("bool is not a number")
    if isinstance(value, int):
        return str(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # repr() gives the shortest round-tripping digits, as ECMAScript requires.
    mantissa, _, exp_part = repr(abs(value)).partition("e")
    exponent = int(exp_part) if exp_part else 0
    int_part, _, frac_part = mantissa.partition(".")
    digits = (int_part + frac_part).lstrip("0")
    # Position of the decimal point relative to the start of `digits` (ECMAScript's n).
    leading_zeros = len(int_part + frac_part) - len((int_part + frac_part).lstrip("0"))
    n = len(int_part) - leading_zeros + exponent
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    exp = f"e{'+' if e >= 0 else '-'}{abs(e)}"
    if k == 1:
        return sign + digits + exp
    return sign + digits[0] + "." + digits[1:] + exp


def js_string(value: Any) -> str:
    """JavaScript's ``String(value)`` for the primitive types JSON can hold."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    return str(value)


def js_json(value: Any) -> str:
    """Serialize like JavaScript's ``JSON.stringify(value)``.

    Compact, keys in their order, non-ASCII characters left as they are.
    """
    parts: list[str] = []
    _write_json(value, parts)
    return "".join(parts)


def _write_json(value: Any, out: list[str]) -> None:
    if value is None or value is True or value is False:
        out.append(js_string(value))
    elif isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, (int, float)):
        out.append(
            "null"
            if isinstance(value, float) and (math.isnan(value) or math.isinf(value))
            else js_number(value)
        )
    elif isinstance(value, Mapping):
        out.append("{")
        first = True
        for key, item in value.items():
            if not first:
                out.append(",")
            first = False
            out.append(json.dumps(str(key), ensure_ascii=False))
            out.append(":")
            _write_json(item, out)
        out.append("}")
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for index, item in enumerate(value):
            if index:
                out.append(",")
            _write_json(item, out)
        out.append("]")
    else:
        raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def json_body(value: Any) -> str:
    """A request body: strings are sent as they are, anything else as JSON."""
    return value if isinstance(value, str) else js_json(value)
