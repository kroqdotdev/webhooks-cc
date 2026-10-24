//! Capture-path counts.
//!
//! Each call adds one to a counter named by a fixed label. Once a minute,
//! when anything was counted, `spawn_reporter` writes one `counts` log line
//! with the totals since the last one and resets them, so StatOSS (and the
//! log file) can show how captures went without a line per request.
//!
//! Every label is a `&'static str` from a small fixed set, never a value read
//! from the database or the request, so the line stays short.

use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

static COUNTS: LazyLock<Counts> = LazyLock::new(Counts::default);

/// Counts since the last report, keyed by (group, label).
#[derive(Default)]
struct Counts(Mutex<BTreeMap<(&'static str, &'static str), u64>>);

impl Counts {
    fn add(&self, group: &'static str, label: &'static str) {
        let mut counts = self.0.lock().unwrap_or_else(|e| e.into_inner());
        *counts.entry((group, label)).or_insert(0) += 1;
    }

    /// The counts as `group.label=n` pairs, and resets them. Log lines the
    /// StatOSS throttle held back are added as `statoss.held_back`. Empty
    /// when nothing happened.
    fn take_line(&self, held_back: u64) -> String {
        let counts = std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()));
        let mut parts: Vec<String> = counts
            .into_iter()
            .map(|((group, label), n)| format!("{group}.{label}={n}"))
            .collect();
        if held_back > 0 {
            parts.push(format!("statoss.held_back={held_back}"));
        }
        parts.join(" ")
    }
}

fn add(group: &'static str, label: &'static str) {
    COUNTS.add(group, label);
}

/// Record the status returned by `capture_webhook()`: ok, not_found,
/// expired, quota_exceeded or unknown.
pub fn capture_result(status: &'static str) {
    add("capture", status);
}

/// Record a capture that did not complete. `kind` is one of
/// `transient`, `permanent`, `account_busy`, `parse`, `unknown_status`.
pub fn capture_failed(kind: &'static str) {
    add("capture_failed", kind);
}

/// Record one mail ingest outcome, such as `check_ok`, `check_unknown`,
/// `captured`, `duplicate`, `over_quota` or `transient`.
pub fn mail_ingest(outcome: &'static str) {
    add("mail", outcome);
}

/// Writes the counts line every `period` while anything was counted.
pub fn spawn_reporter(period: Duration) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            interval.tick().await;
            let line = COUNTS.take_line(crate::observability::take_held_back());
            if !line.is_empty() {
                tracing::info!(counts = %line, "counts");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_sums_by_label_and_resets() {
        let counts = Counts::default();
        counts.add("capture", "ok");
        counts.add("capture", "ok");
        counts.add("capture_failed", "transient");
        counts.add("mail", "captured");
        assert_eq!(
            counts.take_line(3),
            "capture.ok=2 capture_failed.transient=1 mail.captured=1 statoss.held_back=3"
        );
        assert_eq!(counts.take_line(0), "");
        assert_eq!(counts.take_line(2), "statoss.held_back=2");
    }

    #[test]
    fn recording_is_safe_from_any_thread() {
        capture_result("ok");
        capture_failed("permanent");
        mail_ingest("transient");
    }
}
