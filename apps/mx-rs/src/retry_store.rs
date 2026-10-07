//! Hashes of messages that may have been captured without the sender knowing.
//!
//! A sending server retries a message we answered with 4xx, or whose
//! connection broke before our final reply. The receiver may already have
//! stored it (a partial failure, a reply lost on the way back, a restart in
//! the middle of a delivery), so the next attempt is sent with `retry: true`,
//! and the receiver returns the stored copy instead of billing again.
//!
//! Each delivery is an attempt from `begin` to `finish`. An attempt is a
//! retry only when an earlier one left the outcome uncertain: answered with
//! 4xx, or its final reply could not be written. Attempts merely running at
//! the same time are not retries, so two deliberate sends of the same bytes
//! are both captured. A hash is forgotten once no attempt is running and none
//! left it uncertain.
//!
//! The key covers the message and its recipients: the receiver deduplicates
//! per endpoint, so an outcome for these bytes to one address must not settle
//! an attempt to another.
//!
//! The key is written to an append-only file when an attempt begins, so a
//! crash in the middle of a delivery leaves it behind; everything loaded at
//! startup counts as uncertain. Entries last eight days, longer than the retry
//! horizon of common SMTP queues.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use sha2::{Digest, Sha256};

pub const TTL: Duration = Duration::from_secs(8 * 24 * 60 * 60);
/// After this many appends, expired entries are dropped and the file is
/// rewritten, so memory and the file stay at about the live entries plus this.
const COMPACT_EVERY: usize = 1000;

pub struct RetryStore {
    ttl_secs: u64,
    path: Option<PathBuf>,
    inner: Mutex<Inner>,
}

struct Inner {
    entries: HashMap<String, Entry>,
    file: Option<File>,
    appended_since_rewrite: usize,
}

#[derive(Debug, Clone, Copy)]
struct Entry {
    /// Unix seconds.
    expiry: u64,
    /// Attempts between `begin` and `finish`.
    running: u32,
    /// An attempt ended without the sender learning a definitive answer.
    uncertain: bool,
}

/// One delivery attempt, from `begin` to `finish`.
#[derive(Debug)]
pub struct Attempt {
    hash: String,
    /// An earlier attempt left the outcome uncertain.
    pub retry: bool,
}

