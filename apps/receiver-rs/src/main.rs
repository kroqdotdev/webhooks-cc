mod config;
pub mod crypto;
mod handlers;
mod mail;
pub mod metrics;
mod object_store;
mod observability;
pub mod verification;

use axum::Router;
use axum::routing::{any, get};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use tokio::net::TcpListener;
use tokio::signal;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

use config::Config;

/// Shared application state passed to all handlers.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    pub capture_limiter: std::sync::Arc<handlers::capture_limiter::CaptureLimiter>,
    /// Bounds how many mail deliveries are decoded and held in memory at once.
    pub mail_deliver_slots: std::sync::Arc<tokio::sync::Semaphore>,
    /// Object storage for captured email, when configured.
    pub object_store: Option<std::sync::Arc<object_store::ObjectStore>>,
    /// Customers' verified inbound domains, read once a minute.
    pub inbound_domains: std::sync::Arc<mail::domains::InboundDomains>,
}

fn main() {
    // StatOSS first, before the runtime starts its threads, so they and the
    // panic hook see the client. Dropping the guard at the end sends what is
    // queued.
    let _statoss = observability::init();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to start the Tokio runtime")
        .block_on(run(_statoss.is_enabled()));
}

async fn run(statoss: bool) {
    // Load config
    let config = Config::from_env();

    // Initialize tracing: stdout, a rotating log file, and StatOSS when set
    let log_level = if config.debug { "debug" } else { "info" };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| format!("webhooks_receiver={log_level},tower_http={log_level}").into());

    let log_dir = std::path::Path::new(&config.log_dir);
    std::fs::create_dir_all(log_dir).expect("failed to create log directory");
    let file_appender = tracing_appender::rolling::daily(log_dir, "receiver.log");

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_target(false)
                .with_writer(file_appender),
        )
        .with(statoss.then(observability::layer))
        .init();

    metrics::spawn_reporter(std::time::Duration::from_secs(60));

    // Connect to Postgres
    // acquire_timeout bounds how long a capture waits for a pooled connection
    // (sqlx default is 30s). A stalled DB then surfaces as PoolTimedOut, which
    // the webhook handler maps to 503 + Retry-After instead of a false 200.
    let pool = PgPoolOptions::new()
        .min_connections(config.pool_min)
        .max_connections(config.pool_max)
        .acquire_timeout(std::time::Duration::from_secs(
            config.pg_acquire_timeout_secs,
        ))
        .connect(&config.database_url)
        .await
        .expect("failed to connect to Postgres");

    tracing::info!(
        pool_min = config.pool_min,
        pool_max = config.pool_max,
        acquire_timeout_secs = config.pg_acquire_timeout_secs,
        "connected to Postgres"
    );

    // Build app state
    let state = AppState {
        pool,
        config: config.clone(),
        capture_limiter: std::sync::Arc::new(handlers::capture_limiter::CaptureLimiter::new(
            config.capture_max_inflight_per_account,
        )),
        mail_deliver_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(
            mail::handlers::DELIVER_CONCURRENCY,
        )),
        inbound_domains: std::sync::Arc::new(mail::domains::InboundDomains::new()),
        object_store: config
            .object_store
            .clone()
            .map(|c| std::sync::Arc::new(object_store::ObjectStore::new(c))),
    };

    // Private mail ingest listener for the MX host. Bound here, before the
    // public server starts, so a bad MAIL_INGEST_ADDR fails startup loudly
    // instead of leaving mail silently off.
    let mail_server = match config.mail_ingest_addr.as_deref() {
        Some(mail_addr) => {
            let mail_listener = TcpListener::bind(mail_addr)
                .await
                .expect("failed to bind MAIL_INGEST_ADDR");
            tracing::info!(
                addr = mail_addr,
                paused = config.mail_ingest_paused,
                domains = ?config.mail_domains,
                "mail ingest listener starting"
            );
            let mail_app = mail::router(state.clone());
            Some(tokio::spawn(async move {
                if let Err(e) = axum::serve(mail_listener, mail_app)
                    .with_graceful_shutdown(shutdown_signal())
                    .await
                {
                    tracing::error!(error = %e, "mail ingest server error");
                }
            }))
        }
        None => None,
    };

    // CORS: allow all origins on public webhook capture endpoints
    let public_cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Public routes: webhook capture + health
    let app = Router::new()
        .route("/health", get(handlers::health::health))
        .route("/w/{slug}/{*path}", any(handlers::webhook::handle_webhook))
        .route("/w/{slug}", any(handlers::webhook::handle_webhook_no_path))
        .layer(public_cors)
        .layer(RequestBodyLimitLayer::new(config.max_body_size))
        // A 5xx is a warning here: the handler logs its cause as the
        // error, so one failure is one issue, not two.
        .layer(
            TraceLayer::new_for_http()
                .on_response(
                    tower_http::trace::DefaultOnResponse::new().level(tracing::Level::DEBUG),
                )
                .on_failure(tower_http::trace::DefaultOnFailure::new().level(tracing::Level::WARN)),
        )
        .with_state(state);

    // Start server
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = TcpListener::bind(&addr)
        .await
        .expect("failed to bind address");

    tracing::info!(port = config.port, "webhook receiver starting");

    // Serve with graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");

    if let Some(handle) = mail_server
        && let Err(e) = handle.await
    {
        tracing::error!(error = %e, "mail ingest task ended abnormally");
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to listen for ctrl+c");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to listen for SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }

    tracing::info!("shutdown signal received");
}
