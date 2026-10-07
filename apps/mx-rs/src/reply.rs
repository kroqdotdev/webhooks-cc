//! SMTP replies, and how the receiver's answers map onto them.
//!
//! The receiver decides what can be captured; this module only translates its
//! statuses into the reply a sending server understands. Anything uncertain
//! becomes a temporary failure (4xx): the sender keeps the message and
//! retries, and retries are never billed twice (see `retry_store`).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub code: u16,
    pub esc: [u8; 3],
    pub text: &'static str,
}

impl Reply {
    pub const fn new(code: u16, class: u8, subject: u8, detail: u8, text: &'static str) -> Self {
        Self {
            code,
            esc: [class, subject, detail],
            text,
        }
    }

    /// "250 2.1.5 OK\r\n"
    pub fn to_bytes(&self) -> Vec<u8> {
        let [class, subject, detail] = self.esc;
        format!("{} {class}.{subject}.{detail} {}\r\n", self.code, self.text).into_bytes()
    }

    pub fn is_transient(&self) -> bool {
        (400..500).contains(&self.code)
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.code)
    }
}

pub const OK: Reply = Reply::new(250, 2, 0, 0, "OK");
pub const SENDER_OK: Reply = Reply::new(250, 2, 1, 0, "Sender OK");
pub const RECIPIENT_OK: Reply = Reply::new(250, 2, 1, 5, "Recipient OK");
/// The 354 reply carries no enhanced status code (RFC 2034 defines none for
/// intermediate replies), so it is written as plain bytes.
pub const START_DATA: &[u8] = b"354 Send the message, end with <CRLF>.<CRLF>\r\n";
pub const READY_FOR_TLS: Reply = Reply::new(220, 2, 0, 0, "Ready to start TLS");
pub const BYE: Reply = Reply::new(221, 2, 0, 0, "Bye");
pub const VRFY_UNSUPPORTED: Reply = Reply::new(
    252,
    2,
    5,
    0,
    "Cannot verify, but will accept and attempt delivery",
);
pub const HELP: Reply = Reply::new(214, 2, 0, 0, "Receive-only mail capture for webhooks.cc");

pub const NEED_HELO: Reply = Reply::new(503, 5, 5, 1, "Say EHLO first");
pub const NEED_MAIL: Reply = Reply::new(503, 5, 5, 1, "Need MAIL first");
pub const NESTED_MAIL: Reply = Reply::new(503, 5, 5, 1, "Sender already given");
pub const NO_VALID_RECIPIENTS: Reply = Reply::new(554, 5, 5, 1, "No valid recipients");
pub const ALREADY_TLS: Reply = Reply::new(503, 5, 5, 1, "Already in TLS");
pub const TLS_UNAVAILABLE: Reply = Reply::new(454, 4, 7, 0, "TLS not available");
pub const NOT_IMPLEMENTED: Reply = Reply::new(502, 5, 5, 1, "Command not implemented");
pub const UNKNOWN_COMMAND: Reply = Reply::new(500, 5, 5, 1, "Command not recognized");
pub const LINE_TOO_LONG: Reply = Reply::new(500, 5, 5, 6, "Line too long");
pub const BAD_SENDER: Reply = Reply::new(501, 5, 1, 7, "Bad sender address");
pub const BAD_SYNTAX: Reply = Reply::new(501, 5, 5, 4, "Syntax error");
pub const TOO_MANY_RECIPIENTS: Reply = Reply::new(452, 4, 5, 3, "Too many recipients");
pub const MESSAGE_TOO_BIG: Reply = Reply::new(552, 5, 3, 4, "Message too big");
pub const NO_DATA_SLOT: Reply = Reply::new(451, 4, 3, 1, "Busy, try again later");
pub const RATE_LIMITED: Reply = Reply::new(451, 4, 7, 1, "Too many messages, try again later");
pub const TRY_LATER: Reply = Reply::new(451, 4, 3, 0, "Temporary failure, try again later");
pub const TOO_MANY_ERRORS: Reply = Reply::new(421, 4, 7, 0, "Too many errors, closing connection");
pub const TOO_MANY_COMMANDS: Reply =
    Reply::new(421, 4, 7, 0, "Too many commands, closing connection");
