use redis::AsyncCommands;

use super::RedisState;
use crate::convex::types::BufferedRequest;

const BUF_PREFIX: &str = "buf:";
const ACTIVE_SET: &str = "buf:active";

/// Lua script to atomically take up to N items from the tail of a list.
/// Returns the items taken (FIFO order: oldest first).
const BATCH_TAKE_SCRIPT: &str = r#"
local count = tonumber(ARGV[1])
local len = redis.call('LLEN', KEYS[1])
if len == 0 then return {} end
local take = math.min(count, len)
local items = redis.call('LRANGE', KEYS[1], -take, -1)
if take >= len then
    redis.call('DEL', KEYS[1])
else
    redis.call('LTRIM', KEYS[1], 0, len - take - 1)
end
return items
"#;

impl RedisState {
    /// Push a buffered request and mark the slug as active.
    pub async fn push_request(&self, slug: &str, req: &BufferedRequest) {
        let key = format!("{BUF_PREFIX}{slug}");
        let Ok(json) = serde_json::to_string(req) else {
            tracing::warn!(slug, "failed to serialize buffered request");
            return;
        };

        let mut conn = self.conn.clone();
        let result: Result<(), _> = redis::pipe()
            .lpush(&key, &json)
            .ignore()
            .sadd(ACTIVE_SET, slug)
            .ignore()
            .query_async(&mut conn)
            .await;

        if let Err(e) = result {
            tracing::warn!(slug, error = %e, "failed to push request to Redis buffer");
        }
    }

    /// Get all slugs that have pending buffered requests.
    /// Uses SSCAN to iterate in batches, avoiding unbounded SMEMBERS on large sets.
    pub async fn active_slugs(&self) -> Vec<String> {
        let mut conn = self.conn.clone();
        let mut slugs = Vec::new();
        let mut cursor: u64 = 0;
        const SCAN_COUNT: usize = 500;

        loop {
            let result: Result<(u64, Vec<String>), _> = redis::cmd("SSCAN")
                .arg(ACTIVE_SET)
                .arg(cursor)
                .arg("COUNT")
                .arg(SCAN_COUNT)
                .query_async(&mut conn)
                .await;

            match result {
                Ok((next_cursor, batch)) => {
                    slugs.extend(batch);
                    cursor = next_cursor;
                    if cursor == 0 {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "SSCAN failed on active slugs set");
                    break;
                }
            }
        }

        slugs
    }

    /// Atomically take up to `max` requests from a slug's buffer.
    /// Returns deserialized requests in FIFO order.
    pub async fn take_batch(&self, slug: &str, max: usize) -> Vec<BufferedRequest> {
        let key = format!("{BUF_PREFIX}{slug}");
        let mut conn = self.conn.clone();

        let result: Result<Vec<String>, _> = redis::Script::new(BATCH_TAKE_SCRIPT)
            .key(&key)
            .arg(max)
            .invoke_async(&mut conn)
            .await;

        match result {
            Ok(items) => items
                .iter()
                .filter_map(|s| serde_json::from_str(s).ok())
                .collect(),
            Err(e) => {
                tracing::warn!(slug, error = %e, "failed to take batch from Redis");
                Vec::new()
            }
        }
    }

    /// Remove a slug from the active set (when its buffer is empty).
    pub async fn remove_active(&self, slug: &str) {
        let mut conn = self.conn.clone();
        let _: Result<(), _> = conn.srem(ACTIVE_SET, slug).await;
    }

    /// Re-enqueue requests that failed to flush (push back to tail for retry).
    /// Uses a pipeline so the re-enqueue is all-or-nothing.
    pub async fn requeue(&self, slug: &str, requests: &[BufferedRequest]) {
        let key = format!("{BUF_PREFIX}{slug}");
        let mut conn = self.conn.clone();
        let mut pipe = redis::pipe();

        for req in requests {
            let Ok(json) = serde_json::to_string(req) else {
                continue;
            };
            pipe.rpush(&key, json).ignore();
        }
        pipe.sadd(ACTIVE_SET, slug).ignore();

        let _: Result<(), _> = pipe.query_async(&mut conn).await;
    }

    /// Get the length of a slug's request buffer.
    pub async fn buffer_len(&self, slug: &str) -> usize {
        let key = format!("{BUF_PREFIX}{slug}");
        let mut conn = self.conn.clone();
        let len: Result<usize, _> = conn.llen(&key).await;
        len.unwrap_or(0)
    }
}
