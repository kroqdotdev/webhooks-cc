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

    /// Fetch endpoint info from Convex and cache it in Redis.
    pub async fn fetch_and_cache_endpoint(
        &self,
        slug: &str,
    ) -> Result<Option<EndpointInfo>, ConvexError> {
        if !self.circuit.allow_request().await {
            return Err(ConvexError::CircuitOpen);
        }

        let url = format!("{}/endpoint-info?slug={}", self.base_url, slug);
        let resp = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.secret))
            .send()
            .await
            .map_err(|e| {
                self.record_failure_sync();
                ConvexError::Network(e.to_string())
            })?;

        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| {
                self.record_failure_sync();
                ConvexError::Network(e.to_string())
            })?;

        if body.len() > MAX_RESPONSE_SIZE {
            self.record_failure_sync();
            return Err(ConvexError::ResponseTooLarge);
        }

        if status >= 500 {
            self.record_failure_sync();
            return Err(ConvexError::ServerError(status, body));
        }

        // Reachable (even on 4xx) — clear circuit
        self.record_success_sync();

        if !(200..300).contains(&status) {
            return Err(ConvexError::ClientError(status, body));
        }

        let info: EndpointInfo = serde_json::from_str(&body)
            .map_err(|e| ConvexError::ParseError(e.to_string()))?;

        // Don't cache not_found errors
        if info.error.is_empty() {
            self.redis.set_endpoint(slug, &info).await;
        }

        if info.error == "not_found" {
            return Ok(None);
        }

        Ok(Some(info))
    }

    /// Fetch quota from Convex and cache it in Redis.
    pub async fn fetch_and_cache_quota(
        &self,
        slug: &str,
    ) -> Result<(), ConvexError> {
        if !self.circuit.allow_request().await {
            return Err(ConvexError::CircuitOpen);
        }

        let url = format!("{}/quota?slug={}", self.base_url, slug);
        let resp = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.secret))
            .send()
            .await
            .map_err(|e| {
                self.record_failure_sync();
                ConvexError::Network(e.to_string())
            })?;

        let status = resp.status().as_u16();
        let body = resp.text().await.map_err(|e| {
            self.record_failure_sync();
            ConvexError::Network(e.to_string())
        })?;

        if status >= 500 {
            self.record_failure_sync();
            return Err(ConvexError::ServerError(status, body));
        }

        self.record_success_sync();

        if !(200..300).contains(&status) {
            return Err(ConvexError::ClientError(status, body));
        }

        let quota: QuotaResponse = serde_json::from_str(&body)
            .map_err(|e| ConvexError::ParseError(e.to_string()))?;

        if quota.error == "not_found" {
            return Ok(());
        }

        // Handle free users needing period start
        if quota.needs_period_start && !quota.user_id.is_empty()
            && let Ok(period) = self.call_check_period(&quota.user_id).await {
                if period.error.is_empty() {
                    self.redis
                        .set_quota(
                            slug,
                            period.remaining,
                            period.limit,
                            period.period_end.unwrap_or(0),
                            false,
                            &quota.user_id,
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
                            &quota.user_id,
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
                &quota.user_id,
            )
            .await;

        Ok(())
    }

    /// Call check-period to start a free user's billing period.
    async fn call_check_period(
        &self,
        user_id: &str,
    ) -> Result<CheckPeriodResponse, ConvexError> {
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

        let status = resp.status().as_u16();
        let body = resp.text().await.map_err(|e| {
            self.record_failure_sync();
            ConvexError::Network(e.to_string())
        })?;

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

        let status = resp.status().as_u16();
        let body = resp.text().await.map_err(|e| {
            self.record_failure_sync();
            ConvexError::Network(e.to_string())
        })?;

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

impl std::fmt::Display for ConvexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConvexError::CircuitOpen => write!(f, "circuit breaker open"),
            ConvexError::Network(e) => write!(f, "network error: {}", e),
            ConvexError::ServerError(s, b) => write!(f, "server error {}: {}", s, b),
            ConvexError::ClientError(s, b) => write!(f, "client error {}: {}", s, b),
            ConvexError::ParseError(e) => write!(f, "parse error: {}", e),
            ConvexError::ResponseTooLarge => write!(f, "response too large"),
        }
    }
}