pub const TIMEOUT: Reply = Reply::new(421, 4, 4, 2, "Timeout, closing connection");
pub const SHUTTING_DOWN: Reply = Reply::new(421, 4, 3, 2, "Service shutting down");
pub const TOO_BUSY: Reply = Reply::new(421, 4, 7, 0, "Too many connections, try again later");
pub const BLOCKED: Reply = Reply::new(421, 4, 7, 1, "Too many refused recipients, try again later");

/// The receiver's answer to `POST /internal/mail/check`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Ok,
    Unknown,
    Expired,
    Guest,
    OverQuota,
    Paused,
    RelayDenied,
    Invalid,
    /// The call failed or the answer was not understood.
    Error,
}

impl CheckStatus {
    pub fn parse(status: &str) -> Self {
        match status {
            "ok" => Self::Ok,
            "unknown" => Self::Unknown,
            "expired" => Self::Expired,
            "guest" => Self::Guest,
            "over_quota" => Self::OverQuota,
            "paused" => Self::Paused,
            "relay_denied" => Self::RelayDenied,
            "invalid" => Self::Invalid,
            _ => Self::Error,
        }
    }

    /// Refusals that suggest someone probing for addresses.
    pub fn is_bad_recipient(self) -> bool {
        matches!(self, Self::Unknown | Self::Invalid | Self::RelayDenied)
    }

    /// Answers that may be cached, and for how long, in seconds.
    pub fn cache_secs(self) -> Option<u64> {
        match self {
            Self::Ok => Some(30),
            Self::Unknown
            | Self::Expired
            | Self::Guest
            | Self::OverQuota
            | Self::RelayDenied
            | Self::Invalid => Some(60),
            Self::Paused | Self::Error => None,
        }
    }
}

pub fn rcpt_reply(status: CheckStatus) -> Reply {
    match status {
        CheckStatus::Ok => RECIPIENT_OK,
        CheckStatus::Unknown | CheckStatus::Expired => {
            Reply::new(550, 5, 1, 1, "Mailbox does not exist")
        }
        CheckStatus::Guest => Reply::new(
            550,
            5,
            7,
            1,
            "Email capture needs a webhooks.cc account endpoint",
        ),
        CheckStatus::OverQuota => Reply::new(552, 5, 2, 2, "Mailbox full: request quota used up"),
        CheckStatus::RelayDenied => Reply::new(550, 5, 7, 1, "Relaying denied"),
        CheckStatus::Invalid => Reply::new(501, 5, 1, 3, "Bad recipient address syntax"),
        CheckStatus::Paused => Reply::new(
            451,
            4,
            3,
            2,
            "Not accepting mail right now, try again later",
        ),
        CheckStatus::Error => TRY_LATER,
    }
}

/// What came back from `POST /internal/mail/deliver`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliverOutcome {
    /// HTTP 200 with one status per recipient.
    Results(Vec<String>),
    /// Any other HTTP status.
    HttpStatus(u16),
    /// The call itself failed (connection, timeout, unreadable body).
    Failed,
}

/// The reply to the end of DATA, and whether the message hash must be
/// remembered so the sender's retry is recognised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataVerdict {
    pub reply: Reply,
    pub remember_for_retry: bool,
}

