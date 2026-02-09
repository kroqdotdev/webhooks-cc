use redis::AsyncCommands;

use super::RedisState;

const SLUG_PREFIX: &str = "quota:";
const USER_PREFIX: &str = "quota:user:";

/// Result of an atomic quota check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuotaResult {
    /// Request is allowed.
    Allowed,
    /// Quota exceeded.
    Exceeded,
    /// No cached quota data — caller should warm the cache and fail-open.
    NotFound,
}

/// Lua script for atomic quota check + decrement.
/// Returns: 1 = allowed, 0 = denied, -1 = not found.
const QUOTA_CHECK_SCRIPT: &str = r#"
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then return -1 end

local isUnlimited = redis.call('HGET', KEYS[1], 'isUnlimited')
if isUnlimited == '1' then return 1 end

local remaining = tonumber(redis.call('HGET', KEYS[1], 'remaining'))
if remaining == nil then return -1 end
if remaining <= 0 then return 0 end

redis.call('HINCRBY', KEYS[1], 'remaining', -1)
return 1
"#;

impl RedisState {
    /// Atomically check and decrement quota.
    ///
    /// If user_id is provided, uses a per-user quota key (`quota:user:{userId}`).
    /// This ensures all endpoints for the same user share a single quota pool.
    /// For ephemeral endpoints (no userId), falls back to per-slug key.
    pub async fn check_quota(&self, slug: &str, user_id: Option<&str>) -> QuotaResult {
        let key = match user_id {
            Some(uid) if !uid.is_empty() => format!("{USER_PREFIX}{uid}"),
            _ => format!("{SLUG_PREFIX}{slug}"),
        };
        let mut conn = self.conn.clone();

        let result: Result<i64, _> = redis::Script::new(QUOTA_CHECK_SCRIPT)
            .key(&key)
            .invoke_async(&mut conn)
            .await;

        match result {
            Ok(1) => QuotaResult::Allowed,
            Ok(0) => QuotaResult::Exceeded,
            Ok(-1) => QuotaResult::NotFound,
            _ => QuotaResult::NotFound, // Redis error -> fail-open via NotFound
        }
    }

    /// Set quota data in Redis.
    ///
    /// If user_id is non-empty, stores under `quota:user:{userId}` (shared across endpoints).
    /// Also stores a slug-level pointer so cache warmer can resolve slugs to users.
    pub async fn set_quota(
        &self,
        slug: &str,
        remaining: i64,
        limit: i64,
        period_end: i64,
        is_unlimited: bool,
        user_id: &str,
    ) {
        let unlimited_str = if is_unlimited { "1" } else { "0" };
        let mut conn = self.conn.clone();

        if !user_id.is_empty() {
            // Per-user quota key (shared across all user's endpoints)
            let user_key = format!("{USER_PREFIX}{user_id}");

            // Only SET if the key doesn't exist yet (first endpoint to warm wins).
            // If it already exists, don't overwrite — another endpoint already set it
            // and concurrent requests may have already decremented.
            let exists: Result<bool, _> = conn.exists(&user_key).await;
            if matches!(exists, Ok(false)) {
                let result: Result<(), _> = redis::pipe()
                    .hset(&user_key, "remaining", remaining)
                    .ignore()
                    .hset(&user_key, "limit", limit)
                    .ignore()
                    .hset(&user_key, "periodEnd", period_end)
                    .ignore()
                    .hset(&user_key, "isUnlimited", unlimited_str)
                    .ignore()
                    .hset(&user_key, "userId", user_id)
                    .ignore()
                    .expire(&user_key, self.quota_ttl_secs as i64)
                    .ignore()
                    .query_async(&mut conn)
                    .await;

                if let Err(e) = result {
                    tracing::warn!(slug, user_id, error = %e, "failed to set user quota in Redis");
                }
            }

            // Store slug -> userId mapping for cache warmer lookups
            let slug_key = format!("{SLUG_PREFIX}{slug}");
            let _: Result<(), _> = redis::pipe()
                .hset(&slug_key, "userId", user_id)
                .ignore()
                .expire(&slug_key, self.quota_ttl_secs as i64)
                .ignore()
                .query_async(&mut conn)
                .await;
        } else {
            // Ephemeral endpoint: per-slug quota
            let slug_key = format!("{SLUG_PREFIX}{slug}");
            let result: Result<(), _> = redis::pipe()
                .hset(&slug_key, "remaining", remaining)
                .ignore()
                .hset(&slug_key, "limit", limit)
                .ignore()
                .hset(&slug_key, "periodEnd", period_end)
                .ignore()
                .hset(&slug_key, "isUnlimited", unlimited_str)
                .ignore()
                .hset(&slug_key, "userId", "")
                .ignore()
                .expire(&slug_key, self.quota_ttl_secs as i64)
                .ignore()
                .query_async(&mut conn)
                .await;

            if let Err(e) = result {
                tracing::warn!(slug, error = %e, "failed to set slug quota in Redis");
            }
        }
    }

    /// Get the TTL remaining for a quota cache entry.
    /// Checks user key first, then falls back to slug key.
    pub async fn quota_ttl(&self, slug: &str) -> Option<i64> {
        let mut conn = self.conn.clone();

        // Check if there's a slug -> userId mapping
        let slug_key = format!("{SLUG_PREFIX}{slug}");
        let user_id: Option<String> = conn.hget(&slug_key, "userId").await.ok().flatten();

        let key = match user_id {
            Some(ref uid) if !uid.is_empty() => format!("{USER_PREFIX}{uid}"),
            _ => slug_key,
        };

        let ttl: i64 = conn.ttl(&key).await.ok()?;
        if ttl < 0 {
            None
        } else {
            Some(ttl)
        }
    }
}
