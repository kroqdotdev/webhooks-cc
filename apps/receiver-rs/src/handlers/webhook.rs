use axum::body::Bytes;
use axum::extract::{OriginalUri, Path, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::rules::{self, RequestContext, ResponseRule};
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

    // Validate: only allow characters valid in IPv4/IPv6 addresses
    // (digits, a-f, A-F, dots, colons, brackets, percent for zone IDs)
    if raw.len() <= 45
        && raw.bytes().all(|b| {
            b.is_ascii_hexdigit() || b == b'.' || b == b':' || b == b'[' || b == b']' || b == b'%'
        })
    {
        raw
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
fn strip_nul(s: &str) -> Cow<'_, str> {
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
                let joined = existing.get_mut();
                joined.push_str(", ");
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
fn classify_body(body: &[u8]) -> (String, Option<Vec<u8>>) {
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
fn sanitize_query(params: HashMap<String, String>) -> HashMap<String, String> {
    if params
        .iter()
        .all(|(k, v)| !k.contains('\0') && !v.contains('\0'))
    {
        return params;
    }
    params
        .into_iter()
        .map(|(k, v)| (strip_nul(&k).into_owned(), strip_nul(&v).into_owned()))
        .collect()
}

/// Shape returned by the capture_webhook stored procedure.
#[derive(Debug, Deserialize)]
struct CaptureResult {
    status: String,
    /// UUID of the inserted request row (for post-capture verification UPDATE).
    request_id: Option<String>,
    mock_response: Option<MockResponse>,
    /// Raw JSON so that malformed rules don't break mock_response deserialization.
    #[serde(default)]
    response_rules: Option<serde_json::Value>,
    retry_after: Option<i64>,
    notification_url: Option<String>,
    /// Signing provider configured on the endpoint (e.g., "stripe", "github").
    signing_provider: Option<String>,
    /// Base64-encoded AES-256-GCM encrypted signing secret.
    signing_secret_encrypted: Option<String>,
    /// Custom header name for generic-hmac provider.
    signing_header: Option<String>,
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

/// Maximum body preview length in notification payloads (characters, not bytes).
const NOTIFICATION_PREVIEW_LEN: usize = 200;

/// Maximum entries in the rate limiter before a full prune is triggered.
const NOTIFICATION_LIMITER_MAX: usize = 10_000;

/// Ports that should never be reachable through direct notification delivery.
const BLOCKED_NOTIFICATION_PORTS: &[u16] = &[
    22,    // SSH
    23,    // Telnet
    25,    // SMTP
    135,   // MS RPC
    139,   // NetBIOS
    389,   // LDAP
    445,   // SMB
    636,   // LDAPS
    3306,  // MySQL
    3389,  // RDP
    5432,  // Postgres
    5672,  // RabbitMQ
    5900,  // VNC
    6379,  // Redis
    9200,  // Elasticsearch
    9300,  // Elasticsearch transport
    11211, // Memcached
    15672, // RabbitMQ management
    27017, // MongoDB
    27018, // MongoDB
    27019, // MongoDB
];

/// Per-endpoint rate limiter: tracks last notification time per slug.
/// Wrapped in Arc<Mutex<>> and stored in AppState so it's shared across requests.
pub type NotificationLimiter = Arc<Mutex<HashMap<String, std::time::Instant>>>;

pub fn new_notification_limiter() -> NotificationLimiter {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Truncate a string to at most `max_chars` characters (including "..." suffix).
/// Safe for multi-byte UTF-8 — never splits a character.
fn truncate_preview(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        return s.to_string();
    }
    // Reserve 3 chars for "..." so total never exceeds max_chars
    let content_chars = max_chars.saturating_sub(3);
    let byte_pos = s
        .char_indices()
        .nth(content_chars)
        .map(|(pos, _)| pos)
        .unwrap_or(s.len());
    format!("{}...", &s[..byte_pos])
}

/// Returns true if the IP address is private, loopback, link-local, or a cloud metadata address.
/// Used to prevent SSRF via user-controlled notification URLs.
fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()                           // 127.0.0.0/8
            || v4.is_private()                         // 10/8, 172.16/12, 192.168/16
            || v4.is_link_local()                      // 169.254.0.0/16 (includes metadata 169.254.169.254)
            || v4.is_broadcast()                       // 255.255.255.255
            || v4.is_unspecified()                     // 0.0.0.0
            || v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64 // 100.64.0.0/10 (CGNAT)
        }
        std::net::IpAddr::V6(v6) => {
            let segs = v6.segments();
            v6.is_loopback()                           // ::1
            || v6.is_unspecified()                     // ::
            || (segs[0] & 0xfe00) == 0xfc00           // fc00::/7 — Unique Local Address (ULA)
            || (segs[0] & 0xffc0) == 0xfe80           // fe80::/10 — link-local
            // IPv4-mapped IPv6 (::ffff:x.x.x.x) — check the embedded v4
            || v6.to_ipv4_mapped().is_some_and(|v4| is_blocked_ip(std::net::IpAddr::V4(v4)))
        }
    }
}

/// Resolved notification target: original URL + resolved addresses for DNS pinning.
struct ResolvedTarget {
    /// Original URL (unchanged — preserves hostname for TLS verification).
    url: String,
    /// Hostname from the URL (used for `resolve()` pinning).
    host: String,
    /// Validated socket addresses to pin DNS resolution to.
    addrs: Vec<std::net::SocketAddr>,
}

/// Resolve the notification URL's host, validate all IPs are safe, and return
/// the original URL with resolved addresses for DNS pinning.
///
/// The URL is NOT rewritten — reqwest uses `ClientBuilder::resolve_to_addrs()`
/// to connect to the validated IPs while keeping the original hostname for TLS.
async fn resolve_notification_target(url: &str) -> Result<ResolvedTarget, &'static str> {
    let parsed = url::Url::parse(url).map_err(|_| "invalid URL")?;
    let host = parsed.host_str().ok_or("no host in URL")?.to_string();
    let port = parsed
        .port()
        .unwrap_or(if parsed.scheme() == "https" { 443 } else { 80 });

    // Direct IP literal — no DNS needed, but still validate
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_blocked_ip(ip) {
            return Err("blocked IP");
        }
        return Ok(ResolvedTarget {
            url: url.to_string(),
            host,
            addrs: vec![std::net::SocketAddr::new(ip, port)],
        });
    }

    // DNS resolution — check ALL addresses before accepting any
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host(format!("{host}:{port}"))
        .await
        .map_err(|_| "DNS resolution failed")?
        .collect();

    if addrs.is_empty() {
        return Err("DNS returned no addresses");
    }

    for addr in &addrs {
        if is_blocked_ip(addr.ip()) {
            return Err("blocked IP");
        }
    }

    Ok(ResolvedTarget {
        url: url.to_string(),
        host,
        addrs,
    })
}

