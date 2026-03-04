use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;

use serde::Deserialize;

use crate::AppState;
use crate::clickhouse::client::{escape_clickhouse_identifier, escape_clickhouse_string};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchSqlError {
    InvalidPlan,
    InvalidSlug,
}

fn free_retention_clause_for_plan(
    plan: Option<&str>,
) -> Result<Option<&'static str>, SearchSqlError> {
    match plan {
        Some("free") => Ok(Some("received_at >= now() - INTERVAL 7 DAY")),
        Some("pro") | None => Ok(None),
        Some(_) => Err(SearchSqlError::InvalidPlan),
    }
}

fn build_where_conditions(params: &SearchParams) -> Result<Vec<String>, SearchSqlError> {
    let mut conditions = vec![format!(
        "user_id = '{}'",
        escape_clickhouse_string(&params.user_id)
    )];

    match free_retention_clause_for_plan(params.plan.as_deref()) {
        Ok(Some(clause)) => conditions.push(clause.to_string()),
        Ok(None) => {}
        Err(err) => return Err(err),
    }

    if let Some(slug) = &params.slug {
        if !is_valid_slug(slug) {
            return Err(SearchSqlError::InvalidSlug);
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

    Ok(conditions)
}

fn build_search_sql(params: &SearchParams, db: &str) -> Result<String, SearchSqlError> {
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = params.offset.unwrap_or(0).min(10_000);
    let order = match params.order.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };

    let conditions = build_where_conditions(params)?;
    let where_clause = conditions.join(" AND ");
    let db = escape_clickhouse_identifier(db);

    Ok(format!(
        "SELECT endpoint_id, slug, user_id, method, path, headers, body, query_params, ip, content_type, size, is_ephemeral, received_at \
         FROM `{db}`.`requests` \
         WHERE {where_clause} \
         ORDER BY received_at {order} \
         LIMIT {limit} OFFSET {offset}"
    ))
}

fn build_count_sql(params: &SearchParams, db: &str) -> Result<String, SearchSqlError> {
    let conditions = build_where_conditions(params)?;
    let where_clause = conditions.join(" AND ");
    let db = escape_clickhouse_identifier(db);

    Ok(format!(
        "SELECT count() AS total \
         FROM `{db}`.`requests` \
         WHERE {where_clause}"
    ))
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

    let sql = match build_search_sql(&params, &state.config.clickhouse_database) {
        Ok(sql) => sql,
        Err(SearchSqlError::InvalidPlan) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "invalid plan"})),
            );
        }
        Err(SearchSqlError::InvalidSlug) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "invalid slug"})),
            );
        }
    };

    match tokio::time::timeout(Duration::from_secs(5), clickhouse.query_requests(&sql)).await {
        Ok(Ok(results)) => (StatusCode::OK, axum::Json(serde_json::json!(results))),
        Ok(Err(e)) => {
            tracing::error!(error = %e, "ClickHouse search query failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "search query failed"})),
            )
        }
        Err(_) => {
            tracing::error!("ClickHouse search query timed out");
            (
                StatusCode::GATEWAY_TIMEOUT,
                axum::Json(serde_json::json!({"error": "search query timed out"})),
            )
        }
    }
}

