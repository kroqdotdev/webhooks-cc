use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
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
    /// Oldest share among the caller's teams (present when shared with you).
    #[serde(rename = "fromTeam", default)]
    pub from_team: Option<TeamShare>,
    /// Every subscribed team of the caller this endpoint is shared with.
    #[serde(rename = "fromTeams", default)]
    pub from_teams: Vec<TeamShare>,
    /// Address the endpoint receives email at (`{slug}@mailhooks.cc`); none for guest endpoints.
    #[serde(rename = "emailAddress", default)]
    pub email_address: Option<String>,
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
    #[serde(rename = "signingProvider", skip_serializing_if = "Option::is_none")]
    pub signing_provider: Option<String>,
    #[serde(rename = "signingSecret", skip_serializing_if = "Option::is_none")]
    pub signing_secret: Option<String>,
    #[serde(rename = "signingHeader", skip_serializing_if = "Option::is_none")]
    pub signing_header: Option<String>,
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
    /// Signature verification result: true=valid, false=invalid, null=not configured
    #[serde(rename = "signatureVerified", default)]
    pub signature_verified: Option<bool>,
    /// Structured JSON error when signature_verified=false
    #[serde(rename = "signatureError", default)]
    pub signature_error: Option<String>,
    /// Provider that verified the signature (e.g., "stripe", "github")
    #[serde(rename = "signingProvider", default)]
    pub signing_provider: Option<String>,
    /// "email" for a captured email, "http" otherwise. The SSE stream leaves it out.
    #[serde(default)]
    pub kind: Option<String>,
    /// The parsed message of a captured email (the REST API sends it; the stream does not).
    #[serde(default)]
    pub email: Option<EmailSummary>,
    /// What the endpoint's layouts found in a captured email. Only emails on
    /// an endpoint with layouts have it, once their parse is done: in full
    /// from `GET /api/requests/{id}`, as a summary in lists (`partial`), and
    /// never in the stream. Boxed: most requests have none, and every
    /// request is moved around the TUI's messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parsed: Option<Box<ParsedEmail>>,
}

/// `parsed` on a captured email, as the SDK's `ParsedEmail`
/// (packages/sdk/src/email/layouts.ts). Every key the API sends is kept, so
/// `--json` passes it on.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedEmail {
    /// "matched", or "no_layout" when no layout's conditions held.
    #[serde(default)]
    pub status: String,
    /// The layout that applied; none for no_layout.
    #[serde(default)]
    pub layout: Option<ParsedLayout>,
    /// The layout's named values; null when its pattern found nothing.
    #[serde(default)]
    pub fields: BTreeMap<String, Option<String>>,
    #[serde(rename = "lineItems", default)]
    pub line_items: Vec<BTreeMap<String, Option<String>>>,
    /// The line items' columns in order: a JSON object's keys (and jsonb's)
    /// come back in any order.
    #[serde(rename = "lineItemColumns", default)]
    pub line_item_columns: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<ParsedAttachment>,
    /// Billable pages this email used.
    #[serde(default)]
    pub pages: u64,
    /// Cut to fit the email's JSON; the full parse is kept on the server.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// A list's summary: line items and attachments are left out.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
}

