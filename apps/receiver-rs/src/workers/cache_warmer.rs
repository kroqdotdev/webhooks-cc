use std::time::Duration;
use tokio::sync::watch;

use crate::convex::client::ConvexClient;
use crate::redis::RedisState;

const WARM_INTERVAL: Duration = Duration::from_secs(5);
const ENDPOINT_TTL_REFRESH_THRESHOLD: i64 = 10; // seconds remaining
const QUOTA_TTL_REFRESH_THRESHOLD: i64 = 5; // seconds remaining
const MAX_CONCURRENT_WARMS: usize = 8;

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
    // Skip warming if Convex is unreachable — avoid wasted Redis TTL checks
    if convex.circuit().is_degraded().await {
        return;
    }

    let slugs = redis.active_slugs().await;

    // Collect slugs that need refreshing, then warm concurrently
    let mut tasks = tokio::task::JoinSet::new();

    for slug in slugs {
        let needs_endpoint = match redis.endpoint_ttl(&slug).await {
            Some(ttl) => ttl < ENDPOINT_TTL_REFRESH_THRESHOLD,
            None => false,
        };
        let needs_quota = match redis.quota_ttl(&slug).await {
            Some(ttl) => ttl < QUOTA_TTL_REFRESH_THRESHOLD,
            None => false,
        };

        if !needs_endpoint && !needs_quota {
            continue;
        }

        // Bound concurrency to avoid overwhelming Convex
        if tasks.len() >= MAX_CONCURRENT_WARMS {
            tasks.join_next().await;
        }

        let convex = convex.clone();
        let slug = slug.clone();
        tasks.spawn(async move {
            if needs_endpoint {
                tracing::debug!(slug, "proactively refreshing endpoint cache");
                if let Err(e) = convex.fetch_and_cache_endpoint(&slug).await {
                    tracing::warn!(slug, error = %e, "cache warmer endpoint fetch failed");
                }
            }
            if needs_quota {
                tracing::debug!(slug, "proactively refreshing quota cache");
                if let Err(e) = convex.fetch_and_cache_quota(&slug).await {
                    tracing::warn!(slug, error = %e, "cache warmer quota fetch failed");
                }
            }
        });
    }

    // Drain remaining tasks
    while tasks.join_next().await.is_some() {}
}
