"""Settings every test shares.

The tests run pytest inside pytest (``pytester``), each time in a new process,
so the plugin is found the way a user's pytest finds it: through the installed
package's entry point. Nothing here reaches webhooks.cc. Tests that need an API
talk to :class:`StubApi`, a server on this machine's loopback address.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

pytest_plugins = ["pytester"]

#: Where a client that ignored the test's settings would have gone. Nothing
#: listens there, so a test that reached for the real API fails at once.
NOWHERE = "http://127.0.0.1:9"


class StubApi:
    """The two API calls the endpoint fixture makes: create, then delete."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.keys: set[str] = set()
        self.names: list[str] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self, status: int, body: object | None = None) -> None:
                payload = b"" if body is None else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _record(self) -> None:
                stub.calls.append((self.command, self.path))
                stub.keys.add(self.headers.get("Authorization", ""))

            def do_POST(self) -> None:
                self._record()
                length = int(self.headers.get("Content-Length", "0"))
                sent = json.loads(self.rfile.read(length) or b"{}")
                if self.path != "/api/endpoints":
                    self._answer(404, {"error": "not found"})
                    return
                stub.names.append(sent.get("name", ""))
                slug = f"stub{len(stub.names)}"
                self._answer(
                    200,
                    {
                        "id": f"id-{slug}",
                        "slug": slug,
                        "name": sent.get("name"),
                        "url": f"{stub.url}/w/{slug}",
                        "createdAt": 1_700_000_000_000,
                    },
                )

            def do_DELETE(self) -> None:
                self._record()
                self._answer(204)

            def log_message(self, format: str, *args: object) -> None:
                """Keep the server's access log out of the test output."""

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


@pytest.fixture
def stub_api() -> Iterator[StubApi]:
    api = StubApi()
    try:
        yield api
    finally:
        api.close()


@pytest.fixture(autouse=True)
def isolated_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No key, no real API and no credential file of this machine's in any test."""
    for name in ("WHK_API_KEY", "PYTEST_ADDOPTS", "PYTEST_DISABLE_PLUGIN_AUTOLOAD"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("WHK_BASE_URL", NOWHERE)
    monkeypatch.setenv("WHK_WEBHOOK_URL", NOWHERE)
    monkeypatch.setenv("WHK_AGENT_FILE", str(tmp_path / "config" / "whk" / "agent.json"))
