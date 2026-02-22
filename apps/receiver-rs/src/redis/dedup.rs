use sha2::{Digest, Sha256};

use super::RedisState;

/// Dedup TTL in seconds. Requests with the same fingerprint within this window
/// are considered duplicates (caused by Cloudflare edge retries / multi-path delivery).
/// 2 seconds is long enough to catch CF duplicates (sub-millisecond apart) while
/// short enough to not block legitimate identical requests.
const DEDUP_TTL_SECS: u64 = 2;

impl RedisState {
    /// Check whether this request is a duplicate. Returns `true` if the request
    /// should be processed (first seen), `false` if it's a duplicate.
    ///
    /// Uses Redis SET NX EX for atomic check-and-set with TTL.
    /// The fingerprint is: slug + method + path + body (first 512 bytes) + client IP.
    pub async fn check_dedup(
        &self,
        slug: &str,
        method: &str,
        path: &str,
        body: &[u8],
        client_ip: &str,
    ) -> bool {
        let mut hasher = Sha256::new();
        hasher.update(slug.as_bytes());
        hasher.update(b"|");
        hasher.update(method.as_bytes());
        hasher.update(b"|");
        hasher.update(path.as_bytes());
        hasher.update(b"|");
        // Use first 512 bytes of body to keep hashing fast while still
        // differentiating most payloads.
        let body_prefix = &body[..body.len().min(512)];
        hasher.update(body_prefix);
        hasher.update(b"|");
        hasher.update(client_ip.as_bytes());

        let hash_bytes = hasher.finalize();
        let hash: String = hash_bytes.iter().map(|b| format!("{b:02x}")).collect();
        let key = format!("dedup:{slug}:{hash}");

        let mut conn = self.conn.clone();
        // SET key "" NX EX 2 — returns true if key was set (first seen)
        let result: Result<bool, _> = redis::cmd("SET")
            .arg(&key)
            .arg("")
            .arg("NX")
            .arg("EX")
            .arg(DEDUP_TTL_SECS)
            .query_async(&mut conn)
            .await;

        match result {
            Ok(was_set) => was_set, // true = first time, false = duplicate
            Err(e) => {
                // On Redis error, allow the request through (fail open)
                tracing::warn!(slug, error = %e, "dedup check failed, allowing request");
                true
            }
        }
    }
}
