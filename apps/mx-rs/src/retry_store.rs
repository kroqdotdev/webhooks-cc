//! Hashes of messages that may have been captured without the sender knowing.
//!
//! A sending server retries a message we answered with 4xx, or whose
//! connection broke before our final reply. The receiver may already have
//! stored it (a partial failure, a reply lost on the way back, a restart in
//! the middle of a delivery), so the next attempt is sent with `retry: true`,
//! and the receiver returns the stored copy instead of billing again.
//!
//! A hash goes in before each delivery and stays when the answer is a
//! temporary failure; it is forgotten again only once a definitive answer
//! (2xx or 5xx) for a message that was not already a retry has been written
//! to the sender. It is kept for eight days, longer than the retry horizon of
//! common SMTP queues, in memory and in an append-only file so a restart or a
//! crash does not forget it.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

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
    /// Hash to expiry (unix seconds).
    entries: HashMap<String, u64>,
    file: Option<File>,
    appended_since_rewrite: usize,
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
                        entries.insert(hash, expiry);
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

    pub fn contains(&self, hash: &str, now: u64) -> bool {
        self.lock()
            .entries
            .get(hash)
            .is_some_and(|expiry| *expiry > now)
    }

    pub fn remember(&self, hash: &str, now: u64) {
        let expiry = now + self.ttl_secs;
        let mut inner = self.lock();
        inner.entries.insert(hash.to_string(), expiry);
        self.append(&mut inner, hash, expiry, now);
    }

    pub fn forget(&self, hash: &str, now: u64) {
        let mut inner = self.lock();
        if inner.entries.remove(hash).is_some() {
            self.append(&mut inner, hash, 0, now);
        }
    }

    fn append(&self, inner: &mut Inner, hash: &str, expiry: u64, now: u64) {
        if let Some(file) = inner.file.as_mut()
            && let Err(e) = writeln!(file, "{hash} {expiry}").and_then(|()| file.flush())
        {
            tracing::warn!(error = %e, "could not append to the retry store");
        }
        inner.appended_since_rewrite += 1;
        if inner.appended_since_rewrite >= COMPACT_EVERY {
            inner.entries.retain(|_, expiry| *expiry > now);
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
            for (hash, expiry) in &inner.entries {
                writeln!(out, "{hash} {expiry}")?;
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
    fn keeps_hashes_for_eight_days() {
        assert_eq!(TTL.as_secs(), 8 * 86_400);
    }

    #[test]
    fn remembers_until_the_ttl_runs_out() {
        let store = RetryStore::in_memory(Duration::from_secs(100));
        store.remember(&hash(1), NOW);
        assert!(store.contains(&hash(1), NOW + 99));
        assert!(!store.contains(&hash(1), NOW + 100));
        assert!(!store.contains(&hash(2), NOW));
    }

    #[test]
    fn forgets_on_request() {
        let store = RetryStore::in_memory(TTL);
        store.remember(&hash(1), NOW);
        store.forget(&hash(1), NOW);
        assert!(!store.contains(&hash(1), NOW));
        store.forget(&hash(2), NOW); // unknown: nothing happens
    }

    #[test]
    fn survives_a_restart_including_forgets() {
        let (_dir, path) = temp_path();
        {
            let store = RetryStore::open(path.clone(), TTL, NOW).unwrap();
            store.remember(&hash(1), NOW);
            store.remember(&hash(2), NOW - TTL.as_secs()); // already expired
            store.remember(&hash(3), NOW);
            store.forget(&hash(3), NOW);
        }
        let store = RetryStore::open(path, TTL, NOW + 10).unwrap();
        assert!(store.contains(&hash(1), NOW + 10));
        assert!(!store.contains(&hash(2), NOW + 10));
        assert!(!store.contains(&hash(3), NOW + 10), "the forget survived");
        assert_eq!(store.len(), 1);
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
            store.remember(&format!("{:064x}", i), NOW + 20 * i as u64);
        }
        let lines = fs::read_to_string(&path).unwrap().lines().count();
        assert!(lines <= COMPACT_EVERY + 1, "{lines} lines");
        assert!(store.len() <= COMPACT_EVERY + 1, "{} entries", store.len());
    }
}
