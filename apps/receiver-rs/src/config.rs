use std::env;

#[derive(Clone, Debug)]
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
}

impl Config {
    pub fn from_env() -> Self {
        let convex_site_url =
            env::var("CONVEX_SITE_URL").expect("CONVEX_SITE_URL is required");
        let capture_shared_secret =
            env::var("CAPTURE_SHARED_SECRET").expect("CAPTURE_SHARED_SECRET is required");

        let redis_host = env::var("REDIS_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let redis_port = env::var("REDIS_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(6380);
        let redis_password = env::var("REDIS_PASSWORD").ok().filter(|s| !s.is_empty());
        let redis_db = env::var("REDIS_DB")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        let port = env::var("PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3001);

        let sentry_dsn = env::var("SENTRY_DSN").ok().filter(|s| !s.is_empty());
        let debug = env::var("RECEIVER_DEBUG").is_ok_and(|v| !v.is_empty());

        let flush_workers = env::var("FLUSH_WORKERS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(4);
        let batch_max_size = env::var("BATCH_MAX_SIZE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(50);
        let flush_interval_ms = env::var("FLUSH_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100);
        let endpoint_cache_ttl_secs = env::var("ENDPOINT_CACHE_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60);
        let quota_cache_ttl_secs = env::var("QUOTA_CACHE_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);

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
        }
    }

    pub fn redis_url(&self) -> String {
        match &self.redis_password {
            Some(pw) => format!(
                "redis://:{}@{}:{}/{}",
                pw, self.redis_host, self.redis_port, self.redis_db
            ),
            None => format!(
                "redis://{}:{}/{}",
                self.redis_host, self.redis_port, self.redis_db
            ),
        }
    }
}
