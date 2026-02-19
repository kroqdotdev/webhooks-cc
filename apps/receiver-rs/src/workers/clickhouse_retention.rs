use std::time::Duration;

use tokio::sync::watch;

use crate::clickhouse::client::ClickHouseClient;
use crate::convex::client::ConvexClient;
use crate::convex::types::UsersByPlanResponse;

const RETENTION_SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60); // 1 hour
const FREE_RETENTION_DAYS: u32 = 7;
const USER_PAGE_SIZE: u32 = 250;
const DELETE_CHUNK_SIZE: usize = 200;

trait PlanUserSource {
    async fn list_users_by_plan_page(
        &self,
        plan: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<UsersByPlanResponse, String>;
}

trait RequestRetentionDeleter {
    async fn delete_old_requests(
        &self,
        user_ids: &[String],
        retention_days: u32,
    ) -> Result<(), String>;
}

impl PlanUserSource for ConvexClient {
    async fn list_users_by_plan_page(
        &self,
        plan: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<UsersByPlanResponse, String> {
        ConvexClient::list_users_by_plan(self, plan, cursor, limit)
            .await
            .map_err(|e| e.to_string())
    }
}

impl RequestRetentionDeleter for ClickHouseClient {
    async fn delete_old_requests(
        &self,
        user_ids: &[String],
        retention_days: u32,
    ) -> Result<(), String> {
        ClickHouseClient::delete_old_requests_for_users(self, user_ids, retention_days).await
    }
}

/// Spawn a background worker that enforces free-tier ClickHouse retention.
///
/// Convex controls source-of-truth plan state. This worker pages all free users,
/// then submits ClickHouse mutations to delete rows older than 7 days for those users.
pub fn spawn_clickhouse_retention_worker(
    convex: ConvexClient,
    clickhouse: Option<ClickHouseClient>,
    mut shutdown: watch::Receiver<bool>,
) {
    let Some(clickhouse) = clickhouse else {
        tracing::info!("clickhouse retention worker disabled: ClickHouse not configured");
        return;
    };

    tokio::spawn(async move {
        tracing::info!("clickhouse retention worker started");

        loop {
            if *shutdown.borrow() {
                tracing::info!("clickhouse retention worker shutting down");
                return;
            }

            if let Err(err) = run_free_retention_sweep(&convex, &clickhouse).await {
                tracing::warn!(error = %err, "clickhouse retention sweep failed");
            }

            tokio::select! {
                _ = tokio::time::sleep(RETENTION_SWEEP_INTERVAL) => {}
                _ = shutdown.changed() => {}
            }
        }
    });
}

async fn run_free_retention_sweep(
    convex: &impl PlanUserSource,
    clickhouse: &impl RequestRetentionDeleter,
) -> Result<(), String> {
    let mut cursor: Option<String> = None;
    let mut total_users = 0usize;
    let mut total_batches = 0usize;

    loop {
        let page = convex
            .list_users_by_plan_page("free", cursor.as_deref(), USER_PAGE_SIZE)
            .await
            .map_err(|e| format!("fetch free users: {e}"))?;

        if !page.error.is_empty() {
            return Err(format!(
                "convex users-by-plan returned error: {}",
                page.error
            ));
        }

        total_users += page.user_ids.len();

        for user_ids in page.user_ids.chunks(DELETE_CHUNK_SIZE) {
            clickhouse
                .delete_old_requests(user_ids, FREE_RETENTION_DAYS)
                .await
                .map_err(|e| format!("clickhouse delete mutation failed: {e}"))?;
            total_batches += 1;
        }

        if page.done {
            break;
        }

        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }

    tracing::info!(
        free_users = total_users,
        delete_batches = total_batches,
        retention_days = FREE_RETENTION_DAYS,
        "clickhouse free-tier retention sweep complete"
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{DELETE_CHUNK_SIZE, PlanUserSource, USER_PAGE_SIZE, run_free_retention_sweep};
    use crate::clickhouse::client::ClickHouseClient;
    use crate::convex::types::UsersByPlanResponse;
    use axum::extract::{Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use reqwest::Client;
    use serde::Deserialize;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    #[derive(Default, Clone)]
    struct ConvexRequestLog {
        calls: Arc<Mutex<Vec<(String, Option<String>, u32)>>>,
    }

    #[derive(Default, Clone)]
    struct ClickHouseSqlLog {
        sql: Arc<Mutex<Vec<String>>>,
    }

    #[derive(Clone)]
    struct HttpPlanUserSource {
        http: Client,
        base_url: String,
        secret: String,
    }

    impl HttpPlanUserSource {
        fn new(base_url: String, secret: String) -> Self {
            Self {
                http: Client::new(),
                base_url,
                secret,
            }
        }
    }

    impl PlanUserSource for HttpPlanUserSource {
        async fn list_users_by_plan_page(
            &self,
            plan: &str,
            cursor: Option<&str>,
            limit: u32,
        ) -> Result<UsersByPlanResponse, String> {
            let mut req = self
                .http
                .get(format!("{}/users-by-plan", self.base_url))
                .query(&[("plan", plan), ("limit", &limit.to_string())])
                .header("Authorization", format!("Bearer {}", self.secret));

            if let Some(cursor) = cursor {
                req = req.query(&[("cursor", cursor)]);
            }

            let resp = req.send().await.map_err(|e| format!("network: {e}"))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("status {status}: {body}"));
            }

            resp.json::<UsersByPlanResponse>()
                .await
                .map_err(|e| format!("parse: {e}"))
        }
    }

    #[derive(Debug, Deserialize)]
    struct UsersByPlanQuery {
        plan: String,
        cursor: Option<String>,
        limit: Option<u32>,
    }

    async fn mock_users_by_plan(
        State(log): State<ConvexRequestLog>,
        headers: HeaderMap,
        Query(query): Query<UsersByPlanQuery>,
    ) -> (StatusCode, Json<UsersByPlanResponse>) {
        let auth = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if auth != "Bearer test-shared-secret" {
            return (
                StatusCode::UNAUTHORIZED,
                Json(UsersByPlanResponse {
                    error: "unauthorized".to_string(),
                    user_ids: vec![],
                    next_cursor: None,
                    done: true,
                }),
            );
        }

        log.calls.lock().expect("convex call log lock").push((
            query.plan.clone(),
            query.cursor.clone(),
            query.limit.unwrap_or_default(),
        ));

        let payload = match query.cursor.as_deref() {
            None => UsersByPlanResponse {
                error: String::new(),
                user_ids: (0..205).map(|i| format!("user_{i}")).collect(),
                next_cursor: Some("cursor_page_2".to_string()),
                done: false,
            },
            Some("cursor_page_2") => UsersByPlanResponse {
                error: String::new(),
                user_ids: vec![
                    "user_205".to_string(),
                    "user_206".to_string(),
                    "user_207".to_string(),
                ],
                next_cursor: None,
                done: true,
            },
            _ => UsersByPlanResponse {
                error: "bad_cursor".to_string(),
                user_ids: vec![],
                next_cursor: None,
                done: true,
            },
        };

        (StatusCode::OK, Json(payload))
    }

    async fn mock_clickhouse_delete(
        State(log): State<ClickHouseSqlLog>,
        headers: HeaderMap,
        body: String,
    ) -> (StatusCode, &'static str) {
        let user = headers
            .get("X-ClickHouse-User")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        let key = headers
            .get("X-ClickHouse-Key")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if user != "ch_user" || key != "ch_pass" {
            return (StatusCode::UNAUTHORIZED, "bad auth");
        }

        log.sql.lock().expect("sql log lock").push(body);
        (StatusCode::OK, "ok")
    }

    async fn spawn_http_server(app: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve mock server");
        });
        format!("http://{addr}")
    }

