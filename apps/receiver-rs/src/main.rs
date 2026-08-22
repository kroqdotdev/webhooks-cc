mod config;
pub mod crypto;
mod handlers;
pub mod metrics;
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
    pub notification_limiter: handlers::webhook::NotificationLimiter,
    pub redis: Option<redis::aio::MultiplexedConnection>,
}

/// Resource attributes shared by the trace and metric pipelines so AppSignal
/// files both under the same app (service.name + appsignal.config.* + host.name).
fn otel_resource(push_api_key: Option<&str>) -> opentelemetry_sdk::Resource {
    use opentelemetry::KeyValue;

    let hostname = gethostname::gethostname().to_string_lossy().into_owned();

    let mut attrs = vec![
        KeyValue::new("service.name", "webhooks-receiver"),
        KeyValue::new("appsignal.config.name", "webhooks-cc-receiver"),
        KeyValue::new("appsignal.config.environment", "production"),
        KeyValue::new("appsignal.config.language_integration", "rust"),
        KeyValue::new("host.name", hostname),
    ];
    if let Some(key) = push_api_key {
        attrs.push(KeyValue::new(
            "appsignal.config.push_api_key",
            key.to_string(),
        ));
    }

    opentelemetry_sdk::Resource::builder()
        .with_attributes(attrs)
        .build()
}

/// Build an OpenTelemetry tracer provider exporting spans to the given collector URL.
/// Returns `None` on failure so the receiver can continue without tracing (fail-open).
fn init_otel(
    collector_url: &str,
    push_api_key: Option<&str>,
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
            eprintln!(
                "failed to create OTLP span exporter: {e:?} — continuing without tracing export"
            );
            return None;
        }
    };

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(otel_resource(push_api_key))
        .build();

    Some(provider)
}

/// Build an OpenTelemetry meter provider exporting metrics to the given collector URL
/// and install it as the global provider (see `metrics.rs`).
/// Returns `None` on failure so the receiver can continue without metrics (fail-open).
fn init_metrics(
    collector_url: &str,
    push_api_key: Option<&str>,
) -> Option<opentelemetry_sdk::metrics::SdkMeterProvider> {
    use opentelemetry_otlp::MetricExporter;
    use opentelemetry_otlp::WithExportConfig;
    use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};

    let exporter = match MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{collector_url}/v1/metrics"))
        .build()
    {
        Ok(e) => e,
        Err(e) => {
            eprintln!(
                "failed to create OTLP metric exporter: {e:?}, continuing without metrics export"
            );
            return None;
        }
    };

    // PeriodicReader runs its own background thread and uses the blocking
    // reqwest client (crate default), so it needs no Tokio runtime handle.
    let reader = PeriodicReader::builder(exporter).build();

    let provider = SdkMeterProvider::builder()
        .with_reader(reader)
        .with_resource(otel_resource(push_api_key))
        .build();

    // Must happen before the first handler call: metrics.rs caches instruments
    // from whatever global provider is installed at first use.
    opentelemetry::global::set_meter_provider(provider.clone());

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
        .and_then(|url| init_otel(url, config.appsignal_push_api_key.as_deref()));

    // Initialize OTel metrics pipeline (no-op when collector URL is unset).
    // Installs the global meter provider before any request handler runs.
    let meter_provider = config
        .otel_collector_url
        .as_deref()
        .and_then(|url| init_metrics(url, config.appsignal_push_api_key.as_deref()));

    // Initialize tracing — stdout + rotating log file + optional OTel
    let log_level = if config.debug { "debug" } else { "info" };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| format!("webhooks_receiver={log_level},tower_http={log_level}").into());

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
        registry
            .with(
                Option::<
                    tracing_opentelemetry::OpenTelemetryLayer<_, opentelemetry_sdk::trace::Tracer>,
                >::None,
            )
            .init();
    }

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

    // Connect to Redis (optional — falls back to in-memory rate limiting).
    // NOTE: If Redis is down at startup, we use in-memory fallback for the
    // lifetime of this process. MultiplexedConnection handles reconnection
    // for established connections that drop, but not initial connection failures.
    let redis_conn = match config.redis_url.as_deref() {
        Some(url) => {
            match redis::Client::open(url) {
                Ok(client) => {
                    // 2s timeout — don't block startup if Redis is unreachable
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        client.get_multiplexed_async_connection(),
                    )
                    .await
                    {
                        Ok(Ok(conn)) => {
                            tracing::info!("connected to Redis");
                            Some(conn)
                        }
                        Ok(Err(e)) => {
                            tracing::warn!(error = %e, "failed to connect to Redis, using in-memory fallback");
                            None
                        }
                        Err(_) => {
                            tracing::warn!(
                                "Redis connection timed out (2s), using in-memory fallback"
                            );
                            None
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "invalid REDIS_URL, using in-memory fallback");
                    None
                }
            }
        }
        None => None,
    };

    // Build app state
    let state = AppState {
        pool,
        config: config.clone(),
        notification_limiter: handlers::webhook::new_notification_limiter(),
        redis: redis_conn,
    };

    // CORS: allow all origins on public webhook capture endpoints
    let public_cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Public routes: webhook capture + health
    let app =
        Router::new()
            .route("/health", get(handlers::health::health))
            .route("/w/{slug}/{*path}", any(handlers::webhook::handle_webhook))
            .route("/w/{slug}", any(handlers::webhook::handle_webhook_no_path))
            .layer(public_cors)
            .layer(RequestBodyLimitLayer::new(config.max_body_size))
            .layer(TraceLayer::new_for_http().on_response(
                tower_http::trace::DefaultOnResponse::new().level(tracing::Level::DEBUG),
            ))
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

    // Flush any remaining OTel metrics on shutdown
    if let Some(provider) = meter_provider
        && let Err(e) = provider.shutdown()
    {
        eprintln!("OTel metrics shutdown error: {e:?}");
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
