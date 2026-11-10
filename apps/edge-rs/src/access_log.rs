//! The access log for previews: one JSON line per request to a preview, so
//! a phishing or abuse case can be looked into afterwards (what an address
//! served, when, how often, and to whom). It is our own record, kept
//! [`KEEP_DAYS`] days and then deleted, as the privacy page says.
//!
//! One file a day (UTC), `access-2026-10-02.jsonl`, in `ACCESS_LOG_DIR`;
//! without that setting (development) nothing is written. A thread of its
//! own writes them, so a slow disk never holds up a visitor: when it falls
//! behind, lines are dropped and counted rather than queued without end.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use http::{HeaderMap, Request, Response, header};
use serde_json::json;

/// Days a file is kept, today's included.
pub const KEEP_DAYS: i64 = 14;
/// Lines waiting for the disk before new ones are dropped.
const QUEUE: usize = 10_000;
/// A day's file stops growing here; a flood fills it, not the box's disk.
const DAY_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct AccessLog {
    queue: Option<SyncSender<String>>,
    dropped: Arc<AtomicU64>,
}

impl AccessLog {
    /// Starts the writer for `dir`, or a log that keeps nothing.
    pub fn open(dir: Option<PathBuf>) -> Self {
        let Some(dir) = dir else {
            return Self::default();
        };
        if let Err(e) = fs::create_dir_all(&dir) {
            tracing::error!(error = %e, dir = %dir.display(), "access log off: no directory");
            return Self::default();
        }
        let (queue, lines) = sync_channel(QUEUE);
        let dropped = Arc::new(AtomicU64::new(0));
        let counted = dropped.clone();
        let spawned = std::thread::Builder::new()
            .name("access-log".into())
            .spawn(move || write_days(&dir, lines, &counted));
        if let Err(e) = spawned {
            tracing::error!(error = %e, "access log off: no writer");
            return Self::default();
        }
        Self {
            queue: Some(queue),
            dropped,
        }
    }

    pub fn record(&self, line: String) {
        let Some(queue) = &self.queue else { return };
        if let Err(TrySendError::Full(_)) = queue.try_send(line) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// What a request was, taken before it goes on to the share.
pub struct Entry {
    at: SystemTime,
    started: Instant,
    ip: String,
    country: Option<String>,
    method: String,
    host: String,
    path: String,
    agent: Option<String>,
    referer: Option<String>,
}

fn header_cut(headers: &HeaderMap, name: impl header::AsHeaderName, max: usize) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.chars().take(max).collect())
}

impl Entry {
    pub fn of<B>(req: &Request<B>, host: &str, ip: String) -> Self {
        let headers = req.headers();
        Self {
            at: SystemTime::now(),
            started: Instant::now(),
            ip,
            country: header_cut(headers, "cf-ipcountry", 8),
            method: req.method().to_string(),
            host: host.chars().take(255).collect(),
            path: req
                .uri()
                .path_and_query()
                .map(|p| p.as_str())
                .unwrap_or("/")
                .chars()
                .take(2000)
                .collect(),
            agent: header_cut(headers, header::USER_AGENT, 300),
            referer: header_cut(headers, header::REFERER, 500),
        }
    }

    /// The line, once the answer is known. `share` is the share and the
    /// account behind the name, when one is live.
    pub fn answered<B>(self, response: &Response<B>, share: Option<(&str, &str)>) -> String {
        let headers = response.headers();
        let bytes = headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        json!({
            "t": timestamp(self.at),
            "ip": self.ip,
            "country": self.country,
            "method": self.method,
            "host": self.host,
            "path": self.path,
            "status": response.status().as_u16(),
            "type": header_cut(headers, header::CONTENT_TYPE, 100),
            "bytes": bytes,
            "ms": self.started.elapsed().as_millis() as u64,
            "share": share.map(|(id, _)| id),
            "user": share.map(|(_, user)| user),
            "agent": self.agent,
            "referer": self.referer,
        })
        .to_string()
    }
}