fn is_localhost_name(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost")
}

fn validate_direct_notification_target(target: &ResolvedTarget) -> Result<(), &'static str> {
    let parsed = url::Url::parse(&target.url).map_err(|_| "invalid URL")?;

    if parsed.scheme() != "https" {
        return Err("direct notification URL must use HTTPS");
    }

    let host = parsed.host_str().ok_or("no host in URL")?;
    if is_localhost_name(host) || host.parse::<std::net::IpAddr>().is_ok() {
        return Err("direct notification URL host is not allowed");
    }

    let port = parsed.port_or_known_default().ok_or("invalid URL port")?;
    if BLOCKED_NOTIFICATION_PORTS.contains(&port) {
        return Err("blocked port");
    }

    Ok(())
}

/// Notification payload for the fire-and-forget POST.
struct NotificationInfo {
    limiter: NotificationLimiter,
    redis: Option<redis::aio::MultiplexedConnection>,
    url: String,
    slug: String,
    method: String,
    path: String,
    ip: String,
    preview: String,
    received_at: String,
    /// When set, notifications route through this Cloudflare Worker proxy
    /// so the destination sees a Cloudflare IP instead of the origin server.
    proxy_url: Option<String>,
    /// Shared secret for authenticating with the proxy.
    proxy_secret: Option<String>,
    /// Minimum interval between notifications for the same endpoint.
    cooldown: std::time::Duration,
    /// Overall timeout budget for DNS resolution + HTTP POST.
    timeout_secs: u64,
}

