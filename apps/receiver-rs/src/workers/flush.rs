use std::time::Duration;
use tokio::sync::watch;

use crate::convex::client::{ConvexClient, ConvexError};
use crate::redis::RedisState;

/// How long to sleep when the circuit breaker is open.
const CIRCUIT_OPEN_BACKOFF: Duration = Duration::from_secs(5);

/// Spawn N flush workers that drain Redis request buffers and POST to Convex.
pub fn spawn_flush_workers(
    redis: RedisState,
    convex: ConvexClient,
    worker_count: usize,
    batch_max_size: usize,
    flush_interval: Duration,
    shutdown: watch::Receiver<bool>,
) {
    for worker_id in 0..worker_count {
        let redis = redis.clone();
        let convex = convex.clone();
        let mut shutdown = shutdown.clone();

        tokio::spawn(async move {
            tracing::info!(worker_id, "flush worker started");

            loop {
                // Check for shutdown
                if *shutdown.borrow() {
                    // Final drain — skip if circuit is open (Convex unreachable,
                    // batches stay in Redis for next startup)
                    if !convex.circuit().is_degraded().await {
                        drain_pass(&redis, &convex, batch_max_size, worker_id, worker_count).await;
                    }
                    tracing::info!(worker_id, "flush worker shutting down");
                    return;
                }

                // Don't drain if circuit breaker is open — back off instead
                if convex.circuit().is_degraded().await {
                    tracing::debug!(worker_id, "circuit breaker open, backing off");
                    tokio::select! {
                        _ = tokio::time::sleep(CIRCUIT_OPEN_BACKOFF) => {}
                        _ = shutdown.changed() => {}
                    }
                    continue;
                }

                let did_work =
                    drain_pass(&redis, &convex, batch_max_size, worker_id, worker_count).await;

                if !did_work {
                    tokio::select! {
                        _ = tokio::time::sleep(flush_interval) => {}
                        _ = shutdown.changed() => {}
                    }
                }
            }
        });
    }

    // Drop the original receiver so workers can detect shutdown
    drop(shutdown);
}

/// Each worker processes a strided subset of shuffled slugs for fair distribution.
/// Worker 0 processes indices 0, 4, 8, ...; worker 1 processes 1, 5, 9, ...; etc.
async fn drain_pass(
    redis: &RedisState,
    convex: &ConvexClient,
    batch_max_size: usize,
    worker_id: usize,
    worker_count: usize,
) -> bool {
    let mut slugs = redis.active_slugs().await;
    if slugs.is_empty() {
        return false;
    }

    // Shuffle for fairness — each pass processes a random order
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::SystemTime;

    let seed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
        ^ (worker_id as u64);
    // Fisher-Yates shuffle with simple hash-based RNG
    let len = slugs.len();
    let mut h = DefaultHasher::new();
    seed.hash(&mut h);
    let mut rng_state = h.finish();
    for i in (1..len).rev() {
        rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let j = (rng_state >> 33) as usize % (i + 1);
        slugs.swap(i, j);
    }

    // Each worker takes a strided slice: worker_id, worker_id+count, worker_id+2*count, ...
    let mut did_work = false;

    let mut idx = worker_id;
    while idx < slugs.len() {
        let slug = &slugs[idx];
        idx += worker_count;

        let batch = redis.take_batch(slug, batch_max_size).await;

        if batch.is_empty() {
            redis.remove_active(slug).await;
            continue;
        }

        did_work = true;
        let batch_len = batch.len();

        match convex.capture_batch(slug, batch.clone()).await {
            Ok(resp) => {
                if !resp.error.is_empty() {
                    tracing::warn!(
                        slug,
                        error = resp.error,
                        "Convex capture_batch returned error"
                    );
                } else {
                    tracing::debug!(
                        slug,
                        inserted = resp.inserted,
                        "flushed batch to Convex"
                    );
                }
            }
            Err(ref e) => {
                // Only re-enqueue when CERTAIN Convex did not commit:
                // - CircuitOpen: request was never sent
                //
                // All other errors (ServerError, Network, ClientError) may
                // mean Convex committed but we didn't get the response.
                // Drop the batch to avoid duplicates (at-most-once delivery).
                if matches!(e, ConvexError::CircuitOpen) {
                    tracing::warn!(
                        slug,
                        count = batch_len,
                        "circuit open, re-enqueuing batch"
                    );
                    redis.requeue(slug, &batch).await;
                } else {
                    tracing::error!(
                        slug,
                        error = %e,
                        count = batch_len,
                        "batch capture failed, dropping batch (at-most-once)"
                    );
                }
            }
        }
    }

    did_work
}
