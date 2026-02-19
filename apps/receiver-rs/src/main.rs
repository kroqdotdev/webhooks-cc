mod clickhouse;
mod config;
mod convex;
mod handlers;
mod redis;
mod workers;

use std::time::Duration;

use axum::Router;
use axum::routing::{any, get, post};
use tokio::net::TcpListener;
use tokio::signal;
use tokio::sync::watch;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

use clickhouse::client::ClickHouseClient;
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
    pub clickhouse: Option<ClickHouseClient>,
}

#[tokio::main]
async fn main() {
    // Load config
    let config = Config::from_env();

    // Initialize tracing
    let log_level = if config.debug { "debug" } else { "info" };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                format!("webhooks_receiver={log_level},tower_http=info").into()
            }),
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

    // Initialize ClickHouse client (optional)
    let clickhouse = if let Some(url) = &config.clickhouse_url {
        let ch = ClickHouseClient::new(
            url,
            &config.clickhouse_user,
            &config.clickhouse_password,
            &config.clickhouse_database,
        );
        if ch.ping().await {
            tracing::info!(
                url,
                db = config.clickhouse_database,
                "ClickHouse dual-write enabled"
            );
        } else {
            tracing::warn!(
                url,
                "ClickHouse not reachable, dual-write enabled but may fail"
            );
        }
        Some(ch)
    } else {
        tracing::info!("ClickHouse dual-write disabled (CLICKHOUSE_HOST not set)");
        None
    };

    // Shutdown signal
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Spawn background workers
    workers::flush::spawn_flush_workers(
        redis.clone(),
        convex.clone(),
        clickhouse.clone(),
        config.flush_workers,
        config.batch_max_size,
        Duration::from_millis(config.flush_interval_ms),
        shutdown_rx.clone(),
    );
    workers::cache_warmer::spawn_cache_warmer(redis.clone(), convex.clone(), shutdown_rx.clone());
    workers::clickhouse_retention::spawn_clickhouse_retention_worker(
        convex.clone(),
        clickhouse.clone(),
        shutdown_rx.clone(),
    );

    // Build app state
    let state = AppState {
        redis,
        convex,
        config: config.clone(),
        clickhouse,
    };

    // CORS: allow all origins only on public webhook capture endpoints.
    // Internal endpoints (/search, /internal/*) have no CORS (server-to-server only).
    let public_cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Public routes: webhook capture + health (need permissive CORS)
    let public_routes = Router::new()
        .route("/health", get(handlers::health::health))
        .route("/w/{slug}/{*path}", any(handlers::webhook::handle_webhook))
        .route("/w/{slug}", any(handlers::webhook::handle_webhook_no_path))
        .layer(public_cors);

    // Internal routes: no CORS (server-to-server only, authenticated via shared secret)
    let internal_routes = Router::new()
        .route("/search", get(handlers::search::search))
        .route(
            "/internal/cache-invalidate/{slug}",
            post(handlers::cache_invalidate::cache_invalidate),
        );

    // Build router
    let app = public_routes
        .merge(internal_routes)
        .layer(RequestBodyLimitLayer::new(MAX_BODY_SIZE))
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
