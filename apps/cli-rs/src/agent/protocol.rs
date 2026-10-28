//! The auth.md v0.6 steps an agent takes (see `/auth.md`): get and solve a
//! proof-of-work challenge, register (anonymous or service_auth), exchange
//! an identity assertion for an access token, and poll a claim. Mirrors
//! `packages/sdk/src/agent.ts`. Nothing here prints; callers decide what
//! the user sees, and never see an assertion or token in an error.

use anyhow::{Context, Result};
use reqwest::header::{ACCEPT, HeaderMap, RETRY_AFTER, USER_AGENT};
use reqwest::{RequestBuilder, StatusCode};
use serde_json::{Value, json};

use super::pow::PowChallenge;

/// The `client_name` the CLI registers with, shown to humans as self-reported.
pub const CLIENT_NAME: &str = "whk-cli";
pub const JWT_BEARER_GRANT: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";
pub const CLAIM_GRANT: &str = "urn:workos:agent-auth:grant-type:claim";
/// An access token lives this long when the server does not say.
const DEFAULT_TOKEN_SECONDS: i64 = 3600;
const DEFAULT_CLAIM_INTERVAL: u64 = 5;

/// A refused step: `code` is auth.md's or OAuth's error code
/// (`sandbox_full`, `rate_limited`, `invalid_grant`, ...), or `http_<status>`
/// when the body had none.
#[derive(Debug, Clone)]
pub struct AgentError {
    pub code: String,
    pub status: u16,
    pub description: Option<String>,
    /// Seconds from the `Retry-After` header.
    pub retry_after: Option<u64>,
    /// The parsed body, for a fresh challenge. Never contains secrets.
    pub body: Value,
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (HTTP {})", self.code, self.status)?;
        if let Some(description) = &self.description {
            let clean: String = description.chars().filter(|c| !c.is_control()).collect();
            write!(f, ": {clean}")?;
        }
        if let Some(seconds) = self.retry_after {
            write!(f, " Retry after {seconds} s.")?;
        }
        Ok(())
    }
}

impl std::error::Error for AgentError {}

impl AgentError {
    pub fn new(code: &str, status: u16, description: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            status,
            description: Some(description.into()),
            retry_after: None,
            body: Value::Null,
        }
    }

    /// The error a non-2xx answer stands for.
    pub fn from_response(status: StatusCode, headers: &HeaderMap, body: Value) -> Self {
        let text = |key: &str| body.get(key).and_then(Value::as_str).map(String::from);
        Self {
            code: text("error").unwrap_or_else(|| format!("http_{}", status.as_u16())),
            status: status.as_u16(),
            description: text("error_description"),
            retry_after: headers
                .get(RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse().ok()),
            body,
        }
    }
}

/// The server's error code, when `error` is (or wraps) an [`AgentError`].
pub fn error_code(error: &anyhow::Error) -> Option<&str> {
    error.downcast_ref::<AgentError>().map(|e| e.code.as_str())
}

/// Adds the headers every agent call sends.
pub fn agent_request(builder: RequestBuilder) -> RequestBuilder {
    builder
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, format!("{CLIENT_NAME}/{}", env!("WHK_VERSION")))
}

/// Sends a request and returns its status, headers and JSON body (`Null`
/// when there is none or it is not JSON).
pub async fn send_json(builder: RequestBuilder) -> Result<(StatusCode, HeaderMap, Value)> {
    let resp = agent_request(builder)
        .send()
        .await
        .map_err(|e| e.without_url())
        .context("request failed")?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let text = resp.text().await.context("failed to read response body")?;
    let body = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok((status, headers, body))
}

