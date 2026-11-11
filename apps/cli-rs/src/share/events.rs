//! `whk share --json`: what a share says, as one JSON object a line on
//! stdout instead of the text a person reads, for scripts, the SDK and the
//! MCP server. Every line has an "event" saying what it is.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Event<'a> {
    /// The share is open at `url` (again at a new address after a reconnect).
    #[serde(rename_all = "camelCase")]
    Live {
        url: &'a str,
        name: &'a str,
        expires_at: Option<&'a str>,
        notice: bool,
        password: bool,
    },
    /// The share is back at the same address after the connection dropped.
    Reconnected,
    /// One visitor request.
    Request {
        method: &'a str,
        path: &'a str,
        status: u16,
        ms: u64,
    },
    /// Something the edge said, as it is.
    Notice { text: &'a str },
    /// The tunnel could not be reached or dropped; trying again in `seconds`.
    Retrying { message: &'a str, seconds: u64 },
    /// The share ended, and why; the CLI exits next.
    Stopped { reason: &'a str },
    /// What went wrong; the CLI exits with 1 next.
    Error { message: &'a str },
}

impl Event<'_> {
    pub fn line(&self) -> String {
        serde_json::to_string(self).expect("an event is always JSON")
    }

    /// Prints the event, through [`out`], so a reader that falls behind
    /// never holds up the share.
    pub fn print(&self) {
        let droppable = matches!(self, Event::Request { .. });
        out(self.line(), droppable);
    }
}

/// Visitor request lines that may wait to be written before more are
/// dropped.
pub const MAX_PENDING: usize = 256;

/// Lines of any kind that may wait before even the ones that are never
/// dropped are let go: only a reader that has stopped reading gets there,
/// and the share must not grow without bound for it.
pub const MAX_QUEUED: usize = 4 * MAX_PENDING;

/// How long the last line of a share waits for the lines before it to be
/// written before the CLI exits anyway.
pub const FINAL_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Lines written in order by a thread of their own.
pub struct Lines {
    tx: std::sync::mpsc::Sender<String>,
    pending: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl Lines {
    /// Starts the writer thread. `on_broken` runs when the writer fails
    /// (the reader has gone).
    pub fn new<W: std::io::Write + Send + 'static>(mut writer: W, on_broken: fn()) -> Self {
        use std::sync::atomic::Ordering;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let pending = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let left = pending.clone();
        std::thread::spawn(move || {
            for line in rx {
                let ok = writeln!(writer, "{line}").and_then(|()| writer.flush());
                left.fetch_sub(1, Ordering::SeqCst);
                if ok.is_err() {
                    on_broken();
                }
            }
        });
        Self { tx, pending }
    }

    /// Queues a line and returns at once, whether it was queued. A
    /// droppable one is let go when [`MAX_PENDING`] lines already wait, any
    /// other only past [`MAX_QUEUED`]. [`Lines::flush`] waits for them.
    pub fn push(&self, line: String, droppable: bool) -> bool {
        use std::sync::atomic::Ordering;
        let limit = if droppable { MAX_PENDING } else { MAX_QUEUED };
        if self.pending.load(Ordering::SeqCst) >= limit {
            return false;
        }
        self.pending.fetch_add(1, Ordering::SeqCst);
        if self.tx.send(line).is_err() {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        true
    }

    /// Waits until every queued line is written, for up to `wait`; whether
    /// they all were.
    pub fn flush(&self, wait: std::time::Duration) -> bool {
        let until = std::time::Instant::now() + wait;
        while self.pending() > 0 {
            if std::time::Instant::now() >= until {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        true
    }

    /// Lines waiting to be written.
    pub fn pending(&self) -> usize {
        self.pending.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn stdout_lines() -> &'static Lines {
    static LINES: std::sync::OnceLock<Lines> = std::sync::OnceLock::new();
    LINES.get_or_init(|| Lines::new(std::io::stdout(), || std::process::exit(0)))
}

/// Writes a line (it may hold several) to stdout from the writer thread,
/// in order with everything else a share prints, without waiting for it.
/// When nobody reads stdout any more (the program that started this has
/// gone), there is no one to share for: it stops.
pub fn out(text: String, droppable: bool) {
    stdout_lines().push(text, droppable);
}

/// Waits for what [`out`] queued to be written, for up to `wait`: before
/// the CLI exits, so its last lines are not lost.
pub fn flush(wait: std::time::Duration) -> bool {
    stdout_lines().flush(wait)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_share_reads_as_one_object_a_line() {
        assert_eq!(
            Event::Live {
                url: "https://acme.sharehooks.cc",
                name: "acme",
                expires_at: Some("2026-11-10T12:00:00Z"),
                notice: true,
                password: false,
            }
            .line(),
            r#"{"event":"live","url":"https://acme.sharehooks.cc","name":"acme","expiresAt":"2026-11-10T12:00:00Z","notice":true,"password":false}"#
        );
        assert_eq!(Event::Reconnected.line(), r#"{"event":"reconnected"}"#);
        assert_eq!(
            Event::Request {
                method: "GET",
                path: "/pricing?plan=pro",
                status: 200,
                ms: 12,
            }
            .line(),
            r#"{"event":"request","method":"GET","path":"/pricing?plan=pro","status":200,"ms":12}"#
        );
        assert_eq!(
            Event::Notice {
                text: "Kept back a video."
            }
            .line(),
            r#"{"event":"notice","text":"Kept back a video."}"#
        );
        assert_eq!(
            Event::Retrying {
                message: "The connection dropped.",
                seconds: 2,
            }
            .line(),
            r#"{"event":"retrying","message":"The connection dropped.","seconds":2}"#
        );
        assert_eq!(
            Event::Stopped {
                reason: "you stopped it on webhooks.cc",
            }
            .line(),
            r#"{"event":"stopped","reason":"you stopped it on webhooks.cc"}"#
        );
        assert_eq!(
            Event::Error {
                message: "Not logged in."
            }
            .line(),
            r#"{"event":"error","message":"Not logged in."}"#
        );
    }

    #[test]
    fn a_share_without_a_time_limit_has_a_null_end() {
        let line = Event::Live {
            url: "https://a.sharehooks.cc",
            name: "a",
            expires_at: None,
            notice: false,
            password: true,
        }
        .line();
        assert!(line.contains(r#""expiresAt":null"#), "{line}");
    }

    #[test]
    fn a_visitors_path_cannot_break_the_line() {
        let line = Event::Request {
            method: "GET",
            path: "/a\n{\"event\":\"stopped\"}",
            status: 404,
            ms: 1,
        }
        .line();
        assert!(!line.contains('\n'));
        let back: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(back["path"], "/a\n{\"event\":\"stopped\"}");
    }

    /// A writer that takes nothing until it is let go.
    struct Gate(
        std::sync::Arc<std::sync::Mutex<()>>,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    );

    impl std::io::Write for Gate {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _open = self.0.lock().unwrap();
            self.1
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(buf).into_owned());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_slow_reader_drops_request_lines_but_never_holds_the_share_up() {
        let gate = std::sync::Arc::new(std::sync::Mutex::new(()));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let closed = gate.lock().unwrap();
        let lines = Lines::new(Gate(gate.clone(), seen.clone()), || {});
        let started = std::time::Instant::now();
        let mut queued = 0;
        for i in 0..(MAX_PENDING + 100) {
            if lines.push(format!("request {i}"), true) {
                queued += 1;
            }
        }
        // Lines that are never dropped do not wait on the reader either.
        assert!(lines.push("reconnected".to_string(), false));
        // None of it waited on the reader, and the overflow was let go.
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert!(queued <= MAX_PENDING + 1, "{queued}");
        assert!(queued >= MAX_PENDING - 1, "{queued}");
        // A reader that has stopped: a flush gives up.
        assert!(!lines.flush(std::time::Duration::from_millis(50)));
        // Not even the lines that are kept grow without bound.
        let kept = (0..2 * MAX_QUEUED)
            .filter(|_| lines.push("notice".to_string(), false))
            .count();
        assert!(kept < MAX_QUEUED, "{kept}");
        drop(closed);
        // Once the reader reads again, everything kept goes out, and the
        // last line comes after it.
        assert!(lines.flush(std::time::Duration::from_secs(10)));
        assert!(lines.push("stopped".to_string(), false));
        assert!(lines.flush(std::time::Duration::from_secs(10)));
        assert_eq!(lines.pending(), 0);
        let seen = seen.lock().unwrap();
        let at = |what: &str| seen.iter().position(|l| l.starts_with(what)).unwrap();
        assert!(at("reconnected") >= queued);
        assert!(at("stopped") > at("reconnected"));
        let last = seen.iter().rev().find(|l| !l.trim().is_empty());
        assert_eq!(last.map(String::as_str), Some("stopped"));
    }
}
