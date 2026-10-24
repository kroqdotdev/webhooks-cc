"""Text read the way JavaScript reads it.

The TypeScript SDK is the reference, so where it trims a string, reads a number
or matches ``\\s`` and ``\\d``, this port must treat the same characters the same
way. Python's own rules differ: ``str.strip()`` and ``\\s`` also take
``\\x1c``-``\\x1f`` and ``\\x85`` but not ``\\ufeff``, and ``\\d`` and ``float()``
accept digits from every script.
"""

from __future__ import annotations

import math
import re

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
_JS_RADIX = re.compile(r"0([xXoObB])([0-9a-zA-Z]+)")


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
        base = {"x": 16, "o": 8, "b": 2}[radix_match.group(1).lower()]
        try:
            return float(int(radix_match.group(2), base))
        except ValueError:
            return math.nan
    return math.nan
