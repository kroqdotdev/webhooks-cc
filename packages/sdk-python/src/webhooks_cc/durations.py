"""Durations for timeouts and poll intervals."""

from __future__ import annotations

import math
import re
from datetime import timedelta
from typing import TypeAlias

Duration: TypeAlias = int | float | str | timedelta
"""``"30s"``, ``"500ms"``, ``"5m"``, ``"2h"`` or ``"7d"``, a ``timedelta``, or milliseconds."""

_PLAIN_NUMBER = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")
_DURATION = re.compile(r"^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h|d)$")
_UNIT_MS = {"ms": 1, "s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}


def parse_duration(value: Duration) -> float:
    """A duration in milliseconds.

    A number is taken as milliseconds, as in every webhooks.cc SDK, so prefer
    a string (``"30s"``) or a ``timedelta`` where seconds are meant. A string
    is trimmed, then must be decimal digits with an optional fraction,
    optionally followed by a unit (``ms``, ``s``, ``m``, ``h`` or ``d``,
    lowercase); without a unit it is milliseconds.

    Raises ``ValueError`` for anything else, including negative values.
    """
    if isinstance(value, timedelta):
        ms = value.total_seconds() * 1000
        if ms < 0:
            raise ValueError(f"Invalid duration: must not be negative, got {value!r}")
        return ms
    if isinstance(value, bool):
        raise ValueError(f"Invalid duration: {value!r}")
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value < 0:
            raise ValueError(
                f"Invalid duration: must be a finite non-negative number, got {value!r}"
            )
        return value
    if not isinstance(value, str):
        raise ValueError(f"Invalid duration: {value!r}")

    trimmed = value.strip()
    if _PLAIN_NUMBER.fullmatch(trimmed):
        return _number(trimmed)
    match = _DURATION.fullmatch(trimmed)
    if not match:
        raise ValueError(f'Invalid duration: "{value}"')
    return _number(match.group(1)) * _UNIT_MS[match.group(2)]


def _number(text: str) -> float:
    number = float(text)
    return int(number) if number.is_integer() and "." not in text else number
