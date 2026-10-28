"""The agent credential file every webhooks.cc tool shares.

An agent that registered with webhooks.cc (see https://webhooks.cc/auth.md)
holds an identity assertion. The MCP server, the TypeScript, Python and Go
SDKs and the ``whk`` CLI keep it in one JSON file, so a connection a human
approved once survives restarts and works from every tool. The format is
``packages/sdk/conformance/agent-credentials.md`` in the repository.

The rules are pure functions of their inputs (:func:`resolve_agent_credentials_path`,
:func:`read_slots`, :func:`apply_write`), which the shared conformance vectors
drive; :class:`AgentCredentialStore` does the file I/O. Reads never fail and
writes are best effort: a broken file reads as empty, and a write that fails
is reported once as a warning, without the file's contents.
"""

from __future__ import annotations

import contextlib
import copy
import json
import logging
import os
import re
import secrets
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

AGENT_FILE_ENV = "WHK_AGENT_FILE"
"""The environment variable that names the file's full path, overriding the default."""

SlotName = Literal["claimed", "sandbox"]
"""``claimed``: a registration a human connected to their account. ``sandbox``: an
unclaimed anonymous registration."""

_FORMAT_VERSION = 1
# A slot or a cached token closer to expiry than this counts as gone.
_LIVE_MARGIN_MS = 60_000
_SLOT_NAMES: tuple[SlotName, ...] = ("claimed", "sandbox")
_REQUIRED = ("registration_id", "identity_assertion", "assertion_expires")
_OPTIONAL = (
    "scope",
    "email",
    "client_name",
    "saved_at",
    "access_token",
    "access_token_expires",
)
# ASCII digits only (Python's \d also takes other scripts' digits), uppercase T and Z only.
_RFC3339 = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$",
    re.ASCII,
)
_DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

_logger = logging.getLogger("webhooks_cc")
_warned = False


def _now_ms() -> float:
    return time.time() * 1000


def _days_from_civil(year: int, month: int, day: int) -> int:
    """Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm)."""
    year -= month <= 2
    era = (year if year >= 0 else year - 399) // 400
    year_of_era = year - era * 400
    day_of_year = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    day_of_era = year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year
    return era * 146097 + day_of_era - 719468


def _days_in_month(year: int, month: int) -> int:
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    return 29 if month == 2 and leap else _DAYS_IN_MONTH[month - 1]


def parse_timestamp(value: Any) -> float | None:
    """Milliseconds since the epoch of an RFC 3339 timestamp, or ``None``.

    Takes ``Z`` and numeric offsets, with or without fractions of a second (cut
    to milliseconds), and nothing else: a bare date, a lowercase ``t`` or ``z``,
    February 30, hour 24 and a leap second are all refused, as every port
    refuses them.
    """
    if not isinstance(value, str):
        return None
    match = _RFC3339.fullmatch(value)
    if match is None:
        return None
    year, month, day, hour, minute, second = (int(part) for part in match.group(1, 2, 3, 4, 5, 6))
    if not 1 <= month <= 12 or not 1 <= day <= _days_in_month(year, month):
        return None
    if hour > 23 or minute > 59 or second > 59:
        return None
    offset_ms = 0
    if match.group(8) != "Z":
        offset_hours, offset_minutes = int(match.group(10)), int(match.group(11))
        if offset_hours > 23 or offset_minutes > 59:
            return None
        sign = -1 if match.group(9) == "-" else 1
        offset_ms = sign * (offset_hours * 60 + offset_minutes) * 60_000
    millis = int((match.group(7) or "0")[:3].ljust(3, "0"))
    days = _days_from_civil(year, month, 1) + day - 1
    return float(
        days * 86_400_000 + ((hour * 60 + minute) * 60 + second) * 1000 + millis - offset_ms
    )


def format_timestamp(value: datetime | float) -> str:
    """An RFC 3339 timestamp in UTC with milliseconds, as JavaScript's ``toISOString()``."""
    if not isinstance(value, datetime):
        value = datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    utc = value.astimezone(timezone.utc)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


# --- where the file lives -----------------------------------------------------------


def _join(base: str, parts: tuple[str, ...], separator: str) -> str:
    end = len(base)
    while end > 1 and base[end - 1] in "/\\":
        end -= 1
    return separator.join((base[:end], *parts))