fn string(body: &Value, key: &str) -> Result<String> {
    body.get(key)
        .and_then(Value::as_str)
        .map(String::from)
        .with_context(|| format!("malformed response: missing {key}"))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A fresh proof-of-work challenge (auth.md Step 3).
pub async fn challenge(http: &reqwest::Client, base: &str) -> Result<PowChallenge> {
    let request = http
        .post(format!("{base}/api/agent/identity/challenge"))
        .json(&json!({}));
    let (status, headers, body) = send_json(request).await?;
    if !status.is_success() {
        return Err(AgentError::from_response(status, &headers, body).into());
    }
    PowChallenge::from_json(&body)
}

/// An anonymous registration. The claim token stays in this process's
/// memory, as `/auth.md` asks; it is never written anywhere.
pub struct AnonymousRegistration {
    pub registration_id: String,
    pub identity_assertion: String,
    pub assertion_expires: String,
    /// `full` when the shared sandbox has no free endpoint slot.
    pub sandbox_status: String,
}

/// Registers anonymously: fetches a challenge, solves it and registers.
/// Retries once with the fresh challenge a refusal carries (the first one
/// expired while solving, for example). `on_solve` is told about each
/// challenge before the CPU work starts.
pub async fn register_anonymous(
    http: &reqwest::Client,
    base: &str,
    on_solve: &dyn Fn(&PowChallenge),
) -> Result<AnonymousRegistration> {
    let mut current = challenge(http, base).await?;
    for attempt in 0.. {
        on_solve(&current);
        let puzzle = current.clone();
        let nonces = tokio::task::spawn_blocking(move || puzzle.solve())
            .await
            .context("proof-of-work solver failed")?;
        let request = http
            .post(format!("{base}/api/agent/identity"))
            .json(&json!({
                "type": "anonymous",
                "client_name": CLIENT_NAME,
                "proof_of_work": { "challenge": current.challenge, "nonces": nonces },
            }));
        let (status, headers, body) = send_json(request).await?;
        if status.is_success() {
            let sandbox = body.get("sandbox").cloned().unwrap_or(Value::Null);
            return Ok(AnonymousRegistration {
                registration_id: string(&body, "registration_id")?,
                identity_assertion: string(&body, "identity_assertion")?,
                assertion_expires: string(&body, "assertion_expires")?,
                sandbox_status: string(&sandbox, "status").unwrap_or_else(|_| "available".into()),
            });
        }
        let error = AgentError::from_response(status, &headers, body);
        let fresh = matches!(
            error.code.as_str(),
            "invalid_challenge" | "proof_of_work_required"
        ) && error.body.get("challenge").is_some_and(Value::is_string);
        if attempt == 0 && fresh {
            current = PowChallenge::from_json(&error.body)?;
            continue;
        }
        return Err(error.into());
    }
    unreachable!("the loop returns")
}

/// A claim attempt: show `verification_uri` and `user_code` to the human.
#[derive(Debug, Clone)]
pub struct ClaimAttempt {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at_ms: i64,
    /// Seconds to wait between claim polls.
    pub interval: u64,
}

/// A service_auth registration: nothing works until the human claims it.
pub struct ServiceAuthRegistration {
    pub registration_id: String,
    /// In memory only: it collects the claim's result once.
    pub claim_token: String,
    pub claim: ClaimAttempt,
}

/// Registers for a human known by email (auth.md Step 2, service_auth).
pub async fn register_service_auth(
    http: &reqwest::Client,
    base: &str,
    email: &str,
) -> Result<ServiceAuthRegistration> {
    let request = http
        .post(format!("{base}/api/agent/identity"))
        .json(&json!({
            "type": "service_auth",
            "login_hint": email,
            "client_name": CLIENT_NAME,
        }));
    let (status, headers, body) = send_json(request).await?;
    if !status.is_success() {
        return Err(AgentError::from_response(status, &headers, body).into());
    }
    let block = body.get("claim").cloned().unwrap_or(Value::Null);
    let expires_in = block.get("expires_in").and_then(Value::as_i64).unwrap_or(0);
    Ok(ServiceAuthRegistration {
        registration_id: string(&body, "registration_id")?,
        claim_token: string(&body, "claim_token")?,
        claim: ClaimAttempt {
            user_code: string(&block, "user_code")?,
            verification_uri: string(&block, "verification_uri")?,
            expires_at_ms: now_ms() + expires_in.max(0) * 1000,
            interval: block
                .get("interval")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_CLAIM_INTERVAL),
        },
    })
}

/// An access token and when it stops working.
pub struct AccessToken {
    pub access_token: String,
    pub scope: String,
    pub expires_at_ms: i64,
}

fn access_token(body: &Value) -> Result<AccessToken> {
    let seconds = body
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_TOKEN_SECONDS);
    Ok(AccessToken {
        access_token: string(body, "access_token")?,
        scope: body
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        expires_at_ms: now_ms() + seconds * 1000,
    })
}

/// Exchanges an identity assertion for an access token (auth.md Step 5).
/// `resource` is left out on purpose: the server compares it with its own
/// public URL, which a local stack or a loopback address would not match.
pub async fn exchange(http: &reqwest::Client, base: &str, assertion: &str) -> Result<AccessToken> {
    let request = http
        .post(format!("{base}/api/oauth2/token"))
        .form(&[("grant_type", JWT_BEARER_GRANT), ("assertion", assertion)]);
    let (status, headers, body) = send_json(request).await?;
    if !status.is_success() {
        return Err(AgentError::from_response(status, &headers, body).into());
    }
    access_token(&body)
}

/// One answer of the claim grant (auth.md Step 4c).
pub enum ClaimPoll {
    Pending,
    SlowDown,
    Expired,
    Denied,
    Claimed {
        token: AccessToken,
        /// The claimed assertion: mints account tokens for 90 days.
        identity_assertion: String,
        assertion_expires: String,
    },
}

/// Polls the claim grant once.
pub async fn poll_claim(
    http: &reqwest::Client,
    base: &str,
    claim_token: &str,
) -> Result<ClaimPoll> {
    let request = http
        .post(format!("{base}/api/oauth2/token"))
        .form(&[("grant_type", CLAIM_GRANT), ("claim_token", claim_token)]);
    let (status, headers, body) = send_json(request).await?;
    if status.is_success() {
        return Ok(ClaimPoll::Claimed {
            token: access_token(&body)?,
            identity_assertion: string(&body, "identity_assertion")?,
            assertion_expires: string(&body, "assertion_expires")?,
        });
    }
    let error = AgentError::from_response(status, &headers, body);
    Ok(match error.code.as_str() {
        "authorization_pending" => ClaimPoll::Pending,
        "slow_down" => ClaimPoll::SlowDown,
        "expired_token" => ClaimPoll::Expired,
        "access_denied" => ClaimPoll::Denied,
        _ => return Err(error.into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_keep_the_server_code_and_retry_after() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, "600".parse().unwrap());
        let body =
            json!({ "error": "sandbox_full", "error_description": "The sandbox is full.\x1b[2J" });
        let error = AgentError::from_response(StatusCode::SERVICE_UNAVAILABLE, &headers, body);
        assert_eq!(
            error.to_string(),
            "sandbox_full (HTTP 503): The sandbox is full.[2J Retry after 600 s."
        );

        let html =
            AgentError::from_response(StatusCode::BAD_GATEWAY, &HeaderMap::new(), Value::Null);
        assert_eq!(html.to_string(), "http_502 (HTTP 502)");
        assert_eq!(error_code(&anyhow::Error::new(html)), Some("http_502"));
    }
}
