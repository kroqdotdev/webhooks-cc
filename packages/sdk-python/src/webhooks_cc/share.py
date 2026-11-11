"""Share a port on this computer at a public link, by running the webhooks.cc CLI.

:func:`share` runs ``whk share <port> --json --until-stdin-closes`` and reads the
events it prints, one JSON object a line. The tunnel is the CLI's: this only
starts it, listens and stops it.

.. code-block:: python

    from webhooks_cc import share

    with share(3000) as live:
        print(live.url)  # https://sample-preview-1234-free.sharehooks.cc
        ...
    # leaving the block stops the share

``WebhooksCC.shares.start()`` does the same with the client's own account.
"""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any, Literal

from .errors import WebhooksCCError

WHK_INSTALL_COMMAND = "curl -fsSL https://webhooks.cc/install.sh | sh"
"""How to install the CLI on macOS and Linux (Homebrew: ``brew install kroqdotdev/tap/whk``)."""

WHK_INSTALL_WINDOWS = (
    "download whk for Windows from https://github.com/kroqdotdev/webhooks-cc/releases "
    "and put it on your PATH"
)
"""How to get the CLI on Windows, which has no install script: a release download."""

_OPEN_TIMEOUT_S = 60.0
"""How long :func:`share` waits for the link before giving up."""

_STOP_TIMEOUT_S = 5.0
"""How long :meth:`LiveShare.stop` waits after closing the CLI's stdin before it
terminates it, and then again before it kills it."""

_EVENT_BUFFER = 256
"""How many events wait for a reader of :meth:`LiveShare.events`; past it, new
ones are dropped (as the Go SDK does), so a share used only through callbacks
never piles them up and never waits on its reader."""

_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")


def whk_install_hint(platform: str | None = None) -> str:
    """How to install the CLI on ``platform`` (default: this one, as ``sys.platform``)."""
    return WHK_INSTALL_WINDOWS if (platform or sys.platform) == "win32" else WHK_INSTALL_COMMAND


def _install_clause() -> str:
    hint = whk_install_hint()
    return f"run: {hint}" if hint == WHK_INSTALL_COMMAND else f"{hint}."


@dataclass(frozen=True)
class ShareRequestEvent:
    """One visitor request, as the CLI reports it once answered."""

    method: str
    path: str
    status: int
    ms: int


ShareEventName = Literal["live", "reconnected", "request", "notice", "retrying", "stopped", "error"]


@dataclass(frozen=True)
class ShareEvent:
    """One line ``whk share --json`` printed: ``event`` names it, ``data`` holds it all."""

    event: str
    data: dict[str, Any]


_running: set[subprocess.Popen[bytes]] = set()
_running_lock = threading.Lock()


def _stop_all() -> None:
    # No share outlives the program that started it, however it ends.
    with _running_lock:
        children = list(_running)
    for child in children:
        if child.poll() is None:
            with contextlib.suppress(OSError):
                child.terminate()


atexit.register(_stop_all)


def _check(port: int, name: str | None, password: str | None) -> None:
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise WebhooksCCError(0, f"{port!r} is not a port (1 to 65535).")
    if name is not None and not _NAME.fullmatch(name):
        raise WebhooksCCError(
            0,
            "A share name is lowercase letters, digits and dashes, "
            "starting with a letter or digit.",
        )
    if password is not None and not 8 <= len(password) <= 200:
        raise WebhooksCCError(0, "A share password is 8 to 200 characters.")


def _cli_problem(bin_path: str, stderr: str) -> str | None:
    if re.search(r"unrecognized subcommand|unexpected argument", stderr, re.IGNORECASE):
        return (
            f"Sharing a port needs a newer whk than the one at {bin_path}. Update it with "
            f"`whk update`; to install it again, {_install_clause()}"
        )
    return None