def resolve_agent_credentials_path(
    platform: str, home: str | None, env: Mapping[str, str]
) -> str | None:
    """The file's path for a platform, home directory and environment, or ``None``.

    ``platform`` takes ``sys.platform`` names: ``win32`` uses ``%APPDATA%``,
    ``darwin`` ``~/Library/Application Support``, and everything else
    ``$XDG_CONFIG_HOME`` when it is absolute, else ``~/.config``; the file is
    ``whk/agent.json`` in there, next to the CLI's ``token.json``.
    ``WHK_AGENT_FILE``, when set and not empty, is the path instead. ``None``
    means there is no file: nothing is read or written.
    """
    override = env.get(AGENT_FILE_ENV)
    if override:
        return override
    if platform == "win32":
        appdata = env.get("APPDATA") or (
            _join(home, ("AppData", "Roaming"), "\\") if home else None
        )
        return _join(appdata, ("whk", "agent.json"), "\\") if appdata else None
    base: str | None
    if platform == "darwin":
        base = _join(home, ("Library", "Application Support"), "/") if home else None
    else:
        xdg = env.get("XDG_CONFIG_HOME")
        if xdg and xdg.startswith("/"):
            base = xdg
        else:
            base = _join(home, (".config",), "/") if home else None
    return _join(base, ("whk", "agent.json"), "/") if base else None


def _home_dir() -> str | None:
    if os.name == "posix" and not os.environ.get("HOME"):
        try:
            import pwd

            return pwd.getpwuid(os.getuid()).pw_dir or None
        except (ImportError, KeyError, OSError):
            return None
    try:
        home = os.path.expanduser("~")
    except (ImportError, KeyError, OSError, RuntimeError):
        return None
    return home if home and home != "~" else None


def agent_credentials_path() -> Path | None:
    """The file's path in this process (see :func:`resolve_agent_credentials_path`)."""
    resolved = resolve_agent_credentials_path(sys.platform, _home_dir(), os.environ)
    return Path(resolved) if resolved else None


def normalize_issuer(base_url: str) -> str:
    """The key of an app's entry: trailing slashes removed, scheme and host lowercased.

    ``https://WebHooks.cc/`` and ``https://webhooks.cc`` are the same issuer; a
    path, if any, keeps its case.
    """
    url = base_url.rstrip("/")
    scheme = url.find("://")
    if scheme < 0:
        return url
    path_start = url.find("/", scheme + 3)
    if path_start < 0:
        return url.lower()
    return url[:path_start].lower() + url[path_start:]


# --- reading ------------------------------------------------------------------------


@dataclass(frozen=True)
class AgentSlot:
    """One registration in the file. Only ``registration_id``, ``identity_assertion``
    and ``assertion_expires`` are required; the rest is informational, except the
    cached ``access_token`` and its expiry."""

    registration_id: str
    identity_assertion: str = field(repr=False)
    assertion_expires: str
    scope: str | None = None
    email: str | None = None
    client_name: str | None = None
    saved_at: str | None = None
    access_token: str | None = field(default=None, repr=False)
    access_token_expires: str | None = None

    @classmethod
    def from_dict(cls, value: Any) -> AgentSlot | None:
        """The slot when it is well formed, else ``None``. Says nothing about expiry."""
        if not isinstance(value, Mapping):
            return None
        for key in _REQUIRED:
            if not isinstance(value.get(key), str) or value[key] == "":
                return None
        if parse_timestamp(value["assertion_expires"]) is None:
            return None
        optional = {key: value[key] for key in _OPTIONAL if isinstance(value.get(key), str)}
        return cls(
            registration_id=value["registration_id"],
            identity_assertion=value["identity_assertion"],
            assertion_expires=value["assertion_expires"],
            **optional,
        )

    def to_dict(self) -> dict[str, str]:
        """The slot as the file stores it, without the fields that are ``None``."""
        out = {key: getattr(self, key) for key in _REQUIRED}
        out.update({key: getattr(self, key) for key in _OPTIONAL if getattr(self, key) is not None})
        return out

    def is_live(self, now_ms: float | None = None) -> bool:
        """True when the assertion has more than a minute left."""
        expires = parse_timestamp(self.assertion_expires)
        now = _now_ms() if now_ms is None else now_ms
        return expires is not None and expires - now > _LIVE_MARGIN_MS

    def usable_token(self, now_ms: float | None = None) -> str | None:
        """The cached access token, when it starts with ``whcc_`` and has more than a
        minute left."""
        token = self.access_token
        if not token or not token.startswith("whcc_"):
            return None
        expires = parse_timestamp(self.access_token_expires)
        now = _now_ms() if now_ms is None else now_ms
        return token if expires is not None and expires - now > _LIVE_MARGIN_MS else None


