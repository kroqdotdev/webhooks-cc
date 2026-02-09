use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::AppState;

pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let degraded = state.convex.circuit().is_degraded().await;
    let circuit_state = state.convex.circuit().state().await;

    let status = if degraded {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };

    let label = if degraded { "degraded" } else { "ok" };

    (
        status,
        axum::Json(serde_json::json!({
            "status": label,
            "circuit": circuit_state.to_string(),
        })),
    )
}
