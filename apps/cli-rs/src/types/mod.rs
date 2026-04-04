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
    /// Base64-encoded raw bytes, present only for non-UTF-8 payloads
    #[serde(rename = "bodyRaw", default)]
    pub body_raw: Option<String>,
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

#[derive(Clone, Serialize, Deserialize)]
pub struct ClaimResponse {
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    pub email: String,
}

impl std::fmt::Debug for ClaimResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaimResponse")
            .field("api_key", &"[REDACTED]")
            .field("user_id", &self.user_id)
            .field("email", &self.email)
            .finish()
    }
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

#[derive(Clone, Serialize, Deserialize)]
pub struct Token {
    pub access_token: String,
    pub user_id: String,
    pub email: String,
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Token")
            .field("access_token", &"[REDACTED]")
            .field("user_id", &self.user_id)
            .field("email", &self.email)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Tunnel / forwarding
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ForwardResult {
    pub success: bool,
    pub status_code: Option<u16>,
    pub duration: std::time::Duration,
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
    Connected,
    Request(Box<CapturedRequest>),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_endpoint_from_api() {
        let json = r#"{
            "id": "abc-123",
            "slug": "test-slug",
            "url": "https://go.webhooks.cc/w/test-slug",
            "isEphemeral": true,
            "expiresAt": 1775030647212,
            "createdAt": 1774987447212,
            "sharedWith": []
        }"#;
        let ep: Endpoint = serde_json::from_str(json).unwrap();
        assert_eq!(ep.slug, "test-slug");
        assert!(ep.is_ephemeral);
        assert_eq!(ep.expires_at, Some(1775030647212));
        assert_eq!(ep.created_at, Some(1774987447212));
        assert!(ep.name.is_none());
        assert!(ep.mock_response.is_none());
        assert!(ep.request_count.is_none());
    }

    #[test]
    fn test_deserialize_endpoint_with_mock() {
        let json = r#"{
            "id": "abc-123",
            "slug": "test",
            "mockResponse": {"status": 201, "body": "{\"ok\":true}", "headers": {}},
            "createdAt": 1774987447212,
            "sharedWith": []
        }"#;
        let ep: Endpoint = serde_json::from_str(json).unwrap();
        let mock = ep.mock_response.unwrap();
        assert_eq!(mock.status, 201);
        assert_eq!(mock.body, "{\"ok\":true}");
    }

    #[test]
    fn test_deserialize_endpoint_list() {
        let json = r#"{"owned": [{"id":"1","slug":"a","createdAt":123,"sharedWith":[]}], "shared": []}"#;
        let list: EndpointList = serde_json::from_str(json).unwrap();
        assert_eq!(list.owned.len(), 1);
        assert_eq!(list.owned[0].slug, "a");
    }

    #[test]
    fn test_deserialize_request_with_id() {
        let json = r#"{
            "id": "req-123",
            "endpointId": "ep-456",
            "method": "POST",
            "path": "/hook",
            "headers": {"content-type": "application/json"},
            "body": "{\"test\":true}",
            "queryParams": {},
            "contentType": "application/json",
            "ip": "1.2.3.4",
            "size": 14,
            "receivedAt": 1774866106592
        }"#;
        let req: CapturedRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.id, "req-123");
        assert_eq!(req.method, "POST");
        assert_eq!(req.size, 14);
    }

    #[test]
    fn test_deserialize_request_with_underscore_id() {
        // SSE stream uses _id instead of id
        let json = r#"{
            "_id": "sse-req-789",
            "endpointId": "ep-456",
            "method": "GET",
            "path": "/",
            "headers": {},
            "queryParams": {},
            "ip": "1.2.3.4",
            "size": 0,
            "receivedAt": 1774866106592
        }"#;
        let req: CapturedRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.id, "sse-req-789");
    }

    #[test]
    fn test_deserialize_request_bare_array() {
        let json = r#"[
            {"id":"1","endpointId":"ep","method":"POST","path":"/","headers":{},"queryParams":{},"ip":"1.2.3.4","size":0,"receivedAt":123},
            {"id":"2","endpointId":"ep","method":"GET","path":"/health","headers":{},"queryParams":{},"ip":"1.2.3.4","size":0,"receivedAt":124}
        ]"#;
        let reqs: Vec<CapturedRequest> = serde_json::from_str(json).unwrap();
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[1].path, "/health");
    }

    #[test]
    fn test_deserialize_device_code() {
        let json = r#"{
            "deviceCode": "dc-123",
            "userCode": "ABCD-1234",
            "expiresAt": 1774988132951,
            "verificationUrl": "https://webhooks.cc/cli/verify"
        }"#;
        let dc: DeviceCodeResponse = serde_json::from_str(json).unwrap();
        assert_eq!(dc.user_code, "ABCD-1234");
        assert_eq!(dc.expires_at, 1774988132951);
    }

    #[test]
    fn test_deserialize_usage() {
        let json = r#"{"used":1,"limit":100000,"remaining":99999,"plan":"free","periodEnd":1774987719639}"#;
        let u: UsageInfo = serde_json::from_str(json).unwrap();
        assert_eq!(u.plan, "free");
        assert_eq!(u.remaining, 99999);
        assert_eq!(u.period_end, Some(1774987719639));
    }

    #[test]
    fn test_deserialize_usage_null_period() {
        let json = r#"{"used":0,"limit":100000,"remaining":100000,"plan":"free","periodEnd":null}"#;
        let u: UsageInfo = serde_json::from_str(json).unwrap();
        assert!(u.period_end.is_none());
    }

    #[test]
    fn test_deserialize_send_response() {
        let json = r#"{"status":200,"statusText":"OK","body":"OK"}"#;
        let r: SendResponse = serde_json::from_str(json).unwrap();
        assert_eq!(r.status, 200);
    }

    #[test]
    fn test_mock_response_serialization_no_delay() {
        let mock = MockResponse {
            status: 200,
            body: "ok".into(),
            headers: HashMap::new(),
            delay: None,
        };
        let json = serde_json::to_string(&mock).unwrap();
        assert!(!json.contains("delay"), "delay should be skipped when None: {json}");
    }

    #[test]
    fn test_token_debug_redacts() {
        let token = Token {
            access_token: "secret-key-123".into(),
            user_id: "user-1".into(),
            email: "test@example.com".into(),
        };
        let debug = format!("{:?}", token);
        assert!(!debug.contains("secret-key-123"), "token should be redacted in Debug: {debug}");
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn test_forward_result_display() {
        let r = ForwardResult {
            success: true,
            status_code: Some(200),
            duration: std::time::Duration::from_millis(150),
            error: None,
        };
        assert!(r.to_string().contains("200"));

        let r = ForwardResult {
            success: false,
            status_code: None,
            duration: std::time::Duration::from_millis(0),
            error: Some("connection refused".into()),
        };
        assert!(r.to_string().contains("FAILED"));
        assert!(r.to_string().contains("connection refused"));
    }
}
