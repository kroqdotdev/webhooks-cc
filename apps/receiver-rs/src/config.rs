use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use std::env;

#[derive(Clone)]
pub struct Config {
    pub convex_site_url: String,
    pub capture_shared_secret: String,
    pub redis_host: String,
    pub redis_port: u16,
    pub redis_password: Option<String>,
    pub redis_db: u8,
    pub port: u16,
    pub sentry_dsn: Option<String>,
    pub debug: bool,
    pub flush_workers: usize,
    pub batch_max_size: usize,
    pub flush_interval_ms: u64,
    pub endpoint_cache_ttl_secs: u64,
    pub quota_cache_ttl_secs: u64,
    // ClickHouse (optional — disabled when clickhouse_url is None)
    pub clickhouse_url: Option<String>,
    pub clickhouse_user: String,
    pub clickhouse_password: String,
    pub clickhouse_database: String,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("convex_site_url", &self.convex_site_url)
            .field("capture_shared_secret", &"[REDACTED]")
            .field("redis_host", &self.redis_host)
            .field("redis_port", &self.redis_port)
            .field(
                "redis_password",
                &self.redis_password.as_ref().map(|_| "[REDACTED]"),
            )
            .field("redis_db", &self.redis_db)
            .field("port", &self.port)
            .field("debug", &self.debug)
            .field("flush_workers", &self.flush_workers)
            .field("batch_max_size", &self.batch_max_size)
            .field("flush_interval_ms", &self.flush_interval_ms)
            .field("endpoint_cache_ttl_secs", &self.endpoint_cache_ttl_secs)
            .field("quota_cache_ttl_secs", &self.quota_cache_ttl_secs)
            .field("clickhouse_url", &self.clickhouse_url)
            .field("clickhouse_user", &self.clickhouse_user)
            .field("clickhouse_password", &"[REDACTED]")
            .field("clickhouse_database", &self.clickhouse_database)
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
        let convex_site_url = env::var("CONVEX_SITE_URL").expect("CONVEX_SITE_URL is required");
        let capture_shared_secret =
            env::var("CAPTURE_SHARED_SECRET").expect("CAPTURE_SHARED_SECRET is required");

        let redis_host = env::var("REDIS_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let redis_port: u16 = parse_env_or("REDIS_PORT", 6380);
        let redis_password = env::var("REDIS_PASSWORD").ok().filter(|s| !s.is_empty());
        let redis_db: u8 = parse_env_or("REDIS_DB", 0);

        let port: u16 = parse_env_or("PORT", 3001);

        let sentry_dsn = env::var("SENTRY_DSN").ok().filter(|s| !s.is_empty());
        let debug = env::var("RECEIVER_DEBUG").is_ok_and(|v| !v.is_empty());

        let flush_workers: usize = parse_env_or("FLUSH_WORKERS", 4);
        let batch_max_size: usize = parse_env_or("BATCH_MAX_SIZE", 50);
        let flush_interval_ms: u64 = parse_env_or("FLUSH_INTERVAL_MS", 100);
        let endpoint_cache_ttl_secs: u64 = parse_env_or("ENDPOINT_CACHE_TTL_SECS", 300);
        let quota_cache_ttl_secs: u64 = parse_env_or("QUOTA_CACHE_TTL_SECS", 300);

        // ClickHouse — optional, disabled when CLICKHOUSE_HOST is empty/unset.
        // Builds URL from CLICKHOUSE_HOST + CLICKHOUSE_PORT (matches Redis pattern).
        let clickhouse_host = env::var("CLICKHOUSE_HOST").ok().filter(|s| !s.is_empty());
        let clickhouse_port: u16 = parse_env_or("CLICKHOUSE_PORT", 8123);
        let clickhouse_scheme = env::var("CLICKHOUSE_SCHEME").unwrap_or_else(|_| "http".into());
        let clickhouse_url =
            clickhouse_host.map(|host| format!("{clickhouse_scheme}://{host}:{clickhouse_port}"));
        let clickhouse_user = env::var("CLICKHOUSE_USER").unwrap_or_else(|_| "default".into());
        let clickhouse_password = env::var("CLICKHOUSE_PASSWORD").unwrap_or_default();
        let clickhouse_database =
            env::var("CLICKHOUSE_DATABASE").unwrap_or_else(|_| "webhooks".into());

        // Validate database name to prevent SQL injection via env var
        assert!(
            clickhouse_database
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_'),
            "CLICKHOUSE_DATABASE must contain only alphanumeric characters and underscores"
        );

        assert!(flush_workers > 0, "FLUSH_WORKERS must be > 0");
        assert!(batch_max_size > 0, "BATCH_MAX_SIZE must be > 0");

        Self {
            convex_site_url,
            capture_shared_secret,
            redis_host,
            redis_port,
            redis_password,
            redis_db,
            port,
            sentry_dsn,
            debug,
            flush_workers,
            batch_max_size,
            flush_interval_ms,
            endpoint_cache_ttl_secs,
            quota_cache_ttl_secs,
            clickhouse_url,
            clickhouse_user,
            clickhouse_password,
            clickhouse_database,
        }
    }

    pub fn redis_url(&self) -> String {
        match &self.redis_password {
            Some(pw) => format!(
                "redis://:{}@{}:{}/{}",
                utf8_percent_encode(pw, NON_ALPHANUMERIC),
                self.redis_host,
                self.redis_port,
                self.redis_db
            ),
            None => format!(
                "redis://{}:{}/{}",
                self.redis_host, self.redis_port, self.redis_db
            ),
        }
    }
}
