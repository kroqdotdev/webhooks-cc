use axum::body::Bytes;
use axum::extract::{OriginalUri, Path, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::OnceLock;
use std::time::Instant;

use super::capture_limiter::CaptureLimiter;
use super::log_throttle::LogThrottle;
use super::placeholders::{self, Mode, TemplateRequest};
use super::rules::{self, RequestContext, ResponseRule};
use super::values::LazyBody;
use crate::AppState; // ResponseRule needed for deserialization
use crate::metrics;

const MAX_HEADER_KEY_LEN: usize = 256;
const MAX_HEADER_VALUE_LEN: usize = 8192;

/// Proxy/CDN/transport headers added by our infrastructure (Cloudflare + Caddy)
/// that should not be stored — they are not part of the original sender's request.
const PROXY_HEADERS: &[&str] = &[
    "accept-encoding",
    "cdn-loop",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "via",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "true-client-ip",
    "x-webhooks-cc-test-send",
];

/// Blocked response headers that must not be forwarded from mock responses.
const BLOCKED_HEADERS: &[&str] = &[
    "set-cookie",
    "strict-transport-security",
    "content-security-policy",
    "x-frame-options",
];

/// Validate slug: alphanumeric + hyphen + underscore, 1-50 chars.
/// Matches backend SLUG_REGEX = /^[a-zA-Z0-9_-]{1,50}$/.
pub fn is_valid_slug(slug: &str) -> bool {
    if slug.is_empty() || slug.len() > 50 {
        return false;
    }
    slug.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Extract the real client IP from proxy headers.
/// Sanitizes the value to contain only valid IP characters (digits, dots, colons, hex)
/// to prevent XSS via spoofed headers stored in the database.
fn real_ip(headers: &HeaderMap) -> String {
    let raw = if let Some(ip) = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
    {
        ip.to_string()
    } else if let Some(ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        ip.to_string()
    } else if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        && let Some(first) = xff.split(',').next()
    {
        first.trim().to_string()
    } else {
        return String::new();
    };

    sanitize_ip(&raw)
}

/// Keep `raw` only when it looks like an IP address: at most 45 characters,
/// all valid in IPv4/IPv6 (digits, a-f, A-F, dots, colons, brackets, percent
/// for zone IDs). Anything else becomes "" so a spoofed value can never carry
/// markup into the database.
pub(crate) fn sanitize_ip(raw: &str) -> String {
    if raw.len() <= 45
        && raw.bytes().all(|b| {
            b.is_ascii_hexdigit() || b == b'.' || b == b':' || b == b'[' || b == b']' || b == b'%'
        })
    {
        raw.to_string()
    } else {
        String::new()
    }
}

/// True when the byte slice contains a NUL (0x00) byte.
///
/// Postgres rejects U+0000 in `text` and `jsonb` values ("invalid byte
/// sequence for encoding UTF8: 0x00"), so anything bound to those columns
/// must be checked and sanitized first.
fn contains_nul(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

/// Replace every NUL character with U+FFFD (replacement character).
/// Returns `Cow::Borrowed` when there is nothing to replace.
pub(crate) fn strip_nul(s: &str) -> Cow<'_, str> {
    if s.contains('\0') {
        Cow::Owned(s.replace('\0', "\u{FFFD}"))
    } else {
        Cow::Borrowed(s)
    }
}

/// Decode a header value losslessly for storage: hyper accepts obs-text
/// (bytes >= 0x80) in header values, which `HeaderValue::to_str` rejects,
/// so decode with `from_utf8_lossy` instead of dropping the header.
fn header_value_to_string(value: &HeaderValue) -> String {
    let lossy = String::from_utf8_lossy(value.as_bytes());
    strip_nul(&lossy).into_owned()
}

/// Filter request headers: remove proxy/CDN headers, collect into a HashMap.
///
/// Duplicate header names are joined with ", " in wire order (RFC 7230 list
/// semantics) instead of keeping only the last occurrence.
fn filter_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    for (key, value) in headers.iter() {
        let name = key.as_str();
        if PROXY_HEADERS.contains(&name) {
            continue;
        }
        let v = header_value_to_string(value);
        match map.entry(name.to_string()) {
            Entry::Occupied(mut existing) => {
                // RFC 7230 §3.2.2 comma folding, except `cookie`, whose
                // multiple field lines fold with "; " (RFC 6265 §5.4).
                let separator = if name == "cookie" { "; " } else { ", " };
                let joined = existing.get_mut();
                joined.push_str(separator);
                joined.push_str(&v);
            }
            Entry::Vacant(slot) => {
                slot.insert(v);
            }
        }
    }
    map
}

/// Split the request body into the text copy bound to `requests.body` and the
/// optional raw copy bound to `p_body_raw`.
///
/// - Valid UTF-8 without NUL: text only, no raw copy (the common case).
/// - Valid UTF-8 with NUL: raw bytes preserved, NUL replaced by U+FFFD in the
///   text copy so Postgres accepts it.
/// - Invalid UTF-8: raw bytes preserved, lossy text (with NUL also replaced).
pub(crate) fn classify_body(body: &[u8]) -> (String, Option<Vec<u8>>) {
    match std::str::from_utf8(body) {
        Ok(s) if !contains_nul(body) => (s.to_owned(), None),
        Ok(s) => (strip_nul(s).into_owned(), Some(body.to_vec())),
        Err(_) => {
            let lossy = String::from_utf8_lossy(body);
            (strip_nul(&lossy).into_owned(), Some(body.to_vec()))
        }
    }
}

/// Replace NUL in query keys and values (axum percent-decodes `%00`), since
/// the map is bound as `jsonb`. Returns the map untouched when clean.
///
/// Two distinct keys can sanitise to the same key (`k\0ey` and `k\u{FFFD}ey`).
/// Rather than letting HashMap iteration order decide which value survives,
/// keys are visited in sorted order and colliding values are joined with ", "
/// (list semantics, like duplicate headers), so the result is deterministic
/// and nothing is dropped.
fn sanitize_query(params: HashMap<String, String>) -> HashMap<String, String> {
    if params
        .iter()
        .all(|(k, v)| !k.contains('\0') && !v.contains('\0'))
    {
        return params;
    }
    let mut sorted: Vec<(String, String)> = params.into_iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out: HashMap<String, String> = HashMap::with_capacity(sorted.len());
    for (k, v) in sorted {
        let key = strip_nul(&k).into_owned();
        let value = strip_nul(&v).into_owned();
        match out.entry(key) {
            Entry::Occupied(mut existing) => {
                let joined = existing.get_mut();
                joined.push_str(", ");
                joined.push_str(&value);
            }
            Entry::Vacant(slot) => {
                slot.insert(value);
            }
        }
    }
    out
}

/// Shape returned by the capture_webhook stored procedure.
#[derive(Debug, Deserialize)]
pub(crate) struct CaptureResult {
    pub(crate) status: String,
    /// UUID of the inserted request row (for post-capture verification UPDATE).
    pub(crate) request_id: Option<String>,
    mock_response: Option<MockResponse>,
    /// Raw JSON so that malformed rules don't break mock_response deserialization.
    #[serde(default)]
    response_rules: Option<serde_json::Value>,
    retry_after: Option<i64>,
    /// Signing provider configured on the endpoint (e.g., "stripe", "github").
    signing_provider: Option<String>,
    /// Base64-encoded AES-256-GCM encrypted signing secret.
    signing_secret_encrypted: Option<String>,
    /// Custom header name for generic-hmac provider.
    signing_header: Option<String>,
    /// Quota row the capture billed ("user:<id>", "team:<id>", "endpoint:<id>").
    pub(crate) billing_key: Option<String>,
    /// The endpoint's name, for `{{ endpoint.name }}` in mock responses.
    #[serde(default)]
    endpoint_name: Option<String>,
}

struct WebhookTarget {
    slug: String,
    path: String,
    raw_query: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct MockResponse {
    pub status: i64,
    pub body: String,
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub delay: Option<u64>,
}

/// Maximum allowed mock response delay (30 seconds).
const MAX_DELAY_MS: u64 = 30_000;

/// One `quota exceeded` line per slug per window; the rest are counted in
/// `suppressed` on the next line and in the capture metrics.
const QUOTA_LOG_WINDOW: std::time::Duration = std::time::Duration::from_secs(300);
const QUOTA_LOG_MAX_SLUGS: usize = 10_000;

fn quota_log_throttle() -> &'static LogThrottle {
    static THROTTLE: OnceLock<LogThrottle> = OnceLock::new();
    THROTTLE.get_or_init(|| LogThrottle::new(QUOTA_LOG_WINDOW, QUOTA_LOG_MAX_SLUGS))
}

/// Largest mock response body placeholders may produce (the largest body
/// the receiver accepts, so `{{ body }}` fits).
const MAX_FILLED_BODY_BYTES: usize = 1024 * 1024;

/// The response with its placeholders filled in from the request: the body
/// in the mode its Content-Type (or its first character) calls for, header
/// values as text. Headers that end up too long or holding a line break are
/// dropped by `build_mock_response`.
fn fill_mock_response(mut mock: MockResponse, request: &TemplateRequest<'_>) -> MockResponse {
    if placeholders::may_have_placeholders(&mock.body) {
        let mode = placeholders::response_mode(&mock.body, &mock.headers);
        mock.body = placeholders::render(&mock.body, request, mode, MAX_FILLED_BODY_BYTES);
    }
    for value in mock.headers.values_mut() {
        if placeholders::may_have_placeholders(value) {
            *value = placeholders::render(value, request, Mode::Text, MAX_HEADER_VALUE_LEN + 1);
        }
    }
    mock
}

/// Build an HTTP response from a mock_response configuration.
fn build_mock_response(mock: &MockResponse) -> Response {
    let status_code = u16::try_from(mock.status)
        .ok()
        .and_then(|s| StatusCode::from_u16(s).ok())
        .unwrap_or(StatusCode::OK);

    let mut builder = axum::http::Response::builder().status(status_code);

    for (key, value) in &mock.headers {
        // Skip oversized headers
        if key.len() > MAX_HEADER_KEY_LEN || value.len() > MAX_HEADER_VALUE_LEN {
            continue;
        }

        // Skip blocked headers
        let key_lower = key.to_lowercase();
        if BLOCKED_HEADERS.contains(&key_lower.as_str()) {
            continue;
        }

        // Skip CRLF injection attempts
        if key.contains('\r') || key.contains('\n') || value.contains('\r') || value.contains('\n')
        {
            continue;
        }

        builder = builder.header(key.as_str(), value.as_str());
    }

    builder
        .body(axum::body::Body::from(mock.body.clone()))
        .unwrap_or_else(|_| {
            axum::http::Response::builder()
                .status(StatusCode::OK)
                .body(axum::body::Body::from("OK"))
                .unwrap()
        })
}

fn build_verification_request_url(
    base: &str,
    slug: &str,
    req_path: &str,
    raw_query: Option<&str>,
) -> String {
    let path_part = if req_path == "/" { "" } else { req_path };
    let mut url = format!("{base}/w/{slug}{path_part}");
    if let Some(query) = raw_query.filter(|query| !query.is_empty()) {
        url.push('?');
        url.push_str(query);
    }
    url
}

/// How a failed `capture_webhook` query should be surfaced to the sender.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DbFailure {
    /// Connection/pool/transaction-level failure that a retry can fix.
    /// The sender gets 503 + Retry-After so its retry mechanism stays armed.
    Transient,
    /// Data/schema/privilege failure (or unclassifiable) that a retry cannot
    /// fix. We fail open with 200 as a last resort, but log and count it.
    Permanent,
}

