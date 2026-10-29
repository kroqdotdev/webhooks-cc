use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub capture_shared_secret: String,
    pub port: u16,
    pub debug: bool,
    pub log_dir: String,
    pub pool_min: u32,
    pub pool_max: u32,
    /// Max seconds to wait for a pooled Postgres connection before the capture
    /// query fails with `PoolTimedOut` (mapped to 503 + Retry-After so senders retry).
    pub pg_acquire_timeout_secs: u64,
    /// Captures one billing account may run at once (0 = unlimited). They
    /// serialize on the account's quota row, so more only hold connections
    /// other accounts need.
    pub capture_max_inflight_per_account: usize,
    pub max_body_size: usize,
    /// AES-256-GCM key for decrypting signing secrets (base64-decoded, 32 bytes).
    /// Optional: when absent, signature verification is silently skipped.
    pub signing_secret_key: Option<[u8; 32]>,
    /// External webhook base URL (e.g., "https://go.webhooks.cc").
    /// Used to construct the full URL for Twilio signature verification.
    pub webhook_base_url: Option<String>,
    /// Address of the private mail ingest listener (e.g. "0.0.0.0:3002").
    /// Unset: the listener is off. Never route it through Caddy.
    pub mail_ingest_addr: Option<String>,
    /// When true, every recipient check answers "paused" and deliveries are
    /// refused as transient, so the MX host tells senders to retry later.
    pub mail_ingest_paused: bool,
    /// Domains whose recipients map to endpoint slugs, lowercase.
    pub mail_domains: Vec<String>,
    /// How old the set of customers' verified inbound domains may get before
    /// it is read again (INBOUND_DOMAINS_REFRESH_SECS, default 60).
    pub inbound_domains_refresh_secs: u64,
    /// Where captured email (raw message and attachments) is stored. Unset:
    /// only the database copy is kept, as before object storage.
    pub object_store: Option<crate::object_store::ObjectStoreConfig>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"[REDACTED]")
            .field("capture_shared_secret", &"[REDACTED]")
            .field("port", &self.port)
            .field("debug", &self.debug)
            .field("log_dir", &self.log_dir)
            .field("pool_min", &self.pool_min)
            .field("pool_max", &self.pool_max)
            .field("pg_acquire_timeout_secs", &self.pg_acquire_timeout_secs)
            .field(
                "capture_max_inflight_per_account",
                &self.capture_max_inflight_per_account,
            )
            .field("max_body_size", &self.max_body_size)
            .field(
                "signing_secret_key",
                &self.signing_secret_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("webhook_base_url", &self.webhook_base_url)
            .field("mail_ingest_addr", &self.mail_ingest_addr)
            .field("mail_ingest_paused", &self.mail_ingest_paused)
            .field("mail_domains", &self.mail_domains)
            .field(
                "inbound_domains_refresh_secs",
                &self.inbound_domains_refresh_secs,
            )
            .field("object_store", &self.object_store)
            .finish()
    }
}

fn parse_env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    match env::var(name) {
        Ok(v) => match v.parse() {
            Ok(parsed) => parsed,
            Err(_) => {
                tracing::warn!("invalid {} value '{}', using default", name, v);
                default
            }
        },
        Err(_) => default,
    }
}

