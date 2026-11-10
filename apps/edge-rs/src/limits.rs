//! Limits that keep one share from swamping the laptop it runs on, or the
//! home line the edge sits on: requests a second per share and per visitor,
//! and streams in flight per visitor and per account. A dev server's page
//! load is a burst of a few hundred requests, so the buckets are deep and
//! refill quickly. A visitor is an IPv4 address or an IPv6 /56 (main.rs).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Requests a second a share sustains, and the burst it may spend at once.
const SHARE_RATE: f64 = 50.0;
const SHARE_BURST: f64 = 500.0;
/// The same for one visitor (one address) on one share, so a single
/// visitor cannot spend the whole share's allowance.
const VISITOR_RATE: f64 = 25.0;
const VISITOR_BURST: f64 = 300.0;
/// Requests in flight and open WebSockets, across an account's shares.
pub const ACCOUNT_STREAMS: usize = 256;
/// The same for one visitor on one share, so a single visitor holding
/// idle connections cannot use up the account's.
const VISITOR_STREAMS: usize = 64;
/// Of those, the WebSockets one visitor may hold open: a page needs one or
/// two (live reload), and a socket stays open, unlike a request.
const VISITOR_SOCKETS: usize = 16;
/// Phishing reports from badge.js (inject.rs) one visitor may send a share:
/// a few, then one a minute. Each makes the edge read a title.
const FLAG_RATE: f64 = 1.0 / 60.0;
const FLAG_BURST: f64 = 5.0;
/// How often the CLI hears that visitors are being turned away.
const WARN_EVERY: Duration = Duration::from_secs(30);
/// Visitors remembered per share before the idle ones are forgotten.
const VISITORS_KEPT: usize = 10_000;
/// Password tries (password page): ten a visitor, then one a minute; a
/// hundred a share, then one every six seconds, so many addresses together
/// cannot guess either.
const TRY_VISITOR_RATE: f64 = 1.0 / 60.0;
const TRY_VISITOR_BURST: f64 = 10.0;
const TRY_SHARE_RATE: f64 = 1.0 / 6.0;
const TRY_SHARE_BURST: f64 = 100.0;