/// SQLSTATE classes that indicate a transient, retryable condition:
/// 08 connection exception, 40 transaction rollback (serialization failure,
/// deadlock), 53 insufficient resources, 57 operator intervention (admin
/// shutdown, crash shutdown), 58 system error.
fn sqlstate_is_transient(code: &str) -> bool {
    matches!(code.get(..2), Some("08" | "40" | "53" | "57" | "58"))
}

/// SQLSTATE of a database-reported error, if any.
pub(crate) fn sqlstate_of(e: &sqlx::Error) -> Option<String> {
    match e {
        sqlx::Error::Database(db) => db.code().map(|c| c.into_owned()),
        _ => None,
    }
}

/// Classify a sqlx error from the capture query as transient or permanent.
///
/// `Database` errors without a SQLSTATE are treated as permanent (unknown);
/// the caller logs the missing code.
pub(crate) fn classify_db_error(e: &sqlx::Error) -> DbFailure {
    match e {
        sqlx::Error::PoolTimedOut
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed
        | sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::Protocol(_) => DbFailure::Transient,
        sqlx::Error::Database(db) => match db.code() {
            Some(code) if sqlstate_is_transient(&code) => DbFailure::Transient,
            _ => DbFailure::Permanent,
        },
        // Decode, ColumnNotFound, RowNotFound, TypeNotFound, ColumnDecode,
        // Configuration, Encode, ... and any future variant (#[non_exhaustive]).
        _ => DbFailure::Permanent,
    }
}

