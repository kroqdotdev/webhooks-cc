mod config;
mod convex;
mod handlers;
mod redis;
mod workers;

use std::time::Duration;

use axum::routing::{any, get, post};
use axum::Router;
use tokio::net::TcpListener;
use tokio::signal;
use tokio::sync::watch;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

use config::Config;
use convex::client::ConvexClient;
use redis::RedisState;

const MAX_BODY_SIZE: usize = 100 * 1024; // 100KB

/// Shared application state passed to all handlers.
#[derive(Clone)]
pub struct AppState {
    pub redis: RedisState,
    pub convex: ConvexClient,
    pub config: Config,
}

#[tokio::main]
async fn main() {
    // Load config
    let config = Config::from_env();

    // Initialize tracing
    let log_level = if config.debug { "debug" } else { "info" };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| format!("webhooks_receiver={log_level},tower_http=info").into()),
        )
        .init();

    // Connect to Redis
    let redis_url = config.redis_url();
    let redis = RedisState::new(
        &redis_url,
        config.endpoint_cache_ttl_secs,
        config.quota_cache_ttl_secs,
    )
    .await
    .expect("failed to connect to Redis");

    tracing::info!(
        host = config.redis_host,
        port = config.redis_port,
        "connected to Redis"
    );

    // Create Convex client
    let convex = ConvexClient::new(&config, redis.clone());

    // Shutdown signal
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Spawn background workers
    workers::flush::spawn_flush_workers(
        redis.clone(),
        convex.clone(),
        config.flush_workers,
        config.batch_max_size,
        Duration::from_millis(config.flush_interval_ms),
        shutdown_rx.clone(),
    );
    workers::cache_warmer::spawn_cache_warmer(
        redis.clone(),
        convex.clone(),
        shutdown_rx.clone(),
    );

    // Build app state
    let state = AppState {
        redis,
        convex,
        config: config.clone(),
    };

    // CORS: allow all origins (public webhook capture endpoints)
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build router
    let app = Router::new()
        .route("/health", get(handlers::health::health))
        .route(
            "/internal/cache-invalidate/{slug}",
            post(handlers::cache_invalidate::cache_invalidate),
        )
        .route(
            "/w/{slug}/{*path}",
            any(handlers::webhook::handle_webhook),
        )
        .route(
            "/w/{slug}",
            any(handlers::webhook::handle_webhook_no_path),
        )
        .layer(RequestBodyLimitLayer::new(MAX_BODY_SIZE))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    // Start server
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = TcpListener::bind(&addr)
        .await
        .expect("failed to bind address");

    tracing::info!(port = config.port, "webhook receiver starting");

    // Serve with graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown_tx))
        .await
        .expect("server error");
}

async fn shutdown_signal(shutdown_tx: watch::Sender<bool>) {
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

    tracing::info!("shutdown signal received, flushing pending requests...");

    // Notify workers to drain and exit
    let _ = shutdown_tx.send(true);

    // Give workers time to flush
    tokio::time::sleep(Duration::from_secs(5)).await;

    tracing::info!("shutdown complete");
}
