use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::AppState;

pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            axum::Json(serde_json::json!({"status": "ok"})),
        ),
        Err(e) => {
            tracing::error!(error = %e, "health check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(serde_json::json!({"status": "unhealthy"})),
            )
        }
    }
}
