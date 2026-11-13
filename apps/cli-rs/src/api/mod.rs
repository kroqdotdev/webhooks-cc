pub mod client;
pub mod device_auth;
pub mod endpoints;
pub mod keys;
pub mod requests;
pub mod send;
pub mod shares;
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
    /// The bearer is `WHK_API_KEY` (with `WHK_AUTH=key`), for `whk auth status`.
    env_key: bool,
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
    /// `WHK_API_KEY`, chosen with `WHK_AUTH=key`.
    EnvKey,
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

/// Where a client's bearer comes from.
#[derive(Debug, PartialEq)]
enum TokenSource {
    /// `WHK_API_KEY`, only with `WHK_AUTH=key`.
    Key(String),
    /// The agent credential file only (`WHK_AUTH=agent`).
    Agent,
    /// This machine's login (`token.json`), else the agent file.
    Login,
}

/// What `WHK_AUTH` asks for.
#[derive(Debug, PartialEq, Clone, Copy)]
enum AuthMode {
    /// Unset (or anything else): the login, else the agent file. A
    /// `WHK_API_KEY` in the environment is ignored, since it is often there
    /// for the SDKs and may name another account.
    Default,
    /// `WHK_AUTH=key`: the key in `WHK_API_KEY` (the SDKs' `share()` and the
    /// MCP server's `share_port` set both).
    Key,
    /// `WHK_AUTH=agent`: the agent credential file, not `token.json`.
    Agent,
}

fn token_source(key: Option<String>, mode: AuthMode) -> TokenSource {
    match (mode, key) {
        (AuthMode::Key, Some(key)) => TokenSource::Key(key),
        (AuthMode::Agent, _) => TokenSource::Agent,
        _ => TokenSource::Login,
    }
}

fn auth_mode() -> AuthMode {
    match std::env::var("WHK_AUTH")
        .map(|v| v.trim().to_ascii_lowercase())
        .as_deref()
    {
        Ok("key") => AuthMode::Key,
        Ok("agent") => AuthMode::Agent,
        _ => AuthMode::Default,
    }
}

/// What to tell someone who is not logged in but has `WHK_API_KEY` set
/// without `WHK_AUTH=key`: the key is there, and ignored on purpose.
pub const IGNORED_KEY_HINT: &str = "WHK_API_KEY is set, but whk uses it only with WHK_AUTH=key (so a key kept for the SDKs never changes which account whk acts as). Run with WHK_AUTH=key to use it, or log in with `whk auth login`.";

fn ignored_key_hint_for(mode: AuthMode, has_key: bool) -> Option<&'static str> {
    (has_key && mode != AuthMode::Key).then_some(IGNORED_KEY_HINT)
}

/// [`IGNORED_KEY_HINT`] when it applies to this process's environment.
pub fn ignored_key_hint() -> Option<&'static str> {
    ignored_key_hint_for(auth_mode(), env_api_key().is_some())
}

