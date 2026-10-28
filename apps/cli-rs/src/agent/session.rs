//! Access tokens from a slot of the credential file: the cached token while
//! it has more than a minute left, else an exchange of the assertion, whose
//! result is written back so the next command reuses it. A 401 exchanges
//! once more; `invalid_grant` means the registration is gone, so the slot is
//! removed.

use anyhow::Result;
use chrono::Utc;
use reqwest::{RequestBuilder, Response, StatusCode};
use tokio::sync::Mutex;

use super::credentials::{CredentialStore, Slot, SlotKind};
use super::protocol::{self, AgentError};

/// One registration's tokens. Cheap to share behind an `Arc`.
pub struct AgentSession {
    http: reqwest::Client,
    base_url: String,
    store: CredentialStore,
    kind: SlotKind,
    registration_id: String,
    /// `None` once the server answered `invalid_grant`.
    slot: Mutex<Option<Slot>>,
}

impl std::fmt::Debug for AgentSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentSession")
            .field("kind", &self.kind)
            .field("registration_id", &self.registration_id)
            .finish()
    }
}

impl AgentSession {
    pub fn new(
        http: reqwest::Client,
        base_url: &str,
        store: CredentialStore,
        kind: SlotKind,
        slot: Slot,
    ) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            store,
            kind,
            registration_id: slot.registration_id().to_string(),
            slot: Mutex::new(Some(slot)),
        }
    }

    pub fn kind(&self) -> SlotKind {
        self.kind
    }

    pub fn registration_id(&self) -> &str {
        &self.registration_id
    }

    pub fn store(&self) -> &CredentialStore {
        &self.store
    }

    /// The slot as this process holds it (`None` after `invalid_grant`).
    pub async fn slot(&self) -> Option<Slot> {
        self.slot.lock().await.clone()
    }

    /// A bearer token: the cached one unless `force_exchange`, else a new
    /// exchange. On `invalid_grant` the slot is removed from the file and an
    /// [`AgentError`] with that code is returned.
    pub async fn token(&self, force_exchange: bool) -> Result<String> {
        let mut guard = self.slot.lock().await;
        let Some(slot) = guard.as_mut() else {
            return Err(self.gone().into());
        };
        if !force_exchange && let Some(token) = slot.usable_token(Utc::now().timestamp_millis()) {
            return Ok(token.to_string());
        }
        match protocol::exchange(&self.http, &self.base_url, slot.identity_assertion()).await {
            Ok(token) => {
                slot.set_token(&token.access_token, token.expires_at_ms);
                self.write_back(slot);
                Ok(token.access_token)
            }
            Err(error) if protocol::error_code(&error) == Some("invalid_grant") => {
                *guard = None;
                self.store
                    .remove_registration(self.kind, &self.registration_id);
                Err(self.gone().into())
            }
            Err(error) => Err(error),
        }
    }

    /// Stores the new token, unless the file meanwhile holds another
    /// registration in this slot or none (another tool replaced it, or
    /// `whk sandbox forget` removed it): a token must not bring it back.
    fn write_back(&self, slot: &Slot) {
        if self.store.holds(self.kind, slot.registration_id()) {
            self.store.save(self.kind, slot);
        }
    }

    fn gone(&self) -> AgentError {
        let what = match self.kind {
            SlotKind::Claimed => {
                "The agent's account connection was revoked or has expired (the human may have disconnected it)"
            }
            SlotKind::Sandbox => "The sandbox registration expired, was revoked or was claimed",
        };
        AgentError::new(
            "invalid_grant",
            400,
            format!("{what}; it was removed from the credential file."),
        )
    }

    /// Sends a request with the bearer, and once more with a freshly
    /// exchanged token when the API answers 401. `build` makes the request
    /// without credentials; it may run twice.
    pub async fn send(&self, build: impl Fn() -> RequestBuilder) -> Result<Response> {
        let mut resp = self.send_once(&build, false).await?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            resp = self.send_once(&build, true).await?;
        }
        Ok(resp)
    }

    async fn send_once(
        &self,
        build: &impl Fn() -> RequestBuilder,
        force_exchange: bool,
    ) -> Result<Response> {
        let token = self.token(force_exchange).await?;
        protocol::agent_request(build().bearer_auth(&token))
            .send()
            .await
            .map_err(|e| anyhow::Error::new(e.without_url()).context("request failed"))
    }
}
