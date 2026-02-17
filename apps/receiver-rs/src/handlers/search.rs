use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use subtle::ConstantTimeEq;

use serde::Deserialize;

use crate::AppState;

/// Hash a byte slice to a fixed-length digest for length-independent comparison.
fn hash_to_fixed(data: &[u8]) -> [u8; 8] {
    let mut h = DefaultHasher::new();
    data.hash(&mut h);
    h.finish().to_le_bytes()
}

#[derive(Debug, Deserialize)]
pub struct SearchParams {
    user_id: String,
    slug: Option<String>,
    method: Option<String>,
    q: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
    limit: Option<u32>,
    offset: Option<u32>,
    order: Option<String>,
}

/// Escape a string for safe inclusion in ClickHouse SQL string literals.
/// Prevents SQL injection by escaping special characters.
fn escape_clickhouse_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SearchParams>,
) -> impl IntoResponse {
    // Verify shared secret
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let expected = format!("Bearer {}", state.config.capture_shared_secret);

    let auth_hash = hash_to_fixed(auth.as_bytes());
    let expected_hash = hash_to_fixed(expected.as_bytes());

    if auth_hash.ct_eq(&expected_hash).unwrap_u8() != 1 {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "unauthorized"})),
        );
    }

    // ClickHouse must be enabled
    let clickhouse = match &state.clickhouse {
        Some(ch) => ch,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(serde_json::json!({"error": "search not available"})),
            );
        }
    };

    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0);
    let order = match params.order.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };
    let db = &state.config.clickhouse_database;

    // Build WHERE clauses
    let mut conditions = vec![format!(
        "user_id = '{}'",
        escape_clickhouse_string(&params.user_id)
    )];

    if let Some(slug) = &params.slug {
        conditions.push(format!(
            "slug = '{}'",
            escape_clickhouse_string(slug)
        ));
    }

    if let Some(method) = &params.method
        && method != "ALL"
    {
        conditions.push(format!(
            "method = '{}'",
            escape_clickhouse_string(method)
        ));
    }

    if let Some(q) = &params.q
        && !q.is_empty()
    {
        let escaped = escape_clickhouse_string(q);
        conditions.push(format!(
            "(path LIKE '%{escaped}%' OR body LIKE '%{escaped}%' OR headers LIKE '%{escaped}%')"
        ));
    }

    if let Some(from) = params.from {
        let secs = from as f64 / 1000.0;
        conditions.push(format!("received_at >= toDateTime64({secs}, 3, 'UTC')"));
    }

    if let Some(to) = params.to {
        let secs = to as f64 / 1000.0;
        conditions.push(format!("received_at <= toDateTime64({secs}, 3, 'UTC')"));
    }

    let where_clause = conditions.join(" AND ");

    let sql = format!(
        "SELECT endpoint_id, slug, user_id, method, path, headers, body, query_params, ip, content_type, size, is_ephemeral, received_at \
         FROM {db}.requests \
         WHERE {where_clause} \
         ORDER BY received_at {order} \
         LIMIT {limit} OFFSET {offset}"
    );

    match clickhouse.query_requests(&sql).await {
        Ok(results) => (StatusCode::OK, axum::Json(serde_json::json!(results))),
        Err(e) => {
            tracing::error!(error = %e, "ClickHouse search query failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "search query failed"})),
            )
        }
    }
}