    fn count_users_in_delete_sql(sql: &str) -> usize {
        let Some(start) = sql.find("user_id IN (") else {
            return 0;
        };
        let list_start = start + "user_id IN (".len();
        let Some(rel_end) = sql[list_start..].find(") AND received_at") else {
            return 0;
        };
        let list = &sql[list_start..list_start + rel_end];
        if list.trim().is_empty() {
            return 0;
        }
        list.split(',').count()
    }

    #[tokio::test]
    async fn full_sweep_uses_paging_and_chunked_clickhouse_deletes() {
        let convex_log = ConvexRequestLog::default();
        let convex_app = Router::new()
            .route("/users-by-plan", get(mock_users_by_plan))
            .with_state(convex_log.clone());
        let convex_base = spawn_http_server(convex_app).await;
        let convex = HttpPlanUserSource::new(convex_base, "test-shared-secret".to_string());

        let clickhouse_log = ClickHouseSqlLog::default();
        let clickhouse_app = Router::new()
            .route("/", post(mock_clickhouse_delete))
            .with_state(clickhouse_log.clone());
        let clickhouse_base = spawn_http_server(clickhouse_app).await;
        let clickhouse = ClickHouseClient::new(&clickhouse_base, "ch_user", "ch_pass", "webhooks");

        run_free_retention_sweep(&convex, &clickhouse)
            .await
            .expect("retention sweep should succeed");

        let calls = convex_log.calls.lock().expect("convex calls").clone();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], ("free".to_string(), None, USER_PAGE_SIZE));
        assert_eq!(
            calls[1],
            (
                "free".to_string(),
                Some("cursor_page_2".to_string()),
                USER_PAGE_SIZE
            )
        );

        let sql = clickhouse_log.sql.lock().expect("clickhouse sql").clone();
        assert_eq!(sql.len(), 3);
        for statement in &sql {
            assert!(statement.contains("ALTER TABLE webhooks.requests DELETE"));
            assert!(statement.contains("received_at < now() - INTERVAL 7 DAY"));
        }
        assert_eq!(count_users_in_delete_sql(&sql[0]), DELETE_CHUNK_SIZE);
        assert_eq!(count_users_in_delete_sql(&sql[1]), 5);
        assert_eq!(count_users_in_delete_sql(&sql[2]), 3);
    }
}
