use redis::AsyncCommands;

use super::RedisState;
use crate::convex::types::EndpointInfo;

const KEY_PREFIX: &str = "ep:";

impl RedisState {
    /// Get cached endpoint info. Returns None on cache miss.
    pub async fn get_endpoint(&self, slug: &str) -> Option<EndpointInfo> {
        let key = format!("{KEY_PREFIX}{slug}");
        let mut conn = self.conn.clone();
        let data: Option<String> = conn.get(&key).await.ok()?;
        let json = data?;
        serde_json::from_str(&json).ok()
    }

    /// Cache endpoint info with TTL.
    pub async fn set_endpoint(&self, slug: &str, info: &EndpointInfo) {
        let key = format!("{KEY_PREFIX}{slug}");
        let Ok(json) = serde_json::to_string(info) else {
            return;
        };
        let mut conn = self.conn.clone();
        let _: Result<(), _> = conn.set_ex(&key, &json, self.endpoint_ttl_secs).await;
    }

    /// Evict cached endpoint info (called on cache invalidation).
    pub async fn evict_endpoint(&self, slug: &str) {
        let key = format!("{KEY_PREFIX}{slug}");
        let mut conn = self.conn.clone();
        let _: Result<(), _> = conn.del(&key).await;
    }

    /// Get the TTL remaining for an endpoint cache entry. Returns None if key doesn't exist.
    pub async fn endpoint_ttl(&self, slug: &str) -> Option<i64> {
        let key = format!("{KEY_PREFIX}{slug}");
        let mut conn = self.conn.clone();
        let ttl: i64 = conn.ttl(&key).await.ok()?;
        if ttl < 0 { None } else { Some(ttl) }
    }
}
