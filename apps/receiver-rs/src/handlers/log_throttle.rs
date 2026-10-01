//! Per-key log sampling for high-frequency, low-value events.
//!
//! A sender that keeps posting after its quota runs out produced one
//! `quota exceeded` line per request, thousands a day from a single slug,
//! burying everything else in the journal. The metrics counter already counts
//! every rejection, so the log only needs one line per key per window, carrying
//! how many were suppressed since the previous line.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Window {
    started: Instant,
    suppressed: u64,
}

pub struct LogThrottle {
    window: Duration,
    max_keys: usize,
    state: Mutex<HashMap<String, Window>>,
}

impl LogThrottle {
    pub fn new(window: Duration, max_keys: usize) -> Self {
        Self {
            window,
            max_keys,
            state: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `Some(suppressed)` when the caller should log now, where
    /// `suppressed` is how many events for `key` were skipped since the last
    /// logged one. Returns `None` while the key's window is still open.
    pub fn check(&self, key: &str, now: Instant) -> Option<u64> {
        // A poisoned lock only means another thread panicked mid-update; the
        // map is still usable, and logging must never take the request down.
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());

        if let Some(entry) = state.get_mut(key) {
            if now.duration_since(entry.started) < self.window {
                entry.suppressed += 1;
                return None;
            }
            let suppressed = entry.suppressed;
            entry.started = now;
            entry.suppressed = 0;
            return Some(suppressed);
        }

        if state.len() >= self.max_keys {
            let window = self.window;
            state.retain(|_, entry| now.duration_since(entry.started) < window);
            if state.len() >= self.max_keys {
                // Still full of live keys: log unthrottled rather than grow
                // without bound. Only reachable with max_keys distinct
                // offenders inside one window.
                return Some(0);
            }
        }

        state.insert(
            key.to_owned(),
            Window {
                started: now,
                suppressed: 0,
            },
        );
        Some(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_secs(300);

    #[test]
    fn logs_first_event_then_suppresses_within_window() {
        let throttle = LogThrottle::new(WINDOW, 100);
        let t0 = Instant::now();

        assert_eq!(throttle.check("a", t0), Some(0));
        assert_eq!(throttle.check("a", t0 + Duration::from_secs(1)), None);
        assert_eq!(throttle.check("a", t0 + Duration::from_secs(299)), None);
    }

    #[test]
    fn reports_suppressed_count_when_window_reopens() {
        let throttle = LogThrottle::new(WINDOW, 100);
        let t0 = Instant::now();

        assert_eq!(throttle.check("a", t0), Some(0));
        for i in 1..=5 {
            assert_eq!(throttle.check("a", t0 + Duration::from_secs(i)), None);
        }
        assert_eq!(throttle.check("a", t0 + WINDOW), Some(5));
        assert_eq!(
            throttle.check("a", t0 + WINDOW + Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn keys_are_independent() {
        let throttle = LogThrottle::new(WINDOW, 100);
        let t0 = Instant::now();

        assert_eq!(throttle.check("a", t0), Some(0));
        assert_eq!(throttle.check("b", t0), Some(0));
        assert_eq!(throttle.check("a", t0), None);
    }

    #[test]
    fn evicts_expired_keys_when_full() {
        let throttle = LogThrottle::new(WINDOW, 2);
        let t0 = Instant::now();

        assert_eq!(throttle.check("a", t0), Some(0));
        assert_eq!(throttle.check("b", t0), Some(0));
        // Full of live keys: the newcomer logs but is not tracked.
        assert_eq!(throttle.check("c", t0), Some(0));
        assert_eq!(throttle.check("c", t0), Some(0));

        // Once a and b expire they are evicted and c is tracked again.
        let later = t0 + WINDOW;
        assert_eq!(throttle.check("c", later), Some(0));
        assert_eq!(throttle.check("c", later), None);
    }
}