/// `WHK_API_KEY`, trimmed; unset or blank is none.
fn env_api_key() -> Option<String> {
    std::env::var("WHK_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

impl ApiClient {
    /// Create a new API client. The token comes from disk, and without one
    /// a live `claimed` slot in the agent credential file (`WHK_AGENT_FILE`
    /// or the default path) supplies the bearer. `WHK_AUTH=key` uses the API
    /// key in `WHK_API_KEY` instead (the SDKs' `share()` and the MCP server's
    /// `share_port` start `whk` that way); without `WHK_AUTH=key` that
    /// variable is ignored. `WHK_AUTH=agent` skips the token on disk, so a
    /// program running on an agent's connection starts `whk` on the same
    /// account rather than this machine's login. URLs come from env.
    pub fn new(
        base_url_override: Option<&str>,
        webhook_url_override: Option<&str>,
    ) -> Result<Self> {
        let source = token_source(env_api_key(), auth_mode());
        let env_key = matches!(source, TokenSource::Key(_));
        let token = match source {
            TokenSource::Key(key) => Some(key),
            TokenSource::Agent => None,
            TokenSource::Login => auth::load_token()?.map(|t| t.access_token),
        };
        let base = base_url_override
            .map(String::from)
            .or_else(|| std::env::var("WHK_API_URL").ok())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let agents = CredentialStore::locate(base.trim_end_matches('/'));
        let mut client =
            Self::with_credentials(Some(&base), webhook_url_override, token, Some(agents))?;
        client.env_key = env_key;
        Ok(client)
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
            env_key: false,
        })
    }

    /// Set the auth token (used after login).
    pub fn set_token(&mut self, token: String) {
        self.bearer = Bearer::Token(token);
        self.env_key = false;
    }

    pub fn auth_source(&self) -> AuthSource<'_> {
        match &self.bearer {
            Bearer::None => AuthSource::None,
            Bearer::Token(_) if self.env_key => AuthSource::EnvKey,
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

    /// The bearer this client sends, for a connection made outside reqwest
    /// (the tunnel's WebSocket): the login's key, or an agent connection's
    /// access token, exchanged again when `refresh` or when it ran out.
    pub async fn bearer_token(&self, refresh: bool) -> Result<Option<String>> {
        Ok(match &self.bearer {
            Bearer::None => None,
            Bearer::Token(token) => Some(token.clone()),
            Bearer::Agent(session) => Some(session.token(refresh).await?),
        })
    }

    /// Whether a refused bearer is worth one more try with a new token.
    pub fn bearer_refreshes(&self) -> bool {
        self.can_refresh()
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
            // The next step (log in, or why WHK_API_KEY was ignored) comes
            // with the error's hint; see `error::classify`.
            return Err(crate::error::CliError::NotLoggedIn("Not logged in.".into()).into());
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

/// The message to show for an API error: the server's own words when it
/// gave some (they are written for people, so no status code is added),
/// else the status and the start of the body.
pub fn api_error_message(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(err) = serde_json::from_str::<ApiErrorBody>(body)
        && !err.error.is_empty()
    {
        return err.error;
    }
    let preview: String = body.chars().take(200).collect();
    format!("HTTP {status}: {preview}")
}

/// Extract an error message from an API error response body, with the
/// status (the event stream reports it alongside).
pub fn extract_error(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(err) = serde_json::from_str::<ApiErrorBody>(body)
        && !err.error.is_empty()
    {
        return format!("{} ({})", err.error, status);
    }
    let preview: String = body.chars().take(200).collect();
    format!("HTTP {status}: {preview}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_ignored_api_key_is_explained() {
        assert_eq!(
            ignored_key_hint_for(AuthMode::Default, true),
            Some(IGNORED_KEY_HINT)
        );
        assert_eq!(
            ignored_key_hint_for(AuthMode::Agent, true),
            Some(IGNORED_KEY_HINT)
        );
        assert_eq!(ignored_key_hint_for(AuthMode::Key, true), None);
        assert_eq!(ignored_key_hint_for(AuthMode::Default, false), None);
        assert!(IGNORED_KEY_HINT.contains("WHK_AUTH=key"));
    }

    use super::*;

    #[test]
    fn auth_status_names_a_key_from_the_environment() {
        let mut client =
            ApiClient::with_credentials(Some("http://x"), None, Some("whcc_k".into()), None)
                .unwrap();
        assert!(matches!(client.auth_source(), AuthSource::Login));
        client.env_key = true;
        assert!(matches!(client.auth_source(), AuthSource::EnvKey));
        // A login made in this process is the login again.
        client.set_token("whcc_new".into());
        assert!(matches!(client.auth_source(), AuthSource::Login));
    }

    #[test]
    fn an_api_key_counts_only_with_whk_auth_key() {
        let key = || Some("whcc_k".to_string());
        assert_eq!(
            token_source(key(), AuthMode::Key),
            TokenSource::Key("whcc_k".into())
        );
        // A WHK_API_KEY left in the shell for the SDKs never replaces the
        // login, nor the agent file the program asked for.
        assert_eq!(token_source(key(), AuthMode::Default), TokenSource::Login);
        assert_eq!(token_source(key(), AuthMode::Agent), TokenSource::Agent);
        // WHK_AUTH=key without a key falls back to the login.
        assert_eq!(token_source(None, AuthMode::Key), TokenSource::Login);
        assert_eq!(token_source(None, AuthMode::Agent), TokenSource::Agent);
        assert_eq!(token_source(None, AuthMode::Default), TokenSource::Login);
    }

    #[test]
    fn api_errors_read_as_the_servers_words() {
        let status = reqwest::StatusCode::FORBIDDEN;
        assert_eq!(
            api_error_message(status, r#"{"error":"Names come with Pro."}"#),
            "Names come with Pro."
        );
        assert_eq!(
            api_error_message(status, "<html>nope</html>"),
            "HTTP 403 Forbidden: <html>nope</html>"
        );
        assert_eq!(
            extract_error(status, r#"{"error":"x"}"#),
            "x (403 Forbidden)"
        );
    }
}
