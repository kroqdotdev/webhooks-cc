use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use subtle::ConstantTimeEq;

use crate::handlers::webhook::is_valid_slug;
use crate::AppState;

pub async fn cache_invalidate(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // Verify shared secret
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let expected = format!("Bearer {}", state.config.capture_shared_secret);

    if auth.as_bytes().ct_eq(expected.as_bytes()).unwrap_u8() != 1 {
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

    state.redis.evict_endpoint(&slug).await;
    tracing::debug!(slug, "cache invalidated");

    (
        StatusCode::OK,
        axum::Json(serde_json::json!({"ok": true})),
    )
}
