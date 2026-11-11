//! What the accept loops (main.rs, relay.rs, control.rs) do when an accept
//! fails, and the open-files limit raised at start-up.
//!
//! An accept fails at once and again while the process is out of file
//! descriptors (EMFILE, or ENFILE for the whole box): the connection stays
//! in the backlog, so a loop that only went on failed a million times a
//! second and wrote a line each time, while nothing could be served. So the
//! loop waits a moment before it tries again (longer when descriptors ran
//! out, since only closing connections brings them back), and says so at
//! most once a second, with how many it did not say. A connection the peer
//! gave up on before it was taken (aborted, reset) is no fault of ours and
//! is tried again at once, as hyper and axum do.

use std::io;
use std::time::{Duration, Instant};

/// Before trying again after an error that is not the peer's.
const PAUSE: Duration = Duration::from_millis(50);
/// Before trying again when descriptors ran out: connections have to close
/// first.
const PAUSE_OUT_OF_FILES: Duration = Duration::from_millis(250);
/// The most often a failing accept is written about.
const SAY_EVERY: Duration = Duration::from_secs(1);

/// How long to wait before accepting again after `e`.
pub fn pause_for(e: &io::Error) -> Duration {
    if is_connection_error(e) {
        Duration::ZERO
    } else if out_of_files(e) {
        PAUSE_OUT_OF_FILES
    } else {
        PAUSE
    }
}

/// The peer gave up on the connection before it was taken.
fn is_connection_error(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    )
}

/// The process (EMFILE) or the box (ENFILE) has no descriptor left.
fn out_of_files(e: &io::Error) -> bool {
    #[cfg(unix)]
    {
        matches!(e.raw_os_error(), Some(libc::EMFILE) | Some(libc::ENFILE))
    }
    #[cfg(not(unix))]
    {
        let _ = e;
        false
    }
}

/// One listener's failed accepts: when it last said so, and how many it
/// has not said since.
pub struct Failures {
    listener: &'static str,
    said: Option<Instant>,
    unsaid: u64,
}

impl Failures {
    pub fn new(listener: &'static str) -> Self {
        Self {
            listener,
            said: None,
            unsaid: 0,
        }
    }

    /// Whether to write about this failure now, and how many went unsaid
    /// before it.
    fn say_at(&mut self, now: Instant) -> Option<u64> {
        if self
            .said
            .is_some_and(|at| now.saturating_duration_since(at) < SAY_EVERY)
        {
            self.unsaid += 1;
            return None;
        }
        self.said = Some(now);
        Some(std::mem::take(&mut self.unsaid))
    }

    /// Notes a failed accept, at most one line a second, and waits as
    /// [`pause_for`] says before the loop tries again. Running out of
    /// descriptors is an error (it needs someone: the open-files limit or a
    /// flood); anything else a warning.
    pub async fn failed(&mut self, e: &io::Error) {
        if let Some(unsaid) = self.say_at(Instant::now()) {
            let listener = self.listener;
            if out_of_files(e) {
                tracing::error!(listener, error = %e, unsaid, "accept failed: out of file descriptors");
            } else if !is_connection_error(e) {
                tracing::warn!(listener, error = %e, unsaid, "accept failed");
            }
        }
        let pause = pause_for(e);
        if !pause.is_zero() {
            tokio::time::sleep(pause).await;
        }
    }
}

/// Raises the soft limit on open files to the hard one, as far as the
/// system lets it, and returns the soft limit in force. Every tunnel,
/// visitor request and visitor WebSocket is a descriptor, and Docker starts
/// a container at 1,024.
#[cfg(unix)]
pub fn raise_open_files() -> Option<u64> {
    // SAFETY: getrlimit and setrlimit only read and write the struct given.
    unsafe {
        let mut limit = std::mem::zeroed::<libc::rlimit>();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) != 0 {
            return None;
        }
        if limit.rlim_cur < limit.rlim_max {
            let raised = libc::rlimit {
                rlim_cur: limit.rlim_max,
                rlim_max: limit.rlim_max,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &raised) == 0 {
                limit = raised;
            }
        }
        Some(limit.rlim_cur as u64)
    }
}

#[cfg(not(unix))]
pub fn raise_open_files() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_out_of_files_waits_longest_and_a_peer_giving_up_not_at_all() {
        let out = io::Error::from_raw_os_error(libc::EMFILE);
        let box_out = io::Error::from_raw_os_error(libc::ENFILE);
        let other = io::Error::from_raw_os_error(libc::ENOBUFS);
        let aborted = io::Error::from(io::ErrorKind::ConnectionAborted);
        assert_eq!(pause_for(&out), PAUSE_OUT_OF_FILES);
        assert_eq!(pause_for(&box_out), PAUSE_OUT_OF_FILES);
        assert_eq!(pause_for(&other), PAUSE);
        assert_eq!(pause_for(&aborted), Duration::ZERO);
    }

    #[test]
    fn a_failing_accept_is_written_about_once_a_second() {
        let mut failures = Failures::new("test");
        let start = Instant::now();
        assert_eq!(failures.say_at(start), Some(0));
        for i in 1..1000 {
            assert_eq!(failures.say_at(start + Duration::from_micros(i)), None);
        }
        assert_eq!(failures.say_at(start + SAY_EVERY), Some(999));
        assert_eq!(failures.say_at(start + SAY_EVERY * 2), Some(0));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_accept_waits_before_the_next() {
        let mut failures = Failures::new("test");
        let started = tokio::time::Instant::now();
        failures
            .failed(&io::Error::from_raw_os_error(libc::EMFILE))
            .await;
        assert!(started.elapsed() >= PAUSE_OUT_OF_FILES);
    }

    #[test]
    fn the_open_files_limit_is_raised_to_the_hard_one() {
        let soft = raise_open_files().unwrap();
        // SAFETY: as in raise_open_files.
        let hard = unsafe {
            let mut limit = std::mem::zeroed::<libc::rlimit>();
            assert_eq!(libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit), 0);
            limit.rlim_max as u64
        };
        assert_eq!(soft, hard);
    }
}
