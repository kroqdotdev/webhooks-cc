use std::time::Duration;
use tokio::sync::watch;

use crate::convex::client::ConvexClient;
use crate::redis::RedisState;

const WARM_INTERVAL: Duration = Duration::from_secs(5);
const ENDPOINT_TTL_REFRESH_THRESHOLD: i64 = 10; // seconds remaining
const QUOTA_TTL_REFRESH_THRESHOLD: i64 = 5; // seconds remaining

/// Spawn a background task that proactively refreshes caches for active slugs.
pub fn spawn_cache_warmer(
    redis: RedisState,
    convex: ConvexClient,
    mut shutdown: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        tracing::info!("cache warmer started");

        loop {
            if *shutdown.borrow() {
                tracing::info!("cache warmer shutting down");
                return;
            }

            warm_caches(&redis, &convex).await;

            tokio::select! {
                _ = tokio::time::sleep(WARM_INTERVAL) => {}
                _ = shutdown.changed() => {}
            }
        }
    });
}

async fn warm_caches(redis: &RedisState, convex: &ConvexClient) {
    let slugs = redis.active_slugs().await;

    for slug in &slugs {
        // Check endpoint cache TTL
        if let Some(ttl) = redis.endpoint_ttl(slug).await
            && ttl < ENDPOINT_TTL_REFRESH_THRESHOLD {
                tracing::debug!(slug, ttl, "proactively refreshing endpoint cache");
                if let Err(e) = convex.fetch_and_cache_endpoint(slug).await {
                    tracing::warn!(slug, error = %e, "cache warmer endpoint fetch failed");
                }
            }

        // Check quota cache TTL
        if let Some(ttl) = redis.quota_ttl(slug).await
            && ttl < QUOTA_TTL_REFRESH_THRESHOLD {
                tracing::debug!(slug, ttl, "proactively refreshing quota cache");
                if let Err(e) = convex.fetch_and_cache_quota(slug).await {
                    tracing::warn!(slug, error = %e, "cache warmer quota fetch failed");
                }
            }
    }
}
