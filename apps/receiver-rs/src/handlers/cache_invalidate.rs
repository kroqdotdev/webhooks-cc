use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;

use crate::handlers::auth::verify_bearer_token;
use crate::handlers::webhook::is_valid_slug;
use crate::AppState;

pub async fn cache_invalidate(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !verify_bearer_token(auth, &state.config.capture_shared_secret) {
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
