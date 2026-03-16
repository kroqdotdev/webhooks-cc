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

        Self {
            database_url,
            capture_shared_secret,
            port,
            debug,
            log_dir,
            pool_min,
            pool_max,
            otel_collector_url,
        }
    }
}
