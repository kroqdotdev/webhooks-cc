"""Access tokens kept fresh from an agent's identity assertion."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from .agent import AccessToken, AgentAuthError, exchange
from .credentials import AgentCredentialStore, AgentSlot, SlotName, parse_timestamp

# Exchange again this long before a token expires.
_REFRESH_MARGIN_S = 60


@dataclass(frozen=True)
class SlotBinding:
    """The credential-file slot a registration lives in, for writing tokens back."""

    store: AgentCredentialStore
    base_url: str
    name: SlotName
    registration_id: str

    def save_token(self, token: AccessToken | None) -> None:
        self.store.save_token(
            self.base_url,
            self.name,
            self.registration_id,
            token.access_token if token else None,
            token.expires_at if token else None,
        )

    def remove(self) -> None:
        self.store.remove(self.base_url, self.name, registration_id=self.registration_id)


def cached_token(slot: AgentSlot) -> AccessToken | None:
    """The slot's cached access token, when it is still usable."""
    token = slot.usable_token()
    millis = parse_timestamp(slot.access_token_expires)
    if token is None or millis is None:
        return None
    return AccessToken(
        access_token=token,
        scope=slot.scope or "",
        expires_at=datetime.fromtimestamp(millis / 1000, tz=timezone.utc),
    )


class AgentTokens:
    """Exchanges the assertion on first use, again shortly before the token expires,
    and on demand after a 401. With a ``binding``, each new token is cached in the
    credential file, and ``invalid_grant`` removes the slot before it is raised."""

    def __init__(
        self,
        *,
        base_url: str,
        assertion: str,
        http: httpx.Client,
        timeout_ms: float,
        token: AccessToken | None = None,
        binding: SlotBinding | None = None,
    ) -> None:
        self._base_url = base_url
        self._assertion = assertion
        self._http = http
        self._timeout_ms = timeout_ms
        self._token = token
        self._binding = binding
        self._lock = threading.Lock()

    def get(self, force_refresh: bool = False) -> str:
        with self._lock:
            current = self._token
            if (
                not force_refresh
                and current is not None
                and current.expires_at.timestamp() - time.time() > _REFRESH_MARGIN_S
            ):
                return current.access_token
            try:
                token = exchange(
                    self._assertion,
                    base_url=self._base_url,
                    timeout=self._timeout_ms,
                    http_client=self._http,
                )
            except AgentAuthError as error:
                if error.code == "invalid_grant":
                    self._token = None
                    if self._binding is not None:
                        self._binding.remove()
                raise
            self._token = token
            if self._binding is not None:
                self._binding.save_token(token)
            return token.access_token

    def peek(self) -> str | None:
        """The current token, without exchanging."""
        return self._token.access_token if self._token is not None else None

    def drop(self) -> None:
        """Forget the current token (it was revoked), here and in the file."""
        with self._lock:
            self._token = None
            if self._binding is not None:
                self._binding.save_token(None)
