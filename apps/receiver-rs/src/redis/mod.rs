pub mod dedup;
pub mod endpoint_cache;
pub mod quota;
pub mod request_buffer;

use redis::aio::ConnectionManager;

/// Shared Redis state passed to handlers via Axum State.
#[derive(Clone)]
pub struct RedisState {
    pub conn: ConnectionManager,
    pub endpoint_ttl_secs: u64,
    pub quota_ttl_secs: u64,
}

impl RedisState {
    pub async fn new(
        redis_url: &str,
        endpoint_ttl_secs: u64,
        quota_ttl_secs: u64,
    ) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(redis_url)?;
        let conn = ConnectionManager::new(client).await?;
        Ok(Self {
            conn,
            endpoint_ttl_secs,
            quota_ttl_secs,
        })
    }
}