/// Seconds advertised in Retry-After when the capture failed transiently.
const TRANSIENT_RETRY_AFTER_SECS: &str = "5";

/// Billing key for a slug the limiter has not cached: one indexed read that
/// waits on no row lock. Falls back to a per-slug key when the slug is unknown
/// or the lookup fails; the capture itself then reports the real outcome.
pub(crate) async fn resolve_billing_key(state: &AppState, slug: &str) -> String {
    let lookup: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("SELECT capture_billing_key($1)")
            .bind(slug)
            .fetch_one(&state.pool)
            .await;
    match lookup {
        Ok(Some(key)) => {
            state.capture_limiter.remember(slug, &key);
            key
        }
        Ok(None) => CaptureLimiter::slug_key(slug),
        Err(e) => {
            tracing::debug!(slug, error = %e, "billing key lookup failed");
            CaptureLimiter::slug_key(slug)
        }
    }
}

/// 503 + Retry-After: the sender should redeliver.
fn retry_later_response() -> Response {
    let mut response = (StatusCode::SERVICE_UNAVAILABLE, "retry").into_response();
    response.headers_mut().insert(
        "retry-after",
        HeaderValue::from_static(TRANSIENT_RETRY_AFTER_SECS),
    );
    response
}

/// One `slots busy` line per slug per window, like the quota log.
fn busy_log_throttle() -> &'static LogThrottle {
    static THROTTLE: OnceLock<LogThrottle> = OnceLock::new();
    THROTTLE.get_or_init(|| LogThrottle::new(QUOTA_LOG_WINDOW, QUOTA_LOG_MAX_SLUGS))
}

/// Map a failed `capture_webhook` query to an HTTP response, logging and
/// counting the failure. Request bodies are never logged.
fn capture_failure_response(slug: &str, e: &sqlx::Error) -> Response {
    let sqlstate = sqlstate_of(e);
    let sqlstate = sqlstate.as_deref().unwrap_or("none");
    match classify_db_error(e) {
        DbFailure::Transient => {
            metrics::capture_failed("transient");
            tracing::error!(
                slug,
                kind = "transient",
                sqlstate,
                error = %e,
                "capture_webhook query failed, asking sender to retry"
            );
            retry_later_response()
        }
        DbFailure::Permanent => {
            metrics::capture_failed("permanent");
            // Fail open: a sender retry cannot fix this, so return 200 to stop
            // redelivery storms, but make it loud and countable.
            tracing::error!(
                slug,
                kind = "permanent",
                sqlstate,
                error = %e,
                "capture_webhook query failed, failing open with 200"
            );
            (StatusCode::OK, "OK").into_response()
        }
    }
}

/// The main webhook handler: any method at /w/{slug}/{*path}
pub async fn handle_webhook(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    Path((slug, path)): Path<(String, String)>,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    handle_webhook_inner(
        state,
        method,
        WebhookTarget {
            slug,
            path,
            raw_query: uri.query().map(str::to_string),
        },
        headers,
        query,
        body,
    )
    .await
}

/// Handle the case where no trailing path is provided: /w/{slug}
pub async fn handle_webhook_no_path(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    Path(slug): Path<String>,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    handle_webhook_inner(
        state,
        method,
        WebhookTarget {
            slug,
            path: String::new(),
            raw_query: uri.query().map(str::to_string),
        },
        headers,
        query,
        body,
    )
    .await
}

