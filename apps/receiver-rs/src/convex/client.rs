use reqwest::Client;
use std::time::Duration;

use super::circuit_breaker::CircuitBreaker;
use super::types::*;
use crate::config::Config;
use crate::redis::RedisState;

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_SIZE: usize = 1024 * 1024; // 1MB

/// Convex HTTP client with circuit breaker.
#[derive(Clone)]
pub struct ConvexClient {
    http: Client,
    base_url: String,
    secret: String,
    circuit: CircuitBreaker,
    redis: RedisState,
}

impl ConvexClient {
    pub fn new(config: &Config, redis: RedisState) -> Self {
        let http = Client::builder()
            .timeout(HTTP_TIMEOUT)
            .pool_max_idle_per_host(100)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("failed to create HTTP client");

        let circuit = CircuitBreaker::new(redis.clone());

        Self {
            http,
            base_url: config.convex_site_url.clone(),
            secret: config.capture_shared_secret.clone(),
            circuit,
            redis,
        }
    }

    pub fn circuit(&self) -> &CircuitBreaker {
        &self.circuit
    }

    /// Read the response body with size limiting to prevent unbounded allocation.
    /// Uses bytes() and checks length before converting to string, which also
    /// handles chunked responses that lack a Content-Length header.
    async fn read_body(&self, resp: reqwest::Response) -> Result<(u16, String), ConvexError> {
        let status = resp.status().as_u16();

        // Pre-check Content-Length header to reject obviously too-large responses
        // without reading the body at all.
        if let Some(len) = resp.content_length()
            && len > MAX_RESPONSE_SIZE as u64
        {
            self.record_failure_sync();
            return Err(ConvexError::ResponseTooLarge);
        }

        // Read as bytes first — reqwest limits to Content-Length when present,
        // but for chunked responses we check the accumulated size after download.
        let body_bytes = resp.bytes().await.map_err(|e| {
            self.record_failure_sync();
            ConvexError::Network(e.to_string())
        })?;

        if body_bytes.len() > MAX_RESPONSE_SIZE {
            self.record_failure_sync();
            return Err(ConvexError::ResponseTooLarge);
        }

        let body = String::from_utf8_lossy(&body_bytes).into_owned();
        Ok((status, body))
    }

    /// Fetch endpoint info from Convex and cache it in Redis.
    pub async fn fetch_and_cache_endpoint(
        &self,
        slug: &str,
    ) -> Result<Option<EndpointInfo>, ConvexError> {
        if !self.circuit.allow_request().await {
            return Err(ConvexError::CircuitOpen);
        }

        let resp = self
            .http
            .get(format!("{}/endpoint-info", self.base_url))
            .query(&[("slug", slug)])
            .header("Authorization", format!("Bearer {}", self.secret))
            .send()
            .await
            .map_err(|e| {
                self.record_failure_sync();
                ConvexError::Network(e.to_string())
            })?;

        let (status, body) = self.read_body(resp).await?;

        if status >= 500 {
            self.record_failure_sync();
            return Err(ConvexError::ServerError(status, body));
        }

        // Reachable (even on 4xx) — clear circuit
        self.record_success_sync();

        if !(200..300).contains(&status) {
            return Err(ConvexError::ClientError(status, body));
        }

        let info: EndpointInfo =
            serde_json::from_str(&body).map_err(|e| ConvexError::ParseError(e.to_string()))?;

        // Cache valid responses; skip caching errors (not_found, etc.)
        if info.error.is_empty() {
            self.redis.set_endpoint(slug, &info).await;
        }

        if info.error == "not_found" {
            return Ok(None);
        }

        Ok(Some(info))
    }

    /// Fetch quota from Convex and cache it in Redis.
    pub async fn fetch_and_cache_quota(&self, slug: &str) -> Result<(), ConvexError> {
        if !self.circuit.allow_request().await {
            return Err(ConvexError::CircuitOpen);
        }

        let resp = self
            .http
            .get(format!("{}/quota", self.base_url))
            .query(&[("slug", slug)])
            .header("Authorization", format!("Bearer {}", self.secret))
            .send()
            .await
            .map_err(|e| {
                self.record_failure_sync();
                ConvexError::Network(e.to_string())
            })?;

        let (status, body) = self.read_body(resp).await?;

        if status >= 500 {
            self.record_failure_sync();
            return Err(ConvexError::ServerError(status, body));
        }

        self.record_success_sync();

        if !(200..300).contains(&status) {
            return Err(ConvexError::ClientError(status, body));
        }

        let quota: QuotaResponse =
            serde_json::from_str(&body).map_err(|e| ConvexError::ParseError(e.to_string()))?;

        if quota.error == "not_found" {
            return Ok(());
        }

        let user_id = quota.user_id.as_deref().unwrap_or("");

        // Handle free users needing period start
        if quota.needs_period_start
            && !user_id.is_empty()
            && let Ok(period) = self.call_check_period(user_id).await
        {
            if period.error.is_empty() {
                self.redis
                    .set_quota(
                        slug,
                        period.remaining,
                        period.limit,
                        period.period_end.unwrap_or(0),
                        false,
                        user_id,
                    )
                    .await;
                return Ok(());
            } else if period.error == "quota_exceeded" {
                self.redis
                    .set_quota(
                        slug,
                        0,
                        period.limit,
                        period.period_end.unwrap_or(0),
                        false,
                        user_id,
                    )
                    .await;
                return Ok(());
            }
        }
        // Fall through to use original quota response

        let is_unlimited = quota.remaining == -1;
        self.redis
            .set_quota(
                slug,
                quota.remaining,
                quota.limit,
                quota.period_end.unwrap_or(0),
                is_unlimited,
                user_id,
            )
            .await;

        Ok(())
    }

