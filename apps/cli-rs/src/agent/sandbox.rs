//! The agent sandbox routes (`/api/agent/sandbox/...`) for the access token
//! of an anonymous registration: up to 3 endpoints, 25 captures each and
//! 100 in all, gone after 24 hours. Responses are passed on as the server's
//! JSON, so `--json` shows every field.

use anyhow::Result;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use urlencoding::encode;

use super::credentials::{CredentialStore, Slot, SlotKind};
use super::pow::PowChallenge;
use super::protocol::{self, AgentError};
use super::session::AgentSession;

/// The codes after which the sandbox registration can never work again.
pub fn registration_gone(error: &anyhow::Error) -> bool {
    matches!(
        protocol::error_code(error),
        Some("invalid_grant" | "sandbox_closed")
    )
}

pub struct Sandbox {
    http: reqwest::Client,
    base_url: String,
    session: AgentSession,
}

impl Sandbox {
    /// The live sandbox slot from the credential file, if there is one.
    pub fn existing(
        http: &reqwest::Client,
        base_url: &str,
        store: &CredentialStore,
    ) -> Option<Self> {
        let slot = store.load().sandbox?;
        Some(Self::from_slot(http, base_url, store, slot))
    }

    fn from_slot(
        http: &reqwest::Client,
        base_url: &str,
        store: &CredentialStore,
        slot: Slot,
    ) -> Self {
        Self {
            http: http.clone(),
            base_url: base_url.trim_end_matches('/').to_string(),
            session: AgentSession::new(
                http.clone(),
                base_url,
                store.clone(),
                SlotKind::Sandbox,
                slot,
            ),
        }
    }

    /// Registers anonymously (with the proof of work) and saves the slot.
    /// `on_solve` hears about each challenge before it is solved; `on_full`
    /// when the shared sandbox has no free endpoint right now.
    pub async fn register(
        http: &reqwest::Client,
        base_url: &str,
        store: &CredentialStore,
        on_solve: &dyn Fn(&PowChallenge),
    ) -> Result<(Self, bool)> {
        let base = base_url.trim_end_matches('/');
        let registration = protocol::register_anonymous(http, base, on_solve).await?;
        let slot = Slot::new(
            &registration.registration_id,
            &registration.identity_assertion,
            &registration.assertion_expires,
            &[("client_name", protocol::CLIENT_NAME)],
        )
        .ok_or_else(|| {
            anyhow::anyhow!("malformed response: assertion_expires is not a timestamp")
        })?;
        store.save(SlotKind::Sandbox, &slot);
        let full = registration.sandbox_status == "full";
        Ok((Self::from_slot(http, base, store, slot), full))
    }

    pub fn registration_id(&self) -> &str {
        self.session.registration_id()
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Option<Value>> {
        let url = format!("{}/api/agent/sandbox{path}", self.base_url);
        let resp = self
            .session
            .send(|| {
                let request = self.http.request(method.clone(), &url);
                match &body {
                    Some(body) => request.json(body),
                    None => request,
                }
            })
            .await?;
        let status = resp.status();
        if status == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        let headers = resp.headers().clone();
        let text = resp.text().await.unwrap_or_default();
        let parsed: Option<Value> = serde_json::from_str(&text).ok();
        if !status.is_success() {
            let error = AgentError::from_response(status, &headers, parsed.unwrap_or(Value::Null));
            if error.code == "sandbox_closed" {
                self.forget_if_current();
            }
            return Err(error.into());
        }
        match parsed {
            Some(value) => Ok(Some(value)),
            None => Err(AgentError::new(
                "invalid_response",
                status.as_u16(),
                "The sandbox answered with something other than JSON.",
            )
            .into()),
        }
    }

    /// The registration was claimed, revoked or expired: drop its slot,
    /// unless the file already holds another registration.
    fn forget_if_current(&self) {
        self.session
            .store()
            .remove_registration(SlotKind::Sandbox, self.registration_id());
    }

    async fn value(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        Ok(self.call(method, path, body).await?.unwrap_or(Value::Null))
    }

    /// A new capture endpoint. 409 `sandbox_endpoint_limit` at 3 live,
    /// 503 `sandbox_full` when the shared pool is full.
    pub async fn create_endpoint(&self) -> Result<Value> {
        self.value(Method::POST, "/endpoints", Some(json!({})))
            .await
    }

    /// `{ endpoints: [...], sandbox: { expiresAt, maxEndpoints, requestLimit, budget } }`.
    pub async fn list_endpoints(&self) -> Result<Value> {
        self.value(Method::GET, "/endpoints", None).await
    }

    pub async fn get_endpoint(&self, slug: &str) -> Result<Value> {
        self.value(Method::GET, &format!("/endpoints/{}", encode(slug)), None)
            .await
    }

    /// Frees a slot; the registration's request budget is not refunded.
    pub async fn delete_endpoint(&self, slug: &str) -> Result<()> {
        self.call(
            Method::DELETE,
            &format!("/endpoints/{}", encode(slug)),
            None,
        )
        .await
        .map(|_| ())
    }

    /// Captured requests, newest first (the server returns at most 100).
    pub async fn list_requests(
        &self,
        slug: &str,
        since: Option<i64>,
        limit: Option<u32>,
    ) -> Result<Value> {
        let mut query = Vec::new();
        if let Some(since) = since {
            query.push(format!("since={since}"));
        }
        if let Some(limit) = limit {
            query.push(format!("limit={limit}"));
        }
        let suffix = if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query.join("&"))
        };
        self.value(
            Method::GET,
            &format!("/endpoints/{}/requests{suffix}", encode(slug)),
            None,
        )
        .await
    }

    pub async fn get_request(&self, id: &str) -> Result<Value> {
        self.value(Method::GET, &format!("/requests/{}", encode(id)), None)
            .await
    }
}
