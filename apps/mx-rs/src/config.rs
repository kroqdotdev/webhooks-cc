use std::env;
use std::path::PathBuf;
use std::time::Duration;

/// Largest message accepted (advertised as SIZE).
pub const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;
/// Recipients accepted per message.
pub const MAX_RECIPIENTS: usize = 20;

/// Reverse-DNS suffixes of mail providers whose sending addresses are shared
/// by many customers. A forward-confirmed PTR under one of them makes the
/// client trusted (see `limits`).
const DEFAULT_TRUSTED_RDNS: &[&str] = &[
    "google.com",
    "outlook.com",
    "amazonses.com",
    "sendgrid.net",
    "mailgun.net",
    "mtasv.net",
    "sparkpostmail.com",
    "mandrillapp.com",
    "mcsv.net",
    "mailjet.com",
    "sendinblue.com",
    "brevo.com",
    "yahoo.com",
    "zoho.com",
    "zoho.eu",
    "icloud.com",
    "messagingengine.com",
    "protonmail.ch",
];

#[derive(Clone)]
pub struct Config {
    /// Addresses to listen on for SMTP, e.g. "[::]:25" (dual stack on Linux).
    pub listen: Vec<String>,
    /// Name used in the banner and the EHLO reply.
    pub hostname: String,
    /// Base URL of the receiver's private mail listener, e.g. "http://receiver.internal:3002".
    pub ingest_url: String,
    /// HMAC key shared with the receiver, used exactly as given (the receiver
    /// does not trim it either).
    pub shared_secret: String,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    /// Where the retry store keeps its file.
    pub state_dir: PathBuf,
    /// Optional plain-HTTP health endpoint, e.g. "127.0.0.1:8025".
    pub health_addr: Option<String>,
    pub max_sessions: usize,
    /// Messages buffered at once. Each is held about three times over while
    /// it is encoded and sent (raw, base64, request body), so 16 cap that at
    /// roughly 560 MiB.
    pub data_slots: usize,
    pub trusted_rdns: Vec<String>,
    pub limits: Limits,
    pub timeouts: Timeouts,
}

/// Limits applied before mail is accepted (see `limits`).
#[derive(Clone, Debug)]
pub struct Limits {
    pub sessions_per_client: usize,
    pub trusted_sessions_per_client: usize,
    /// DATA transfers running at once per client.
    pub data_per_client: usize,
    pub trusted_data_per_client: usize,
    pub messages_per_client_per_hour: u32,
    pub trusted_messages_per_client_per_hour: u32,
    /// Refused recipients (unknown, invalid, another domain) after which the
    /// session is closed.
    pub bad_recipients_per_session: u32,
    /// Accepted recipients per address per client per minute.
    pub messages_per_address_per_minute: u32,
    /// Slowest DATA transfer tolerated once `min_data_rate_after` has passed,
    /// in bytes per second.
    pub min_data_rate: u64,
    pub min_data_rate_after: Duration,
}

#[derive(Clone, Debug)]
pub struct Timeouts {
    pub command: Duration,
    pub data: Duration,
    pub session: Duration,
    pub data_slot_wait: Duration,
    pub reverse_dns: Duration,
    pub auth_checks: Duration,
    pub check_call: Duration,
    pub deliver_call: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            sessions_per_client: 10,
            trusted_sessions_per_client: 50,
            data_per_client: 2,
            trusted_data_per_client: 8,
            messages_per_client_per_hour: 300,
            trusted_messages_per_client_per_hour: 3000,
            bad_recipients_per_session: 10,
            messages_per_address_per_minute: 60,
            min_data_rate: 512,
            min_data_rate_after: Duration::from_secs(30),
        }
    }
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            command: Duration::from_secs(60),
            data: Duration::from_secs(300),
            session: Duration::from_secs(600),
            data_slot_wait: Duration::from_secs(30),
            reverse_dns: Duration::from_secs(3),
            auth_checks: Duration::from_secs(8),
            check_call: Duration::from_secs(10),
            deliver_call: Duration::from_secs(120),
        }
    }
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("hostname", &self.hostname)
            .field("ingest_url", &self.ingest_url)
            .field("shared_secret", &"[REDACTED]")
            .field("tls_cert", &self.tls_cert)
            .field("tls_key", &self.tls_key)
            .field("state_dir", &self.state_dir)
            .field("health_addr", &self.health_addr)
            .field("max_sessions", &self.max_sessions)
            .field("data_slots", &self.data_slots)
            .field("trusted_rdns", &self.trusted_rdns)
            .field("limits", &self.limits)
            .field("timeouts", &self.timeouts)
            .finish()
    }
}

fn parse_env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    match env::var(name) {
        Ok(v) => v.trim().parse().unwrap_or_else(|_| {
            tracing::warn!("invalid {name} value '{v}', using the default");
            default
        }),
        Err(_) => default,
    }
}

fn non_empty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

impl Config {
    pub fn from_env() -> Self {
        let ingest_url = non_empty("MAIL_INGEST_URL")
            .expect("MAIL_INGEST_URL is required")
            .trim_end_matches('/')
            .to_string();
        let shared_secret = env::var("CAPTURE_SHARED_SECRET")
            .ok()
            .filter(|v| !v.is_empty())
            .expect("CAPTURE_SHARED_SECRET is required");
        let tls_cert = non_empty("MX_TLS_CERT").map(PathBuf::from);
        let tls_key = non_empty("MX_TLS_KEY").map(PathBuf::from);
        if tls_cert.is_some() != tls_key.is_some() {
            panic!("MX_TLS_CERT and MX_TLS_KEY must be set together");
        }
        let trusted_rdns = match non_empty("MX_TRUSTED_RDNS") {
            Some(raw) => list(&raw),
            None => DEFAULT_TRUSTED_RDNS.iter().map(|s| s.to_string()).collect(),
        };
        Self {
            listen: non_empty("MX_LISTEN")
                .unwrap_or_else(|| "[::]:25".into())
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            hostname: non_empty("MX_HOSTNAME").unwrap_or_else(|| "mx.mailhooks.cc".into()),
            ingest_url,
            shared_secret,
            tls_cert,
            tls_key,
            state_dir: non_empty("MX_STATE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/var/lib/webhooks-mx")),
            health_addr: non_empty("MX_HEALTH_ADDR"),
            max_sessions: parse_env_or("MX_MAX_SESSIONS", 500).max(1),
            data_slots: parse_env_or("MX_DATA_SLOTS", 16).max(1),
            trusted_rdns,
            limits: Limits::default(),
            timeouts: Timeouts::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::list;

    #[test]
    fn parses_suffix_lists() {
        assert_eq!(
            list(" Google.com., amazonses.com ,, "),
            vec!["google.com".to_string(), "amazonses.com".to_string()]
        );
    }
}