/// A bucket of tokens: a burst at once, then a rate.
#[derive(Debug)]
pub(crate) struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    pub(crate) fn full(burst: f64, now: Instant) -> Self {
        Self {
            tokens: burst,
            at: now,
        }
    }

    fn refill(&mut self, rate: f64, burst: f64, now: Instant) {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.tokens = (self.tokens + elapsed * rate).min(burst);
        self.at = now;
    }

    /// Takes one token, if there is one.
    pub(crate) fn take(&mut self, rate: f64, burst: f64, now: Instant) -> bool {
        self.refill(rate, burst, now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Whether it would be full by now, so forgetting it changes nothing.
    pub(crate) fn idle(&self, rate: f64, burst: f64, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.tokens + elapsed * rate >= burst
    }
}

/// Tunnel connections a network may open: a CLI reconnects with a growing
/// wait, so this only stops a flood (each try costs the web app a lookup).
const CONNECT_RATE: f64 = 0.5;
const CONNECT_BURST: f64 = 20.0;

/// Buckets for `/v1/connect`, by network.
#[derive(Debug, Default)]
pub struct ConnectLimits(Mutex<HashMap<String, Bucket>>);

impl ConnectLimits {
    pub fn allow(&self, network: &str, now: Instant) -> bool {
        let mut buckets = self.0.lock().unwrap();
        if buckets.len() >= VISITORS_KEPT {
            buckets.retain(|_, b| !b.idle(CONNECT_RATE, CONNECT_BURST, now));
        }
        buckets
            .entry(network.to_string())
            .or_insert_with(|| Bucket::full(CONNECT_BURST, now))
            .take(CONNECT_RATE, CONNECT_BURST, now)
    }
}

/// One share's buckets.
#[derive(Debug)]
pub struct ShareLimits {
    share: Mutex<Bucket>,
    visitors: Mutex<HashMap<String, Bucket>>,
    tries: Mutex<Bucket>,
    visitor_tries: Mutex<HashMap<String, Bucket>>,
    visitor_streams: Mutex<HashMap<String, Arc<Streams>>>,
    visitor_sockets: Mutex<HashMap<String, Arc<Streams>>>,
    flags: Mutex<HashMap<String, Bucket>>,
    warned: Mutex<Option<Instant>>,
    blocked_warned: Mutex<Option<Instant>>,
    over_warned: Mutex<Option<Instant>>,
    debugger_warned: AtomicBool,
}

/// Whether `at` was long enough ago to say something again, marking now.
fn due(at: &Mutex<Option<Instant>>, now: Instant) -> bool {
    let mut at = at.lock().unwrap();
    if at.is_some_and(|t| now.saturating_duration_since(t) < WARN_EVERY) {
        return false;
    }
    *at = Some(now);
    true
}

impl ShareLimits {
    pub fn new(now: Instant) -> Self {
        Self {
            share: Mutex::new(Bucket::full(SHARE_BURST, now)),
            visitors: Mutex::new(HashMap::new()),
            tries: Mutex::new(Bucket::full(TRY_SHARE_BURST, now)),
            visitor_tries: Mutex::new(HashMap::new()),
            visitor_streams: Mutex::new(HashMap::new()),
            visitor_sockets: Mutex::new(HashMap::new()),
            flags: Mutex::new(HashMap::new()),
            warned: Mutex::new(None),
            blocked_warned: Mutex::new(None),
            over_warned: Mutex::new(None),
            debugger_warned: AtomicBool::new(false),
        }
    }

    /// Counts one more stream for this visitor, unless they hold the most.
    pub fn enter_visitor(&self, visitor: &str) -> Option<StreamGuard> {
        let streams = {
            let mut all = self.visitor_streams.lock().unwrap();
            if all.len() >= VISITORS_KEPT {
                all.retain(|_, s| s.count() > 0);
            }
            all.entry(visitor.to_string()).or_default().clone()
        };
        streams.enter(VISITOR_STREAMS)
    }

    /// Counts one more WebSocket for this visitor, unless they hold
    /// [`VISITOR_SOCKETS`]. Held as well as the stream, for as long as the
    /// socket is open.
    pub fn enter_socket(&self, visitor: &str) -> Option<StreamGuard> {
        let sockets = {
            let mut all = self.visitor_sockets.lock().unwrap();
            if all.len() >= VISITORS_KEPT {
                all.retain(|_, s| s.count() > 0);
            }
            all.entry(visitor.to_string()).or_default().clone()
        };
        sockets.enter(VISITOR_SOCKETS)
    }

    /// Whether this visitor may send a phishing report now, counting it.
    pub fn try_flag(&self, visitor: &str, now: Instant) -> bool {
        let mut visitors = self.flags.lock().unwrap();
        if visitors.len() >= VISITORS_KEPT {
            visitors.retain(|_, b| !b.idle(FLAG_RATE, FLAG_BURST, now));
        }
        visitors
            .entry(visitor.to_string())
            .or_insert_with(|| Bucket::full(FLAG_BURST, now))
            .take(FLAG_RATE, FLAG_BURST, now)
    }

    /// Whether one more request from this visitor fits, counting it.
    pub fn allow(&self, visitor: &str, now: Instant) -> bool {
        {
            let mut visitors = self.visitors.lock().unwrap();
            if visitors.len() >= VISITORS_KEPT {
                visitors.retain(|_, b| !b.idle(VISITOR_RATE, VISITOR_BURST, now));
            }
            let bucket = visitors
                .entry(visitor.to_string())
                .or_insert_with(|| Bucket::full(VISITOR_BURST, now));
            if !bucket.take(VISITOR_RATE, VISITOR_BURST, now) {
                return false;
            }
        }
        self.share
            .lock()
            .unwrap()
            .take(SHARE_RATE, SHARE_BURST, now)
    }

    /// Whether this visitor may try a password now, counting the try.
    pub fn try_password(&self, visitor: &str, now: Instant) -> bool {
        {
            let mut visitors = self.visitor_tries.lock().unwrap();
            if visitors.len() >= VISITORS_KEPT {
                visitors.retain(|_, b| !b.idle(TRY_VISITOR_RATE, TRY_VISITOR_BURST, now));
            }
            let bucket = visitors
                .entry(visitor.to_string())
                .or_insert_with(|| Bucket::full(TRY_VISITOR_BURST, now));
            if !bucket.take(TRY_VISITOR_RATE, TRY_VISITOR_BURST, now) {
                return false;
            }
        }
        self.tries
            .lock()
            .unwrap()
            .take(TRY_SHARE_RATE, TRY_SHARE_BURST, now)
    }

    /// Whether to tell the CLI that visitors are being turned away: at most
    /// once every [`WARN_EVERY`].
    pub fn should_warn(&self, now: Instant) -> bool {
        due(&self.warned, now)
    }

    /// The same for responses kept from visitors (content.rs).
    pub fn should_warn_blocked(&self, now: Instant) -> bool {
        due(&self.blocked_warned, now)
    }

    /// The same for visitors turned away because the account's data for
    /// the month is used up (meter.rs).
    pub fn should_warn_over(&self, now: Instant) -> bool {
        due(&self.over_warned, now)
    }

    /// Whether to tell the CLI that a debugger was kept from visitors
    /// (debugger.rs): once, the first time. What to do about it does not
    /// change, and a traceback page alone asks for it several times.
    pub fn should_warn_debugger(&self) -> bool {
        !self.debugger_warned.swap(true, Ordering::Relaxed)
    }
}

/// An account's streams in flight, across its shares.
#[derive(Debug, Default)]
pub struct Streams(AtomicUsize);

/// One stream counted against its account until dropped.
#[derive(Debug)]
pub struct StreamGuard(Arc<Streams>);

impl Streams {
    /// Counts one more stream, unless the account is at `max`.
    pub fn enter(self: &Arc<Self>, max: usize) -> Option<StreamGuard> {
        let before = self.0.fetch_add(1, Ordering::SeqCst);
        if before >= max {
            self.0.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(StreamGuard(self.clone()))
    }

    pub fn count(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.0.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_load_burst_fits() {
        let now = Instant::now();
        let limits = ShareLimits::new(now);
        assert!((0..300).all(|_| limits.allow("203.0.113.7", now)));
    }

    #[test]
    fn one_visitor_cannot_spend_the_share() {
        let now = Instant::now();
        let limits = ShareLimits::new(now);
        let let_in = (0..1000)
            .filter(|_| limits.allow("203.0.113.7", now))
            .count();
        assert_eq!(let_in, VISITOR_BURST as usize);
        assert!(limits.allow("198.51.100.2", now), "others still get in");
    }

    #[test]
    fn the_share_has_a_ceiling() {
        let now = Instant::now();
        let limits = ShareLimits::new(now);
        let let_in = (0..1000)
            .filter(|i| limits.allow(&format!("visitor-{}", i % 10), now))
            .count();
        assert_eq!(let_in, SHARE_BURST as usize);
    }

    #[test]
    fn buckets_refill() {
        let now = Instant::now();
        let limits = ShareLimits::new(now);
        while limits.allow("203.0.113.7", now) {}
        assert!(!limits.allow("203.0.113.7", now));
        assert!(limits.allow("203.0.113.7", now + Duration::from_millis(100)));
    }

    #[test]
    fn connects_are_limited_per_network() {
        let now = Instant::now();
        let limits = ConnectLimits::default();
        let let_in = (0..100)
            .filter(|_| limits.allow("203.0.113.7", now))
            .count();
        assert_eq!(let_in, CONNECT_BURST as usize);
        assert!(limits.allow("198.51.100.2", now));
        assert!(limits.allow("203.0.113.7", now + Duration::from_secs(2)));
    }

    #[test]
    fn warnings_are_spaced_out() {
        let now = Instant::now();
        let limits = ShareLimits::new(now);
        assert!(limits.should_warn(now));
        assert!(!limits.should_warn(now + Duration::from_secs(5)));
        assert!(limits.should_warn(now + WARN_EVERY));
    }

    #[test]
    fn the_debugger_is_warned_about_once() {
        let limits = ShareLimits::new(Instant::now());
        assert!(limits.should_warn_debugger());
        assert!(!limits.should_warn_debugger());
        assert!(!limits.should_warn_debugger());
    }

    #[test]
    fn one_visitor_cannot_hold_every_stream() {
        let limits = ShareLimits::new(Instant::now());
        let held: Vec<_> = (0..VISITOR_STREAMS)
            .map(|_| limits.enter_visitor("203.0.113.7").unwrap())
            .collect();
        assert!(limits.enter_visitor("203.0.113.7").is_none());
        assert!(
            limits.enter_visitor("198.51.100.2").is_some(),
            "others still get in"
        );
        drop(held);
        assert!(limits.enter_visitor("203.0.113.7").is_some());
    }

    #[test]
    fn streams_stop_at_the_ceiling_and_free_up() {
        let streams = Arc::new(Streams::default());
        let held: Vec<_> = (0..3).map(|_| streams.enter(3).unwrap()).collect();
        assert!(streams.enter(3).is_none());
        drop(held);
        assert_eq!(streams.count(), 0);
        assert!(streams.enter(3).is_some());
    }

    #[test]
    fn one_visitor_holds_a_few_sockets_at_most() {
        let limits = ShareLimits::new(Instant::now());
        let held: Vec<_> = (0..VISITOR_SOCKETS)
            .map(|_| limits.enter_socket("203.0.113.7").unwrap())
            .collect();
        assert!(limits.enter_socket("203.0.113.7").is_none());
        assert!(limits.enter_socket("198.51.100.2").is_some());
        drop(held);
        assert!(limits.enter_socket("203.0.113.7").is_some());
    }

    #[test]
    fn flags_are_limited_per_visitor() {
        let now = Instant::now();
        let limits = ShareLimits::new(now);
        let let_in = (0..20)
            .filter(|_| limits.try_flag("203.0.113.7", now))
            .count();
        assert_eq!(let_in, FLAG_BURST as usize);
        assert!(limits.try_flag("198.51.100.2", now));
        assert!(limits.try_flag("203.0.113.7", now + Duration::from_secs(61)));
    }
}