@dataclass(frozen=True)
class AgentSlots:
    """The live slots for one issuer; ``None`` where there is none."""

    claimed: AgentSlot | None = None
    sandbox: AgentSlot | None = None


def _is_version_one(value: Any) -> bool:
    # JSON has one number type: 1 and 1.0 are the same value, true is not a number.
    return not isinstance(value, bool) and isinstance(value, (int, float)) and value == 1


def read_slots(file: Any, issuer: str, now_ms: float) -> AgentSlots:
    """The live slots for ``issuer`` in a parsed file (``None`` when there is no file)."""
    if not isinstance(file, dict) or not _is_version_one(file.get("version", None)):
        return AgentSlots()
    issuers = file.get("issuers")
    if not isinstance(issuers, dict):
        return AgentSlots()
    entry = issuers.get(normalize_issuer(issuer))
    if not isinstance(entry, dict):
        return AgentSlots()

    def live(value: Any) -> AgentSlot | None:
        slot = AgentSlot.from_dict(value)
        return slot if slot is not None and slot.is_live(now_ms) else None

    return AgentSlots(claimed=live(entry.get("claimed")), sandbox=live(entry.get("sandbox")))


# --- writing ------------------------------------------------------------------------


Unchanged = Literal["unchanged"]


def apply_write(
    before: Any,
    issuer: str,
    name: SlotName,
    slot: AgentSlot | Mapping[str, Any] | None,
    now_ms: float,
) -> dict[str, Any] | Unchanged | None:
    """The file after setting slot ``name`` of ``issuer`` to exactly ``slot``, or removing
    it when ``slot`` is ``None``.

    ``before`` is the parsed file (``None`` when it is missing; anything that does
    not parse counts as missing). Returns the new JSON value, ``None`` when the
    file should be deleted, or ``"unchanged"`` when a newer format owns the file
    and nothing may be written. Other issuers and unknown keys are kept; slots
    that are no longer live, and issuers left empty, are dropped.
    """
    if isinstance(before, dict) and "version" in before and not _is_version_one(before["version"]):
        return "unchanged"
    root: dict[str, Any] = (
        copy.deepcopy(before)
        if isinstance(before, dict) and _is_version_one(before.get("version"))
        else {"version": _FORMAT_VERSION}
    )
    issuers: dict[str, Any] = root["issuers"] if isinstance(root.get("issuers"), dict) else {}
    key = normalize_issuer(issuer)
    entry: dict[str, Any] = issuers[key] if isinstance(issuers.get(key), dict) else {}
    if slot is None:
        entry.pop(name, None)
    else:
        entry[name] = slot.to_dict() if isinstance(slot, AgentSlot) else dict(slot)
    issuers[key] = entry

    for issuer_key, value in list(issuers.items()):
        if not isinstance(value, dict):
            del issuers[issuer_key]
            continue
        for slot_name in _SLOT_NAMES:
            if slot_name not in value:
                continue
            parsed = AgentSlot.from_dict(value[slot_name])
            if parsed is None or not parsed.is_live(now_ms):
                del value[slot_name]
        if not value:
            del issuers[issuer_key]
    if not issuers:
        return None
    root["issuers"] = issuers
    return root


def _reject_constant(name: str) -> Any:
    # JSON has no NaN or Infinity; Python's parser accepts them, JavaScript's does not.
    raise ValueError(f"invalid JSON constant {name}")


def parse_file_text(text: str) -> Any:
    """The parsed file, or ``None`` when it is not JSON."""
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except ValueError:
        return None


_UNREADABLE: Any = object()


def _warn_once(message: str) -> None:
    global _warned
    if _warned:
        return
    _warned = True
    _logger.warning("webhooks.cc: %s", message)


_Keep = object()
"""Returned by a slot update that leaves the file alone."""