pub fn data_reply(outcome: &DeliverOutcome) -> DataVerdict {
    let try_later = DataVerdict {
        reply: TRY_LATER,
        remember_for_retry: true,
    };
    let statuses = match outcome {
        DeliverOutcome::Results(statuses) if !statuses.is_empty() => statuses,
        DeliverOutcome::HttpStatus(413) => {
            return DataVerdict {
                reply: MESSAGE_TOO_BIG,
                remember_for_retry: false,
            };
        }
        _ => return try_later,
    };

    const PERMANENT: [&str; 7] = [
        "unknown",
        "expired",
        "guest",
        "over_quota",
        "invalid",
        "relay_denied",
        "failed",
    ];
    // Anything this code does not recognise is uncertain, so retry.
    if statuses.iter().any(|s| {
        s == "transient"
            || !(s == "captured" || s == "duplicate" || PERMANENT.contains(&s.as_str()))
    }) {
        return try_later;
    }
    if statuses.iter().any(|s| s == "captured" || s == "duplicate") {
        return DataVerdict {
            reply: Reply::new(250, 2, 0, 0, "Message captured"),
            remember_for_retry: false,
        };
    }
    let has = |status: &str| statuses.iter().any(|s| s == status);
    let reply = if has("over_quota") {
        rcpt_reply(CheckStatus::OverQuota)
    } else if has("guest") {
        rcpt_reply(CheckStatus::Guest)
    } else if has("unknown") || has("expired") {
        rcpt_reply(CheckStatus::Unknown)
    } else if has("invalid") {
        Reply::new(550, 5, 1, 3, "Bad recipient address")
    } else if has("relay_denied") {
        rcpt_reply(CheckStatus::RelayDenied)
    } else {
        Reply::new(554, 5, 6, 0, "Message could not be stored")
    };
    DataVerdict {
        reply,
        remember_for_retry: false,
    }
}

