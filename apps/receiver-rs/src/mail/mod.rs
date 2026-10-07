//! Internal mail ingestion API.
//!
//! The MX host (`apps/mx-rs`, on its own box) speaks SMTP and calls these
//! routes over the private network: `check` while the sender names each
//! recipient, `deliver` once the message is accepted. They run on a separate
//! listener (`MAIL_INGEST_ADDR`) that is published on the private interface
//! only and never routed through Caddy. Every request is HMAC-signed.

pub mod address;
pub mod auth;
pub mod handlers;
pub mod parse;

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::post;
use tower_http::limit::RequestBodyLimitLayer;

use crate::AppState;

/// A 10 MiB message is about 13.4 MiB as base64, plus the JSON around it.
const MAX_INGEST_BODY: usize = 16 * 1024 * 1024;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route(handlers::CHECK_PATH, post(handlers::check))
        // The delivery slot is taken before the handler reads the body.
        .route(
            handlers::DELIVER_PATH,
            post(handlers::deliver).layer(middleware::from_fn_with_state(
                state.clone(),
                handlers::delivery_slot,
            )),
        )
        // The `Bytes` extractor's own 2 MB default would cut messages short;
        // the layer below is the one limit that applies.
        .layer(DefaultBodyLimit::disable())
        .layer(RequestBodyLimitLayer::new(MAX_INGEST_BODY))
        // Outermost: unsigned or stale requests are refused before any body
        // is read. The handlers verify the full signature.
        .layer(middleware::from_fn(require_signature_headers))
        .with_state(state)
}

async fn require_signature_headers(request: Request, next: Next) -> Response {
    let now = chrono::Utc::now().timestamp();
    if let Err(e) = auth::precheck(request.headers(), now) {
        return handlers::unauthorized(request.uri().path(), &e);
    }
    next.run(request).await
}