class LiveShare:
    """A running share: its link, what the plan says about it, and :meth:`stop`.

    A context manager: leaving the ``with`` block stops the share. :meth:`events`
    iterates the events the CLI prints until it ends (at most 256 unread are
    held; the callbacks see every one); :meth:`wait` blocks until it ends and
    returns why.
    """

    def __init__(
        self,
        child: subprocess.Popen[bytes],
        port: int,
        bin_path: str,
        on_event: Callable[[ShareEvent], None] | None,
        on_request: Callable[[ShareRequestEvent], None] | None,
        on_notice: Callable[[str], None] | None,
    ) -> None:
        self._child = child
        self.port = port
        """The port on this computer it forwards to."""
        self.url = ""
        """The public link."""
        self.name = ""
        """Its name: the reserved one, or a random one ending in ``-free`` on Free."""
        self.expires_at: str | None = None
        """When the plan's session time runs out (ISO 8601), or ``None`` without a limit."""
        self.notice = False
        """Whether visitors see a short notice before the page (Free, and new paid accounts)."""
        self.password = False
        """Whether visitors need a password."""
        self._bin = bin_path
        self._on_event = on_event
        self._on_request = on_request
        self._on_notice = on_notice
        self._live = threading.Event()
        self._done = threading.Event()
        self._events: queue.Queue[ShareEvent | None] = queue.Queue()
        self._words: str | None = None
        self._last_retry: str | None = None
        self._stderr = ""
        self._stopping = False
        self._reason: str | None = None
        self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self._stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._stderr_thread.start()
        self._stdout_thread.start()

    # --- reading the CLI --------------------------------------------------------------

    def _read_stderr(self) -> None:
        stream = self._child.stderr
        if stream is None:
            return
        for chunk in iter(lambda: stream.read(1024), b""):
            self._stderr = (self._stderr + chunk.decode("utf-8", "replace"))[-4000:]

    def _call(self, listener: Callable[..., None] | None, *args: Any) -> None:
        if listener is None:
            return
        with contextlib.suppress(Exception):
            listener(*args)

    def _read_stdout(self) -> None:
        stream = self._child.stdout
        if stream is not None:
            for raw in iter(stream.readline, b""):
                try:
                    data = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if not isinstance(data, dict) or not isinstance(data.get("event"), str):
                    continue
                event = ShareEvent(event=data["event"], data=data)
                self._handle(event)
                # Bounded: this thread is the only one adding, so the check
                # holds, and the end marker below always fits.
                if self._events.qsize() < _EVENT_BUFFER:
                    self._events.put_nowait(event)
                self._call(self._on_event, event)
        self._child.wait()
        self._stderr_thread.join(timeout=1)
        with _running_lock:
            _running.discard(self._child)
        said = (
            self._words or _cli_problem(self._bin, self._stderr) or (self._stderr.strip() or None)
        )
        if self._stopping:
            self._reason = "you stopped it on this computer"
        else:
            self._reason = said or f"whk share exited with code {self._child.returncode}"
        self._done.set()
        self._events.put(None)

    def _handle(self, event: ShareEvent) -> None:
        data = event.data
        if event.event == "live":
            self.url = str(data.get("url") or "")
            self.name = str(data.get("name") or "")
            if not self._live.is_set():
                expires = data.get("expiresAt")
                self.expires_at = expires if isinstance(expires, str) else None
                self.notice = data.get("notice") is True
                self.password = data.get("password") is True
                self._live.set()
        elif event.event == "request":
            self._call(
                self._on_request,
                ShareRequestEvent(
                    method=str(data.get("method") or ""),
                    path=str(data.get("path") or ""),
                    status=int(data.get("status") or 0),
                    ms=int(data.get("ms") or 0),
                ),
            )
        elif event.event == "notice":
            self._call(self._on_notice, str(data.get("text") or ""))
        elif event.event == "retrying":
            self._last_retry = str(data.get("message") or "") or None
        elif event.event == "stopped":
            self._words = str(data.get("reason") or "") or None
        elif event.event == "error":
            self._words = str(data.get("message") or "") or None

    def _wait_live(self, timeout: float) -> None:
        """Returns once the link works; raises with the CLI's words if it never does."""
        deadline = time.monotonic() + timeout
        while not self._live.wait(0.05):
            if self._done.is_set():
                raise WebhooksCCError(
                    0, self._reason or "whk share exited before the link was ready."
                )
            if time.monotonic() >= deadline:
                self.stop()
                tail = f": {self._last_retry}" if self._last_retry else "."
                raise WebhooksCCError(
                    0, f"The share did not open within {round(timeout)} seconds{tail}"
                )

    # --- the public surface -----------------------------------------------------------

    @property
    def running(self) -> bool:
        """Whether the share is still running."""
        return not self._done.is_set()

    @property
    def reason(self) -> str | None:
        """Why the share ended, once it has; ``None`` while it runs."""
        return self._reason if self._done.is_set() else None

    def events(self) -> Iterator[ShareEvent]:
        """The events the CLI prints (requests, notices, reconnects), until the
        share ends. Meant for one consumer.

        At most 256 events wait to be read; while that many are unread, new ones
        are dropped (the ending included; :meth:`wait` still says why it ended),
        so a share never waits on its reader and one used only through the
        ``on_event``, ``on_request`` and ``on_notice`` callbacks, which see every
        event, holds no more than that."""
        while True:
            event = self._events.get()
            if event is None:
                self._events.put(None)
                return
            yield event

    def wait(self, timeout: float | None = None) -> str | None:
        """Blocks until the share ends (or ``timeout`` seconds pass) and returns why,
        or ``None`` if it is still running."""
        self._done.wait(timeout)
        return self.reason

    def stop(self) -> str:
        """Stops the share and waits for the CLI to exit; returns why it ended.

        Closes the CLI's stdin, which ends it cleanly on every platform
        (``--until-stdin-closes``); it is terminated only if it has not exited in
        time, then killed.
        """
        if not self._done.is_set():
            self._stopping = True
            stdin = self._child.stdin
            if stdin is not None:
                with contextlib.suppress(OSError):
                    stdin.close()
            if not self._done.wait(_STOP_TIMEOUT_S):
                with contextlib.suppress(OSError):
                    self._child.terminate()
                if not self._done.wait(_STOP_TIMEOUT_S):
                    with contextlib.suppress(OSError):
                        self._child.kill()
                    self._done.wait(_STOP_TIMEOUT_S)
        return self._reason or "you stopped it on this computer"

    def __enter__(self) -> LiveShare:
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()

    def __repr__(self) -> str:
        state = "running" if self.running else f"ended: {self._reason}"
        return f"LiveShare(url={self.url!r}, port={self.port}, {state})"


