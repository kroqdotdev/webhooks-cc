use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

use super::types::{ClickHouseRequest, ClickHouseResponseRow, SearchResultRequest};

/// Maximum response size from ClickHouse queries (10 MB).
const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024;

/// ClickHouse HTTP client for inserting and querying request data.
#[derive(Clone)]
pub struct ClickHouseClient {
    client: Client,
    base_url: String,
    user: String,
    password: String,
    database: String,
}

#[derive(Debug, Deserialize)]
struct ClickHouseJsonResponse {
    data: Vec<ClickHouseResponseRow>,
}

impl ClickHouseClient {
    pub fn new(base_url: &str, user: &str, password: &str, database: &str) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(4)
            .build()
            .expect("failed to build ClickHouse HTTP client");

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            user: user.to_string(),
            password: password.to_string(),
            database: database.to_string(),
        }
    }

    /// Insert a batch of requests into ClickHouse.
    /// Uses `INSERT INTO ... FORMAT JSONEachRow` for efficient bulk insert.
    pub async fn insert_requests(&self, requests: &[ClickHouseRequest]) -> Result<(), String> {
        if requests.is_empty() {
            return Ok(());
        }

        let query = format!("INSERT INTO {}.requests FORMAT JSONEachRow", self.database);

        // Build JSONEachRow body: one JSON object per line
        let mut body = String::with_capacity(requests.len() * 512);
        for req in requests {
            let line = serde_json::to_string(req).map_err(|e| format!("serialize: {e}"))?;
            body.push_str(&line);
            body.push('\n');
        }

        let resp = self
            .client
            .post(&self.base_url)
            .query(&[("query", &query)])
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("ClickHouse insert failed ({status}): {text}"));
        }

        Ok(())
    }

    /// Query requests from ClickHouse. Returns parsed search results.
    pub async fn query_requests(&self, sql: &str) -> Result<Vec<SearchResultRequest>, String> {
        let resp = self
            .client
            .post(&self.base_url)
            .query(&[("default_format", "JSON")])
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .header("Content-Type", "text/plain")
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("ClickHouse query failed ({status}): {text}"));
        }

        // Reject oversized responses early via Content-Length before buffering
        if let Some(cl) = resp.content_length()
            && cl > MAX_RESPONSE_SIZE as u64
        {
            return Err(format!(
                "ClickHouse response too large: Content-Length {cl} bytes (max {MAX_RESPONSE_SIZE})"
            ));
        }

        let body_bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("read response: {e}"))?;

        if body_bytes.len() > MAX_RESPONSE_SIZE {
            return Err(format!(
                "ClickHouse response too large: {} bytes (max {})",
                body_bytes.len(),
                MAX_RESPONSE_SIZE
            ));
        }

        let json_resp: ClickHouseJsonResponse =
            serde_json::from_slice(&body_bytes).map_err(|e| format!("parse response: {e}"))?;

        Ok(json_resp
            .data
            .iter()
            .map(SearchResultRequest::from_row)
            .collect())
    }

    /// Delete requests older than `retention_days` for the given user IDs.
    /// Executes a ClickHouse mutation (`ALTER TABLE ... DELETE WHERE ...`).
    pub async fn delete_old_requests_for_users(
        &self,
        user_ids: &[String],
        retention_days: u32,
    ) -> Result<(), String> {
        let Some(sql) = build_delete_sql(&self.database, user_ids, retention_days) else {
            return Ok(());
        };

        let resp = self
            .client
            .post(&self.base_url)
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .header("Content-Type", "text/plain")
            .body(sql)
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("ClickHouse delete failed ({status}): {text}"));
        }

        Ok(())
    }

    /// Check if ClickHouse is reachable (simple ping).
    pub async fn ping(&self) -> bool {
        self.client
            .get(format!("{}/ping", self.base_url))
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
    }
}

fn escape_clickhouse_string(input: &str) -> String {
    input.replace('\\', "\\\\").replace('\'', "\\'")
}

fn build_delete_sql(database: &str, user_ids: &[String], retention_days: u32) -> Option<String> {
    if user_ids.is_empty() {
        return None;
    }

    let user_list = user_ids
        .iter()
        .map(|user_id| format!("'{}'", escape_clickhouse_string(user_id)))
        .collect::<Vec<_>>()
        .join(", ");

    Some(format!(
        "ALTER TABLE {}.requests DELETE \
         WHERE user_id IN ({}) \
         AND received_at < now() - INTERVAL {} DAY",
        database, user_list, retention_days
    ))
}

#[cfg(test)]
mod tests {
    use super::build_delete_sql;

    #[test]
    fn build_delete_sql_returns_none_for_empty_user_list() {
        let sql = build_delete_sql("webhooks", &[], 7);
        assert!(sql.is_none());
    }

    #[test]
    fn build_delete_sql_includes_retention_and_escaped_user_ids() {
        let user_ids = vec!["user_plain".to_string(), "user'quoted\\slash".to_string()];
        let sql = build_delete_sql("webhooks", &user_ids, 7).expect("expected SQL");

        assert!(sql.contains("ALTER TABLE webhooks.requests DELETE"));
        assert!(sql.contains("user_id IN ('user_plain', 'user\\'quoted\\\\slash')"));
        assert!(sql.contains("INTERVAL 7 DAY"));
    }
}
