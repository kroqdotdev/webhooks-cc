use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use std::collections::HashMap;

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
}

#[derive(Debug, Deserialize)]
struct MockResponse {
    status: i64,
    body: String,
    headers: HashMap<String, String>,
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
    // 1. Validate slug
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
    let body_str = String::from_utf8_lossy(&body).into_owned();
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
        "SELECT capture_webhook($1, $2, $3, $4, $5, $6, $7, $8, $9)",
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
                    if let Some(mock) = &capture.mock_response {
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
        };

        let response = build_mock_response(&mock);
        let headers = response.headers();
        assert!(headers.get("good-header").is_some());
        assert!(headers.get("bad-header").is_none());
    }
}