/// The multi-line EHLO reply.
pub fn ehlo(hostname: &str, max_size: usize, offer_starttls: bool) -> Vec<u8> {
    let mut lines = vec![
        hostname.to_string(),
        format!("SIZE {max_size}"),
        "8BITMIME".to_string(),
        "SMTPUTF8".to_string(),
        "PIPELINING".to_string(),
        "ENHANCEDSTATUSCODES".to_string(),
    ];
    if offer_starttls {
        lines.push("STARTTLS".to_string());
    }
    let last = lines.len() - 1;
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        out.push_str(if i == last { "250 " } else { "250-" });
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn results(statuses: &[&str]) -> DeliverOutcome {
        DeliverOutcome::Results(statuses.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn formats_replies() {
        assert_eq!(RECIPIENT_OK.to_bytes(), b"250 2.1.5 Recipient OK\r\n");
        assert!(TRY_LATER.is_transient());
        assert!(OK.is_success());
    }

    #[test]
    fn maps_every_check_status() {
        assert_eq!(rcpt_reply(CheckStatus::Ok).code, 250);
        assert_eq!(rcpt_reply(CheckStatus::Unknown).code, 550);
        assert_eq!(rcpt_reply(CheckStatus::Expired).code, 550);
        assert_eq!(rcpt_reply(CheckStatus::Guest).esc, [5, 7, 1]);
        assert_eq!(rcpt_reply(CheckStatus::OverQuota).code, 552);
        assert_eq!(rcpt_reply(CheckStatus::RelayDenied).code, 550);
        assert_eq!(rcpt_reply(CheckStatus::Invalid).code, 501);
        assert_eq!(rcpt_reply(CheckStatus::Paused).code, 451);
        assert_eq!(rcpt_reply(CheckStatus::Error).code, 451);
    }

    #[test]
    fn parses_every_status_the_receiver_sends() {
        for (raw, status) in [
            ("ok", CheckStatus::Ok),
            ("unknown", CheckStatus::Unknown),
            ("expired", CheckStatus::Expired),
            ("guest", CheckStatus::Guest),
            ("over_quota", CheckStatus::OverQuota),
            ("paused", CheckStatus::Paused),
            ("relay_denied", CheckStatus::RelayDenied),
            ("invalid", CheckStatus::Invalid),
            ("something new", CheckStatus::Error),
            ("OK", CheckStatus::Error),
            ("", CheckStatus::Error),
        ] {
            assert_eq!(CheckStatus::parse(raw), status, "{raw:?}");
        }
        assert!(CheckStatus::Unknown.is_bad_recipient());
        assert!(CheckStatus::Invalid.is_bad_recipient());
        assert!(CheckStatus::RelayDenied.is_bad_recipient());
        assert!(!CheckStatus::OverQuota.is_bad_recipient());
        assert!(!CheckStatus::Guest.is_bad_recipient());
        assert!(!CheckStatus::Paused.is_bad_recipient());
    }

    #[test]
    fn caches_answers_but_not_errors() {
        assert_eq!(CheckStatus::Ok.cache_secs(), Some(30));
        assert_eq!(CheckStatus::Unknown.cache_secs(), Some(60));
        assert_eq!(CheckStatus::Paused.cache_secs(), None);
        assert_eq!(CheckStatus::Error.cache_secs(), None);
    }

    #[test]
    fn captured_wins_unless_anything_is_transient() {
        let verdict = data_reply(&results(&["captured", "over_quota"]));
        assert_eq!(verdict.reply.code, 250);
        assert!(!verdict.remember_for_retry);

        let verdict = data_reply(&results(&["captured", "transient"]));
        assert_eq!(verdict.reply.code, 451);
        assert!(verdict.remember_for_retry);

        assert_eq!(data_reply(&results(&["duplicate"])).reply.code, 250);
    }

    #[test]
    fn unknown_statuses_and_failed_calls_mean_try_later() {
        for outcome in [
            results(&["captured", "brand_new_status"]),
            results(&[]),
            DeliverOutcome::HttpStatus(503),
            DeliverOutcome::HttpStatus(500),
            DeliverOutcome::Failed,
        ] {
            let verdict = data_reply(&outcome);
            assert_eq!(verdict.reply.code, 451, "{outcome:?}");
            assert!(verdict.remember_for_retry);
        }
    }

    #[test]
    fn too_large_is_permanent() {
        let verdict = data_reply(&DeliverOutcome::HttpStatus(413));
        assert_eq!(verdict.reply, MESSAGE_TOO_BIG);
        assert!(!verdict.remember_for_retry);
    }

    #[test]
    fn picks_the_most_specific_refusal() {
        assert_eq!(
            data_reply(&results(&["unknown", "over_quota"])).reply.code,
            552
        );
        assert_eq!(
            data_reply(&results(&["unknown", "guest"])).reply.esc,
            [5, 7, 1]
        );
        assert_eq!(
            data_reply(&results(&["guest", "over_quota"])).reply,
            rcpt_reply(CheckStatus::OverQuota)
        );
        assert_eq!(
            data_reply(&results(&["invalid", "unknown"])).reply.esc,
            [5, 1, 1]
        );
        assert_eq!(
            data_reply(&results(&["relay_denied", "invalid"])).reply.esc,
            [5, 1, 3]
        );
        assert_eq!(
            data_reply(&results(&["failed", "relay_denied"])).reply.esc,
            [5, 7, 1]
        );
        assert_eq!(data_reply(&results(&["expired"])).reply.esc, [5, 1, 1]);
        assert_eq!(data_reply(&results(&["invalid"])).reply.esc, [5, 1, 3]);
        assert_eq!(data_reply(&results(&["relay_denied"])).reply.code, 550);
        assert_eq!(data_reply(&results(&["failed"])).reply.code, 554);
    }

    #[test]
    fn ehlo_lists_extensions_and_starttls_only_when_offered() {
        let with_tls = String::from_utf8(ehlo("mx.example", 10, true)).unwrap();
        assert!(with_tls.starts_with("250-mx.example\r\n250-SIZE 10\r\n"));
        assert!(with_tls.ends_with("250 STARTTLS\r\n"));
        let without = String::from_utf8(ehlo("mx.example", 10, false)).unwrap();
        assert!(without.ends_with("250 ENHANCEDSTATUSCODES\r\n"));
        assert!(!without.contains("STARTTLS"));
    }
}