async fn handle_webhook_inner(
    state: AppState,
    method: Method,
    target: WebhookTarget,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    // 1. Validate and normalize slug to lowercase (case-insensitive matching)
    let slug = target.slug.to_ascii_lowercase();
    if !is_valid_slug(&slug) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "invalid_slug"})),
        )
            .into_response();
    }

    // 2. Normalize path (axum percent-decodes %00, so strip NUL for Postgres)
    let path = target.path;
    let raw_query = target.raw_query;
    let req_path = if path.is_empty() {
        "/".to_string()
    } else if path.starts_with('/') {
        path.clone()
    } else {
        format!("/{path}")
    };
    let req_path = strip_nul(&req_path).into_owned();

    // 3. Extract request data
    let ip = real_ip(&headers);
    let filtered_headers = filter_headers(&headers);
    // Text copy for `requests.body`; raw bytes only when the text copy is lossy
    // (invalid UTF-8 or NUL bytes, which Postgres text columns reject).
    let (body_str, body_raw) = classify_body(&body);
    let content_type = headers
        .get("content-type")
        .map(header_value_to_string)
        .unwrap_or_default();
    let query_params = sanitize_query(query.0);
    let received_at = Utc::now();

    // Serialize headers and query params as JSON values
    let headers_json = serde_json::to_value(&filtered_headers)
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
    let query_json = serde_json::to_value(&query_params)
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

    // 4. Call the stored procedure, holding one of the account's capture slots
    //    for the query only (never across a mock response delay).
    let limit_key = match state.capture_limiter.cached_key(&slug) {
        Some(key) => key,
        None => resolve_billing_key(&state, &slug).await,
    };
    let acquire_timeout = std::time::Duration::from_secs(state.config.pg_acquire_timeout_secs);
    let Some(permit) = state
        .capture_limiter
        .acquire(&limit_key, acquire_timeout)
        .await
    else {
        metrics::capture_failed("account_busy");
        if let Some(suppressed) = busy_log_throttle().check(&slug, Instant::now()) {
            tracing::warn!(
                slug,
                key = limit_key,
                suppressed,
                "account capture slots busy, asking sender to retry"
            );
        }
        return retry_later_response();
    };
    let result: Result<serde_json::Value, sqlx::Error> =
        // p_query_raw by name (migration 00058): the email parameters between
        // keep their defaults.
        sqlx::query_scalar(
            "SELECT capture_webhook($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, p_query_raw => $11)",
        )
        .bind(&slug)
            .bind(method.as_str())
            .bind(&req_path)
            .bind(&headers_json)
            .bind(&body_str)
            .bind(&query_json)
            .bind(&content_type)
            .bind(&ip)
            .bind(received_at)
            .bind(&body_raw)
            .bind(raw_query.as_deref())
            .fetch_one(&state.pool)
            .await;
    drop(permit);

    // 5. Map result to HTTP response
    match result {
        Ok(json_value) => {
            let capture: CaptureResult = match serde_json::from_value(json_value) {
                Ok(c) => c,
                Err(e) => {
                    // The row was inserted but we cannot read the outcome; fail open
                    // (the sender must not retry), but count and log it loudly.
                    metrics::capture_failed("parse");
                    tracing::error!(slug, kind = "parse", error = %e, "failed to parse capture_webhook result");
                    return (StatusCode::OK, "OK").into_response();
                }
            };

            if let Some(ref billing_key) = capture.billing_key {
                state.capture_limiter.remember(&slug, billing_key);
            }

            match capture.status.as_str() {
                "ok" => {
                    metrics::capture_result("ok");

                    // Fire-and-forget signature verification if configured
                    if let Some(ref provider) = capture.signing_provider
                        && let Some(ref encrypted_b64) = capture.signing_secret_encrypted
                        && let Some(ref request_id) = capture.request_id
                    {
                        if let Some(ref encryption_key) = state.config.signing_secret_key {
                            let pool = state.pool.clone();
                            let request_id = request_id.clone();
                            let provider = provider.clone();
                            let encryption_key = *encryption_key;
                            let encrypted_b64 = encrypted_b64.clone();
                            let signing_header = capture.signing_header.clone();
                            let verify_headers = filtered_headers.clone();
                            let verify_body = body.to_vec();
                            // HTTP method is needed by HubSpot (signs method + uri + body + ts).
                            let verify_method = method.as_str().to_string();
                            // Construct full URL for Twilio verification (signs URL + params)
                            let request_url = state.config.webhook_base_url.as_ref().map(|base| {
                                build_verification_request_url(
                                    base,
                                    &slug,
                                    &req_path,
                                    raw_query.as_deref(),
                                )
                            });

                            tokio::spawn(async move {
                                let secret = match crate::crypto::decrypt_secret_b64(
                                    &encrypted_b64,
                                    &encryption_key,
                                ) {
                                    Ok(s) => s,
                                    Err(e) => {
                                        tracing::error!(request_id, error = %e, "failed to decrypt signing secret");
                                        // Write the error to the request row so the user sees it in the dashboard
                                        let error_json = serde_json::json!({
                                        "code": "decryption_failed",
                                        "message": "Failed to decrypt signing secret. The encryption key may have changed."
                                    }).to_string();
                                        if let Err(db_err) = sqlx::query(
                                        "UPDATE public.requests SET signature_verified = $1, signature_error = $2, signing_provider = $3 WHERE id = $4::uuid"
                                    )
                                    .bind(Some(false))
                                    .bind(Some(&error_json))
                                    .bind(provider.as_str())
                                    .bind(&request_id)
                                    .execute(&pool)
                                    .await {
                                        tracing::error!(request_id, error = %db_err, "failed to persist decryption error to request row");
                                    }
                                        return;
                                    }
                                };

                                let result = crate::verification::verify_signature_async(
                                    &provider,
                                    &secret,
                                    &verify_headers,
                                    &verify_body,
                                    signing_header.as_deref(),
                                    request_url.as_deref(),
                                    Some(verify_method.as_str()),
                                )
                                .await;

                                let (verified, error_json, error_provider) = match &result {
                                    crate::verification::VerificationResult::Valid => {
                                        (Some(true), None, Some(provider.as_str()))
                                    }
                                    crate::verification::VerificationResult::Invalid(err) => {
                                        let json = serde_json::to_string(err).unwrap_or_else(|_| {
                                        r#"{"code":"serialization_error","message":"Verification failed but error details could not be serialized"}"#.to_string()
                                    });
                                        (Some(false), Some(json), Some(provider.as_str()))
                                    }
                                    crate::verification::VerificationResult::Skipped(err) => {
                                        let json = serde_json::to_string(err).unwrap_or_else(|_| {
                                        r#"{"code":"serialization_error","message":"Verification skipped but error details could not be serialized"}"#.to_string()
                                    });
                                        (None, Some(json), Some(provider.as_str()))
                                    }
                                };

                                if let Err(e) = sqlx::query(
                                "UPDATE public.requests SET signature_verified = $1, signature_error = $2, signing_provider = $3 WHERE id = $4::uuid"
                            )
                            .bind(verified)
                            .bind(&error_json)
                            .bind(error_provider)
                            .bind(&request_id)
                            .execute(&pool)
                            .await {
                                tracing::error!(request_id, error = %e, "failed to update verification result");
                            }
                            });
                        } else {
                            // Server missing SIGNING_SECRET_KEY — write error so user sees feedback
                            let pool = state.pool.clone();
                            let request_id = request_id.clone();
                            let provider = provider.clone();
                            tokio::spawn(async move {
                                let error_json = serde_json::json!({
                                    "code": "server_not_configured",
                                    "message": "Signature verification is configured but the server encryption key is missing."
                                }).to_string();
                                if let Err(e) = sqlx::query(
                                    "UPDATE public.requests SET signature_verified = $1, signature_error = $2, signing_provider = $3 WHERE id = $4::uuid"
                                )
                                .bind(Some(false))
                                .bind(Some(&error_json))
                                .bind(provider.as_str())
                                .bind(&request_id)
                                .execute(&pool)
                                .await {
                                    tracing::error!(request_id, error = %e, "failed to write server-not-configured error");
                                }
                            });
                        }
                    }

                    // Evaluate conditional response rules first, fall back to default mock.
                    // Parse rules item-by-item so one malformed rule doesn't kill all rules.
                    let parsed_rules: Option<Vec<ResponseRule>> = capture
                        .response_rules
                        .and_then(|v| match v {
                            serde_json::Value::Array(items) => {
                                let mut rules = Vec::with_capacity(items.len());
                                for (idx, item) in items.into_iter().enumerate() {
                                    match serde_json::from_value::<ResponseRule>(item) {
                                        Ok(rule) => rules.push(rule),
                                        Err(e) => {
                                            tracing::error!(slug, index = idx, error = %e, "skipping malformed response rule");
                                        }
                                    }
                                }
                                if rules.is_empty() { None } else { Some(rules) }
                            }
                            serde_json::Value::Null => None,
                            other => {
                                tracing::error!(slug, kind = %other, "response_rules is not an array");
                                None
                            }
                        });

                    // Pick the response and fill in its placeholders before any
                    // delay: the parsed body is not held across the await.
                    let effective_mock = {
                        let content_type =
                            (!content_type.is_empty()).then_some(content_type.as_str());
                        let lazy_body = LazyBody::new(&body_str, content_type);
                        let chosen = if let Some(ref rules) = parsed_rules {
                            let ctx = RequestContext {
                                method: method.as_str(),
                                path: &req_path,
                                headers: &filtered_headers,
                                body: &body_str,
                                query: &query_params,
                                content_type,
                                size: Some(body.len() as u64),
                            };
                            rules::evaluate_rules_with(rules, &ctx, &lazy_body)
                                .or(capture.mock_response.clone())
                        } else {
                            capture.mock_response.clone()
                        };
                        chosen.map(|mock| {
                            let request_id = capture.request_id.clone().unwrap_or_default();
                            let received = received_at.to_rfc3339_opts(SecondsFormat::Millis, true);
                            let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
                            let uuid = uuid::Uuid::new_v4().to_string();
                            fill_mock_response(
                                mock,
                                &TemplateRequest {
                                    id: &request_id,
                                    method: method.as_str(),
                                    path: &req_path,
                                    headers: &filtered_headers,
                                    query: &query_params,
                                    body: &lazy_body,
                                    body_text: &body_str,
                                    content_type,
                                    ip: &ip,
                                    size: body.len() as u64,
                                    received_at: &received,
                                    endpoint_slug: &slug,
                                    endpoint_name: capture.endpoint_name.as_deref(),
                                    uuid: &uuid,
                                    now: &now,
                                },
                            )
                        })
                    };

                    if let Some(ref mock) = effective_mock {
                        if let Some(delay) = mock.delay {
                            let capped = delay.min(MAX_DELAY_MS);
                            if capped > 0 {
                                tokio::time::sleep(std::time::Duration::from_millis(capped)).await;
                            }
                        }
                        build_mock_response(mock)
                    } else {
                        (StatusCode::OK, "OK").into_response()
                    }
                }
                "not_found" => {
                    metrics::capture_result("not_found");
                    (
                        StatusCode::NOT_FOUND,
                        axum::Json(serde_json::json!({"error": "not_found"})),
                    )
                        .into_response()
                }
                "expired" => {
                    metrics::capture_result("expired");
                    (
                        StatusCode::GONE,
                        axum::Json(serde_json::json!({"error": "expired"})),
                    )
                        .into_response()
                }
                "quota_exceeded" => {
                    metrics::capture_result("quota_exceeded");
                    if let Some(suppressed) = quota_log_throttle().check(&slug, Instant::now()) {
                        tracing::info!(slug, ip = %ip, suppressed, "quota exceeded");
                    }
                    let mut response = (
                        StatusCode::TOO_MANY_REQUESTS,
                        axum::Json(serde_json::json!({"error": "quota_exceeded"})),
                    )
                        .into_response();

                    if let Some(retry_after_ms) = capture.retry_after {
                        let retry_after_secs = (retry_after_ms + 999) / 1000; // ceil to seconds
                        if let Ok(val) =
                            axum::http::HeaderValue::from_str(&retry_after_secs.to_string())
                        {
                            response.headers_mut().insert("retry-after", val);
                        }
                    }

                    response
                }
                unknown => {
                    metrics::capture_result("unknown");
                    metrics::capture_failed("unknown_status");
                    tracing::warn!(slug, status = unknown, "unexpected capture_webhook status");
                    (StatusCode::OK, "OK").into_response()
                }
            }
        }
        // Transient DB failures become 503 + Retry-After (sender retries);
        // permanent ones fail open with 200 but are logged and counted.
        Err(e) => capture_failure_response(&slug, &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filled(mock: MockResponse, body: &str, content_type: Option<&str>) -> MockResponse {
        let headers = HashMap::from([("x-event".to_string(), "order.paid".to_string())]);
        let query = HashMap::from([("page".to_string(), "2".to_string())]);
        let lazy = LazyBody::new(body, content_type);
        fill_mock_response(
            mock,
            &TemplateRequest {
                id: "req_1",
                method: "POST",
                path: "/orders",
                headers: &headers,
                query: &query,
                body: &lazy,
                body_text: body,
                content_type,
                ip: "203.0.113.7",
                size: body.len() as u64,
                received_at: "2026-01-01T00:00:00.000Z",
                endpoint_slug: "acme",
                endpoint_name: None,
                uuid: "u",
                now: "n",
            },
        )
    }

    #[test]
    fn mock_response_placeholders_are_filled_in() {
        let mock = MockResponse {
            status: 201,
            body: r#"{"id": "{{ json.id }}", "echo": {{ json }}, "page": "{{ query.page }}"}"#
                .to_string(),
            headers: HashMap::from([
                ("x-request-id".to_string(), "{{ id }}".to_string()),
                (
                    "x-event".to_string(),
                    "{{ headers.X-Event | upper }}".to_string(),
                ),
            ]),
            delay: None,
        };
        let out = filled(mock, r#"{"id":"o\"1","n":1.0}"#, Some("application/json"));
        assert_eq!(
            out.body,
            r#"{"id": "o\"1", "echo": {"id":"o\"1","n":1}, "page": "2"}"#
        );
        assert_eq!(out.headers["x-request-id"], "req_1");
        assert_eq!(out.headers["x-event"], "ORDER.PAID");
        assert_eq!(out.status, 201);
    }

    #[test]
    fn mock_response_without_placeholders_is_unchanged() {
        let mock = MockResponse {
            status: 200,
            body: "{{ name }} and {{ }}".to_string(),
            headers: HashMap::new(),
            delay: Some(5),
        };
        let out = filled(mock, "", None);
        assert_eq!(out.body, "{{ name }} and {{ }}");
        assert_eq!(out.delay, Some(5));
    }

    #[test]
    fn a_filled_in_header_with_a_line_break_is_dropped() {
        let mock = MockResponse {
            status: 200,
            body: String::new(),
            headers: HashMap::from([("x-echo".to_string(), "{{ body }}".to_string())]),
            delay: None,
        };
        let out = filled(mock, "a\r\nset-cookie: x=1", Some("text/plain"));
        let response = build_mock_response(&out);
        assert!(response.headers().get("x-echo").is_none());
        assert!(response.headers().get("set-cookie").is_none());
    }

    #[test]
    fn valid_slugs() {
        assert!(is_valid_slug("abc"));
        assert!(is_valid_slug("my-endpoint"));
        assert!(is_valid_slug("test_123"));
        assert!(is_valid_slug("A"));
        assert!(is_valid_slug(&"a".repeat(50)));
    }

    #[test]
    fn invalid_slugs() {
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug(&"a".repeat(51)));
        assert!(!is_valid_slug("has space"));
        assert!(!is_valid_slug("has/slash"));
        assert!(!is_valid_slug("has.dot"));
    }

    #[test]
    fn real_ip_extraction() {
        use axum::http::HeaderValue;

        // cf-connecting-ip takes priority
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", HeaderValue::from_static("1.2.3.4"));
        headers.insert("x-real-ip", HeaderValue::from_static("5.6.7.8"));
        assert_eq!(real_ip(&headers), "1.2.3.4");

        // Falls back to x-real-ip
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", HeaderValue::from_static("5.6.7.8"));
        assert_eq!(real_ip(&headers), "5.6.7.8");

        // Falls back to x-forwarded-for (first IP)
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("9.10.11.12, 13.14.15.16"),
        );
        assert_eq!(real_ip(&headers), "9.10.11.12");

        // Empty when no headers
        let headers = HeaderMap::new();
        assert_eq!(real_ip(&headers), "");

        // Rejects malicious IP values
        let mut headers = HeaderMap::new();
        headers.insert(
            "cf-connecting-ip",
            HeaderValue::from_static("<script>alert(1)</script>"),
        );
        assert_eq!(real_ip(&headers), "");
    }

    #[test]
    fn header_filtering() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.insert("x-custom", HeaderValue::from_static("hello"));
        headers.insert("cf-ray", HeaderValue::from_static("abc123"));
        headers.insert("x-forwarded-for", HeaderValue::from_static("1.2.3.4"));

        let filtered = filter_headers(&headers);
        assert_eq!(filtered.get("content-type").unwrap(), "application/json");
        assert_eq!(filtered.get("x-custom").unwrap(), "hello");
        assert!(!filtered.contains_key("cf-ray"));
        assert!(!filtered.contains_key("x-forwarded-for"));
    }

    #[test]
    fn header_filtering_keeps_non_ascii_values_via_lossy_decoding() {
        let mut headers = HeaderMap::new();
        // Valid UTF-8 but not visible ASCII: HeaderValue::to_str() rejects it.
        headers.insert(
            "x-utf8",
            HeaderValue::from_bytes("caf\u{e9}".as_bytes()).unwrap(),
        );
        // Invalid UTF-8 obs-text byte: must be kept with U+FFFD, not dropped.
        headers.insert("x-latin1", HeaderValue::from_bytes(b"caf\xe9").unwrap());
        // Proxy headers are still filtered even with odd bytes.
        headers.insert("cf-ray", HeaderValue::from_bytes(b"\xff").unwrap());

        let filtered = filter_headers(&headers);
        assert_eq!(filtered.get("x-utf8").unwrap(), "caf\u{e9}");
        assert_eq!(filtered.get("x-latin1").unwrap(), "caf\u{FFFD}");
        assert!(!filtered.contains_key("cf-ray"));
    }

    #[test]
    fn header_filtering_joins_duplicates_in_wire_order() {
        let mut headers = HeaderMap::new();
        headers.append("x-dup", HeaderValue::from_static("first"));
        headers.append("x-dup", HeaderValue::from_static("second"));
        headers.append("x-dup", HeaderValue::from_static("third"));
        headers.append("x-single", HeaderValue::from_static("only"));
        // Cookie is the RFC exception: multiple Cookie lines fold with "; ".
        headers.append("cookie", HeaderValue::from_static("a=1"));
        headers.append("cookie", HeaderValue::from_static("b=2"));
        // Duplicate proxy headers are filtered entirely.
        headers.append("x-forwarded-for", HeaderValue::from_static("1.1.1.1"));
        headers.append("x-forwarded-for", HeaderValue::from_static("2.2.2.2"));

        let filtered = filter_headers(&headers);
        assert_eq!(filtered.get("x-dup").unwrap(), "first, second, third");
        assert_eq!(filtered.get("x-single").unwrap(), "only");
        assert_eq!(filtered.get("cookie").unwrap(), "a=1; b=2");
        assert!(!filtered.contains_key("x-forwarded-for"));
    }

    #[test]
    fn contains_nul_detects_zero_bytes() {
        assert!(!contains_nul(b""));
        assert!(!contains_nul(b"hello"));
        assert!(!contains_nul("caf\u{e9}".as_bytes()));
        assert!(contains_nul(b"\0"));
        assert!(contains_nul(b"hel\0lo"));
        assert!(contains_nul(b"trailing\0"));
    }

    #[test]
    fn strip_nul_borrows_when_clean() {
        let clean = "no nul here";
        match strip_nul(clean) {
            Cow::Borrowed(s) => assert_eq!(s, clean),
            Cow::Owned(_) => panic!("expected Borrowed for a clean string"),
        }
        assert!(matches!(strip_nul(""), Cow::Borrowed("")));
    }

    #[test]
    fn strip_nul_replaces_every_nul_with_replacement_char() {
        match strip_nul("a\0b") {
            Cow::Owned(s) => assert_eq!(s, "a\u{FFFD}b"),
            Cow::Borrowed(_) => panic!("expected Owned when a NUL is present"),
        }
        assert_eq!(
            strip_nul("\0start\0middle\0end\0").as_ref(),
            "\u{FFFD}start\u{FFFD}middle\u{FFFD}end\u{FFFD}"
        );
        assert_eq!(strip_nul("\0\0\0").as_ref(), "\u{FFFD}\u{FFFD}\u{FFFD}");
        // Result never contains a NUL
        assert!(!strip_nul("x\0y\0z").contains('\0'));
    }

    #[test]
    fn classify_body_valid_utf8_without_nul_has_no_raw_copy() {
        let (text, raw) = classify_body(b"{\"hello\":\"world\"}");
        assert_eq!(text, "{\"hello\":\"world\"}");
        assert!(raw.is_none());

        let (text, raw) = classify_body("caf\u{e9} \u{1F389}".as_bytes());
        assert_eq!(text, "caf\u{e9} \u{1F389}");
        assert!(raw.is_none());

        let (text, raw) = classify_body(b"");
        assert_eq!(text, "");
        assert!(raw.is_none());
    }

    #[test]
    fn classify_body_valid_utf8_with_nul_keeps_raw_and_replaces_nul() {
        let input = b"abc\0def\0";
        let (text, raw) = classify_body(input);
        assert_eq!(text, "abc\u{FFFD}def\u{FFFD}");
        assert!(!text.contains('\0'));
        assert_eq!(raw.as_deref(), Some(&input[..]));
    }

    #[test]
    fn classify_body_invalid_utf8_keeps_raw_and_lossy_text() {
        let input = b"\xff\xfe binary \0 payload";
        let (text, raw) = classify_body(input);
        assert_eq!(raw.as_deref(), Some(&input[..]));
        assert!(text.contains('\u{FFFD}'));
        assert!(text.contains("binary"));
        assert!(text.contains("payload"));
        // NUL inside an invalid-UTF-8 body is also replaced (lossy alone keeps it)
        assert!(!text.contains('\0'));
    }

    #[test]
    fn sanitize_query_strips_nul_from_keys_and_values() {
        let clean: HashMap<String, String> = HashMap::from([("a".to_string(), "1".to_string())]);
        assert_eq!(sanitize_query(clean.clone()), clean);

        let dirty: HashMap<String, String> = HashMap::from([
            ("k\0ey".to_string(), "v\0al".to_string()),
            ("plain".to_string(), "ok".to_string()),
        ]);
        let cleaned = sanitize_query(dirty);
        assert_eq!(cleaned.get("k\u{FFFD}ey").unwrap(), "v\u{FFFD}al");
        assert_eq!(cleaned.get("plain").unwrap(), "ok");
        assert!(
            cleaned
                .iter()
                .all(|(k, v)| !k.contains('\0') && !v.contains('\0'))
        );
    }

    #[test]
    fn sanitize_query_joins_values_when_sanitized_keys_collide() {
        // "k\0ey" and "k\u{FFFD}ey" both sanitise to "k\u{FFFD}ey": neither value
        // may be dropped, and the order is by original key ("\0" sorts first),
        // so the result does not depend on HashMap iteration order.
        let dirty: HashMap<String, String> = HashMap::from([
            ("k\u{FFFD}ey".to_string(), "second".to_string()),
            ("k\0ey".to_string(), "first".to_string()),
        ]);
        let cleaned = sanitize_query(dirty);
        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned.get("k\u{FFFD}ey").unwrap(), "first, second");
    }

    #[test]
    fn sqlstate_transient_classes() {
        // Transient: connection, transaction rollback, resources, operator intervention, system
        assert!(sqlstate_is_transient("08006")); // connection_failure
        assert!(sqlstate_is_transient("08003")); // connection_does_not_exist
        assert!(sqlstate_is_transient("40001")); // serialization_failure
        assert!(sqlstate_is_transient("40P01")); // deadlock_detected
        assert!(sqlstate_is_transient("53300")); // too_many_connections
        assert!(sqlstate_is_transient("53200")); // out_of_memory
        assert!(sqlstate_is_transient("57P01")); // admin_shutdown
        assert!(sqlstate_is_transient("57014")); // query_canceled (statement_timeout)
        assert!(sqlstate_is_transient("58030")); // io_error

        // Permanent: data, integrity, syntax/privilege, and anything unexpected
        assert!(!sqlstate_is_transient("22021")); // character_not_in_repertoire (NUL byte)
        assert!(!sqlstate_is_transient("22P05")); // untranslatable_character
        assert!(!sqlstate_is_transient("23505")); // unique_violation
        assert!(!sqlstate_is_transient("42501")); // insufficient_privilege
        assert!(!sqlstate_is_transient("42883")); // undefined_function
        assert!(!sqlstate_is_transient("P0001")); // raise_exception
        assert!(!sqlstate_is_transient("XX000")); // internal_error
        assert!(!sqlstate_is_transient(""));
        assert!(!sqlstate_is_transient("4"));
    }

    #[test]
    fn classify_db_error_transient_variants() {
        assert_eq!(
            classify_db_error(&sqlx::Error::PoolTimedOut),
            DbFailure::Transient
        );
        assert_eq!(
            classify_db_error(&sqlx::Error::PoolClosed),
            DbFailure::Transient
        );
        assert_eq!(
            classify_db_error(&sqlx::Error::WorkerCrashed),
            DbFailure::Transient
        );
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset by peer");
        assert_eq!(
            classify_db_error(&sqlx::Error::Io(io)),
            DbFailure::Transient
        );
        assert_eq!(
            classify_db_error(&sqlx::Error::Protocol("unexpected message".into())),
            DbFailure::Transient
        );
        let tls: Box<dyn std::error::Error + Send + Sync> = Box::new(std::io::Error::other("tls"));
        assert_eq!(
            classify_db_error(&sqlx::Error::Tls(tls)),
            DbFailure::Transient
        );
    }

    #[test]
    fn classify_db_error_permanent_variants() {
        assert_eq!(
            classify_db_error(&sqlx::Error::RowNotFound),
            DbFailure::Permanent
        );
        assert_eq!(
            classify_db_error(&sqlx::Error::ColumnNotFound("status".into())),
            DbFailure::Permanent
        );
        let decode: Box<dyn std::error::Error + Send + Sync> =
            Box::new(std::io::Error::other("bad json"));
        assert_eq!(
            classify_db_error(&sqlx::Error::Decode(decode)),
            DbFailure::Permanent
        );
        assert_eq!(
            classify_db_error(&sqlx::Error::TypeNotFound {
                type_name: "jsonb".into()
            }),
            DbFailure::Permanent
        );
        assert_eq!(
            sqlstate_of(&sqlx::Error::PoolTimedOut),
            None,
            "non-database errors carry no SQLSTATE"
        );
    }

    #[test]
    fn capture_failure_response_transient_is_503_with_retry_after() {
        let response = capture_failure_response("abc", &sqlx::Error::PoolTimedOut);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.headers().get("retry-after").unwrap(),
            TRANSIENT_RETRY_AFTER_SECS
        );
    }

    #[test]
    fn capture_failure_response_permanent_fails_open_with_200() {
        let response = capture_failure_response("abc", &sqlx::Error::RowNotFound);
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get("retry-after").is_none());
    }

    #[test]
    fn mock_response_blocks_security_headers() {
        let mock = MockResponse {
            status: 200,
            body: "test".to_string(),
            headers: HashMap::from([
                ("content-type".to_string(), "text/plain".to_string()),
                (
                    "set-cookie".to_string(),
                    "session=abc; HttpOnly".to_string(),
                ),
                (
                    "strict-transport-security".to_string(),
                    "max-age=31536000".to_string(),
                ),
                (
                    "content-security-policy".to_string(),
                    "default-src 'self'".to_string(),
                ),
                ("x-custom".to_string(), "allowed".to_string()),
            ]),
            delay: None,
        };

        let response = build_mock_response(&mock);
        let headers = response.headers();
        assert!(headers.get("content-type").is_some());
        assert!(headers.get("x-custom").is_some());
        assert!(headers.get("set-cookie").is_none());
        assert!(headers.get("strict-transport-security").is_none());
        assert!(headers.get("content-security-policy").is_none());
    }

    #[test]
    fn mock_response_blocks_crlf_injection() {
        let mock = MockResponse {
            status: 200,
            body: "test".to_string(),
            headers: HashMap::from([
                ("good-header".to_string(), "safe-value".to_string()),
                (
                    "bad-header".to_string(),
                    "value\r\nInjected: header".to_string(),
                ),
                ("bad\r\nkey".to_string(), "value".to_string()),
            ]),
            delay: None,
        };

        let response = build_mock_response(&mock);
        let headers = response.headers();
        assert!(headers.get("good-header").is_some());
        assert!(headers.get("bad-header").is_none());
    }

    #[test]
    fn verification_url_preserves_raw_query_string() {
        let url = build_verification_request_url(
            "https://go.webhooks.cc",
            "abc123",
            "/twilio",
            Some("Digits=1&Digits=2&Body=a%2Bb"),
        );

        assert_eq!(
            url,
            "https://go.webhooks.cc/w/abc123/twilio?Digits=1&Digits=2&Body=a%2Bb"
        );
    }

    #[test]
    fn verification_url_omits_root_path_and_empty_query() {
        let url = build_verification_request_url("https://go.webhooks.cc", "abc123", "/", Some(""));
        assert_eq!(url, "https://go.webhooks.cc/w/abc123");
    }
}
