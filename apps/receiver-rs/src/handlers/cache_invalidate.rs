use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use subtle::ConstantTimeEq;

use crate::handlers::webhook::is_valid_slug;
use crate::AppState;

/// Hash a byte slice to a fixed-length digest for length-independent comparison.
fn hash_to_fixed(data: &[u8]) -> [u8; 8] {
    let mut h = DefaultHasher::new();
    data.hash(&mut h);
    h.finish().to_le_bytes()
}

pub async fn cache_invalidate(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // Verify shared secret using fixed-length hashes to prevent length leaking.
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let expected = format!("Bearer {}", state.config.capture_shared_secret);

    // Hash both to fixed 8 bytes so ct_eq doesn't short-circuit on length difference.
    let auth_hash = hash_to_fixed(auth.as_bytes());
    let expected_hash = hash_to_fixed(expected.as_bytes());

    if auth_hash.ct_eq(&expected_hash).unwrap_u8() != 1 {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "unauthorized"})),
        );
    }

    if !is_valid_slug(&slug) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "invalid_slug"})),
        );
    }

    // Evict both endpoint and quota caches
    state.redis.evict_endpoint(&slug).await;
    state.redis.evict_quota(&slug).await;
    tracing::debug!(slug, "cache invalidated (endpoint + quota)");

    (
        StatusCode::OK,
        axum::Json(serde_json::json!({"ok": true})),
    )
}
