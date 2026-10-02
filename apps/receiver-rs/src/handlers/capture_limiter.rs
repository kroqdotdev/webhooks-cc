//! Caps concurrent captures per billing account.
//!
//! Every capture updates the quota row of the account it bills (the user, the
//! team, or a guest endpoint), so captures for one account run one at a time
//! on that row lock. Without a cap, a burst to one account fills the whole
//! Postgres pool with captures waiting on that lock, and every other account
//! waits for a connection: measured locally, ten accounts fell from about
//! 1,400 to 83 captures/s while one account was flooded. Since one account's
//! captures are serialized anyway, a few in flight keep its row busy, and the
//! rest wait here without holding a connection.
//!
//! The account comes from the `billing_key` that `capture_webhook()` returns,
//! remembered per slug. For a slug not in the cache the handler asks
//! `capture_billing_key()` first, so a burst across fresh slugs of one account
//! still shares that account's cap; only if that lookup fails is the slug
//! capped on its own.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// How long a slug's billing key is trusted. Sharing an endpoint with a team
/// moves its billing; a stale key only affects fairness, never correctness.
const BILLING_KEY_TTL: Duration = Duration::from_secs(300);
/// Bounds on the two maps; past them, idle entries are dropped.
const MAX_SLUGS: usize = 50_000;
const MAX_KEYS: usize = 10_000;

pub struct CaptureLimiter {
    per_key: usize,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    billing_keys: HashMap<String, (String, Instant)>,
    slots: HashMap<String, Arc<Semaphore>>,
}

/// Held for the duration of one capture query.
pub struct CapturePermit {
    _permit: Option<OwnedSemaphorePermit>,
}

impl CaptureLimiter {
    /// `per_key` = 0 disables the cap.
    pub fn new(per_key: usize) -> Self {
        Self {
            per_key,
            state: Mutex::new(State::default()),
        }
    }

    /// The cached billing key for `slug`, if it is still fresh.
    pub fn cached_key(&self, slug: &str) -> Option<String> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match state.billing_keys.get(slug) {
            Some((key, seen)) if seen.elapsed() < BILLING_KEY_TTL => Some(key.clone()),
            _ => None,
        }
    }

    /// Key for a slug whose account could not be resolved.
    pub fn slug_key(slug: &str) -> String {
        format!("slug:{slug}")
    }

    /// Remember which account `slug` bills to.
    pub fn remember(&self, slug: &str, billing_key: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.billing_keys.len() >= MAX_SLUGS && !state.billing_keys.contains_key(slug) {
            state
                .billing_keys
                .retain(|_, (_, seen)| seen.elapsed() < BILLING_KEY_TTL);
            if state.billing_keys.len() >= MAX_SLUGS {
                state.billing_keys.clear();
            }
        }
        state
            .billing_keys
            .insert(slug.to_owned(), (billing_key.to_owned(), Instant::now()));
    }

    /// Waits up to `timeout` for a slot under `key`; `None` when it timed out.
    pub async fn acquire(&self, key: &str, timeout: Duration) -> Option<CapturePermit> {
        if self.per_key == 0 {
            return Some(CapturePermit { _permit: None });
        }
        let semaphore = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.slots.len() >= MAX_KEYS && !state.slots.contains_key(key) {
                // Drop idle keys: nobody holds or waits on them.
                state.slots.retain(|_, s| Arc::strong_count(s) > 1);
            }
            state
                .slots
                .entry(key.to_owned())
                .or_insert_with(|| Arc::new(Semaphore::new(self.per_key)))
                .clone()
        };
        match tokio::time::timeout(timeout, semaphore.acquire_owned()).await {
            Ok(Ok(permit)) => Some(CapturePermit {
                _permit: Some(permit),
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn caps_concurrent_permits_per_key() {
        let limiter = CaptureLimiter::new(2);
        let short = Duration::from_millis(20);
        let a = limiter.acquire("user:a", short).await;
        let b = limiter.acquire("user:a", short).await;
        assert!(a.is_some() && b.is_some());
        assert!(limiter.acquire("user:a", short).await.is_none());
        // Other accounts are unaffected.
        assert!(limiter.acquire("user:b", short).await.is_some());
        drop(a);
        assert!(limiter.acquire("user:a", short).await.is_some());
    }

    #[tokio::test]
    async fn zero_disables_the_cap() {
        let limiter = CaptureLimiter::new(0);
        let held: Vec<_> = acquire_many(&limiter, 50).await;
        assert!(held.iter().all(Option::is_some));
    }

    async fn acquire_many(limiter: &CaptureLimiter, n: usize) -> Vec<Option<CapturePermit>> {
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(limiter.acquire("user:a", Duration::from_millis(5)).await);
        }
        out
    }

    #[test]
    fn learns_the_billing_key_per_slug() {
        let limiter = CaptureLimiter::new(4);
        assert_eq!(limiter.cached_key("abc"), None);
        limiter.remember("abc", "team:t1");
        assert_eq!(limiter.cached_key("abc").as_deref(), Some("team:t1"));
        assert_eq!(limiter.cached_key("other"), None);
        assert_eq!(CaptureLimiter::slug_key("other"), "slug:other");
    }
}