    /// Call check-period to start a free user's billing period.
    async fn call_check_period(&self, user_id: &str) -> Result<CheckPeriodResponse, ConvexError> {
        if !self.circuit.allow_request().await {
            return Err(ConvexError::CircuitOpen);
        }

        let url = format!("{}/check-period", self.base_url);
        let payload = serde_json::json!({ "userId": user_id });

        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.secret))
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                self.record_failure_sync();
                ConvexError::Network(e.to_string())
            })?;

        let (status, body) = self.read_body(resp).await?;

        if status >= 500 {
            self.record_failure_sync();
            return Err(ConvexError::ServerError(status, body));
        }

        self.record_success_sync();

        // 429 contains valid quota_exceeded JSON
        if status != 200 && status != 429 {
            return Err(ConvexError::ClientError(status, body));
        }

        serde_json::from_str(&body).map_err(|e| ConvexError::ParseError(e.to_string()))
    }

    /// List users by plan (paginated) via shared-secret Convex HTTP action.
    pub async fn list_users_by_plan(
        &self,
        plan: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<UsersByPlanResponse, ConvexError> {
        if !self.circuit.allow_request().await {
            return Err(ConvexError::CircuitOpen);
        }

        let mut request = self
            .http
            .get(format!("{}/users-by-plan", self.base_url))
            .query(&[("plan", plan), ("limit", &limit.to_string())])
            .header("Authorization", format!("Bearer {}", self.secret));

        if let Some(cursor) = cursor {
            request = request.query(&[("cursor", cursor)]);
        }

        let resp = request.send().await.map_err(|e| {
            self.record_failure_sync();
            ConvexError::Network(e.to_string())
        })?;

        let (status, body) = self.read_body(resp).await?;

        if status >= 500 {
            self.record_failure_sync();
            return Err(ConvexError::ServerError(status, body));
        }

        self.record_success_sync();

        if !(200..300).contains(&status) {
            return Err(ConvexError::ClientError(status, body));
        }

        serde_json::from_str(&body).map_err(|e| ConvexError::ParseError(e.to_string()))
    }

    /// Send a batch of captured requests to Convex.
    pub async fn capture_batch(
        &self,
        slug: &str,
        requests: Vec<BufferedRequest>,
    ) -> Result<CaptureResponse, ConvexError> {
        if !self.circuit.allow_request().await {
            return Err(ConvexError::CircuitOpen);
        }

        let url = format!("{}/capture-batch", self.base_url);
        let payload = BatchPayload {
            slug: slug.to_string(),
            requests,
        };

        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.secret))
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                self.record_failure_sync();
                ConvexError::Network(e.to_string())
            })?;

        let (status, body) = self.read_body(resp).await?;

        if status >= 500 {
            self.record_failure_sync();
            return Err(ConvexError::ServerError(status, body));
        }

        self.record_success_sync();

        if !(200..300).contains(&status) {
            return Err(ConvexError::ClientError(status, body));
        }

        serde_json::from_str(&body).map_err(|e| ConvexError::ParseError(e.to_string()))
    }

    // Spawn fire-and-forget circuit breaker updates on the tokio runtime.
    fn record_failure_sync(&self) {
        let circuit = self.circuit.clone();
        tokio::spawn(async move { circuit.record_failure().await });
    }

    fn record_success_sync(&self) {
        let circuit = self.circuit.clone();
        tokio::spawn(async move { circuit.record_success().await });
    }
}

#[derive(Debug)]
pub enum ConvexError {
    CircuitOpen,
    Network(String),
    ServerError(u16, String),
    ClientError(u16, String),
    ParseError(String),
    ResponseTooLarge,
}

impl std::error::Error for ConvexError {}

impl std::fmt::Display for ConvexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConvexError::CircuitOpen => write!(f, "circuit breaker open"),
            ConvexError::Network(e) => write!(f, "network error: {}", e),
            ConvexError::ServerError(s, b) => {
                let truncated = match b.char_indices().nth(200) {
                    Some((idx, _)) => &b[..idx],
                    None => b.as_str(),
                };
                write!(f, "server error {}: {}", s, truncated)
            }
            ConvexError::ClientError(s, b) => {
                let truncated = match b.char_indices().nth(200) {
                    Some((idx, _)) => &b[..idx],
                    None => b.as_str(),
                };
                write!(f, "client error {}: {}", s, truncated)
            }
            ConvexError::ParseError(e) => write!(f, "parse error: {}", e),
            ConvexError::ResponseTooLarge => write!(f, "response too large"),
        }
    }
}
