pub mod account;
pub mod alerts;
pub mod billing;
pub mod client;
pub mod destinations;
pub mod device_auth;
pub mod endpoints;
pub mod google;
pub mod keys;
pub mod layouts;
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

/// The API base URL in use: the override (`--api-url`), else `WHK_API_URL`,
/// else webhooks.cc, without a trailing slash.
fn effective_base_url(flag: Option<&str>, env: Option<&str>) -> String {
    flag.or(env)
        .unwrap_or(DEFAULT_BASE_URL)
        .trim_end_matches('/')
        .to_string()
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
        let base_url = effective_base_url(
            base_url_override,
            std::env::var("WHK_API_URL").ok().as_deref(),
        );

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

    /// The API base URL in use (from `--api-url`, `WHK_API_URL` or the
    /// default). A command printed for a later run names it, since that run
    /// may not have the same flags or environment.
    pub fn base_url(&self) -> &str {
        &self.base_url
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
    let code = status.as_u16();
    if let Some(text) = error_text_of(body) {
        // A bare code (`{"error":"not_found"}`) is no sentence: say the status.
        return if is_bare_code(&text) {
            code_text(code, &text)
        } else {
            text
        };
    }
    if let Some(summary) = html_summary(code, body) {
        return summary;
    }
    if body.trim().is_empty() {
        return format!("{} (HTTP {code})", status_text(code));
    }
    cut_text(body, ERROR_BODY_CUT)
}

/// Longest text taken from a JSON error body (`MAX_ERROR_TEXT` in the SDK).
const MAX_ERROR_TEXT: usize = 1_000;

/// How much of an error body that is not JSON goes into the message.
const ERROR_BODY_CUT: usize = 200;

/// An error code rather than text: lower-case ASCII letters, digits and
/// underscores, starting with a letter (`BARE_CODE` in the SDK).
pub fn is_bare_code(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Whitespace as JavaScript's `trim()` sees it, which the SDK's rules use.
fn js_blank(text: &str) -> bool {
    text.chars().all(|c| c.is_whitespace() || c == '\u{feff}')
}

/// A JSON error body's string `message`, else its string `error` (a blank
/// one gives way), cut short; None when the body is not a JSON object naming
/// either. The rules are the SDK's (packages/sdk/conformance/errors.json).
fn error_text_of(body: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let object = parsed.as_object()?;
    let text = |key: &str| {
        object
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|t| !js_blank(t))
    };
    text("message")
        .or_else(|| text("error"))
        .map(|t| cut_text(t, MAX_ERROR_TEXT))
}

/// The API's error code in a JSON error body: `error` when it is a code,
/// wherever it sits in the object, else a `code` field that is one; never a
/// sentence. A body that is not valid JSON (cut short by a proxy) still
/// gives a leading `{"error":"<code>"`.
pub fn error_code_of(body: &str) -> Option<String> {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(parsed) => {
            let object = parsed.as_object()?;
            let code = |key: &str| {
                object
                    .get(key)
                    .and_then(|v| v.as_str())
                    .filter(|t| is_bare_code(t))
                    .map(str::to_string)
            };
            code("error").or_else(|| code("code"))
        }
        Err(_) => {
            let rest = body.strip_prefix('{')?.trim_start();
            let rest = rest.strip_prefix("\"error\"")?.trim_start();
            let rest = rest.strip_prefix(':')?.trim_start();
            let rest = rest.strip_prefix('"')?;
            let end = rest.find('"')?;
            Some(rest[..end].to_string()).filter(|c| is_bare_code(c))
        }
    }
}

/// A short plain sentence for an error status (`statusText` in the SDK).
fn status_text(status: u16) -> String {
    match status {
        400 => "Bad request".into(),
        401 => "Unauthorized".into(),
        403 => "Forbidden".into(),
        404 => "Not found".into(),
        409 => "Conflict".into(),
        429 => "Too many requests".into(),
        s if s >= 500 => "Server error".into(),
        s => format!("Request failed with HTTP {s}"),
    }
}

/// The status in words for a body that names only `code`: alone when the
/// code just names the status, else with the code in brackets.
fn code_text(status: u16, code: &str) -> String {
    let words = status_text(status);
    if code.replace('_', " ") == words.to_lowercase() {
        words
    } else {
        format!("{words} ({code})")
    }
}

/// `text` cut to `max` characters with "..." after it, or whole.
fn cut_text(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((end, _)) => format!("{}...", &text[..end]),
        None => text.to_string(),
    }
}