/// The store's key for one message to one set of recipients, regardless of
/// their order or case.
pub fn key(raw: &[u8], recipients: &[String]) -> String {
    let mut recipients: Vec<String> = recipients
        .iter()
        .map(|r| r.trim().to_ascii_lowercase())
        .collect();
    recipients.sort();
    recipients.dedup();
    let mut hasher = Sha256::new();
    hasher.update(Sha256::digest(raw));
    for recipient in &recipients {
        hasher.update(b"\n");
        hasher.update(recipient.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

impl RetryStore {
    /// An in-memory store, for tests and as the fallback when the file cannot
    /// be opened.
    pub fn in_memory(ttl: Duration) -> Self {
        Self {
            ttl_secs: ttl.as_secs(),
            path: None,
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                file: None,
                appended_since_rewrite: 0,
            }),
        }
    }

    /// Load `path` and keep appending to it. Lines are "hash expiry", applied
    /// in order: an expiry in the past (a forget writes 0) removes the hash.
    /// Unreadable lines are skipped rather than losing the rest of the file.
    pub fn open(path: PathBuf, ttl: Duration, now: u64) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut entries = HashMap::new();
        if let Ok(file) = File::open(&path) {
            for line in BufReader::new(file).split(b'\n') {
                let line = line?;
                let line = String::from_utf8_lossy(&line);
                let mut parts = line.split_whitespace();
                if let (Some(hash), Some(expiry)) = (parts.next(), parts.next())
                    && is_hash(hash)
                    && let Ok(expiry) = expiry.parse::<u64>()
                {
                    let hash = hash.to_ascii_lowercase();
                    if expiry > now {
                        // Whatever was running when the process stopped has
                        // an unknown outcome.
                        let entry = Entry {
                            expiry,
                            running: 0,
                            uncertain: true,
                        };
                        entries.insert(hash, entry);
                    } else {
                        entries.remove(&hash);
                    }
                }
            }
        }
        let store = Self {
            ttl_secs: ttl.as_secs(),
            path: Some(path),
            inner: Mutex::new(Inner {
                entries,
                file: None,
                appended_since_rewrite: 0,
            }),
        };
        {
            let mut inner = store.lock();
            store.rewrite(&mut inner)?;
        }
        Ok(store)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock only means another thread panicked mid-update; the
        // map is still usable, and mail must keep flowing.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Start delivering the message with this hash. Checking for an earlier
    /// uncertain attempt and recording this one happen under one lock.
    pub fn begin(&self, hash: &str, now: u64) -> Attempt {
        let expiry = now + self.ttl_secs;
        let mut inner = self.lock();
        let entry = inner.entries.entry(hash.to_string()).or_insert(Entry {
            expiry,
            running: 0,
            uncertain: false,
        });
        if entry.expiry <= now {
            entry.running = 0;
            entry.uncertain = false;
        }
        let retry = entry.uncertain;
        entry.running += 1;
        entry.expiry = expiry;
        self.append(&mut inner, hash, expiry, now);
        Attempt {
            hash: hash.to_string(),
            retry,
        }
    }

    /// End an attempt. `settled` means the sender has received a definitive
    /// answer (2xx or 5xx); anything else leaves the outcome uncertain, and
    /// the next attempt is a retry.
    pub fn finish(&self, attempt: Attempt, settled: bool, now: u64) {
        let mut inner = self.lock();
        let Some(entry) = inner.entries.get_mut(&attempt.hash) else {
            return;
        };
        entry.running = entry.running.saturating_sub(1);
        if !settled {
            entry.uncertain = true;
        } else if attempt.retry {
            // This retry resolved what the earlier attempt left open.
            entry.uncertain = false;
        }
        if entry.running == 0 && !entry.uncertain {
            inner.entries.remove(&attempt.hash);
            self.append(&mut inner, &attempt.hash, 0, now);
        }
    }

    /// Whether the hash is known at all (running or uncertain).
    #[cfg(test)]
    pub fn contains(&self, hash: &str, now: u64) -> bool {
        self.lock()
            .entries
            .get(hash)
            .is_some_and(|entry| entry.expiry > now)
    }

    fn append(&self, inner: &mut Inner, hash: &str, expiry: u64, now: u64) {
        if let Some(file) = inner.file.as_mut()
            && let Err(e) = writeln!(file, "{hash} {expiry}").and_then(|()| file.flush())
        {
            tracing::warn!(error = %e, "could not append to the retry store");
        }
        inner.appended_since_rewrite += 1;
        if inner.appended_since_rewrite >= COMPACT_EVERY {
            inner.entries.retain(|_, entry| entry.expiry > now);
            if let Err(e) = self.rewrite(inner) {
                tracing::warn!(error = %e, "could not compact the retry store");
            }
            inner.appended_since_rewrite = 0;
        }
    }

    pub fn len(&self) -> usize {
        self.lock().entries.len()
    }

    /// Write the live entries to a fresh file and swap it in. If the swapped
    /// file cannot be reopened, appends stop (memory keeps working) instead of
    /// going to an unlinked file.
    fn rewrite(&self, inner: &mut Inner) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let tmp = path.with_extension("tmp");
        {
            let mut out = File::create(&tmp)?;
            for (hash, entry) in &inner.entries {
                writeln!(out, "{hash} {}", entry.expiry)?;
            }
            out.sync_all()?;
        }
        fs::rename(&tmp, path)?;
        if let Some(dir) = path.parent()
            && let Ok(dir) = File::open(dir)
        {
            let _ = dir.sync_all();
        }
        match OpenOptions::new().append(true).open(path) {
            Ok(file) => {
                inner.file = Some(file);
                Ok(())
            }
            Err(e) => {
                inner.file = None;
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn hash(n: u8) -> String {
        format!("{:064x}", n)
    }

    /// A path inside a directory that is deleted when the guard drops.
    fn temp_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join("retry-hashes");
        (dir, path)
    }

    #[test]
    fn keys_cover_the_recipients_in_any_order_or_case() {
        let to = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let k = key(b"raw", &to(&["a@mailhooks.cc", "b@mailhooks.cc"]));
        assert!(is_hash(&k));
        assert_eq!(k, key(b"raw", &to(&["B@mailhooks.cc", "a@mailhooks.cc"])));
        assert_ne!(k, key(b"raw", &to(&["a@mailhooks.cc"])));
        assert_ne!(k, key(b"other", &to(&["a@mailhooks.cc", "b@mailhooks.cc"])));
    }

    #[test]
    fn keeps_hashes_for_eight_days() {
        assert_eq!(TTL.as_secs(), 8 * 86_400);
    }

    #[test]
    fn a_settled_attempt_leaves_nothing_behind() {
        let store = RetryStore::in_memory(TTL);
        let attempt = store.begin(&hash(1), NOW);
        assert!(!attempt.retry);
        assert!(store.contains(&hash(1), NOW), "recorded while running");
        store.finish(attempt, true, NOW);
        assert!(!store.contains(&hash(1), NOW));
        assert!(!store.begin(&hash(1), NOW).retry, "a later send is new");
    }

    #[test]
    fn an_unsettled_attempt_makes_the_next_one_a_retry_until_it_settles() {
        let store = RetryStore::in_memory(TTL);
        let first = store.begin(&hash(1), NOW);
        store.finish(first, false, NOW);
        let second = store.begin(&hash(1), NOW + 60);
        assert!(second.retry);
        store.finish(second, false, NOW + 60);
        let third = store.begin(&hash(1), NOW + 120);
        assert!(third.retry, "still uncertain after another 4xx");
        store.finish(third, true, NOW + 120);
        assert!(!store.contains(&hash(1), NOW + 120));
        assert!(!store.begin(&hash(1), NOW + 180).retry);
    }

    #[test]
    fn concurrent_attempts_are_not_retries() {
        let store = RetryStore::in_memory(TTL);
        let a = store.begin(&hash(1), NOW);
        let b = store.begin(&hash(1), NOW);
        assert!(!a.retry && !b.retry);
        store.finish(a, true, NOW);
        assert!(store.contains(&hash(1), NOW), "b is still running");
        store.finish(b, true, NOW);
        assert!(!store.contains(&hash(1), NOW));
    }

    #[test]
    fn one_unsettled_concurrent_attempt_keeps_the_hash() {
        let store = RetryStore::in_memory(TTL);
        let a = store.begin(&hash(1), NOW);
        let b = store.begin(&hash(1), NOW);
        store.finish(a, false, NOW);
        store.finish(b, true, NOW);
        assert!(
            store.begin(&hash(1), NOW).retry,
            "a's outcome is still unknown to its sender"
        );
    }

    #[test]
    fn uncertain_hashes_expire() {
        let store = RetryStore::in_memory(Duration::from_secs(100));
        let attempt = store.begin(&hash(1), NOW);
        store.finish(attempt, false, NOW);
        assert!(store.contains(&hash(1), NOW + 99));
        assert!(!store.contains(&hash(1), NOW + 100));
        assert!(!store.begin(&hash(1), NOW + 100).retry);
    }

    #[test]
    fn survives_a_restart_and_a_crash_mid_delivery() {
        let (_dir, path) = temp_path();
        {
            let store = RetryStore::open(path.clone(), TTL, NOW).unwrap();
            let deferred = store.begin(&hash(1), NOW);
            store.finish(deferred, false, NOW);
            let settled = store.begin(&hash(2), NOW);
            store.finish(settled, true, NOW);
            // Still running when the process dies.
            let _crashed = store.begin(&hash(3), NOW);
        }
        let store = RetryStore::open(path, TTL, NOW + 10).unwrap();
        assert!(store.begin(&hash(1), NOW + 10).retry);
        assert!(!store.contains(&hash(2), NOW + 10), "the forget survived");
        assert!(store.begin(&hash(3), NOW + 10).retry);
    }

    #[test]
    fn skips_malformed_and_non_utf8_lines() {
        let (_dir, path) = temp_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut content =
            format!("garbage\n{} notanumber\nshort 9999999999\n", hash(1)).into_bytes();
        content.extend_from_slice(b"\xff\xfe broken\n");
        content.extend_from_slice(format!("{} {}\n", hash(2), NOW + 50).as_bytes());
        fs::write(&path, content).unwrap();
        let store = RetryStore::open(path, TTL, NOW).unwrap();
        assert_eq!(store.len(), 1);
        assert!(store.contains(&hash(2), NOW));
    }

    #[test]
    fn compacts_the_file() {
        let (_dir, path) = temp_path();
        let store = RetryStore::open(path.clone(), Duration::from_secs(10), NOW).unwrap();
        // Entries that expire quickly: neither memory nor the file may grow
        // without bound.
        for i in 0..(3 * COMPACT_EVERY) {
            let now = NOW + 20 * i as u64;
            let attempt = store.begin(&format!("{:064x}", i), now);
            store.finish(attempt, false, now);
        }
        let lines = fs::read_to_string(&path).unwrap().lines().count();
        assert!(lines <= COMPACT_EVERY + 1, "{lines} lines");
        assert!(store.len() <= COMPACT_EVERY + 1, "{} entries", store.len());
    }
}
