"""A marker for arguments that were not given, where ``None`` has a meaning of its own."""

from __future__ import annotations

from typing import Any


class _Unset:
    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET: Any = _Unset()