impl ParsedEmail {
    pub fn matched(&self) -> bool {
        self.status == "matched"
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedLayout {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// One attachment a layout parsed, or why it was not.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedAttachment {
    /// Its place among the email's attachments, from 0.
    #[serde(default)]
    pub index: u64,
    #[serde(default)]
    pub filename: Option<String>,
    /// csv, tsv, xlsx, xls, ods, pdf or text.
    #[serde(default)]
    pub format: String,
    /// Billable pages this parse used (0 when an earlier parse was read again).
    #[serde(default)]
    pub pages: u64,
    /// A spreadsheet's sheets, each with its first 1,000 rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheets: Option<Vec<ParsedSheet>>,
    /// A PDF's or text file's text, cut at 256 KB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Stopped at the per-file page cap, or cut to fit.
    #[serde(default)]
    pub truncated: bool,
    /// Why it was not parsed: limit, not_kept, not_parsed, too_large,
    /// malformed, encrypted, zip_bomb or empty.
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedSheet {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub rows: Vec<Vec<String>>,
    /// Rows in the sheet, also those not sent inline.
    #[serde(rename = "rowCount", default)]
    pub row_count: u64,
    #[serde(default)]
    pub truncated: bool,
}

/// The parts of a captured email the CLI shows. The API's `email` object has
/// more (HTML, sender checks, every header); `--json` on the API is the way
/// to read those.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmailSummary {
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub from: Vec<EmailAddress>,
    #[serde(default)]
    pub to: Vec<EmailAddress>,
    /// The `+tag` of the address it was sent to.
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub attachments: Vec<EmailAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailAddress {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
}

impl fmt::Display for EmailAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let address = self.address.as_deref().unwrap_or("");
        match self.name.as_deref() {
            Some(name) if !name.is_empty() => write!(f, "{name} <{address}>"),
            _ => write!(f, "{address}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailAttachment {
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(rename = "contentType", default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub size: u64,
}

impl CapturedRequest {
    /// A captured email (sent to the endpoint's mailhooks.cc address). Its
    /// `path` is the recipient address and its body a raw MIME message, so it
    /// must never be sent on as an HTTP request.
    ///
    /// The REST API says so in `kind`. The SSE stream leaves `kind` out, and an
    /// HTTP sender may use `EMAIL` as a custom method, so without `kind` an
    /// email is the `EMAIL` method with a path that is not a URL path (HTTP
    /// paths always start with a slash).
    pub fn is_email(&self) -> bool {
        match self.kind.as_deref() {
            Some(kind) => kind == "email",
            None => self.method.eq_ignore_ascii_case("EMAIL") && !self.path.starts_with('/'),
        }
    }

    /// A captured email's subject, for one line of output: the parsed one when
    /// the REST API sent it, otherwise the raw `Subject` header the stream
    /// carries, with its encoded words decoded. The sender wrote it, so pass it
    /// through `sanitize_line` before printing.
    pub fn email_subject(&self) -> Option<String> {
        if let Some(subject) = self.email.as_ref().and_then(|e| e.subject.as_ref()) {
            return Some(subject.clone());
        }
        self.headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("subject"))
            .map(|(_, value)| crate::util::format::decode_encoded_words(value))
    }
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

/// One row from `GET /api/search/requests`. Search rows carry the endpoint
/// slug instead of an endpoint id because a search spans endpoints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub slug: String,
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
    #[serde(rename = "detectedProvider", default)]
    pub detected_provider: Option<String>,
    #[serde(rename = "detectedEvent", default)]
    pub detected_event: Option<String>,
}

impl From<SearchHit> for CapturedRequest {
    /// Search rows have no endpoint id (only a slug), so `endpoint_id` is left
    /// empty; the TUI shows search hits through the request views, which never
    /// read it.
    fn from(hit: SearchHit) -> Self {
        CapturedRequest {
            id: hit.id,
            endpoint_id: String::new(),
            method: hit.method,
            path: hit.path,
            headers: hit.headers,
            body: hit.body,
            body_raw: None,
            query_params: hit.query_params,
            content_type: hit.content_type,
            ip: hit.ip,
            size: hit.size,
            received_at: hit.received_at,
            signature_verified: None,
            signature_error: None,
            signing_provider: None,
            kind: None,
            email: None,
            parsed: None,
        }
    }
}

/// The search route returns a bare JSON array (one page), so this wraps it
/// transparently. Use `count_requests` for the total across pages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SearchResult {
    pub requests: Vec<SearchHit>,
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
// Teams
// ---------------------------------------------------------------------------

/// A team the user owns or belongs to. Seats are both the member cap and the
/// pooled request quota (seats x 100,000 per 30-day period).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(rename = "memberCount", default)]
    pub member_count: u32,
    /// True while the team has no subscription; a suspended team shares nothing.
    #[serde(default)]
    pub suspended: bool,
    #[serde(rename = "subscriptionStatus", default)]
    pub subscription_status: Option<String>,
    #[serde(default)]
    pub seats: u32,
    #[serde(rename = "requestsUsed", default)]
    pub requests_used: u64,
    #[serde(rename = "requestLimit", default)]
    pub request_limit: u64,
    #[serde(rename = "periodEnd", default)]
    pub period_end: Option<i64>,
    #[serde(rename = "cancelAtPeriodEnd", default)]
    pub cancel_at_period_end: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMember {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role: String,
    #[serde(rename = "joinedAt", default)]
    pub joined_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamInvite {
    pub id: String,
    #[serde(rename = "teamId", default)]
    pub team_id: String,
    #[serde(rename = "teamName", default)]
    pub team_name: String,
    #[serde(rename = "inviterEmail", default)]
    pub inviter_email: String,
    #[serde(rename = "invitedEmail", default)]
    pub invited_email: String,
    #[serde(default)]
    pub status: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<i64>,
    /// Set when the invite row exists but the email could not be sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMembersResponse {
    #[serde(default)]
    pub members: Vec<TeamMember>,
    #[serde(rename = "pendingInvites", default)]
    pub pending_invites: Vec<TeamInvite>,
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
// Rendered email (POST /api/requests/{id}/render)
// ---------------------------------------------------------------------------

/// The shape the tunnel posts a captured email in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum EmailFormat {
    /// webhooks.cc's email.received JSON, the body forwarding posts (unsigned here)
    #[default]
    Json,
    /// Postmark's inbound JSON
    Postmark,
    /// SendGrid Inbound Parse, a multipart/form-data form
    Sendgrid,
    /// A Mailgun route's form, signed with --mailgun-signing-key
    Mailgun,
    /// CloudMailin's JSON Normalized format
    Cloudmailin,
}

impl EmailFormat {
    /// The value the API and `--email-format` take.
    pub fn as_str(self) -> &'static str {
        match self {
            EmailFormat::Json => "json",
            EmailFormat::Postmark => "postmark",
            EmailFormat::Sendgrid => "sendgrid",
            EmailFormat::Mailgun => "mailgun",
            EmailFormat::Cloudmailin => "cloudmailin",
        }
    }

    /// What the format is called, for people.
    pub fn label(self) -> &'static str {
        match self {
            EmailFormat::Json => "webhooks.cc email JSON",
            EmailFormat::Postmark => "Postmark inbound",
            EmailFormat::Sendgrid => "SendGrid Inbound Parse",
            EmailFormat::Mailgun => "Mailgun route",
            EmailFormat::Cloudmailin => "CloudMailin JSON",
        }
    }
}

/// A captured email rendered for a handler: the request to send it with.
/// `body` is text in every format (JSON, a multipart form or a URL-encoded
/// form), and `headers` carries its content type, with the multipart
/// boundary for SendGrid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderedEmail {
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: String,
}

// ---------------------------------------------------------------------------
// SSE events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum SseEvent {
    Connected,
    Request(Box<CapturedRequest>),
    EndpointDeleted,
    /// The server rotated the stream (it closes every connection after 30 minutes).
    /// The stream layer reconnects transparently; consumers can ignore this.
    Timeout,
    /// The stream dropped and the stream layer is about to retry.
    Reconnecting {
        attempt: u32,
        delay_ms: u64,
        reason: String,
    },
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

#[cfg(test)]
mod search_tests {
    use super::SearchResult;

    #[test]
    fn search_result_parses_the_bare_array_the_api_returns() {
        let json = r#"[{"id":"r1","slug":"abc","method":"POST","path":"/hook","headers":{},"queryParams":{},"ip":"::1","size":3,"receivedAt":1700000000000,"detectedProvider":null,"detectedEvent":null}]"#;
        let result: SearchResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.requests.len(), 1);
        assert_eq!(result.requests[0].slug, "abc");
        assert!(result.requests[0].detected_provider.is_none());

        let empty: SearchResult = serde_json::from_str("[]").unwrap();
        assert!(empty.requests.is_empty());
    }
}

#[cfg(test)]
mod email_tests {
    use super::{CapturedRequest, EmailAddress, Endpoint};

