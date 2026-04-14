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
    pub otel_collector_url: Option<String>,
    pub appsignal_push_api_key: Option<String>,
    pub notify_proxy_url: Option<String>,
    pub notify_secret: Option<String>,
    pub redis_url: Option<String>,
    pub max_body_size: usize,
    pub notification_cooldown_secs: u64,
    pub notification_timeout_secs: u64,
    /// AES-256-GCM key for decrypting signing secrets (base64-decoded, 32 bytes).
    /// Optional: when absent, signature verification is silently skipped.
    pub signing_secret_key: Option<[u8; 32]>,
    /// External webhook base URL (e.g., "https://go.webhooks.cc").
    /// Used to construct the full URL for Twilio signature verification.
    pub webhook_base_url: Option<String>,
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
            .field("otel_collector_url", &self.otel_collector_url.as_ref().map(|_| "[REDACTED]"))
            .field("appsignal_push_api_key", &self.appsignal_push_api_key.as_ref().map(|_| "[REDACTED]"))
            .field("notify_proxy_url", &self.notify_proxy_url)
            .field("notify_secret", &self.notify_secret.as_ref().map(|_| "[REDACTED]"))
            .field("redis_url", &self.redis_url.as_ref().map(|_| "[REDACTED]"))
            .field("max_body_size", &self.max_body_size)
            .field("notification_cooldown_secs", &self.notification_cooldown_secs)
            .field("notification_timeout_secs", &self.notification_timeout_secs)
            .field("signing_secret_key", &self.signing_secret_key.as_ref().map(|_| "[REDACTED]"))
            .field("webhook_base_url", &self.webhook_base_url)
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
        let otel_collector_url = env::var("APPSIGNAL_COLLECTOR_URL")
            .ok()
            .filter(|v| !v.is_empty());
        let appsignal_push_api_key = env::var("APPSIGNAL_PUSH_API_KEY")
            .ok()
            .filter(|v| !v.is_empty());
        let notify_proxy_url = env::var("NOTIFY_PROXY_URL")
            .ok()
            .filter(|v| !v.is_empty());
        let notify_secret = env::var("NOTIFY_SECRET")
            .ok()
            .filter(|v| !v.is_empty());
        let redis_url = env::var("REDIS_URL")
            .ok()
            .filter(|v| !v.is_empty());
        let max_body_size: usize = parse_env_or("RECEIVER_MAX_BODY_SIZE", 1_048_576).max(1024);
        let notification_cooldown_secs: u64 = parse_env_or("NOTIFICATION_COOLDOWN_SECS", 1).max(1);
        let notification_timeout_secs: u64 = parse_env_or("NOTIFICATION_TIMEOUT_SECS", 5).max(2);
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
            .filter(|v| !v.is_empty())
            .map(|v| v.trim_end_matches('/').to_string());

        Self {
            database_url,
            capture_shared_secret,
            port,
            debug,
            log_dir,
            pool_min,
            pool_max,
            otel_collector_url,
            appsignal_push_api_key,
            notify_proxy_url,
            notify_secret,
            redis_url,
            max_body_size,
            notification_cooldown_secs,
            notification_timeout_secs,
            signing_secret_key,
            webhook_base_url,
        }
    }
}