SlotUpdate = Callable[[AgentSlot | None, dict[str, Any]], object]
"""Gets the live slot (or ``None``) and the slot as stored, unknown keys included; returns
a slot to set, ``None`` to remove it, or ``_Keep`` to leave the file alone."""


class AgentCredentialStore:
    """Reads and writes the credential file at ``path``.

    Every method is best effort: a broken file reads as empty, and a write that
    fails is reported once, without contents, while the caller carries on with
    what it holds in memory.
    """

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    @classmethod
    def resolve(cls, file: bool | str | os.PathLike[str] = True) -> AgentCredentialStore | None:
        """The store for ``WHK_AGENT_FILE`` or the default path (``True``), a given
        path, or none at all (``False``, or no home directory)."""
        if file is False:
            return None
        if file is True:
            path = agent_credentials_path()
            return cls(path) if path is not None else None
        return cls(file)

    def _read_raw(self) -> Any:
        """The parsed file; None when it is missing or not JSON, ``_UNREADABLE``
        when it exists but cannot be read now (it must not be written over)."""
        try:
            text = self.path.read_text(encoding="utf-8")
        except (FileNotFoundError, NotADirectoryError):
            return None
        except UnicodeDecodeError:
            return None
        except OSError:
            return _UNREADABLE
        return parse_file_text(text)

    def load(self, base_url: str) -> AgentSlots:
        """The live slots for the app at ``base_url``."""
        raw = self._read_raw()
        return read_slots(None if raw is _UNREADABLE else raw, base_url, _now_ms())

    def save(self, base_url: str, name: SlotName, slot: AgentSlot | Mapping[str, Any]) -> None:
        """Set slot ``name`` to ``slot``."""
        self.update(base_url, name, lambda _current, _stored: slot)

    def remove(self, base_url: str, name: SlotName, *, registration_id: str | None = None) -> None:
        """Remove slot ``name``; with ``registration_id``, only while it holds that
        registration."""

        def change(current: AgentSlot | None, _stored: dict[str, Any]) -> object:
            if registration_id is not None and (
                current is None or current.registration_id != registration_id
            ):
                return _Keep
            return None

        self.update(base_url, name, change)

    def save_token(
        self,
        base_url: str,
        name: SlotName,
        registration_id: str,
        access_token: str | None,
        expires: datetime | None,
    ) -> None:
        """Cache an access token in slot ``name`` while it holds ``registration_id``
        (``None`` drops the cached one)."""

        def change(current: AgentSlot | None, stored: dict[str, Any]) -> object:
            if current is None or current.registration_id != registration_id:
                return _Keep
            stored.pop("access_token", None)
            stored.pop("access_token_expires", None)
            if access_token is not None and expires is not None:
                stored["access_token"] = access_token
                stored["access_token_expires"] = format_timestamp(expires)
            return stored

        self.update(base_url, name, change)

    def update(self, base_url: str, name: SlotName, change: SlotUpdate) -> None:
        """Read the file again and write slot ``name`` as ``change`` returns it."""
        before = self._read_raw()
        if before is _UNREADABLE:
            _warn_once(f"could not read the agent credential file at {self.path}; left it as it is")
            return
        current: AgentSlot | None = getattr(read_slots(before, base_url, _now_ms()), name)
        issuers = before.get("issuers") if isinstance(before, dict) else None
        entry = issuers.get(normalize_issuer(base_url)) if isinstance(issuers, dict) else None
        stored = entry.get(name) if isinstance(entry, dict) else None
        result = change(current, dict(stored) if isinstance(stored, dict) else {})
        if result is _Keep:
            return
        slot = result if isinstance(result, (AgentSlot, Mapping)) else None
        after = apply_write(before, base_url, name, slot, _now_ms())
        if after == "unchanged":
            return
        if after is None:
            try:
                self.path.unlink(missing_ok=True)
            except OSError:
                _warn_once(f"could not remove the agent credential file at {self.path}")
            return
        self._write_atomically(after)

    def _write_atomically(self, value: dict[str, Any]) -> None:
        directory = self.path.parent
        temp = directory / f"{self.path.name}.{secrets.token_hex(6)}.tmp"
        try:
            if not directory.exists():
                directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, (json.dumps(value, indent=2) + "\n").encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(temp, self.path)
        except OSError:
            with contextlib.suppress(OSError):
                temp.unlink(missing_ok=True)
            _warn_once(f"could not write the agent credential file at {self.path}")