/// An HTML page in place of an API answer (a proxy's error page, or a web
/// page at a path with no API route) said in one line: the status and the
/// page's title, never the markup. None when the body is not HTML.
pub fn html_summary(status: u16, body: &str) -> Option<String> {
    let start: String = body.trim_start().chars().take(15).collect();
    let start = start.to_ascii_lowercase();
    if !(start.starts_with("<!doctype html") || start.starts_with("<html")) {
        return None;
    }
    let lower = body.to_ascii_lowercase();
    let title = lower
        .find("<title")
        .and_then(|at| Some(at + lower[at..].find('>')? + 1))
        .and_then(|from| Some((from, from + lower[from..].find("</title")?)))
        .map(|(from, to)| {
            body[from..to]
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .map(|t| crate::cli::output::sanitize_line(&t))
        .filter(|t| !t.is_empty())
        .map(|t| cut_text(&t, 80));
    let words = status_text(status);
    Some(match title {
        Some(title) => format!(
            "{words} (HTTP {status}): the server answered with a web page, \"{title}\", not the API"
        ),
        None => {
            format!("{words} (HTTP {status}): the server answered with a web page, not the API")
        }
    })
}

/// Extract an error message from an API error response body, with the
/// status (the event stream reports it alongside).
pub fn extract_error(status: reqwest::StatusCode, body: &str) -> String {
    match error_text_of(body) {
        Some(text) => format!("{text} ({status})"),
        None => api_error_message(status, body),
    }
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
    fn the_base_url_in_use_comes_from_the_flag_then_the_environment() {
        let dev = "http://localhost:3110";
        for (flag, env, want) in [
            (Some(dev), None, dev),
            (Some(dev), Some(dev), dev),
            (None, Some(dev), dev),
            (Some(dev), Some("http://localhost:9"), dev),
            (Some("http://localhost:3110/"), None, dev),
            // The default asked for by flag wins over a custom environment,
            // and a printed command must say so.
            (Some("https://webhooks.cc"), Some(dev), DEFAULT_BASE_URL),
            (None, None, DEFAULT_BASE_URL),
            (None, Some("https://webhooks.cc/"), DEFAULT_BASE_URL),
        ] {
            assert_eq!(effective_base_url(flag, env), want, "{flag:?} {env:?}");
        }
        let client = ApiClient::with_credentials(Some(dev), None, None, None).unwrap();
        assert_eq!(client.base_url(), dev);
    }

    /// The SDK's error-message vectors (packages/sdk/conformance/errors.json):
    /// the CLI words an API error as the SDKs do and reads the same code,
    /// apart from the vectors below, where it differs on purpose.
    #[test]
    fn api_errors_follow_the_sdks_vectors() {
        // HTML is said in one line, never printed; an empty body says the
        // status, since "Error: " alone tells a person nothing.
        const DIFFERS: &[&str] = &["503 HTML", "404 an empty body"];
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/sdk/conformance/errors.json"
        );
        // A Rust string cannot hold a lone surrogate, which one expected
        // message is (JSON allows it): that vector is skipped. An HTTP body
        // is UTF-8, so a CLI never meets one.
        const LONE: &str = "404 a lone surrogate counts as one character";
        let text = std::fs::read_to_string(path)
            .expect("read errors.json")
            .replace("\"message\": \"\\ud800\"", "\"message\": \"(skipped)\"");
        let vectors: serde_json::Value = serde_json::from_str(&text).expect("errors.json is JSON");
        let cases = vectors["vectors"].as_array().expect("vectors");
        assert!(cases.len() > 50, "read too few cases");
        let mut differed = Vec::new();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            if name == LONE {
                assert_eq!(case["expected"]["message"], "(skipped)");
                continue;
            }
            let status =
                reqwest::StatusCode::from_u16(case["status"].as_u64().unwrap() as u16).unwrap();
            let body = case["body"].as_str().unwrap();
            let message = api_error_message(status, body);
            let code = error_code_of(body);
            let expected = &case["expected"];
            let same = message == expected["message"].as_str().unwrap()
                && code.as_deref() == expected["code"].as_str();
            if DIFFERS.contains(&name) {
                assert!(!same, "{name} no longer differs: take it off the list");
                differed.push(name);
            } else {
                assert!(same, "{name}: {message:?} {code:?}, expected {expected}");
            }
        }
        assert_eq!(differed.len(), DIFFERS.len(), "a listed vector is gone");
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
            "Forbidden (HTTP 403): the server answered with a web page, not the API"
        );
        assert_eq!(
            api_error_message(
                reqwest::StatusCode::NOT_FOUND,
                "<!DOCTYPE html><html><head><title>404: This page\n could not be found</title></head><body>...</body></html>"
            ),
            "Not found (HTTP 404): the server answered with a web page, \"404: This page could not be found\", not the API"
        );
        assert_eq!(api_error_message(status, ""), "Forbidden (HTTP 403)");
        assert_eq!(
            extract_error(status, r#"{"error":"x"}"#),
            "x (403 Forbidden)"
        );
    }
}
