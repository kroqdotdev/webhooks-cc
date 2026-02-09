use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockResponse {
    pub status: i32,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInfo {
    pub endpoint_id: String,
    pub user_id: Option<String>,
    #[serde(default)]
    pub is_ephemeral: bool,
    pub expires_at: Option<i64>,
    pub mock_response: Option<MockResponse>,
    #[serde(default)]
    pub error: String,
}

impl EndpointInfo {
    pub fn is_expired(&self) -> bool {
        if let Some(expires_at) = self.expires_at {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            expires_at < now_ms
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaResponse {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub remaining: i64,
    #[serde(default)]
    pub limit: i64,
    pub period_end: Option<i64>,
    pub plan: Option<String>,
    #[serde(default)]
    pub needs_period_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckPeriodResponse {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub remaining: i64,
    #[serde(default)]
    pub limit: i64,
    pub period_end: Option<i64>,
    pub retry_after: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferedRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub body: String,
    pub query_params: HashMap<String, String>,
    pub ip: String,
    pub received_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResponse {
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub inserted: usize,
    pub mock_response: Option<MockResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPayload {
    pub slug: String,
    pub requests: Vec<BufferedRequest>,
}
