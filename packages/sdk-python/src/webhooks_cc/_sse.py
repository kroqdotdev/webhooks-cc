"""Server-sent events, as the request stream sends them."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass


@dataclass(frozen=True)
class SSEFrame:
    event: str
    data: str


def parse_sse(lines: Iterable[str]) -> Iterator[SSEFrame]:
    """Frames from the lines of an event stream (line endings already removed).

    ``data:`` lines join with newlines, a blank line ends a frame, and a
    comment (``: ...``) is yielded as a frame with event ``"comment"``, which
    is how the server's keepalives show up. Other fields are ignored.
    """
    event = "message"
    data: list[str] = []
    for line in lines:
        if line == "":
            if data:
                yield SSEFrame(event, "\n".join(data))
            data = []
            event = "message"
            continue
        if line.startswith(":"):
            comment = line[1:]
            yield SSEFrame("comment", comment[1:] if comment.startswith(" ") else comment)
            continue
        name, colon, value = line.partition(":")
        if not colon:
            continue
        if value.startswith(" "):
            value = value[1:]
        if name == "event":
            event = value
        elif name == "data":
            data.append(value)
    if data:
        yield SSEFrame(event, "\n".join(data))
