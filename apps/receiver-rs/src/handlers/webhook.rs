use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::AppState;

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
    let raw = if let Some(ip) = headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()) {
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

/// Filter request headers: remove proxy/CDN headers, collect into a HashMap.
fn filter_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (key, value) in headers.iter() {
        let name = key.as_str();
        if PROXY_HEADERS.contains(&name) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            map.insert(name.to_string(), v.to_string());
        }
    }
    map
}

/// Shape returned by the capture_webhook stored procedure.
#[derive(Debug, Deserialize)]
struct CaptureResult {
    status: String,
    mock_response: Option<MockResponse>,
    retry_after: Option<i64>,
    notification_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MockResponse {
    status: i64,
    body: String,
    headers: HashMap<String, String>,
    #[serde(default)]
    delay: Option<u64>,
}

/// Maximum allowed mock response delay (30 seconds).
const MAX_DELAY_MS: u64 = 30_000;

/// Maximum body preview length in notification payloads (characters, not bytes).
const NOTIFICATION_PREVIEW_LEN: usize = 200;

/// Minimum interval between notifications for a single endpoint (rate limit).
const NOTIFICATION_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(1);

/// Maximum entries in the rate limiter before a full prune is triggered.
const NOTIFICATION_LIMITER_MAX: usize = 10_000;

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
            || v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64  // 100.64.0.0/10 (CGNAT)
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

/// Notification payload for the fire-and-forget POST.
struct NotificationInfo {
    limiter: NotificationLimiter,
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
}

/// Fire-and-forget POST to the notification URL with a JSON summary.
fn spawn_notification(info: NotificationInfo) {
    tokio::spawn(async move {
        // Rate limit: skip if we notified this endpoint within the cooldown period
        {
            let mut map = info.limiter.lock().await;
            let now = std::time::Instant::now();
            if let Some(last) = map.get(&info.slug)
                && now.duration_since(*last) < NOTIFICATION_COOLDOWN
            {
                return;
            }
            map.insert(info.slug.clone(), now);

            // Prune stale entries to prevent unbounded memory growth
            if map.len() > NOTIFICATION_LIMITER_MAX {
                map.retain(|_, last_time| now.duration_since(*last_time) < NOTIFICATION_COOLDOWN);
            }
        }

        // Wrap DNS resolution + POST in a single 5s timeout so slow DNS
        // can't keep fire-and-forget tasks alive past the budget.
        let slug_ref = info.slug.clone();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
                    .timeout(std::time::Duration::from_secs(4))
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

                let pinned_client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(4))
                    .redirect(reqwest::redirect::Policy::none())
                    .resolve_to_addrs(&target.host, &target.addrs)
                    .build()
                    .map_err(|_| "failed to build client")?;

                let mut req = pinned_client
                    .post(&target.url)
                    .json(&payload);

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

/// The main webhook handler: any method at /w/{slug}/{*path}
pub async fn handle_webhook(
    State(state): State<AppState>,
    method: Method,
    Path((slug, path)): Path<(String, String)>,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    handle_webhook_inner(state, method, slug, path, headers, query, body).await
}

/// Handle the case where no trailing path is provided: /w/{slug}
pub async fn handle_webhook_no_path(
    State(state): State<AppState>,
    method: Method,
    Path(slug): Path<String>,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    handle_webhook_inner(state, method, slug, String::new(), headers, query, body).await
}

async fn handle_webhook_inner(
    state: AppState,
    method: Method,
    slug: String,
    path: String,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    // 1. Validate and normalize slug to lowercase (case-insensitive matching)
    let slug = slug.to_ascii_lowercase();
    if !is_valid_slug(&slug) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "invalid_slug"})),
        )
            .into_response();
    }

    // 2. Normalize path
    let req_path = if path.is_empty() {
        "/".to_string()
    } else if path.starts_with('/') {
        path.clone()
    } else {
        format!("/{path}")
    };

    // 3. Extract request data
    let ip = real_ip(&headers);
    let filtered_headers = filter_headers(&headers);
    // Try exact UTF-8 first; only store raw bytes when the payload isn't valid UTF-8
    let (body_str, body_raw): (String, Option<Vec<u8>>) = match String::from_utf8(body.to_vec()) {
        Ok(s) => (s, None),
        Err(e) => {
            let lossy = String::from_utf8_lossy(e.as_bytes()).into_owned();
            (lossy, Some(e.into_bytes()))
        }
    };
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let received_at = Utc::now();

    // Serialize headers and query params as JSON values
    let headers_json = serde_json::to_value(&filtered_headers).unwrap_or(serde_json::Value::Object(
        serde_json::Map::new(),
    ));
    let query_json = serde_json::to_value(&query.0).unwrap_or(serde_json::Value::Object(
        serde_json::Map::new(),
    ));

    // 4. Call the stored procedure
    let result: Result<serde_json::Value, sqlx::Error> = sqlx::query_scalar(
        "SELECT capture_webhook($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
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
    .fetch_one(&state.pool)
    .await;

    // 5. Map result to HTTP response
    match result {
        Ok(json_value) => {
            let capture: CaptureResult = match serde_json::from_value(json_value) {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!(slug, error = %e, "failed to parse capture_webhook result");
                    return (StatusCode::OK, "OK").into_response();
                }
            };

            match capture.status.as_str() {
                "ok" => {
                    // Fire notification webhook if configured
                    if let Some(ref url) = capture.notification_url
                        && !url.is_empty()
                    {
                        let preview = truncate_preview(&body_str, NOTIFICATION_PREVIEW_LEN);
                        spawn_notification(NotificationInfo {
                            limiter: state.notification_limiter.clone(),
                            url: url.clone(),
                            slug: slug.clone(),
                            method: method.as_str().to_string(),
                            path: req_path.clone(),
                            ip: ip.clone(),
                            preview,
                            received_at: received_at.to_rfc3339(),
                            proxy_url: state.config.notify_proxy_url.clone(),
                            proxy_secret: state.config.notify_secret.clone(),
                        });
                    }

                    if let Some(mock) = &capture.mock_response {
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
                "not_found" => (
                    StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({"error": "not_found"})),
                )
                    .into_response(),
                "expired" => (
                    StatusCode::GONE,
                    axum::Json(serde_json::json!({"error": "expired"})),
                )
                    .into_response(),
                "quota_exceeded" => {
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
                    tracing::warn!(slug, status = unknown, "unexpected capture_webhook status");
                    (StatusCode::OK, "OK").into_response()
                }
            }
        }
        Err(e) => {
            // Fail open: return 200 so the sender doesn't retry
            tracing::error!(slug, error = %e, "capture_webhook query failed");
            (StatusCode::OK, "OK").into_response()
        }
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
        use axum::http::HeaderValue;

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
        assert!(is_blocked_ip("fdab:cdef:1234::1".parse::<IpAddr>().unwrap()));

        // IPv6 link-local (fe80::/10)
        assert!(is_blocked_ip("fe80::1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("fe80::abcd:1234".parse::<IpAddr>().unwrap()));

        // IPv4-mapped IPv6
        assert!(is_blocked_ip("::ffff:127.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("::ffff:10.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip("::ffff:169.254.169.254".parse::<IpAddr>().unwrap()));

        // Public IPs — should NOT be blocked
        assert!(!is_blocked_ip("8.8.8.8".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip("1.1.1.1".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip("142.250.80.46".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip("2606:4700::1".parse::<IpAddr>().unwrap()));
    }

    #[tokio::test]
    async fn resolve_blocks_private_ip_literals() {
        assert!(resolve_notification_target("http://127.0.0.1:9876/hook").await.is_err());
        assert!(resolve_notification_target("http://10.0.0.1/hook").await.is_err());
        assert!(resolve_notification_target("http://169.254.169.254/meta").await.is_err());
        assert!(resolve_notification_target("http://[::1]/hook").await.is_err());
        assert!(resolve_notification_target("not-a-url").await.is_err());
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