def share(
    port: int,
    *,
    name: str | None = None,
    password: str | None = None,
    whk_path: str | None = None,
    api_key: str | None = None,
    auth: Literal["agent"] | None = None,
    agent_file: str | os.PathLike[str] | None = None,
    base_url: str | None = None,
    tunnel_url: str | None = None,
    on_event: Callable[[ShareEvent], None] | None = None,
    on_request: Callable[[ShareRequestEvent], None] | None = None,
    on_notice: Callable[[str], None] | None = None,
    timeout: float = _OPEN_TIMEOUT_S,
) -> LiveShare:
    """Shares a local port at a public link (``whk share``) and returns once the link works.

    The share runs until :meth:`LiveShare.stop`, the plan's session limit, a stop
    from elsewhere (``whk shares stop``, the API, an agent), or the end of this
    process: the CLI stops when its stdin closes, so no share outlives the program
    that started it.

    ``name`` is a name you reserved (Pro and Business); Free shares get a random
    name ending in ``-free``. ``password`` (8 to 200 characters, Pro and Business)
    goes to the CLI through the environment, never the command line. ``api_key``
    is the key whk uses; ``auth="agent"`` makes whk use the agent credential file
    (``agent_file``, default its own) and never this machine's own login. With
    neither, whk uses ``WHK_API_KEY`` if set, else its own login. ``timeout`` is
    how long to wait for the link, in seconds.

    Raises :class:`~webhooks_cc.errors.WebhooksCCError` with the CLI's own words when
    the share is refused, and with install instructions when whk is missing.
    """
    _check(port, name, password)
    bin_path = whk_path or "whk"
    args = [bin_path, "share", str(port), "--json", "--until-stdin-closes"]
    if name:
        args += ["--name", name]
    env = dict(os.environ)
    env.pop("WHK_SHARE_PASSWORD", None)
    if password is not None:
        # Through the environment, never the arguments, which others can see.
        args.append("--password")
        env["WHK_SHARE_PASSWORD"] = password
    # Whose share it is: the key given, else the agent connection when asked,
    # never whatever this machine's environment happened to hold.
    inherited = env.pop("WHK_API_KEY", None)
    env.pop("WHK_AUTH", None)
    # whk reads WHK_API_KEY only with WHK_AUTH=key, so a key in someone's
    # shell never changes which account their own whk commands act as.
    if api_key:
        env["WHK_API_KEY"] = api_key
        env["WHK_AUTH"] = "key"
    elif auth == "agent":
        env["WHK_AUTH"] = "agent"
        if agent_file is not None:
            env["WHK_AGENT_FILE"] = os.fspath(agent_file)
    elif inherited:
        env["WHK_API_KEY"] = inherited
        env["WHK_AUTH"] = "key"
    if base_url:
        env["WHK_API_URL"] = base_url
    if tunnel_url:
        env["WHK_TUNNEL_URL"] = tunnel_url

    try:
        child = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError:
        where = "which is not installed" if whk_path is None else f"and there is none at {bin_path}"
        raise WebhooksCCError(
            0,
            f"Sharing a port needs the webhooks.cc CLI (whk), {where}. To install it, "
            f"{_install_clause()}",
        ) from None
    except OSError as error:
        raise WebhooksCCError(0, f"Could not run {bin_path}: {error}") from None
    with _running_lock:
        _running.add(child)
    live = LiveShare(child, port, bin_path, on_event, on_request, on_notice)
    live._wait_live(timeout)
    return live
