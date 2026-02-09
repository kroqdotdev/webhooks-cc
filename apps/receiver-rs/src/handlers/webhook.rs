use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::convex::types::BufferedRequest;
use crate::redis::quota::QuotaResult;
use crate::AppState;

const MAX_HEADER_KEY_LEN: usize = 256;
const MAX_HEADER_VALUE_LEN: usize = 8192;

/// Blocked response headers that must not be forwarded from mock responses.
const BLOCKED_HEADERS: &[&str] = &[
    "set-cookie",
    "strict-transport-security",
    "content-security-policy",
    "x-frame-options",
];

/// Validate slug: alphanumeric + hyphen + underscore, 1-64 chars.
pub fn is_valid_slug(slug: &str) -> bool {
    if slug.is_empty() || slug.len() > 64 {
        return false;
    }
    slug.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Extract the real client IP from proxy headers.
fn real_ip(headers: &HeaderMap) -> String {
    if let Some(ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        return ip.to_string();
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        && let Some(first) = xff.split(',').next() {
            return first.trim().to_string();
        }
    String::new()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// The main webhook handler: GET/POST/PUT/PATCH/DELETE /w/{slug}/*
pub async fn handle_webhook(
    State(state): State<AppState>,
    method: Method,
    Path((slug, path)): Path<(String, String)>,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if !is_valid_slug(&slug) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "invalid_slug"})),
        )
            .into_response();
    }

    let req_path = if path.is_empty() {
        "/".to_string()
    } else if path.starts_with('/') {
        path.clone()
    } else {
        format!("/{path}")
    };

    // 1. Get endpoint info from Redis cache
    let endpoint = match state.redis.get_endpoint(&slug).await {
        Some(ep) => {
            if !ep.error.is_empty() && ep.error == "not_found" {
                return (
                    StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({"error": "not_found"})),
                )
                    .into_response();
            }
            ep
        }
        None => {
            // Cache miss: spawn background warm, serve optimistically
            let convex = state.convex.clone();
            let slug_clone = slug.clone();
            tokio::spawn(async move {
                if let Err(e) = convex.fetch_and_cache_endpoint(&slug_clone).await {
                    tracing::warn!(slug = slug_clone, error = %e, "background endpoint fetch failed");
                }
            });

            // Also warm quota in background
            let convex2 = state.convex.clone();
            let slug_clone2 = slug.clone();
            tokio::spawn(async move {
                if let Err(e) = convex2.fetch_and_cache_quota(&slug_clone2).await {
                    tracing::warn!(slug = slug_clone2, error = %e, "background quota fetch failed");
                }
            });

            // Buffer the request and return 200 OK (fail-open)
            buffer_request(&state, &slug, &method, &req_path, &headers, &query, &body).await;
            return (StatusCode::OK, "OK").into_response();
        }
    };

    // 2. Check expiry
    if endpoint.is_expired() {
        return (
            StatusCode::GONE,
            axum::Json(serde_json::json!({"error": "expired"})),
        )
            .into_response();
    }

    // 3. Atomic quota check via Redis Lua script (per-user when userId present)
    match state.redis.check_quota(&slug, endpoint.user_id.as_deref()).await {
        QuotaResult::Allowed => {}
        QuotaResult::Exceeded => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                axum::Json(serde_json::json!({"error": "quota_exceeded"})),
            )
                .into_response();
        }
        QuotaResult::NotFound => {
            // Cache miss: spawn background warm, fail-open
            let convex = state.convex.clone();
            let slug_clone = slug.clone();
            tokio::spawn(async move {
                if let Err(e) = convex.fetch_and_cache_quota(&slug_clone).await {
                    tracing::warn!(slug = slug_clone, error = %e, "background quota fetch failed");
                }
            });
        }
    }

    // 4. Buffer the request
    buffer_request(&state, &slug, &method, &req_path, &headers, &query, &body).await;

    // 5. Return mock response or "OK"
    if let Some(mock) = &endpoint.mock_response {
        return build_mock_response(mock);
    }

    (StatusCode::OK, "OK").into_response()
}

/// Also handle the case where no trailing path is provided: /w/{slug}
pub async fn handle_webhook_no_path(
    state: State<AppState>,
    method: Method,
    Path(slug): Path<String>,
    headers: HeaderMap,
    query: axum::extract::Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    handle_webhook(state, method, Path((slug, String::new())), headers, query, body).await
}

async fn buffer_request(
    state: &AppState,
    slug: &str,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    query: &axum::extract::Query<HashMap<String, String>>,
    body: &Bytes,
) {
    let mut header_map = HashMap::new();
    for (key, value) in headers.iter() {
        if let Ok(v) = value.to_str() {
            header_map.insert(key.as_str().to_string(), v.to_string());
        }
    }

    let body_str = String::from_utf8_lossy(body).into_owned();
    let ip = real_ip(headers);

    let buffered = BufferedRequest {
        method: method.as_str().to_string(),
        path: path.to_string(),
        headers: header_map,
        body: body_str,
        query_params: query.0.clone(),
        ip,
        received_at: now_ms(),
    };

    state.redis.push_request(slug, &buffered).await;
}

fn build_mock_response(mock: &crate::convex::types::MockResponse) -> Response {
    let status_code = if (100..=599).contains(&mock.status) {
        StatusCode::from_u16(mock.status as u16).unwrap_or(StatusCode::OK)
    } else {
        StatusCode::OK
    };

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