fn write_days(dir: &Path, lines: Receiver<String>, dropped: &AtomicU64) {
    let mut day = String::new();
    let mut file: Option<(BufWriter<File>, u64)> = None;
    let mut full_warned = false;
    loop {
        let next = lines.recv_timeout(Duration::from_secs(1));
        let today = date(SystemTime::now());
        if today != day {
            if let Some((mut w, _)) = file.take() {
                let _ = w.flush();
            }
            prune(dir, &today);
            file = open_day(dir, &today);
            day = today;
            full_warned = false;
        }
        match next {
            Ok(line) => {
                let Some((w, size)) = file.as_mut() else {
                    continue;
                };
                if *size >= DAY_LIMIT {
                    if !full_warned {
                        tracing::warn!(day, "access log full for the day");
                        full_warned = true;
                    }
                    continue;
                }
                if writeln!(w, "{line}").is_ok() {
                    *size += line.len() as u64 + 1;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some((w, _)) = file.as_mut() {
                    let _ = w.flush();
                }
                let lost = dropped.swap(0, Ordering::Relaxed);
                if lost > 0 {
                    tracing::warn!(lost, "access log behind: lines dropped");
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                if let Some((mut w, _)) = file.take() {
                    let _ = w.flush();
                }
                return;
            }
        }
    }
}

fn open_day(dir: &Path, day: &str) -> Option<(BufWriter<File>, u64)> {
    let path = dir.join(format!("access-{day}.jsonl"));
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => {
            let size = f.metadata().map(|m| m.len()).unwrap_or(0);
            Some((BufWriter::new(f), size))
        }
        Err(e) => {
            tracing::error!(error = %e, path = %path.display(), "access log not written");
            None
        }
    }
}

/// Deletes the days past keeping: with 14 kept, on 2026-10-15 the oldest
/// left is 2026-10-02.
fn prune(dir: &Path, today: &str) {
    let Some(oldest) = days_before(today, KEEP_DAYS - 1) else {
        return;
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(day) = name
            .to_str()
            .and_then(|n| n.strip_prefix("access-"))
            .and_then(|n| n.strip_suffix(".jsonl"))
        else {
            continue;
        };
        // ISO dates sort as text.
        if day.len() == 10
            && day < oldest.as_str()
            && let Err(e) = fs::remove_file(entry.path())
        {
            tracing::warn!(error = %e, day, "old access log not deleted");
        }
    }
}

/// "2026-10-02".
fn date(at: SystemTime) -> String {
    let secs = at
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d) = civil((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// "2026-10-02T19:46:26.123Z".
fn timestamp(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let (y, m, d) = civil((secs / 86_400) as i64);
    let s = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        s / 3600,
        s / 60 % 60,
        s % 60,
        since.subsec_millis()
    )
}

/// The date `n` days before an ISO date.
fn days_before(day: &str, n: i64) -> Option<String> {
    let mut parts = day.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    let (y, m, d) = civil(days_from_civil(y, m, d) - n);
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// Days since 1970-01-01 to a date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number since 1970-01-01.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn dates_and_times_read_as_utc() {
        assert_eq!(date(at(0)), "1970-01-01");
        assert_eq!(date(at(951_782_400)), "2000-02-29");
        assert_eq!(date(at(4_102_444_800)), "2100-01-01");
        assert_eq!(
            timestamp(at(1_790_970_386) + Duration::from_millis(42)),
            "2026-10-02T19:46:26.042Z"
        );
        assert_eq!(days_before("2026-10-15", 13).as_deref(), Some("2026-10-02"));
        assert_eq!(days_before("2026-03-01", 1).as_deref(), Some("2026-02-28"));
        assert_eq!(days_before("2024-03-01", 1).as_deref(), Some("2024-02-29"));
        assert_eq!(days_before("2027-01-05", 13).as_deref(), Some("2026-12-23"));
    }

    #[test]
    fn days_past_keeping_are_deleted() {
        let dir = std::env::temp_dir().join(format!("whk-edge-access-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "access-2026-10-01.jsonl",
            "access-2026-10-02.jsonl",
            "access-2026-10-15.jsonl",
            "notes.txt",
        ] {
            fs::write(dir.join(name), "x\n").unwrap();
        }
        prune(&dir, "2026-10-15");
        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "access-2026-10-02.jsonl",
                "access-2026-10-15.jsonl",
                "notes.txt"
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_line_has_the_request_and_the_answer() {
        let req = Request::builder()
            .uri("/login?next=%2F")
            .header("user-agent", "Mozilla/5.0")
            .header("cf-ipcountry", "DK")
            .body(())
            .unwrap();
        let entry = Entry::of(&req, "calm-otter-4821.sharehooks.cc", "203.0.113.7".into());
        let response = Response::builder()
            .status(200)
            .header("content-type", "text/html")
            .header("content-length", "512")
            .body(())
            .unwrap();
        let line: serde_json::Value =
            serde_json::from_str(&entry.answered(&response, Some(("s1", "u1")))).unwrap();
        assert_eq!(line["ip"], "203.0.113.7");
        assert_eq!(line["country"], "DK");
        assert_eq!(line["path"], "/login?next=%2F");
        assert_eq!(line["status"], 200);
        assert_eq!(line["bytes"], 512);
        assert_eq!(line["share"], "s1");
        assert_eq!(line["user"], "u1");
        assert!(line["referer"].is_null());
    }

    #[test]
    fn the_writer_puts_lines_in_todays_file() {
        let dir = std::env::temp_dir().join(format!("whk-edge-access-w-{}", std::process::id()));
        let log = AccessLog::open(Some(dir.clone()));
        log.record("{\"a\":1}".into());
        log.record("{\"a\":2}".into());
        drop(log);
        // The writer ends once the last sender is gone.
        let file = dir.join(format!("access-{}.jsonl", date(SystemTime::now())));
        let deadline = Instant::now() + Duration::from_secs(5);
        while fs::read_to_string(&file)
            .map(|s| s.lines().count())
            .unwrap_or(0)
            < 2
        {
            assert!(Instant::now() < deadline, "lines not written");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":1}\n{\"a\":2}\n");
        fs::remove_dir_all(&dir).unwrap();
    }
}
