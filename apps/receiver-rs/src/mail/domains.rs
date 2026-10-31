//! The customers' verified inbound domains (migration 00072), kept in memory
//! so mail for any other domain is refused without a database query: relay
//! probes are common, and each would otherwise cost one.
//!
//! The set is read again when it is a minute old (INBOUND_DOMAINS_REFRESH_SECS),
//! so a domain verified in the web app receives mail within about a minute. When a read fails the
//! last set still says yes for the domains it lists; a domain it does not list
//! (perhaps verified since), or any domain with no set at all, is "unknown",
//! and the caller asks the sender to retry rather than bouncing mail for a
//! domain that may be a customer's. After a failed read the next second's
//! callers answer from the last set too, so a database that is down costs
//! one timeout a second, not one for every recipient waiting behind it.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::PgPool;
use tokio::sync::{Mutex, RwLock};

/// How long after a failed read callers answer from the last set without
/// trying the database again.
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(1);

pub struct InboundDomains {
    max_age: Duration,
    current: RwLock<Option<(Instant, Arc<HashSet<String>>)>>,
    /// One read at a time; the others wait for it and use its result. Holds
    /// when the last read failed, so those waiting behind it do not each
    /// try again.
    reading: Mutex<Option<Instant>>,
}

impl InboundDomains {
    pub fn new(max_age: Duration) -> Self {
        Self {
            max_age,
            current: RwLock::new(None),
            reading: Mutex::new(None),
        }
    }

    /// A set that is never read again (tests).
    #[cfg(test)]
    pub fn fixed(domains: &[&str]) -> Self {
        let set = domains.iter().map(|d| d.to_string()).collect();
        Self {
            max_age: Duration::from_secs(60),
            current: RwLock::new(Some((
                Instant::now() + Duration::from_secs(86_400),
                Arc::new(set),
            ))),
            reading: Mutex::new(None),
        }
    }

    async fn fresh(&self) -> Option<Arc<HashSet<String>>> {
        let current = self.current.read().await;
        match current.as_ref() {
            Some((at, set)) if at.elapsed() < self.max_age || *at > Instant::now() => {
                Some(set.clone())
            }
            _ => None,
        }
    }

    /// Whether `domain` (lowercase) is a verified customer domain; None when
    /// it cannot be known (never read, and the database is unreachable).
    pub async fn contains(&self, pool: &PgPool, domain: &str) -> Option<bool> {
        if let Some(set) = self.fresh().await {
            return Some(set.contains(domain));
        }
        let mut failed_at = self.reading.lock().await;
        // Read by another caller while this one waited.
        if let Some(set) = self.fresh().await {
            return Some(set.contains(domain));
        }
        if failed_at.is_some_and(|at| at.elapsed() < RETRY_AFTER_FAILURE) {
            return self.listed(domain).await;
        }
        let read: Result<Vec<String>, sqlx::Error> =
            sqlx::query_scalar("SELECT domain FROM inbound_domains WHERE status = 'verified'")
                .fetch_all(pool)
                .await;
        match read {
            Ok(domains) => {
                *failed_at = None;
                let set: Arc<HashSet<String>> = Arc::new(domains.into_iter().collect());
                let found = set.contains(domain);
                *self.current.write().await = Some((Instant::now(), set));
                Some(found)
            }
            Err(e) => {
                tracing::error!(error = %e, "reading the inbound domains failed");
                *failed_at = Some(Instant::now());
                self.listed(domain).await
            }
        }
    }

    /// The last set's answer when it cannot be read again: yes for a domain
    /// it lists, else unknown. A domain missing from it may have been
    /// verified since, so the sender tries again, never a permanent refusal.
    async fn listed(&self, domain: &str) -> Option<bool> {
        let current = self.current.read().await;
        current
            .as_ref()
            .and_then(|(_, set)| set.contains(domain).then_some(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn answers_from_a_fixed_set_without_the_database() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap();
        let domains = InboundDomains::fixed(&["inbound.acme.example"]);
        assert_eq!(
            domains.contains(&pool, "inbound.acme.example").await,
            Some(true)
        );
        assert_eq!(domains.contains(&pool, "example.com").await, Some(false));
    }

    #[tokio::test]
    async fn a_stale_set_only_vouches_for_the_domains_it_lists() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(200))
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap();
        let set: HashSet<String> = ["inbound.acme.example".to_string()].into_iter().collect();
        let domains = InboundDomains {
            max_age: Duration::from_secs(60),
            current: RwLock::new(Some((
                Instant::now() - Duration::from_secs(120),
                Arc::new(set),
            ))),
            reading: Mutex::new(None),
        };
        // The read fails: a listed domain still receives mail, one verified
        // since the last read is retried later, never refused for good.
        assert_eq!(
            domains.contains(&pool, "inbound.acme.example").await,
            Some(true)
        );
        assert_eq!(domains.contains(&pool, "new.acme.example").await, None);
    }

    #[tokio::test]
    async fn callers_after_a_failed_read_do_not_wait_for_another() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(300))
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap();
        let set: HashSet<String> = ["inbound.acme.example".to_string()].into_iter().collect();
        let domains = InboundDomains {
            max_age: Duration::from_secs(60),
            current: RwLock::new(Some((
                Instant::now() - Duration::from_secs(120),
                Arc::new(set),
            ))),
            reading: Mutex::new(None),
        };
        assert_eq!(domains.contains(&pool, "new.acme.example").await, None);
        // Within the next second the old set answers at once.
        let started = Instant::now();
        assert_eq!(
            domains.contains(&pool, "inbound.acme.example").await,
            Some(true)
        );
        assert_eq!(domains.contains(&pool, "new.acme.example").await, None);
        assert!(started.elapsed() < Duration::from_millis(150));
    }

    #[tokio::test]
    async fn does_not_know_when_it_was_never_read() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(200))
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap();
        assert_eq!(
            InboundDomains::new(Duration::from_secs(60))
                .contains(&pool, "example.com")
                .await,
            None
        );
    }
}