/// Fire-and-forget POST to the notification URL with a JSON summary.
fn spawn_notification(info: NotificationInfo) {
    tokio::spawn(async move {
        // Rate limit: skip if we notified this endpoint within the cooldown period.
        // Try Redis first (distributed), fall back to in-memory on error or absence.
        let mut use_in_memory = info.redis.is_none();
        if let Some(mut conn) = info.redis.clone() {
            let key = format!("whcc:notify:{}", info.slug);
            // 100ms timeout — if Redis doesn't respond on localhost, fall back fast
            let redis_result = tokio::time::timeout(
                std::time::Duration::from_millis(100),
                redis::cmd("SET")
                    .arg(&key)
                    .arg("1")
                    .arg("NX")
                    .arg("EX")
                    .arg(info.cooldown.as_secs())
                    .query_async::<Option<String>>(&mut conn),
            )
            .await;

            match redis_result {
                Ok(Ok(Some(_))) => {
                    // Redis admitted the notification — also record in the in-memory
                    // map so a subsequent Redis error within 1s doesn't cause a duplicate.
                    let now = std::time::Instant::now();
                    let mut map = info.limiter.lock().await;
                    map.insert(info.slug.clone(), now);
                    if map.len() > NOTIFICATION_LIMITER_MAX {
                        map.retain(|_, last_time| now.duration_since(*last_time) < info.cooldown);
                    }
                }
                Ok(Ok(None)) => return, // cooldown active, skip
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, slug = %info.slug, "Redis notification rate limit failed, falling back to in-memory");
                    use_in_memory = true;
                }
                Err(_) => {
                    tracing::warn!(slug = %info.slug, "Redis notification rate limit timed out, falling back to in-memory");
                    use_in_memory = true;
                }
            }
        }
        if use_in_memory {
            let mut map = info.limiter.lock().await;
            let now = std::time::Instant::now();
            if let Some(last) = map.get(&info.slug)
                && now.duration_since(*last) < info.cooldown
            {
                return;
            }
            map.insert(info.slug.clone(), now);

            // Prune stale entries to prevent unbounded memory growth
            if map.len() > NOTIFICATION_LIMITER_MAX {
                map.retain(|_, last_time| now.duration_since(*last_time) < info.cooldown);
            }
        }

        // Wrap DNS resolution + POST in a single timeout so slow DNS
        // can't keep fire-and-forget tasks alive past the budget.
        let slug_ref = info.slug.clone();
        let outer_timeout = std::time::Duration::from_secs(info.timeout_secs);
        let inner_timeout =
            std::time::Duration::from_secs(info.timeout_secs.saturating_sub(1).max(1));
        let result = tokio::time::timeout(outer_timeout, async {
            let payload = serde_json::json!({
                "slug": info.slug,
                "method": info.method,
                "path": info.path,
                "ip": info.ip,
                "receivedAt": info.received_at,
                "preview": info.preview,
            });

            // Route through Cloudflare Worker proxy when configured,
            // otherwise deliver directly with SSRF-safe DNS pinning.
            if let Some(ref proxy_url) = info.proxy_url {
                let client = reqwest::Client::builder()
                    .timeout(inner_timeout)
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|_| "failed to build client")?;

                let mut req = client
                    .post(proxy_url)
                    .header("X-Target-URL", &info.url)
                    .json(&payload);

                if let Some(ref secret) = info.proxy_secret {
                    req = req.header("X-Auth", secret.as_str());
                }
                if !info.ip.is_empty() {
                    req = req.header("X-Sender-IP", &info.ip);
                }

                req.send().await.map_err(|_| "proxy POST failed")?;
            } else {
                // Direct delivery with SSRF protection
                let target = resolve_notification_target(&info.url).await?;
                validate_direct_notification_target(&target)?;

                let pinned_client = reqwest::Client::builder()
                    .timeout(inner_timeout)
                    .redirect(reqwest::redirect::Policy::none())
                    .resolve_to_addrs(&target.host, &target.addrs)
                    .build()
                    .map_err(|_| "failed to build client")?;

                let mut req = pinned_client.post(&target.url).json(&payload);

                if !info.ip.is_empty() {
                    req = req.header("X-Sender-IP", &info.ip);
                }

                req.send().await.map_err(|_| "POST failed")?;
            }

            Ok::<(), &'static str>(())
        })
        .await;

        match result {
            Ok(Err(reason)) => {
                tracing::debug!(slug = slug_ref, reason, "notification delivery failed");
            }
            Err(_) => {
                tracing::debug!(slug = slug_ref, "notification timed out");
            }
            Ok(Ok(())) => {}
        }
    });
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
enum DbFailure {
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
fn sqlstate_of(e: &sqlx::Error) -> Option<String> {
    match e {
        sqlx::Error::Database(db) => db.code().map(|c| c.into_owned()),
        _ => None,
    }
}

/// Classify a sqlx error from the capture query as transient or permanent.
///
/// `Database` errors without a SQLSTATE are treated as permanent (unknown);
/// the caller logs the missing code.
fn classify_db_error(e: &sqlx::Error) -> DbFailure {
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
            let mut response = (StatusCode::SERVICE_UNAVAILABLE, "retry").into_response();
            response.headers_mut().insert(
                "retry-after",
                HeaderValue::from_static(TRANSIENT_RETRY_AFTER_SECS),
            );
            response
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

    // 4. Call the stored procedure
    let result: Result<serde_json::Value, sqlx::Error> =
        sqlx::query_scalar("SELECT capture_webhook($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)")
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
            .fetch_one(&state.pool)
            .await;

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

                    // Fire notification webhook if configured
                    if let Some(ref url) = capture.notification_url
                        && !url.is_empty()
                    {
                        let preview = truncate_preview(&body_str, NOTIFICATION_PREVIEW_LEN);
                        spawn_notification(NotificationInfo {
                            limiter: state.notification_limiter.clone(),
                            redis: state.redis.clone(),
                            url: url.clone(),
                            slug: slug.clone(),
                            method: method.as_str().to_string(),
                            path: req_path.clone(),
                            ip: ip.clone(),
                            preview,
                            received_at: received_at.to_rfc3339(),
                            proxy_url: state.config.notify_proxy_url.clone(),
                            proxy_secret: state.config.notify_secret.clone(),
                            cooldown: std::time::Duration::from_secs(
                                state.config.notification_cooldown_secs,
                            ),
                            timeout_secs: state.config.notification_timeout_secs,
                        });
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

                    let effective_mock = if let Some(ref rules) = parsed_rules {
                        let ctx = RequestContext {
                            method: method.as_str(),
                            path: &req_path,
                            headers: &filtered_headers,
                            body: &body_str,
                            query: &query_params,
                        };
                        rules::evaluate_rules(rules, &ctx).or(capture.mock_response.clone())
                    } else {
                        capture.mock_response.clone()
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
                    tracing::info!(slug, ip = %ip, "quota exceeded");
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
        // Duplicate proxy headers are filtered entirely.
        headers.append("x-forwarded-for", HeaderValue::from_static("1.1.1.1"));
        headers.append("x-forwarded-for", HeaderValue::from_static("2.2.2.2"));

        let filtered = filter_headers(&headers);
        assert_eq!(filtered.get("x-dup").unwrap(), "first, second, third");
        assert_eq!(filtered.get("x-single").unwrap(), "only");
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
    fn truncate_preview_ascii() {
        let short = "hello";
        assert_eq!(truncate_preview(short, 200), "hello");

        let exact = "a".repeat(200);
        assert_eq!(truncate_preview(&exact, 200), exact);

        // 250 chars truncated to 200: 197 content + "..." = 200 total
        let long = "a".repeat(250);
        let result = truncate_preview(&long, 200);
        assert_eq!(result.chars().count(), 200);
        assert!(result.ends_with("..."));
        assert_eq!(result, format!("{}...", "a".repeat(197)));
    }

    #[test]
    fn truncate_preview_multibyte() {
        // Each emoji is 4 bytes — slicing at byte 200 would panic without char-safe truncation
        let emojis = "🎉".repeat(60); // 60 chars, 240 bytes
        let result = truncate_preview(&emojis, 50);
        assert!(result.ends_with("..."));
        // 47 emojis + "..." = 50 chars total
        assert_eq!(result.chars().count(), 50);
    }

    #[test]
    fn truncate_preview_empty() {
        assert_eq!(truncate_preview("", 200), "");
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

    #[test]
    fn blocked_ips() {
        use std::net::IpAddr;

        // Loopback
        assert!(is_blocked_ip("127.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("127.0.0.2".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("::1".parse::<IpAddr>().unwrap()));

        // Private ranges
        assert!(is_blocked_ip("10.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("172.16.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("192.168.1.1".parse::<IpAddr>().unwrap()));

        // Link-local / cloud metadata
        assert!(is_blocked_ip("169.254.169.254".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("169.254.0.1".parse::<IpAddr>().unwrap()));

        // CGNAT
        assert!(is_blocked_ip("100.64.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("100.127.255.254".parse::<IpAddr>().unwrap()));

        // Unspecified
        assert!(is_blocked_ip("0.0.0.0".parse::<IpAddr>().unwrap()));

        // IPv6 ULA (fc00::/7)
        assert!(is_blocked_ip("fd00::1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("fc00::1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip(
            "fdab:cdef:1234::1".parse::<IpAddr>().unwrap()
        ));

        // IPv6 link-local (fe80::/10)
        assert!(is_blocked_ip("fe80::1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("fe80::abcd:1234".parse::<IpAddr>().unwrap()));

        // IPv4-mapped IPv6
        assert!(is_blocked_ip("::ffff:127.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("::ffff:10.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip(
            "::ffff:169.254.169.254".parse::<IpAddr>().unwrap()
        ));

        // Public IPs — should NOT be blocked
        assert!(!is_blocked_ip("8.8.8.8".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip("1.1.1.1".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip("142.250.80.46".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip("2606:4700::1".parse::<IpAddr>().unwrap()));
    }

    #[tokio::test]
    async fn resolve_blocks_private_ip_literals() {
        assert!(
            resolve_notification_target("http://127.0.0.1:9876/hook")
                .await
                .is_err()
        );
        assert!(
            resolve_notification_target("http://10.0.0.1/hook")
                .await
                .is_err()
        );
        assert!(
            resolve_notification_target("http://169.254.169.254/meta")
                .await
                .is_err()
        );
        assert!(
            resolve_notification_target("http://[::1]/hook")
                .await
                .is_err()
        );
        assert!(resolve_notification_target("not-a-url").await.is_err());
    }

    #[test]
    fn direct_notification_policy_requires_https_hostname_and_safe_port() {
        let target = ResolvedTarget {
            url: "https://example.com/hook".to_string(),
            host: "example.com".to_string(),
            addrs: vec!["93.184.216.34:443".parse().unwrap()],
        };
        assert!(validate_direct_notification_target(&target).is_ok());

        let http_target = ResolvedTarget {
            url: "http://example.com/hook".to_string(),
            host: "example.com".to_string(),
            addrs: vec!["93.184.216.34:80".parse().unwrap()],
        };
        assert!(validate_direct_notification_target(&http_target).is_err());

        let redis_target = ResolvedTarget {
            url: "https://example.com:6379/hook".to_string(),
            host: "example.com".to_string(),
            addrs: vec!["93.184.216.34:6379".parse().unwrap()],
        };
        assert!(validate_direct_notification_target(&redis_target).is_err());

        let localhost_target = ResolvedTarget {
            url: "https://localhost/hook".to_string(),
            host: "localhost".to_string(),
            addrs: vec!["127.0.0.1:443".parse().unwrap()],
        };
        assert!(validate_direct_notification_target(&localhost_target).is_err());

        let ip_literal_target = ResolvedTarget {
            url: "https://8.8.8.8/hook".to_string(),
            host: "8.8.8.8".to_string(),
            addrs: vec!["8.8.8.8:443".parse().unwrap()],
        };
        assert!(validate_direct_notification_target(&ip_literal_target).is_err());
    }

    #[tokio::test]
    async fn resolve_preserves_original_url() {
        // Public IP literal should pass through with original URL preserved
        let result = resolve_notification_target("http://8.8.8.8:9876/hook").await;
        assert!(result.is_ok());
        let target = result.unwrap();
        assert_eq!(target.url, "http://8.8.8.8:9876/hook");
        assert_eq!(target.host, "8.8.8.8");
        assert!(!target.addrs.is_empty());
    }
}
