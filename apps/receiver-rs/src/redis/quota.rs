use redis::AsyncCommands;

use super::RedisState;

const SLUG_PREFIX: &str = "quota:";
const USER_PREFIX: &str = "quota:user:";

/// Lua script to atomically set user quota only if the key doesn't exist yet.
/// Prevents TOCTOU race between EXISTS and HSET.
const SET_QUOTA_IF_NOT_EXISTS: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'remaining', ARGV[1], 'limit', ARGV[2],
           'periodEnd', ARGV[3], 'isUnlimited', ARGV[4], 'userId', ARGV[5])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
return 1
"#;

/// Result of an atomic quota check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuotaResult {
    /// Request is allowed.
    Allowed,
    /// Quota exceeded.
    Exceeded,
    /// No cached quota data — caller should block-fetch from Convex and re-check.
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
            _ => QuotaResult::NotFound, // Redis error -> triggers blocking Convex fetch
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

            // Atomically set quota only if the key doesn't exist yet.
            // First endpoint to warm wins — avoids overwriting decremented values.
            let result: Result<i64, _> = redis::Script::new(SET_QUOTA_IF_NOT_EXISTS)
                .key(&user_key)
                .arg(remaining)
                .arg(limit)
                .arg(period_end)
                .arg(unlimited_str)
                .arg(user_id)
                .arg(self.quota_ttl_secs)
                .invoke_async(&mut conn)
                .await;

            if let Err(e) = result {
                tracing::warn!(slug, user_id, error = %e, "failed to set user quota in Redis");
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
            // Ephemeral endpoint: per-slug quota.
            // Use set-if-not-exists to prevent concurrent cold-cache requests
            // from overwriting each other's decremented values.
            let slug_key = format!("{SLUG_PREFIX}{slug}");
            let result: Result<i64, _> = redis::Script::new(SET_QUOTA_IF_NOT_EXISTS)
                .key(&slug_key)
                .arg(remaining)
                .arg(limit)
                .arg(period_end)
                .arg(unlimited_str)
                .arg("") // empty userId for ephemeral
                .arg(self.quota_ttl_secs)
                .invoke_async(&mut conn)
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
        if ttl < 0 { None } else { Some(ttl) }
    }

    /// Evict cached quota data for a slug (and its user key if mapped).
    pub async fn evict_quota(&self, slug: &str) {
        let mut conn = self.conn.clone();
        let slug_key = format!("{SLUG_PREFIX}{slug}");

        // Check if there's a user-level key to also evict
        let user_id: Option<String> = conn.hget(&slug_key, "userId").await.ok().flatten();

        let _: Result<(), _> = conn.del(&slug_key).await;

        if let Some(uid) = user_id
            && !uid.is_empty()
        {
            let user_key = format!("{USER_PREFIX}{uid}");
            let _: Result<(), _> = conn.del(&user_key).await;
        }
    }
}
