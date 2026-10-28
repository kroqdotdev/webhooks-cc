pub mod client;
pub mod device_auth;
pub mod endpoints;
pub mod requests;
pub mod send;
pub mod stream;
pub mod teams;
pub mod update;
pub mod usage;

use anyhow::{Context, Result};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT};
use std::sync::Arc;
use std::time::Duration;

use crate::agent::{AgentSession, CredentialStore, SlotKind};
use crate::auth;
use crate::types::ApiErrorBody;

const DEFAULT_BASE_URL: &str = "https://webhooks.cc";
const DEFAULT_WEBHOOK_URL: &str = "https://go.webhooks.cc";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Central API client. Holds the HTTP client, base URLs, and auth token.
#[derive(Clone)]
pub struct ApiClient {
    pub http: reqwest::Client,
    /// For the agent protocol (registration, token exchange, claims): never
    /// follows a redirect, so an assertion or claim token is never re-sent.
    pub agent_http: reqwest::Client,
    pub base_url: String,
    pub webhook_url: String,
    bearer: Bearer,
}

/// Where the client's bearer comes from: the device login's API key
/// (`token.json`, or one set after `whk auth login`), else an agent's
/// account connection from the shared credential file, whose access tokens
/// are exchanged on demand.
#[derive(Clone)]
enum Bearer {
    None,
    Token(String),
    Agent(Arc<AgentSession>),
}

/// How the client authenticates, for `whk auth status`.
pub enum AuthSource<'a> {
    None,
    Login,
    Agent(&'a AgentSession),
}

impl std::fmt::Debug for ApiClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let bearer = match &self.bearer {
            Bearer::None => "none",
            Bearer::Token(_) => "[REDACTED]",
            Bearer::Agent(_) => "agent",
        };
        f.debug_struct("ApiClient")
            .field("base_url", &self.base_url)
            .field("webhook_url", &self.webhook_url)
            .field("token", &bearer)
            .finish()
    }
}

impl ApiClient {
    /// Create a new API client. Reads the token from disk and URLs from env;
    /// without a token, a live `claimed` slot in the agent credential file
    /// (`WHK_AGENT_FILE` or the default path) supplies the bearer.
    pub fn new(
        base_url_override: Option<&str>,
        webhook_url_override: Option<&str>,
    ) -> Result<Self> {
        let token = auth::load_token()?.map(|t| t.access_token);
        let base = base_url_override
            .map(String::from)
            .or_else(|| std::env::var("WHK_API_URL").ok())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let agents = CredentialStore::locate(base.trim_end_matches('/'));
        Self::with_credentials(Some(&base), webhook_url_override, token, Some(agents))
    }

    /// A client with an explicit login token and credential store (`None`:
    /// no agent fallback).
    pub fn with_credentials(
        base_url_override: Option<&str>,
        webhook_url_override: Option<&str>,
        token: Option<String>,
        agents: Option<CredentialStore>,
    ) -> Result<Self> {
        let base_url = base_url_override
            .map(String::from)
            .or_else(|| std::env::var("WHK_API_URL").ok())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
            .trim_end_matches('/')
            .to_string();

        let webhook_url = webhook_url_override
            .map(String::from)
            .or_else(|| std::env::var("WHK_WEBHOOK_URL").ok())
            .unwrap_or_else(|| DEFAULT_WEBHOOK_URL.to_string())
            .trim_end_matches('/')
            .to_string();

        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("failed to create HTTP client")?;
        let agent_http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("failed to create HTTP client")?;

        let bearer = match (token, agents) {
            (Some(token), _) => Bearer::Token(token),
            (None, Some(store)) => match store.load().claimed {
                Some(slot) => Bearer::Agent(Arc::new(AgentSession::new(
                    agent_http.clone(),
                    &base_url,
                    store,
                    SlotKind::Claimed,
                    slot,
                ))),
                None => Bearer::None,
            },
            (None, None) => Bearer::None,
        };

        Ok(Self {
            http,
            agent_http,
            base_url,
            webhook_url,
            bearer,
        })
    }

    /// Set the auth token (used after login).
    pub fn set_token(&mut self, token: String) {
        self.bearer = Bearer::Token(token);
    }

    pub fn auth_source(&self) -> AuthSource<'_> {
        match &self.bearer {
            Bearer::None => AuthSource::None,
            Bearer::Token(_) => AuthSource::Login,
            Bearer::Agent(session) => AuthSource::Agent(session),
        }
    }

    /// True when a 401 is worth one more try with a newly exchanged token.
    pub(crate) fn can_refresh(&self) -> bool {
        matches!(self.bearer, Bearer::Agent(_))
    }

    /// Build default headers with auth. An agent connection's token is the
    /// cached one, or a new exchange when `refresh` or when it runs out.
    pub async fn auth_headers(&self) -> Result<HeaderMap> {
        self.headers_with(false).await
    }

    pub(crate) async fn headers_with(&self, refresh: bool) -> Result<HeaderMap> {
        let mut headers = Self::anonymous_headers()?;
        let token = match &self.bearer {
            Bearer::None => None,
            Bearer::Token(token) => Some(token.clone()),
            Bearer::Agent(session) => Some(session.token(refresh).await?),
        };
        if let Some(token) = token {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))?,
            );
        }
        Ok(headers)
    }

    /// The headers without a bearer, for the routes that take none (the
    /// device login), so a saved agent connection is never exchanged and a
    /// revoked one cannot get in the way.
    pub(crate) fn anonymous_headers() -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            USER_AGENT,
            HeaderValue::from_str(&format!("whk-cli/{}", env!("WHK_VERSION")))?,
        );
        Ok(headers)
    }

    /// Require auth or return a friendly error.
    pub fn require_auth(&self) -> Result<()> {
        if matches!(self.bearer, Bearer::None) {
            anyhow::bail!(
                "Not logged in. Run `whk auth login` first, or connect an agent with `whk sandbox connect --email <address>`."
            );
        }
        Ok(())
    }

    /// Full URL for an API path.
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// Full webhook URL for a slug.
    pub fn webhook_url_for(&self, slug: &str) -> String {
        format!("{}/w/{}", self.webhook_url, slug)
    }
}

/// Extract an error message from an API error response body.
pub fn extract_error(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(err) = serde_json::from_str::<ApiErrorBody>(body)
        && !err.error.is_empty()
    {
        return format!("{} ({})", err.error, status);
    }
    let preview: String = body.chars().take(200).collect();
    format!("HTTP {status}: {preview}")
}
