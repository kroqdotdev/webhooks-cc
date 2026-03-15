mod config;
mod handlers;

use axum::Router;
use axum::routing::{any, get};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::signal;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

use config::Config;

const MAX_BODY_SIZE: usize = 1_024 * 1_024; // 1MB

/// Shared application state passed to all handlers.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
}

#[tokio::main]
async fn main() {
    // Load config
    let config = Config::from_env();

    // Initialize Sentry — must be before tracing so the layer can capture events.
    // When DSN is empty/unset, sentry creates a disabled (no-op) client.
    let _sentry_guard = sentry::init((
        config.sentry_dsn.clone().unwrap_or_default(),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            environment: Some("production".into()),
            ..Default::default()
        },
    ));

    // Initialize tracing — stdout + rotating log file + Sentry
    let log_level = if config.debug { "debug" } else { "info" };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        format!("webhooks_receiver={log_level},tower_http=info").into()
    });

    let log_dir = std::path::Path::new(&config.log_dir);
    std::fs::create_dir_all(log_dir).expect("failed to create log directory");
    let file_appender = tracing_appender::rolling::daily(log_dir, "receiver.log");

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    // Sentry layer: captures WARN and ERROR as Sentry events, INFO+ as breadcrumbs.
    let sentry_layer =
        sentry::integrations::tracing::layer().event_filter(|md: &tracing::Metadata<'_>| {
            match *md.level() {
                tracing::Level::ERROR | tracing::Level::WARN => {
                    sentry::integrations::tracing::EventFilter::Event
                }
                _ => sentry::integrations::tracing::EventFilter::Breadcrumb,
            }
        });

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_target(false)
                .with_writer(file_appender),
        )
        .with(sentry_layer)
        .init();

    // Connect to Postgres
    let pool = PgPoolOptions::new()
        .min_connections(config.pool_min)
        .max_connections(config.pool_max)
        .connect(&config.database_url)
        .await
        .expect("failed to connect to Postgres");

    tracing::info!(
        pool_min = config.pool_min,
        pool_max = config.pool_max,
        "connected to Postgres"
    );

    // Build app state
    let state = AppState {
        pool,
        config: config.clone(),
    };

    // CORS: allow all origins on public webhook capture endpoints
    let public_cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Public routes: webhook capture + health
    let app = Router::new()
        .route("/health", get(handlers::health::health))
        .route(
            "/w/{slug}/{*path}",
            any(handlers::webhook::handle_webhook),
        )
        .route(
            "/w/{slug}",
            any(handlers::webhook::handle_webhook_no_path),
        )
        .layer(public_cors)
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
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
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
