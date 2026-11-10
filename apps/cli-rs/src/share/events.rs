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

    /// Prints the event. When nobody reads them any more (the program that
    /// started this has gone), there is no one to share for: it stops.
    pub fn print(&self) {
        use std::io::Write;
        if writeln!(std::io::stdout(), "{}", self.line()).is_err() {
            std::process::exit(0);
        }
    }
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
}
