//! How the web app reaches the edge: `POST /close` and `/gate` on a
//! listener of its own ([`Config::control_listen`]), on the private network
//! only and never routed by Caddy, with the same bearer secret the edge uses
//! towards the web app. The web app records a stop or a new password first,
//! then tells the edge, so it applies at once. `POST /requests` answers with
//! the last requests of some shares, for the dashboard (meter.rs).
//!
//! Every 30 seconds ([`Config::sync_every`]) the edge also asks the web app
//! which of its shares and live sessions have ended there, which catches a
//! stop the edge never heard of (it was down, or the account was deleted
//! with its records), and which password each is behind. With it go the
//! bytes and requests visitors took, and back come the accounts past their
//! plan's data for the month.
//!
//! [`Config::control_listen`]: crate::config::Config
//! [`Config::sync_every`]: crate::config::Config

use std::convert::Infallible;
use std::time::Duration;

use http::{Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use tokio::net::TcpListener;

use crate::web::{Close, Gate};
use crate::{Body, State, header_str, pages};

#[derive(Deserialize)]
struct CloseRequest {
    closes: Vec<Close>,
}

#[derive(Deserialize)]
struct GateRequest {
    gates: Vec<Gate>,
}

#[derive(Deserialize)]
struct RequestsRequest {
    ids: Vec<String>,
}

/// Shares one `/requests` may ask about.
const REQUESTS_AT_ONCE: usize = 100;

pub async fn serve(state: State) -> anyhow::Result<()> {
    let listener = TcpListener::bind(state.config.control_listen).await?;
    tracing::info!(listen = %state.config.control_listen, "control up");
    let mut failures = crate::accept::Failures::new("control");
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                failures.failed(&e).await;
                continue;
            }
        };
        let state = state.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| {
                let state = state.clone();
                async move { Ok::<_, Infallible>(handle(state, req).await) }
            });
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(10))
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

/// Compares in constant time for equal lengths; the secret's length is no secret.
pub(crate) fn same_secret(given: &str, secret: &str) -> bool {
    given.len() == secret.len()
        && given
            .bytes()
            .zip(secret.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

async fn handle(state: State, req: Request<Incoming>) -> Response<Body> {
    let authorized = header_str(req.headers(), "authorization")
        .and_then(|a| a.strip_prefix("Bearer "))
        .is_some_and(|given| same_secret(given, &state.config.edge_secret));
    let path = req.uri().path().to_string();
    if !authorized
        || req.method() != Method::POST
        || !matches!(path.as_str(), "/close" | "/gate" | "/requests")
    {
        return json(
            StatusCode::NOT_FOUND,
            r#"{"error":"Not found"}"#.to_string(),
        );
    }
    let Ok(body) = Limited::new(req.into_body(), 64 * 1024).collect().await else {
        return json(
            StatusCode::BAD_REQUEST,
            r#"{"error":"Bad body"}"#.to_string(),
        );
    };
    if path == "/requests" {
        let Ok(request) = serde_json::from_slice::<RequestsRequest>(&body.to_bytes()) else {
            return json(
                StatusCode::BAD_REQUEST,
                r#"{"error":"Bad body"}"#.to_string(),
            );
        };
        let activity: serde_json::Map<String, serde_json::Value> = request
            .ids
            .into_iter()
            .take(REQUESTS_AT_ONCE)
            .map(|id| {
                let found = serde_json::to_value(state.meter.activity(&id)).unwrap_or_default();
                (id, found)
            })
            .collect();
        return json(
            StatusCode::OK,
            serde_json::json!({ "activity": activity }).to_string(),
        );
    }
    if path == "/gate" {
        let Ok(request) = serde_json::from_slice::<GateRequest>(&body.to_bytes()) else {
            return json(
                StatusCode::BAD_REQUEST,
                r#"{"error":"Bad body"}"#.to_string(),
            );
        };
        let changed = request
            .gates
            .into_iter()
            .filter(|g| state.registry.set_gate(&g.share_id, g.gate.clone()))
            .count();
        return json(StatusCode::OK, format!(r#"{{"changed":{changed}}}"#));
    }
    let Ok(request) = serde_json::from_slice::<CloseRequest>(&body.to_bytes()) else {
        return json(
            StatusCode::BAD_REQUEST,
            r#"{"error":"Bad body"}"#.to_string(),
        );
    };
    let closed = request
        .closes
        .iter()
        .filter(|c| state.registry.close_share(&c.share_id, &c.reason))
        .count();
    tracing::info!(
        asked = request.closes.len(),
        closed,
        "web app closed shares"
    );
    json(StatusCode::OK, format!(r#"{{"closed":{closed}}}"#))
}

fn json(status: StatusCode, body: String) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(pages::full(body))
        .unwrap()
}

/// One round: the open shares, and every batch of counts the web app has
/// not confirmed; the batches it took are not sent again.
async fn sync_once(state: &State) -> Option<crate::web::SyncAnswer> {
    let ids = state.registry.share_ids();
    let batches = state.meter.batches();
    let mut answer = state.web.sync(&ids, &batches).await?;
    let sent: Vec<String> = batches.into_iter().map(|b| b.id).collect();
    state.meter.confirmed(&sent);
    state.meter.set_over(std::mem::take(&mut answer.over));
    Some(answer)
}

/// The counts since the last round, handed over as the edge stops; a
/// shutdown waits for it no longer than a few seconds.
pub async fn last_sync(state: &State) {
    if tokio::time::timeout(Duration::from_secs(5), sync_once(state))
        .await
        .ok()
        .flatten()
        .is_none()
    {
        tracing::warn!("the last counts were not handed over");
    }
}

/// Asks the web app about the open shares every 30 seconds, handing
/// over what visitors took meanwhile. Also with no share open: an
/// account's allowance can open up again.
pub async fn sync(state: State) {
    let mut every = tokio::time::interval(state.config.sync_every);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        every.tick().await;
        // Said once a sync, not once each (held.rs).
        let taken = state.held.taken_stats();
        if taken.cut > 0 || taken.stalled > 0 {
            let (most_held_by, most_held) = state.held.most().unzip();
            tracing::warn!(
                cut = taken.cut,
                for_other_accounts = taken.made_room,
                stalled = taken.stalled,
                held_up = state.held.count(),
                most_held_by,
                most_held,
                "visitors' answers cut off: too many held up, or nothing taken for a minute"
            );
        }
        let Some(answer) = sync_once(&state).await else {
            continue;
        };
        for g in answer.gates {
            state.registry.set_gate(&g.share_id, g.gate);
        }
        for c in answer.close {
            if state.registry.close_share(&c.share_id, &c.reason) {
                tracing::info!(share = %c.share_id, "closed after the sync");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::same_secret;

    #[test]
    fn secrets_compare_exactly() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abd", "abc"));
        assert!(!same_secret("ab", "abc"));
        assert!(!same_secret("", "abc"));
    }
}
