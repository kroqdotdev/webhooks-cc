pub mod client;
pub mod device_auth;
pub mod endpoints;
pub mod requests;
pub mod send;
pub mod stream;
pub mod usage;
pub mod update;

use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use std::time::Duration;

use crate::auth;
use crate::types::ApiErrorBody;

const DEFAULT_BASE_URL: &str = "https://webhooks.cc";
const DEFAULT_WEBHOOK_URL: &str = "https://go.webhooks.cc";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Central API client. Holds the HTTP client, base URLs, and auth token.
#[derive(Debug, Clone)]
pub struct ApiClient {
    pub http: reqwest::Client,
    pub base_url: String,
    pub webhook_url: String,
    token: Option<String>,
}

impl ApiClient {
    /// Create a new API client. Reads token from disk and URLs from env.
    pub fn new(base_url_override: Option<&str>, webhook_url_override: Option<&str>) -> Result<Self> {
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

        let token = auth::load_token()?.map(|t| t.access_token);

        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("failed to create HTTP client")?;

        Ok(Self {
            http,
            base_url,
            webhook_url,
            token,
        })
    }

    /// Set the auth token (used after login).
    pub fn set_token(&mut self, token: String) {
        self.token = Some(token);
    }

    /// Build default headers with auth.
    pub fn auth_headers(&self) -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            USER_AGENT,
            HeaderValue::from_str(&format!("whk-cli/{}", env!("WHK_VERSION")))?,
        );
        if let Some(ref token) = self.token {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))?,
            );
        }
        Ok(headers)
    }

    /// Require auth or return a friendly error.
    pub fn require_auth(&self) -> Result<()> {
        if self.token.is_none() {
            anyhow::bail!("Not logged in. Run `whk auth login` first.");
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
    if let Ok(err) = serde_json::from_str::<ApiErrorBody>(body) {
        if !err.error.is_empty() {
            return format!("{} ({})", err.error, status);
        }
    }
    let preview: String = body.chars().take(200).collect();
    format!("HTTP {status}: {preview}")
}
