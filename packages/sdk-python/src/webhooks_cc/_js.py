"""Text read the way JavaScript reads it.

The TypeScript SDK is the reference, so where it trims a string, reads a number
or matches ``\\s`` and ``\\d``, this port must treat the same characters the same
way. Python's own rules differ: ``str.strip()`` and ``\\s`` also take
``\\x1c``-``\\x1f`` and ``\\x85`` but not ``\\ufeff``, and ``\\d`` and ``float()``
accept digits from every script.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

# What String.prototype.trim(), Number() and a regular expression's \s treat as whitespace.
JS_WHITESPACE = "".join(
    chr(code)
    for code in (
        *(0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680),
        *range(0x2000, 0x200B),
        *(0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF),
    )
)

# A regular-expression class equal to JavaScript's \s.
JS_SPACE = f"[{re.escape(JS_WHITESPACE)}]"

_JS_DECIMAL = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
# One digit class per base: int() would also take a second prefix ("0x0x10").
_JS_RADIX = re.compile(r"0(?:[xX]([0-9a-fA-F]+)|[oO]([0-7]+)|[bB]([01]+))")


def js_trim(value: str) -> str:
    """JavaScript's ``value.trim()``."""
    return value.strip(JS_WHITESPACE)


def js_to_number(value: str | None) -> float:
    """JavaScript's ``Number(value)`` for a string: NaN when it is not a number, 0 when blank."""
    if value is None:
        return math.nan
    text = js_trim(value)
    if text == "":
        return 0.0
    if _JS_DECIMAL.fullmatch(text):
        return float(text.replace("Infinity", "inf"))
    radix_match = _JS_RADIX.fullmatch(text)
    if radix_match:
        hex_digits, octal_digits, binary_digits = radix_match.groups()
        if hex_digits is not None:
            return float(int(hex_digits, 16))
        if octal_digits is not None:
            return float(int(octal_digits, 8))
        return float(int(binary_digits, 2))
    return math.nan


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def json_parse(text: str | bytes) -> Any:
    """JavaScript's ``JSON.parse``: ``json.loads`` without NaN and Infinity, which it refuses."""
    return json.loads(text, parse_constant=_reject_constant)