    #[test]
    fn captured_email_parses_the_api_shape() {
        let json = r#"{"id":"e1","endpointId":"ep","method":"EMAIL","path":"acme+run@mailhooks.cc","headers":{"subject":"Hi"},"body":"raw","queryParams":{},"ip":"192.0.2.1","size":120,"receivedAt":1700000000000,"kind":"email","email":{"subject":"Confirm your email","from":[{"name":"Tidewater","address":"no-reply@tidewater.app"}],"to":[{"name":null,"address":"acme+run@mailhooks.cc"}],"cc":[],"tag":"run","text":"Code 482913","html":"<p>x</p>","attachments":[{"filename":"a.pdf","contentType":"application/pdf","size":10,"contentId":null,"inline":false}],"auth":null}}"#;
        let request: CapturedRequest = serde_json::from_str(json).unwrap();
        assert!(request.is_email());
        let email = request.email.unwrap();
        assert_eq!(email.subject.as_deref(), Some("Confirm your email"));
        assert_eq!(email.tag.as_deref(), Some("run"));
        assert_eq!(email.from[0].to_string(), "Tidewater <no-reply@tidewater.app>");
        assert_eq!(email.attachments[0].size, 10);
    }

    #[test]
    fn http_requests_and_endpoints_without_email_fields_still_parse() {
        let json = r#"{"id":"r1","endpointId":"ep","method":"POST","path":"/hook","headers":{},"queryParams":{},"ip":"::1","size":3,"receivedAt":1}"#;
        let request: CapturedRequest = serde_json::from_str(json).unwrap();
        assert!(request.email.is_none());
        assert!(!request.is_email());

        let endpoint: Endpoint =
            serde_json::from_str(r#"{"id":"ep","slug":"acme","emailAddress":"acme@mailhooks.cc"}"#)
                .unwrap();
        assert_eq!(endpoint.email_address.as_deref(), Some("acme@mailhooks.cc"));
        let guest: Endpoint = serde_json::from_str(r#"{"id":"ep","slug":"g"}"#).unwrap();
        assert!(guest.email_address.is_none());
    }

    #[test]
    fn address_without_a_name_prints_the_address() {
        let address = EmailAddress { name: None, address: Some("a@b.c".into()) };
        assert_eq!(address.to_string(), "a@b.c");
    }

    #[test]
    fn email_subject_prefers_the_parsed_one_then_the_header() {
        // As the stream delivers it: kind, the raw headers, no parsed email.
        let json = r#"{"_id":"e1","endpointId":"ep","method":"EMAIL","path":"acme@mailhooks.cc","headers":{"subject":"=?UTF-8?Q?Gr=C3=BC=C3=9Fe?="},"queryParams":{},"ip":"192.0.2.1","size":120,"receivedAt":1,"kind":"email"}"#;
        let mut request: CapturedRequest = serde_json::from_str(json).unwrap();
        assert_eq!(request.email_subject().as_deref(), Some("Grüße"));

        request.email = Some(crate::types::EmailSummary {
            subject: Some("Parsed".into()),
            ..Default::default()
        });
        assert_eq!(request.email_subject().as_deref(), Some("Parsed"));

        request.email = None;
        request.headers.clear();
        assert_eq!(request.email_subject(), None);
    }
}

#[cfg(test)]
mod parsed_tests {
    use super::{CapturedRequest, RequestList};
    use crate::util::parsed::tests::{ACME_ORDER_EMAIL, acme_order};

    #[test]
    fn captured_email_keeps_the_parsed_result() {
        let parsed = acme_order().parsed.expect("parsed is kept");
        assert!(parsed.matched());
        assert_eq!(
            parsed.layout.as_ref().map(|l| l.name.as_str()),
            Some("Acme orders")
        );
        assert_eq!(parsed.fields.get("order"), Some(&Some("1001".to_string())));
        assert_eq!(parsed.fields.get("po"), Some(&None));
        assert_eq!(parsed.line_item_columns, ["sku", "qty", "price"]);
        assert_eq!(parsed.line_items.len(), 2);
        assert_eq!(parsed.line_items[1]["price"].as_deref(), Some("24.00"));
        assert_eq!(parsed.pages, 3);
        assert!(!parsed.truncated && !parsed.partial);

        let sheets = parsed.attachments[0].sheets.as_ref().unwrap();
        assert_eq!(sheets[0].row_count, 3);
        assert_eq!(sheets[0].rows[1], ["A-1", "2", "9.50"]);
        assert_eq!(
            parsed.attachments[1].text.as_deref(),
            Some("Acme terms of sale")
        );
        assert_eq!(parsed.attachments[2].error.as_deref(), Some("encrypted"));
    }

    /// `whk requests get --json` prints the request it deserialised, so a
    /// `parsed` the types drop would vanish from the output.
    #[test]
    fn json_output_passes_parsed_on_unchanged() {
        let sent: serde_json::Value = serde_json::from_str(ACME_ORDER_EMAIL).unwrap();
        let printed = serde_json::to_string_pretty(&acme_order()).unwrap();
        let printed: serde_json::Value = serde_json::from_str(&printed).unwrap();
        assert_eq!(printed["parsed"], sent["parsed"]);
        assert_eq!(
            printed["parsed"]["lineItemColumns"],
            serde_json::json!(["sku", "qty", "price"])
        );
    }

    #[test]
    fn list_summaries_and_requests_without_parsed() {
        // A list's summary, as `GET /api/endpoints/{slug}/requests` sends it.
        let json = r#"[{"id":"e1","endpointId":"ep","method":"EMAIL","path":"orders@mailhooks.cc","headers":{},"queryParams":{},"ip":"192.0.2.1","size":1,"receivedAt":1,"kind":"email","parsed":{"status":"matched","layout":{"id":"orders","name":"Acme orders"},"fields":{"order":"1001"},"lineItems":[],"lineItemColumns":[],"attachments":[],"pages":1,"partial":true}},{"id":"r1","endpointId":"ep","method":"POST","path":"/hook","headers":{},"queryParams":{},"ip":"::1","size":3,"receivedAt":2}]"#;
        let requests: Vec<CapturedRequest> = serde_json::from_str(json).unwrap();
        assert!(requests[0].parsed.as_ref().unwrap().partial);
        assert!(requests[1].parsed.is_none());

        let printed = serde_json::to_value(RequestList {
            requests,
            count: None,
        })
        .unwrap();
        assert_eq!(printed["requests"][0]["parsed"]["partial"], true);
        assert_eq!(printed["requests"][0]["parsed"]["fields"]["order"], "1001");
        // HTTP requests never had `parsed`, and --json does not add it.
        assert!(printed["requests"][1].get("parsed").is_none());
    }
}

#[cfg(test)]
mod render_tests {
    use super::{EmailFormat, RenderedEmail};

    #[test]
    fn email_format_serializes_as_the_api_expects() {
        assert_eq!(
            serde_json::to_string(&EmailFormat::Cloudmailin).unwrap(),
            r#""cloudmailin""#
        );
        assert_eq!(
            serde_json::to_string(&EmailFormat::default()).unwrap(),
            r#""json""#
        );
        for format in [
            EmailFormat::Json,
            EmailFormat::Postmark,
            EmailFormat::Sendgrid,
            EmailFormat::Mailgun,
            EmailFormat::Cloudmailin,
        ] {
            assert_eq!(serde_json::to_value(format).unwrap(), format.as_str());
        }
    }

    #[test]
    fn rendered_email_parses_the_api_shape() {
        let json = r#"{"format":"sendgrid","method":"POST","headers":{"content-type":"multipart/form-data; boundary=xyz","user-agent":"webhooks.cc (+https://webhooks.cc/docs/forwarding)"},"body":"--xyz\r\n..."}"#;
        let rendered: RenderedEmail = serde_json::from_str(json).unwrap();
        assert_eq!(rendered.format, "sendgrid");
        assert_eq!(rendered.method, "POST");
        assert_eq!(
            rendered.headers.get("content-type").map(String::as_str),
            Some("multipart/form-data; boundary=xyz")
        );
        assert!(rendered.body.starts_with("--xyz"));
    }
}