impl Config {
    pub fn from_env() -> Self {
        let database_url = env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let capture_shared_secret =
            env::var("CAPTURE_SHARED_SECRET").expect("CAPTURE_SHARED_SECRET is required");

        let port: u16 = parse_env_or("PORT", 3001);
        let debug = env::var("RECEIVER_DEBUG").is_ok_and(|v| !v.is_empty());
        let log_dir = env::var("RECEIVER_LOG_DIR").unwrap_or_else(|_| "logs".into());
        let pool_min: u32 = parse_env_or("PG_POOL_MIN", 5);
        let pool_max: u32 = parse_env_or("PG_POOL_MAX", 20);
        let pg_acquire_timeout_secs: u64 = match parse_env_or("PG_ACQUIRE_TIMEOUT_SECS", 5) {
            0 => {
                tracing::warn!("PG_ACQUIRE_TIMEOUT_SECS must be > 0, using default 5");
                5
            }
            v => v,
        };
        let max_body_size: usize = parse_env_or("RECEIVER_MAX_BODY_SIZE", 1_048_576).max(1024);
        let capture_max_inflight_per_account: usize =
            parse_env_or("CAPTURE_MAX_INFLIGHT_PER_ACCOUNT", 4);
        let signing_secret_key = env::var("SIGNING_SECRET_KEY")
            .ok()
            .filter(|v| !v.is_empty())
            .map(|v| {
                crate::crypto::parse_signing_key(&v).unwrap_or_else(|| {
                    panic!("SIGNING_SECRET_KEY is set but not valid base64 or not exactly 32 bytes. Generate a valid key with: openssl rand -base64 32");
                })
            });

        let webhook_base_url = env::var("WEBHOOK_BASE_URL")
            .or_else(|_| env::var("NEXT_PUBLIC_WEBHOOK_URL"))
            .ok()
            .map(|v| v.trim().trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty())
            .inspect(|v| {
                if !(v.starts_with("http://") || v.starts_with("https://")) {
                    panic!("WEBHOOK_BASE_URL must start with http:// or https://");
                }
            });

        let mail_ingest_addr = env::var("MAIL_INGEST_ADDR")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let mail_ingest_paused = env::var("MAIL_INGEST_PAUSED")
            .is_ok_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
        let mail_domains =
            parse_mail_domains(&env::var("MAIL_DOMAINS").unwrap_or_else(|_| "mailhooks.cc".into()));
        let inbound_domains_refresh_secs = env::var("INBOUND_DOMAINS_REFRESH_SECS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|secs| (1..=3600).contains(secs))
            .unwrap_or(60);

        let object_store = object_store_from_env();

        Self {
            database_url,
            capture_shared_secret,
            port,
            debug,
            log_dir,
            pool_min,
            pool_max,
            pg_acquire_timeout_secs,
            capture_max_inflight_per_account,
            max_body_size,
            signing_secret_key,
            webhook_base_url,
            mail_ingest_addr,
            mail_ingest_paused,
            mail_domains,
            inbound_domains_refresh_secs,
            object_store,
        }
    }
}

/// OBJECT_STORAGE_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY
/// together (OBJECT_STORAGE_REGION defaults to us-east-1, which most
/// S3-compatible services accept). Setting some but not all is a mistake
/// worth stopping for.
fn object_store_from_env() -> Option<crate::object_store::ObjectStoreConfig> {
    let get = |name: &str| {
        env::var(name)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let endpoint = get("OBJECT_STORAGE_ENDPOINT");
    let bucket = get("OBJECT_STORAGE_BUCKET");
    let access_key_id = get("OBJECT_STORAGE_ACCESS_KEY_ID");
    let secret_access_key = get("OBJECT_STORAGE_SECRET_ACCESS_KEY");
    match (endpoint, bucket, access_key_id, secret_access_key) {
        (None, None, None, None) => None,
        (Some(endpoint), Some(bucket), Some(access_key_id), Some(secret_access_key)) => {
            if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
                panic!("OBJECT_STORAGE_ENDPOINT must start with http:// or https://");
            }
            Some(crate::object_store::ObjectStoreConfig {
                endpoint: endpoint.trim_end_matches('/').to_string(),
                region: get("OBJECT_STORAGE_REGION").unwrap_or_else(|| "us-east-1".into()),
                bucket,
                access_key_id,
                secret_access_key,
            })
        }
        _ => panic!(
            "set all of OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY_ID and OBJECT_STORAGE_SECRET_ACCESS_KEY, or none"
        ),
    }
}

#[cfg(test)]
impl Config {
    /// Defaults for unit tests; nothing here points at a real service.
    pub fn for_tests() -> Self {
        Self {
            database_url: "postgres://nobody@127.0.0.1:1/none".into(),
            capture_shared_secret: String::new(),
            port: 0,
            debug: false,
            log_dir: "logs".into(),
            pool_min: 0,
            pool_max: 1,
            pg_acquire_timeout_secs: 1,
            capture_max_inflight_per_account: 4,
            max_body_size: 1_048_576,
            signing_secret_key: None,
            webhook_base_url: None,
            mail_ingest_addr: None,
            mail_ingest_paused: false,
            inbound_domains_refresh_secs: 60,
            mail_domains: vec!["mailhooks.cc".into()],
            object_store: None,
        }
    }
}

/// Comma-separated domain list, trimmed, lowercased, without trailing dots.
fn parse_mail_domains(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|d| d.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|d| !d.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::parse_mail_domains;

    #[test]
    fn mail_domains_are_normalised() {
        assert_eq!(
            parse_mail_domains(" MailHooks.cc. , dev.mailhooks.cc,, "),
            vec!["mailhooks.cc".to_string(), "dev.mailhooks.cc".to_string()]
        );
        assert!(parse_mail_domains(" , ").is_empty());
    }
}
