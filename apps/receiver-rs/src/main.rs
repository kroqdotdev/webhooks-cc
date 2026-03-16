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

/// Build an OpenTelemetry tracer provider exporting spans to the given collector URL.
/// Returns `None` on failure so the receiver can continue without tracing (fail-open).
fn init_otel(
    collector_url: &str,
) -> Option<opentelemetry_sdk::trace::SdkTracerProvider> {
    use opentelemetry_otlp::SpanExporter;
    use opentelemetry_otlp::WithExportConfig;
    use opentelemetry_sdk::trace::SdkTracerProvider;

    let exporter = match SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{collector_url}/v1/traces"))
        .build()
    {
        Ok(e) => e,
        Err(e) => {
            eprintln!("failed to create OTLP span exporter: {e:?} — continuing without tracing export");
            return None;
        }
    };

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(
            opentelemetry_sdk::Resource::builder()
                .with_service_name("webhooks-receiver")
                .build(),
        )
        .build();

    Some(provider)
}

#[tokio::main]
async fn main() {
    // Load config
    let config = Config::from_env();

    // Initialize OTel pipeline (no-op when collector URL is unset)
    let otel_provider = config
        .otel_collector_url
        .as_deref()
        .and_then(init_otel);

    // Initialize tracing — stdout + rotating log file + optional OTel
    let log_level = if config.debug { "debug" } else { "info" };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        format!("webhooks_receiver={log_level},tower_http={log_level}").into()
    });

    let log_dir = std::path::Path::new(&config.log_dir);
    std::fs::create_dir_all(log_dir).expect("failed to create log directory");
    let file_appender = tracing_appender::rolling::daily(log_dir, "receiver.log");

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let registry = tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_target(false)
                .with_writer(file_appender),
        );

    // Add OTel layer only when provider is active
    if let Some(ref provider) = otel_provider {
        use opentelemetry::trace::TracerProvider;
        let tracer = provider.tracer("webhooks-receiver");
        let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
        registry.with(otel_layer).init();
    } else {
        registry.with(Option::<tracing_opentelemetry::OpenTelemetryLayer<_, opentelemetry_sdk::trace::Tracer>>::None).init();
    }

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
        .layer(
            TraceLayer::new_for_http()
                .on_response(
                    tower_http::trace::DefaultOnResponse::new()
                        .level(tracing::Level::DEBUG),
                ),
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

    // Flush any remaining OTel spans on shutdown
    if let Some(provider) = otel_provider
        && let Err(e) = provider.shutdown()
    {
        eprintln!("OTel shutdown error: {e:?}");
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
