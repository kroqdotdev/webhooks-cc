use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub id: String,
    pub slug: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(rename = "isEphemeral", default)]
    pub is_ephemeral: bool,
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<i64>,
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<i64>,
    #[serde(rename = "requestCount", default)]
    pub request_count: Option<u64>,
    #[serde(rename = "mockResponse", default)]
    pub mock_response: Option<MockResponse>,
    #[serde(rename = "sharedWith", default)]
    pub shared_with: Vec<TeamShare>,
    #[serde(rename = "fromTeam", default)]
    pub from_team: Option<TeamShare>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamShare {
    #[serde(rename = "teamId")]
    pub team_id: String,
    #[serde(rename = "teamName")]
    pub team_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MockResponse {
    pub status: u16,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateEndpointRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "isEphemeral", skip_serializing_if = "Option::is_none")]
    pub is_ephemeral: Option<bool>,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(rename = "mockResponse", skip_serializing_if = "Option::is_none")]
    pub mock_response: Option<MockResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateEndpointRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        rename = "mockResponse",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub mock_response: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointList {
    pub owned: Vec<Endpoint>,
    #[serde(default)]
    pub shared: Vec<Endpoint>,
}

// ---------------------------------------------------------------------------
// Captured request
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapturedRequest {
    #[serde(alias = "_id")]
    pub id: String,
    #[serde(rename = "endpointId")]
    pub endpoint_id: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(rename = "queryParams", default)]
    pub query_params: HashMap<String, String>,
    #[serde(rename = "contentType", default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub ip: String,
    #[serde(default)]
    pub size: usize,
    #[serde(rename = "receivedAt")]
    pub received_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestList {
    pub requests: Vec<CapturedRequest>,
    #[serde(default)]
    pub count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaginatedRequestList {
    pub requests: Vec<CapturedRequest>,
    #[serde(rename = "nextCursor", default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub requests: Vec<CapturedRequest>,
    #[serde(default)]
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountResult {
    pub count: u64,
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageInfo {
    pub used: u64,
    pub limit: u64,
    pub remaining: u64,
    pub plan: String,
    #[serde(rename = "periodEnd", default)]
    pub period_end: Option<i64>,
}

// ---------------------------------------------------------------------------
// Device auth
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    #[serde(rename = "deviceCode")]
    pub device_code: String,
    #[serde(rename = "userCode")]
    pub user_code: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    #[serde(rename = "verificationUrl")]
    pub verification_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollResponse {
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimResponse {
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    pub email: String,
}

// ---------------------------------------------------------------------------
// Send webhook
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendWebhookRequest {
    pub method: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendResponse {
    pub status: u16,
    #[serde(rename = "statusText")]
    pub status_text: String,
    #[serde(default)]
    pub body: Option<String>,
}

// ---------------------------------------------------------------------------
// Auth token (stored on disk)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    pub access_token: String,
    pub user_id: String,
    pub email: String,
}

// ---------------------------------------------------------------------------
// GitHub release (self-update)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    pub assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubAsset {
    pub name: String,
    pub browser_download_url: String,
}

// ---------------------------------------------------------------------------
// Tunnel / forwarding
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ForwardResult {
    pub success: bool,
    pub status_code: Option<u16>,
    pub duration: std::time::Duration,
    pub body_size: usize,
    pub error: Option<String>,
}

impl fmt::Display for ForwardResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.success {
            write!(
                f,
                "{} ({:.0?})",
                self.status_code.unwrap_or(0),
                self.duration
            )
        } else {
            write!(
                f,
                "FAILED: {}",
                self.error.as_deref().unwrap_or("unknown error")
            )
        }
    }
}

// ---------------------------------------------------------------------------
// SSE events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum SseEvent {
    Connected { slug: String },
    Request(CapturedRequest),
    EndpointDeleted,
    Timeout,
}

// ---------------------------------------------------------------------------
// API error response
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorBody {
    #[serde(default)]
    pub error: String,
}