pub async fn search_count(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SearchParams>,
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

    if params.user_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "user_id is required"})),
        );
    }

    let clickhouse = match &state.clickhouse {
        Some(ch) => ch,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(serde_json::json!({"error": "search not available"})),
            );
        }
    };

    let sql = match build_count_sql(&params, &state.config.clickhouse_database) {
        Ok(sql) => sql,
        Err(SearchSqlError::InvalidPlan) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "invalid plan"})),
            );
        }
        Err(SearchSqlError::InvalidSlug) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "invalid slug"})),
            );
        }
    };

    match tokio::time::timeout(Duration::from_secs(5), clickhouse.query_count(&sql)).await {
        Ok(Ok(count)) => (StatusCode::OK, axum::Json(serde_json::json!({ "count": count }))),
        Ok(Err(e)) => {
            tracing::error!(error = %e, "ClickHouse count query failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "count query failed"})),
            )
        }
        Err(_) => {
            tracing::error!("ClickHouse count query timed out");
            (
                StatusCode::GATEWAY_TIMEOUT,
                axum::Json(serde_json::json!({"error": "count query timed out"})),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        SearchParams, SearchSqlError, build_count_sql, build_search_sql,
        free_retention_clause_for_plan,
    };

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
        assert_eq!(result, Err(SearchSqlError::InvalidPlan));
    }

    #[test]
    fn build_search_sql_includes_free_plan_retention_clause() {
        let params = SearchParams {
            user_id: "user_123".to_string(),
            plan: Some("free".to_string()),
            slug: Some("demo_slug".to_string()),
            method: Some("POST".to_string()),
            q: None,
            from: None,
            to: None,
            limit: Some(25),
            offset: Some(10),
            order: Some("desc".to_string()),
        };

        let sql = build_search_sql(&params, "webhooks").expect("sql should build");

        assert!(sql.contains("FROM `webhooks`.`requests`"));
        assert!(sql.contains("user_id = 'user_123'"));
        assert!(sql.contains("received_at >= now() - INTERVAL 7 DAY"));
        assert!(sql.contains("slug = 'demo_slug'"));
        assert!(sql.contains("method = 'POST'"));
        assert!(sql.contains("LIMIT 25 OFFSET 10"));
    }

    #[test]
    fn build_search_sql_omits_retention_for_pro_plan() {
        let params = SearchParams {
            user_id: "user_123".to_string(),
            plan: Some("pro".to_string()),
            slug: None,
            method: None,
            q: None,
            from: None,
            to: None,
            limit: None,
            offset: None,
            order: None,
        };

        let sql = build_search_sql(&params, "webhooks").expect("sql should build");
        assert!(!sql.contains("INTERVAL 7 DAY"));
    }

    #[test]
    fn build_count_sql_applies_same_filters_without_limit_order() {
        let params = SearchParams {
            user_id: "user_123".to_string(),
            plan: Some("free".to_string()),
            slug: Some("demo_slug".to_string()),
            method: Some("POST".to_string()),
            q: Some("needle".to_string()),
            from: Some(1_700_000_000_000),
            to: Some(1_700_000_100_000),
            limit: Some(25),
            offset: Some(10),
            order: Some("asc".to_string()),
        };

        let sql = build_count_sql(&params, "webhooks").expect("count sql should build");
        assert!(sql.contains("SELECT count() AS total"));
        assert!(sql.contains("FROM `webhooks`.`requests`"));
        assert!(sql.contains("received_at >= now() - INTERVAL 7 DAY"));
        assert!(sql.contains("slug = 'demo_slug'"));
        assert!(sql.contains("method = 'POST'"));
        assert!(!sql.contains("LIMIT"));
        assert!(!sql.contains("ORDER BY"));
    }

    #[test]
    fn build_search_sql_rejects_invalid_slug() {
        let params = SearchParams {
            user_id: "user_123".to_string(),
            plan: Some("free".to_string()),
            slug: Some("../bad".to_string()),
            method: None,
            q: None,
            from: None,
            to: None,
            limit: None,
            offset: None,
            order: None,
        };

        let err = build_search_sql(&params, "webhooks").expect_err("invalid slug should fail");
        assert_eq!(err, SearchSqlError::InvalidSlug);
    }

    #[test]
    fn build_search_sql_escapes_inputs_and_handles_negative_timestamps() {
        let params = SearchParams {
            user_id: "user'; DROP TABLE requests--".to_string(),
            plan: None,
            slug: None,
            method: None,
            q: Some("needle'\\\\test".to_string()),
            from: Some(-1),
            to: Some(-1001),
            limit: None,
            offset: None,
            order: Some("asc".to_string()),
        };

        let sql = build_search_sql(&params, "web`hooks").expect("sql should build");

        assert!(sql.contains("FROM `web``hooks`.`requests`"));
        assert!(sql.contains("user_id = 'user\\'; DROP TABLE requests--'"));
        assert!(sql.contains("multiSearchAny(path, ['needle\\'\\\\\\\\test'])"));
        assert!(sql.contains("received_at >= toDateTime64('-1.999', 3, 'UTC')"));
        assert!(sql.contains("received_at <= toDateTime64('-2.999', 3, 'UTC')"));
        assert!(sql.contains("ORDER BY received_at ASC"));
    }
}
