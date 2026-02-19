use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;

use serde::Deserialize;

use crate::AppState;
use crate::handlers::auth::verify_bearer_token;
use crate::handlers::webhook::is_valid_slug;

#[derive(Debug, Deserialize)]
pub struct SearchParams {
    user_id: String,
    plan: Option<String>,
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
/// Only escapes backslash and single-quote (the two characters that can
/// break out of a ClickHouse string literal).
fn escape_clickhouse_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

fn free_retention_clause_for_plan(
    plan: Option<&str>,
) -> Result<Option<&'static str>, &'static str> {
    match plan {
        Some("free") => Ok(Some("received_at >= now() - INTERVAL 7 DAY")),
        Some("pro") | None => Ok(None),
        Some(_) => Err("invalid plan"),
    }
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

    if !verify_bearer_token(auth, &state.config.capture_shared_secret) {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "unauthorized"})),
        );
    }

    // user_id is required and must be non-empty
    if params.user_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "user_id is required"})),
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
    let offset = params.offset.unwrap_or(0).min(10_000);
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

    match free_retention_clause_for_plan(params.plan.as_deref()) {
        Ok(Some(clause)) => conditions.push(clause.to_string()),
        Ok(None) => {}
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "invalid plan"})),
            );
        }
    }

    if let Some(slug) = &params.slug {
        if !is_valid_slug(slug) {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "invalid slug"})),
            );
        }
        conditions.push(format!("slug = '{}'", escape_clickhouse_string(slug)));
    }

    if let Some(method) = &params.method
        && method != "ALL"
    {
        conditions.push(format!("method = '{}'", escape_clickhouse_string(method)));
    }

    // Use multiSearchAny() for substring search — it does exact substring
    // matching (no wildcard/regex escaping needed) and is supported by
    // ngrambf_v1 skip indexes for efficient filtering.
    if let Some(q) = &params.q
        && !q.is_empty()
    {
        let escaped = escape_clickhouse_string(q);
        conditions.push(format!(
            "(multiSearchAny(path, ['{escaped}']) OR multiSearchAny(body, ['{escaped}']) OR multiSearchAny(headers, ['{escaped}']))"
        ));
    }

    // Use integer arithmetic for timestamps to avoid f64 precision loss
    // and potential scientific notation formatting.
    if let Some(from) = params.from {
        let secs = from.div_euclid(1000);
        let ms = from.rem_euclid(1000) as u64;
        conditions.push(format!(
            "received_at >= toDateTime64('{secs}.{ms:03}', 3, 'UTC')"
        ));
    }

    if let Some(to) = params.to {
        let secs = to.div_euclid(1000);
        let ms = to.rem_euclid(1000) as u64;
        conditions.push(format!(
            "received_at <= toDateTime64('{secs}.{ms:03}', 3, 'UTC')"
        ));
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

#[cfg(test)]
mod tests {
    use super::free_retention_clause_for_plan;

    #[test]
    fn free_plan_gets_retention_clause() {
        let clause =
            free_retention_clause_for_plan(Some("free")).expect("free plan should be valid");
        assert_eq!(clause, Some("received_at >= now() - INTERVAL 7 DAY"));
    }

    #[test]
    fn pro_and_missing_plan_have_no_clause() {
        let pro_clause =
            free_retention_clause_for_plan(Some("pro")).expect("pro plan should be valid");
        assert_eq!(pro_clause, None);

        let none_clause =
            free_retention_clause_for_plan(None).expect("missing plan should be valid");
        assert_eq!(none_clause, None);
    }

    #[test]
    fn invalid_plan_is_rejected() {
        let result = free_retention_clause_for_plan(Some("enterprise"));
        assert!(result.is_err());
    }
}
