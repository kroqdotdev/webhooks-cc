//! Live captures (`whk tunnel --live`, migration 00092).
//!
//! An endpoint with an open live session has its HTTP captures relayed to
//! the tunnel edge (`EDGE_RELAY_URL`), which sends each one down the CLI's
//! tunnel to the local app; the sender gets the app's own answer instead of
//! the mock response. The capture is stored, billed and queued first, and
//! the relay runs after the capture slot and its database connection are
//! released, so a slow app never holds the pool.
//!
//! The edge marks its answers with `x-whk-live`: `answered` when the app
//! answered (whatever its status), or what stood in for an answer:
//! `offline` (502, no session), `timeout` (504, no answer within 25 s),
//! `unreachable` (502, nothing on the port or the tunnel dropped), `busy`
//! (503, the account's streams are in use), `refused` (502, an answer the
//! edge does not pass back: a download, a type no API answers with, or one
//! over [`MAX_ANSWER_BYTES`]; or, as a 404, our own secret or path, which is
//! a fault on our side). The header is removed before the answer goes out.
//! When the edge itself cannot be reached the sender gets 502, and a capture
//! past the account's live relays gets 503 with `Retry-After`.
//!
//! The app's answer streams through to the sender as it arrives; only its
//! first 64 KB are kept on the side. An answer that runs past
//! [`MAX_ANSWER_BYTES`] is broken off, so the sender sees a failed answer
//! rather than a clean, cut one, and the row records it as refused.
//!
//! The app gets `X-Forwarded-Host`, `X-Forwarded-Proto` and
//! `X-Forwarded-Prefix` (`/w/<slug>`), so it can rebuild the public URL the
//! sender signed (Twilio signs the whole URL). What the sender got is then recorded on
//! the row (`record_live_response()`: status, headers, those first 64 KB as
//! text or base64) once the answer has gone out, in the background and
//! never changing the answer. Relays in flight are capped per account and
//! across all accounts, so live traffic cannot take the receiver's memory
//! or connections from ordinary captures.

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use bytes::BytesMut;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};

use super::capture_limiter::{CaptureLimiter, CapturePermit};
use crate::metrics;

/// Request header carrying the shared secret to the edge's relay port.
pub const RELAY_AUTH_HEADER: &str = "x-whk-relay-auth";
/// The captured request's id, on the relay call: the edge names it to the CLI
/// (so `whk tunnel --live` forwards none of its captures twice) and takes it
/// off before the app sees the request. A sender's own copy is dropped.
pub const REQUEST_ID_HEADER: &str = "x-whk-request-id";

/// When the last "live but not configured" warning went out (seconds since
/// the epoch), to warn at most once a minute.
static NOT_CONFIGURED_WARNED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A capture the database calls live while this receiver has no relay
/// (`EDGE_RELAY_URL` unset): it is answered like any capture, counted as
/// `live.not_configured`, and warned about at most once a minute, since the
/// CLI shows "live" while senders get the mock.
pub fn not_configured() {
    crate::metrics::live("not_configured");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last = NOT_CONFIGURED_WARNED.load(std::sync::atomic::Ordering::Relaxed);
    if now.saturating_sub(last) >= 60
        && NOT_CONFIGURED_WARNED
            .compare_exchange(
                last,
                now,
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    {
        tracing::warn!(
            "a live endpoint captured, but EDGE_RELAY_URL is not set: answered like any capture"
        );
    }
}
/// The edge's mark on its answers.
pub const LIVE_HEADER: &str = "x-whk-live";
/// How much of an answer's body the row keeps.
pub const RECORDED_BODY_BYTES: usize = 64 * 1024;
/// The most of an answer passed on: a webhook's answer is a few bytes of
/// JSON or text. The edge refuses a longer stated length and cuts a stream a
/// little past this, so this cap is the one that ends it and says so.
pub const MAX_ANSWER_BYTES: usize = 1024 * 1024;
/// The edge gives the app 25 s for the head and caps bodies at about 1 MB;
/// this bounds the whole exchange from the receiver's side.
const RELAY_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Seconds a sender is asked to wait when the account's live relays are full.
const BUSY_RETRY_AFTER_SECS: &str = "5";

/// Hop-by-hop headers (RFC 9110 7.6.1), plus those the client recomputes.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
];

/// Answer headers that never go out on the capture host: a cookie set there
/// could be scoped to the parent domain, and the security headers are ours
/// to set (the same list mock responses skip).
const BLOCKED_ANSWER_HEADERS: &[&str] = &[
    "set-cookie",
    "strict-transport-security",
    "content-security-policy",
    "x-frame-options",
];

#[derive(Clone)]
pub struct LiveConfig {
    /// The edge's relay listener, without a trailing slash.
    pub relay_url: String,
    pub secret: String,
    /// Live relays in flight per billing account; 0 turns the cap off.
    pub max_inflight_per_account: usize,
    /// Live relays in flight across all accounts; 0 turns the cap off.
    pub max_inflight_total: usize,
    /// The capture host the app is told the sender used
    /// (`X-Forwarded-Host`), from the public capture URL; without it, the
    /// request's own Host.
    pub public_host: Option<String>,
    /// Whether the public capture URL is https (`X-Forwarded-Proto`).
    pub public_https: bool,
}

impl std::fmt::Debug for LiveConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveConfig")
            .field("relay_url", &self.relay_url)
            .field("secret", &"[REDACTED]")
            .field("max_inflight_per_account", &self.max_inflight_per_account)
            .field("max_inflight_total", &self.max_inflight_total)
            .field("public_host", &self.public_host)
            .field("public_https", &self.public_https)
            .finish()
    }
}

/// What a live capture was answered with, for `record_live_response()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveRecord {
    pub status: u16,
    pub headers: serde_json::Map<String, serde_json::Value>,
    pub body: String,
    pub body_truncated: bool,
    /// `utf8` or `base64`.
    pub body_encoding: &'static str,
    pub ms: u32,
    /// `answered`, `offline`, `timeout`, `unreachable`, `busy` or `refused`.
    pub outcome: &'static str,
}

pub struct LiveRelay {
    client: reqwest::Client,
    config: LiveConfig,
    limiter: CaptureLimiter,
    /// Relays in flight across all accounts.
    total: Option<Arc<Semaphore>>,
}

/// What to record for a relayed capture, delivered once the answer has gone
/// out to the sender (or at once for a stand-in).
pub type Recorded = oneshot::Receiver<LiveRecord>;

/// One live capture to relay.
pub struct LiveRequest<'a> {
    pub endpoint_id: &'a str,
    /// The endpoint's slug, for `X-Forwarded-Prefix: /w/<slug>`.
    pub slug: &'a str,
    /// The billing key the capture returned, for the per-account cap.
    pub limit_key: &'a str,
    pub method: &'a Method,
    /// The path after `/w/<slug>` as the sender sent it (still encoded),
    /// starting with `/`, and the query.
    pub rest: &'a str,
    pub raw_query: Option<&'a str>,
    pub headers: &'a HeaderMap,
    pub body: Bytes,
    /// The captured request's id, sent to the edge in [`REQUEST_ID_HEADER`]
    /// so the CLI knows the relay carried it.
    pub request_id: Option<&'a str>,
}

/// A [`LiveRequest`] that owns its parts, to relay in a task of its own.
pub struct OwnedLiveRequest {
    pub endpoint_id: String,
    pub slug: String,
    pub limit_key: String,
    pub method: Method,
    pub rest: String,
    pub raw_query: Option<String>,
    pub headers: HeaderMap,
    pub body: Bytes,
    pub request_id: Option<String>,
}

impl OwnedLiveRequest {
    fn borrowed(&self) -> LiveRequest<'_> {
        LiveRequest {
            endpoint_id: &self.endpoint_id,
            slug: &self.slug,
            limit_key: &self.limit_key,
            method: &self.method,
            rest: &self.rest,
            raw_query: self.raw_query.as_deref(),
            headers: &self.headers,
            body: self.body.clone(),
            request_id: self.request_id.as_deref(),
        }
    }
}

/// Relays a capture in a task of its own and hands what to record to
/// `on_record`, from that task. A sender that hangs up while the app is
/// still answering (Slack gives up after 3 seconds) drops the handler, not
/// the relay: the row still gets the app's answer and the status it gave,
/// and an answer cut short by the hang-up is recorded as cut.
pub fn spawn_relay(
    relay: Arc<LiveRelay>,
    request: OwnedLiveRequest,
    on_record: impl FnOnce(Recorded) + Send + 'static,
) -> tokio::task::JoinHandle<Response> {
    tokio::spawn(async move {
        let (response, recorded) = relay.relay(request.borrowed()).await;
        on_record(recorded);
        response
    })
}

impl LiveRelay {
    pub fn new(config: LiveConfig) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(RELAY_TIMEOUT)
            // Redirects are the app's answer, for the sender to follow.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build the live relay client");
        Self {
            client,
            limiter: CaptureLimiter::new(config.max_inflight_per_account),
            total: (config.max_inflight_total > 0)
                .then(|| Arc::new(Semaphore::new(config.max_inflight_total))),
            config,
        }
    }

    /// Relays one capture and returns what the sender gets, and what to
    /// record on the row once the answer has gone out.
    pub async fn relay(&self, request: LiveRequest<'_>) -> (Response, Recorded) {
        let (response, record) = self.relay_inner(request).await;
        match record {
            Ok(record) => {
                let (tx, rx) = oneshot::channel();
                let _ = tx.send(record);
                (response, rx)
            }
            Err(rx) => (response, rx),
        }
    }

    async fn relay_inner(
        &self,
        request: LiveRequest<'_>,
    ) -> (Response, Result<LiveRecord, Recorded>) {
        let started = Instant::now();
        let busy = || {
            metrics::live("receiver_busy");
            let mut response = (StatusCode::SERVICE_UNAVAILABLE, "retry").into_response();
            response.headers_mut().insert(
                "retry-after",
                HeaderValue::from_static(BUSY_RETRY_AFTER_SECS),
            );
            (response, Ok(stand_in(503, "busy", started)))
        };
        // No waiting: a sender over either cap is asked to retry, and its
        // capture is already stored. The permits ride with the answer's
        // body, so a slow sender keeps its slot until the answer is out.
        let Some(account_permit) = self
            .limiter
            .acquire(request.limit_key, Duration::ZERO)
            .await
        else {
            return busy();
        };
        let total_permit = match &self.total {
            Some(total) => match total.clone().try_acquire_owned() {
                Ok(permit) => Some(permit),
                Err(_) => return busy(),
            },
            None => None,
        };

        let Some(url) = relay_url(
            &self.config.relay_url,
            request.endpoint_id,
            request.rest,
            request.raw_query,
        ) else {
            metrics::live("bad_path");
            return (
                (StatusCode::BAD_REQUEST, "bad path").into_response(),
                Ok(stand_in(400, "refused", started)),
            );
        };
        let mut headers = relay_headers(request.headers);
        forwarded_headers(
            &mut headers,
            Forwarded {
                host: self
                    .config
                    .public_host
                    .as_deref()
                    .or_else(|| request.headers.get("host").and_then(|h| h.to_str().ok())),
                https: self.config.public_https,
                slug: request.slug,
                // After the prefix, as the docs and the CLI define it: the
                // signed URL is proto://host + X-Forwarded-Prefix + this.
                uri: &match request.raw_query.filter(|q| !q.is_empty()) {
                    Some(query) => format!("{}?{query}", request.rest),
                    None => request.rest.to_string(),
                },
                sender: &super::webhook::real_ip(request.headers),
            },
        );
        if let Ok(secret) = HeaderValue::from_str(&self.config.secret) {
            headers.insert(HeaderName::from_static(RELAY_AUTH_HEADER), secret);
        }
        if let Some(id) = request
            .request_id
            .and_then(|id| HeaderValue::from_str(id).ok())
        {
            headers.insert(HeaderName::from_static(REQUEST_ID_HEADER), id);
        }
        let sent = self
            .client
            .request(request.method.clone(), url)
            .headers(headers)
            .body(request.body)
            .send()
            .await;
        let answer = match sent {
            Ok(answer) => answer,
            Err(e) => {
                let timed_out = e.is_timeout();
                metrics::live(if timed_out {
                    "edge_timeout"
                } else {
                    "edge_unreachable"
                });
                tracing::warn!(timed_out, error = %e, "live relay: edge not reachable");
                return if timed_out {
                    (
                        (StatusCode::GATEWAY_TIMEOUT, "live tunnel timed out").into_response(),
                        Ok(stand_in(504, "timeout", started)),
                    )
                } else {
                    (
                        (StatusCode::BAD_GATEWAY, "live tunnel unreachable").into_response(),
                        Ok(stand_in(502, "unreachable", started)),
                    )
                };
            }
        };

        let status = answer.status();
        let outcome = outcome_of(answer.headers().get(LIVE_HEADER));
        if outcome == "refused" && status == StatusCode::NOT_FOUND {
            // The edge did not take our secret or path: a configuration
            // fault on our side, not the sender's. (Its other refusals are
            // 502s about the app's answer, passed on below.)
            metrics::live("refused");
            tracing::error!("live relay: the edge refused the relay (check EDGE_SECRET)");
            return (
                (StatusCode::BAD_GATEWAY, "live tunnel unreachable").into_response(),
                Ok(stand_in(502, "unreachable", started)),
            );
        }
        metrics::live(outcome);
        let sent_headers = sent_answer_headers(answer.headers());
        let mut builder = axum::http::Response::builder().status(status);
        for (name, value) in sent_headers.iter() {
            builder = builder.header(name, value);
        }
        // An answer with no body (204, 304, HEAD, or a stated length of 0)
        // is whole as soon as its head is: the server never reads such a
        // body, so its end would never be seen.
        let bodiless = status == StatusCode::NO_CONTENT
            || status == StatusCode::NOT_MODIFIED
            || *request.method == Method::HEAD
            || answer
                .headers()
                .get(axum::http::header::CONTENT_LENGTH)
                .and_then(|l| l.to_str().ok())
                .is_some_and(|l| l.trim() == "0");
        let (tx, rx) = oneshot::channel();
        let recorder = Recorder {
            base: LiveRecord {
                status: status.as_u16(),
                // What the sender got, not what the app sent.
                headers: recorded_headers(&sent_headers),
                outcome,
                ..recorded_body(b"")
            },
            started,
            kept: BytesMut::new(),
            total: 0,
            complete: bodiless,
            too_large: false,
            tx: Some(tx),
            _permits: (account_permit, total_permit),
        };
        let body = Body::from_stream(answer_stream(answer, recorder));
        match builder.body(body) {
            Ok(response) => (response, Err(rx)),
            Err(_) => (
                (StatusCode::BAD_GATEWAY, "live tunnel unreachable").into_response(),
                Ok(stand_in(502, "unreachable", started)),
            ),
        }
    }
}

/// Keeps the start of an answer while it streams to the sender, and hands
/// over what to record when the stream ends, fails or is dropped (a sender
/// that went away): then the record says the body was cut.
struct Recorder {
    base: LiveRecord,
    started: Instant,
    kept: BytesMut,
    total: usize,
    complete: bool,
    /// Broken off at [`MAX_ANSWER_BYTES`].
    too_large: bool,
    tx: Option<oneshot::Sender<LiveRecord>>,
    _permits: (CapturePermit, Option<OwnedSemaphorePermit>),
}

impl Recorder {
    fn take(&mut self, chunk: &[u8]) {
        self.total += chunk.len();
        let room = RECORDED_BODY_BYTES.saturating_sub(self.kept.len());
        self.kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let Some(tx) = self.tx.take() else {
            return;
        };
        if self.too_large {
            metrics::live("too_large");
        } else if !self.complete {
            metrics::live("body_failed");
        }
        let truncated = !self.complete || self.total > RECORDED_BODY_BYTES;
        let mut record = LiveRecord {
            ms: elapsed_ms(self.started),
            ..std::mem::replace(&mut self.base, recorded_body(b""))
        };
        if self.too_large {
            record.outcome = "refused";
        }
        let kept = recorded_body_of(&self.kept, truncated);
        record.body = kept.body;
        record.body_truncated = kept.body_truncated;
        record.body_encoding = kept.body_encoding;
        let _ = tx.send(record);
    }
}

/// The answer's body, chunk by chunk as the edge sends it. Past
/// [`MAX_ANSWER_BYTES`] it is broken off with an error, so the sender sees
/// an answer that failed, never a clean one that was cut short.
fn answer_stream(
    answer: reqwest::Response,
    recorder: Recorder,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send {
    futures_util::stream::unfold(Some((answer, recorder)), |state| async move {
        let (mut answer, mut recorder) = state?;
        match answer.chunk().await {
            Ok(Some(chunk)) => {
                let room = MAX_ANSWER_BYTES - recorder.total;
                if chunk.len() > room {
                    // What fits is kept for the row; the sender gets an
                    // error in place of the rest.
                    recorder.take(&chunk[..room]);
                    recorder.too_large = true;
                    return Some((Err(std::io::Error::other("live answer too large")), None));
                }
                recorder.take(&chunk);
                Some((Ok(chunk), Some((answer, recorder))))
            }
            Ok(None) => {
                recorder.complete = true;
                None
            }
            Err(e) => {
                tracing::warn!(error = %e, "live relay: the answer's body was cut off");
                Some((Err(std::io::Error::other(e)), None))
            }
        }
    })
}

/// Records what the sender got on the request row in the background, once
/// the answer has gone out, twice at most, as the answer correction does. A
/// failure is logged and counted, never more.
pub fn record(pool: &sqlx::PgPool, request_id: &str, recorded: Recorded) {
    let pool = pool.clone();
    let request_id = request_id.to_string();
    tokio::spawn(async move {
        let Ok(record) = recorded.await else {
            return;
        };
        for attempt in 1..=2 {
            let result = sqlx::query(
                "SELECT public.record_live_response($1::uuid, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(&request_id)
            .bind(i32::from(record.status))
            .bind(serde_json::Value::Object(record.headers.clone()))
            .bind(&record.body)
            .bind(record.body_truncated)
            .bind(i32::try_from(record.ms).unwrap_or(i32::MAX))
            .bind(record.body_encoding)
            .bind(record.outcome)
            .execute(&pool)
            .await;
            match result {
                Ok(_) => return,
                Err(e) if attempt == 2 => {
                    metrics::live("record_failed");
                    tracing::warn!(request_id, error = %e, "failed to record a live answer");
                }
                Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
            }
        }
    });
}

/// `<relay>/v1/live/<endpoint id><rest>[?query]`.
pub fn relay_url(
    base: &str,
    endpoint_id: &str,
    rest: &str,
    raw_query: Option<&str>,
) -> Option<reqwest::Url> {
    let rest = if rest.starts_with('/') { rest } else { "/" };
    let mut url = format!("{}/v1/live/{endpoint_id}{rest}", base.trim_end_matches('/'));
    if let Some(query) = raw_query.filter(|q| !q.is_empty()) {
        url.push('?');
        url.push_str(query);
    }
    // The sender writes `rest`. Parsing resolves `..` and `%2e%2e` segments,
    // so a path such as `/../<other id>/x` would otherwise reach another
    // endpoint's live session with our relay secret. Whatever the parse made
    // of it must still sit under this endpoint.
    let parsed = reqwest::Url::parse(&url).ok()?;
    let own = format!("/v1/live/{endpoint_id}");
    let path = parsed.path();
    let base_path = reqwest::Url::parse(base)
        .ok()
        .map(|b| b.path().trim_end_matches('/').to_string())
        .unwrap_or_default();
    let within = path
        .strip_prefix(base_path.as_str())
        .is_some_and(|p| p == own || p.starts_with(&format!("{own}/")));
    within.then_some(parsed)
}

/// The part of the original path after `/w/<slug>`, still encoded: `/` when
/// there is none.
pub fn path_after_slug(path: &str) -> &str {
    let after_w = path.strip_prefix("/w/").unwrap_or("");
    match after_w.find('/') {
        Some(index) if index + 1 < after_w.len() => &after_w[index..],
        _ => "/",
    }
}

/// The sender's headers as the app should see them: in wire order, without
/// what our proxies add, hop-by-hop headers or a relay secret of its own.
pub fn relay_headers(headers: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers.iter() {
        let lower = name.as_str();
        if super::webhook::is_proxy_header(lower)
            || HOP_BY_HOP.contains(&lower)
            || lower == RELAY_AUTH_HEADER
            || lower == REQUEST_ID_HEADER
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out
}

fn sendable_answer_header(name: &str) -> bool {
    !(HOP_BY_HOP.contains(&name) || name == LIVE_HEADER || BLOCKED_ANSWER_HEADERS.contains(&name))
}

/// The headers the sender gets: the app's, without hop-by-hop headers, the
/// edge's mark and those the capture host keeps for itself, plus its guard:
/// the answer comes from the capture host, so the browser must take it for
/// nothing but what it says, and run nothing in it.
fn sent_answer_headers(answer: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(answer.len() + 2);
    for (name, value) in answer.iter() {
        if sendable_answer_header(name.as_str()) {
            out.append(name.clone(), value.clone());
        }
    }
    out.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    out.insert(
        "content-security-policy",
        HeaderValue::from_static("sandbox"),
    );
    out
}

/// Headers a sender may set to steer how an app rebuilds the URL or sees
/// the client, which our proxies do not add (those go with the proxy
/// headers, relay_headers): never passed to the app as the sender wrote
/// them.
const SENDER_FORWARDING_HEADERS: &[&str] = &[
    "forwarded",
    "x-forwarded-port",
    "x-forwarded-ssl",
    "x-forwarded-scheme",
    "x-forwarded-server",
    "x-forwarded-prefix",
    "x-forwarded-uri",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-for",
    "x-original-host",
    "x-original-url",
    "x-rewrite-url",
    "x-client-ip",
    "x-cluster-client-ip",
    "x-real-ip",
    "true-client-ip",
    "client-ip",
];

/// Where the sender sent a capture, as the app is told.
struct Forwarded<'a> {
    host: Option<&'a str>,
    https: bool,
    slug: &'a str,
    /// The path and query as the sender sent them (`/w/<slug>/...?...`).
    uri: &'a str,
    /// The sender's address as the receiver records it (from Cloudflare's
    /// header), empty when unknown.
    sender: &'a str,
}

/// Tells the app where the sender sent it: the capture host, the scheme,
/// the `/w/<slug>` the edge took off the path (`X-Forwarded-Prefix`), the
/// path and query as sent after that prefix (`X-Forwarded-Uri`, for an app
/// behind a base path: `whk tunnel 8080/api --live` puts `/api` in front,
/// which the signed URL never had),
/// and the sender's address,
/// so it can rebuild the public URL a provider signed. Whatever the sender
/// put in these, or in other headers apps read for the same purpose
/// (`Forwarded`, `X-Forwarded-Port`, ...), is dropped first.
fn forwarded_headers(headers: &mut HeaderMap, to: Forwarded<'_>) {
    for name in SENDER_FORWARDING_HEADERS {
        headers.remove(*name);
    }
    if let Some(host) = to.host.and_then(|h| HeaderValue::from_str(h).ok()) {
        headers.insert("x-forwarded-host", host);
    }
    headers.insert(
        "x-forwarded-proto",
        HeaderValue::from_static(if to.https { "https" } else { "http" }),
    );
    if let Ok(prefix) = HeaderValue::from_str(&format!("/w/{}", to.slug)) {
        headers.insert("x-forwarded-prefix", prefix);
    }
    if let Ok(uri) = HeaderValue::from_str(to.uri) {
        headers.insert("x-forwarded-uri", uri);
    }
    if !to.sender.is_empty()
        && let Ok(sender) = HeaderValue::from_str(to.sender)
    {
        headers.insert("x-forwarded-for", sender);
    }
}

/// The answer's headers for the row: everything the app sent apart from
/// hop-by-hop headers and the edge's mark, repeated names joined.
fn recorded_headers(headers: &HeaderMap) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    for (name, value) in headers.iter() {
        let key = name.as_str();
        if HOP_BY_HOP.contains(&key) || key == LIVE_HEADER {
            continue;
        }
        let value =
            super::webhook::strip_nul(&String::from_utf8_lossy(value.as_bytes())).into_owned();
        match map.get_mut(key) {
            Some(serde_json::Value::String(existing)) => {
                existing.push_str(if key == "set-cookie" { "\n" } else { ", " });
                existing.push_str(&value);
            }
            _ => {
                map.insert(key.to_string(), serde_json::Value::String(value));
            }
        }
    }
    map
}

/// The first [`RECORDED_BODY_BYTES`] of `body`: as text when they are UTF-8
/// without NUL (a character cut at the end is dropped), else as base64.
pub fn recorded_body(body: &[u8]) -> LiveRecord {
    recorded_body_of(
        &body[..body.len().min(RECORDED_BODY_BYTES)],
        body.len() > RECORDED_BODY_BYTES,
    )
}

/// The record of a kept body start, `truncated` when more came (or was cut).
fn recorded_body_of(kept: &[u8], truncated: bool) -> LiveRecord {
    let text = match std::str::from_utf8(kept) {
        Ok(text) => Some(text),
        // Only a character cut by the limit, at the very end.
        Err(e) if truncated && e.error_len().is_none() => {
            std::str::from_utf8(&kept[..e.valid_up_to()]).ok()
        }
        Err(_) => None,
    };
    let (body, body_encoding) = match text.filter(|t| !t.contains('\0')) {
        Some(text) => (text.to_string(), "utf8"),
        None => (
            base64::engine::general_purpose::STANDARD.encode(kept),
            "base64",
        ),
    };
    LiveRecord {
        status: 0,
        headers: serde_json::Map::new(),
        body,
        body_truncated: truncated,
        body_encoding,
        ms: 0,
        outcome: "answered",
    }
}

/// The edge's mark on an answer. A missing mark is read as the app's
/// answer: the edge marks everything it sends itself.
fn outcome_of(value: Option<&HeaderValue>) -> &'static str {
    match value.and_then(|v| v.to_str().ok()) {
        Some("offline") => "offline",
        Some("timeout") => "timeout",
        Some("unreachable") => "unreachable",
        Some("busy") => "busy",
        Some("refused") => "refused",
        _ => "answered",
    }
}

fn stand_in(status: u16, outcome: &'static str, started: Instant) -> LiveRecord {
    LiveRecord {
        status,
        ms: elapsed_ms(started),
        outcome,
        ..recorded_body(b"")
    }
}

fn elapsed_ms(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::extract::Request;
    use axum::routing::any;

    #[test]
    fn the_path_after_the_slug_keeps_its_encoding() {
        assert_eq!(path_after_slug("/w/acme"), "/");
        assert_eq!(path_after_slug("/w/acme/"), "/");
        assert_eq!(path_after_slug("/w/acme/hooks/a%20b"), "/hooks/a%20b");
        assert_eq!(path_after_slug("/elsewhere"), "/");
    }

    #[test]
    fn the_relay_url_names_the_endpoint_and_keeps_the_query() {
        let url = |base, rest, query| relay_url(base, "ep_1", rest, query).map(|u| u.to_string());
        assert_eq!(
            url("http://10.0.0.4:4002/", "/hooks", Some("a=1&b=2")).as_deref(),
            Some("http://10.0.0.4:4002/v1/live/ep_1/hooks?a=1&b=2")
        );
        assert_eq!(
            url("http://e", "", Some("")).as_deref(),
            Some("http://e/v1/live/ep_1/")
        );
        // Dot segments that stay inside the endpoint resolve as usual.
        assert_eq!(
            url("http://e", "/a/../b", None).as_deref(),
            Some("http://e/v1/live/ep_1/b")
        );
    }

    #[test]
    fn the_relay_url_never_leaves_its_endpoint() {
        for rest in [
            "/../ep_2/hooks",
            "/%2e%2e/ep_2/hooks",
            "/%2E%2E/ep_2",
            "/.%2e/ep_2",
            "/../../other",
            "/..",
            "/a/../../ep_2",
        ] {
            assert!(
                relay_url("http://e", "ep_1", rest, None).is_none(),
                "{rest} left the endpoint"
            );
        }
        // A prefix of another id is not this endpoint either.
        assert!(relay_url("http://e", "ep", "/../ep_1x", None).is_none());
    }

    #[test]
    fn relayed_headers_drop_proxy_hop_by_hop_and_a_forged_secret() {
        let mut headers = HeaderMap::new();
        headers.append("content-type", HeaderValue::from_static("application/json"));
        headers.append("x-signature", HeaderValue::from_static("abc"));
        headers.append("x-multi", HeaderValue::from_static("1"));
        headers.append("x-multi", HeaderValue::from_static("2"));
        headers.append("cf-connecting-ip", HeaderValue::from_static("203.0.113.9"));
        headers.append("connection", HeaderValue::from_static("keep-alive"));
        headers.append("host", HeaderValue::from_static("go.webhooks.cc"));
        headers.append(RELAY_AUTH_HEADER, HeaderValue::from_static("forged"));
        headers.append(REQUEST_ID_HEADER, HeaderValue::from_static("forged-id"));
        let out = relay_headers(&headers);
        assert_eq!(out.get("content-type").unwrap(), "application/json");
        assert_eq!(out.get("x-signature").unwrap(), "abc");
        assert_eq!(out.get_all("x-multi").iter().count(), 2);
        for gone in [
            "cf-connecting-ip",
            "connection",
            "host",
            RELAY_AUTH_HEADER,
            REQUEST_ID_HEADER,
        ] {
            assert!(out.get(gone).is_none(), "{gone} should be dropped");
        }
    }

    #[test]
    fn bodies_are_recorded_as_text_or_base64_and_cut_at_64_kb() {
        let small = recorded_body(br#"{"ok":true}"#);
        assert_eq!(small.body, r#"{"ok":true}"#);
        assert_eq!(small.body_encoding, "utf8");
        assert!(!small.body_truncated);

        let binary = recorded_body(&[0xff, 0x00, 0x01]);
        assert_eq!(binary.body_encoding, "base64");
        assert_eq!(binary.body, "/wAB");

        let nul = recorded_body(b"a\0b");
        assert_eq!(nul.body_encoding, "base64");

        // A two-byte character cut by the limit is dropped, not base64'd.
        let mut long = vec![b'a'; RECORDED_BODY_BYTES - 1];
        long.extend_from_slice("\u{e9}tail".as_bytes());
        let cut = recorded_body(&long);
        assert!(cut.body_truncated);
        assert_eq!(cut.body_encoding, "utf8");
        assert_eq!(cut.body.len(), RECORDED_BODY_BYTES - 1);
    }

    #[test]
    fn the_edge_mark_reads_as_an_outcome() {
        assert_eq!(outcome_of(None), "answered");
        assert_eq!(
            outcome_of(Some(&HeaderValue::from_static("answered"))),
            "answered"
        );
        for mark in ["offline", "timeout", "unreachable", "busy", "refused"] {
            assert_eq!(
                outcome_of(Some(&HeaderValue::from_str(mark).unwrap())),
                mark
            );
        }
    }

    /// A fake edge on a local port; `answer` builds its reply.
    async fn fake_edge<F>(answer: F) -> String
    where
        F: Fn(Request) -> Response + Clone + Send + Sync + 'static,
    {
        let app = Router::new().fallback(any(move |req: Request| {
            let answer = answer.clone();
            async move { answer(req) }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn relay_to(base: String, per_account: usize) -> LiveRelay {
        relay_with(base, per_account, 256)
    }

    fn relay_with(base: String, per_account: usize, total: usize) -> LiveRelay {
        LiveRelay::new(LiveConfig {
            relay_url: base,
            secret: "s3cret".into(),
            max_inflight_per_account: per_account,
            max_inflight_total: total,
            public_host: Some("go.webhooks.cc".into()),
            public_https: true,
        })
    }

    /// Sends one capture, reads the whole answer as the sender would, then
    /// takes what is recorded.
    async fn exchange(
        relay: &LiveRelay,
        headers: &HeaderMap,
        method: &Method,
    ) -> (StatusCode, HeaderMap, Bytes, LiveRecord) {
        let (response, recorded) = relay.relay(live_request(headers, method)).await;
        let status = response.status();
        let answer_headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, answer_headers, body, recorded.await.unwrap())
    }

    fn live_request<'a>(headers: &'a HeaderMap, method: &'a Method) -> LiveRequest<'a> {
        LiveRequest {
            endpoint_id: "ep_1",
            slug: "acme-hooks",
            limit_key: "user:1",
            method,
            rest: "/orders",
            raw_query: Some("x=1"),
            headers,
            body: Bytes::from_static(br#"{"id":1}"#),
            request_id: Some("3f2a8c1e-0000-4000-8000-000000000001"),
        }
    }

    #[tokio::test]
    async fn a_sender_that_hangs_up_mid_relay_still_leaves_the_answer_on_the_row() {
        // An edge (and app) that takes a while to answer.
        let app = Router::new().fallback(any(|_req: Request| async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            axum::http::Response::builder()
                .status(202)
                .header("content-type", "application/json")
                .header(LIVE_HEADER, "answered")
                .body(Body::from(r#"{"ok":true}"#))
                .unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let relay = Arc::new(relay_to(format!("http://{addr}"), 16));
        let (tx, rx) = oneshot::channel();
        let handle = spawn_relay(
            relay,
            OwnedLiveRequest {
                endpoint_id: "ep_1".into(),
                slug: "acme-hooks".into(),
                limit_key: "user:1".into(),
                method: Method::POST,
                rest: "/orders".into(),
                raw_query: None,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"{}"),
                request_id: None,
            },
            move |recorded| {
                let _ = tx.send(recorded);
            },
        );
        // The sender gives up at once: its handler, and the handle, go.
        drop(handle);
        let recorded = tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .expect("the relay went on without the sender")
            .unwrap();
        let record = tokio::time::timeout(Duration::from_secs(5), recorded)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.status, 202);
        assert_eq!(record.outcome, "answered");
    }

    #[test]
    fn a_live_capture_without_a_relay_warns_at_most_once_a_minute() {
        NOT_CONFIGURED_WARNED.store(0, std::sync::atomic::Ordering::Relaxed);
        not_configured();
        let first = NOT_CONFIGURED_WARNED.load(std::sync::atomic::Ordering::Relaxed);
        assert!(first > 0, "the first one warns");
        not_configured();
        assert_eq!(
            NOT_CONFIGURED_WARNED.load(std::sync::atomic::Ordering::Relaxed),
            first,
            "the next within the minute does not"
        );
    }

    #[tokio::test]
    async fn the_apps_answer_reaches_the_sender_and_the_row() {
        let base = fake_edge(|req: Request| {
            // The edge sees the endpoint, the rest of the path, the query and
            // the secret.
            assert_eq!(req.uri().path(), "/v1/live/ep_1/orders");
            assert_eq!(req.uri().query(), Some("x=1"));
            assert_eq!(req.headers().get(RELAY_AUTH_HEADER).unwrap(), "s3cret");
            // The capture's id, for the CLI, once.
            assert_eq!(
                req.headers().get(REQUEST_ID_HEADER).unwrap(),
                "3f2a8c1e-0000-4000-8000-000000000001"
            );
            assert_eq!(req.headers().get_all(REQUEST_ID_HEADER).iter().count(), 1);
            assert_eq!(req.method(), Method::POST);
            // Where the sender sent it, for the app to rebuild the URL.
            assert_eq!(
                req.headers().get("x-forwarded-host").unwrap(),
                "go.webhooks.cc"
            );
            assert_eq!(req.headers().get("x-forwarded-proto").unwrap(), "https");
            assert_eq!(
                req.headers().get("x-forwarded-prefix").unwrap(),
                "/w/acme-hooks"
            );
            assert_eq!(req.headers().get("x-forwarded-uri").unwrap(), "/orders?x=1");
            axum::http::Response::builder()
                .status(201)
                .header("content-type", "application/json")
                .header("set-cookie", "a=b; Domain=webhooks.cc")
                .header(LIVE_HEADER, "answered")
                .header("x-app", "yes")
                .body(Body::from(r#"{"created":true}"#))
                .unwrap()
        })
        .await;
        let relay = relay_to(base, 16);
        let headers = HeaderMap::new();
        let method = Method::POST;
        let (status, answer_headers, body, record) = exchange(&relay, &headers, &method).await;
        assert_eq!(status, StatusCode::CREATED);
        assert!(answer_headers.get(LIVE_HEADER).is_none());
        assert!(answer_headers.get("set-cookie").is_none());
        assert_eq!(answer_headers.get("x-app").unwrap(), "yes");
        // The capture host's own guard on whatever the app sent.
        assert_eq!(
            answer_headers.get("x-content-type-options").unwrap(),
            "nosniff"
        );
        assert_eq!(
            answer_headers.get("content-security-policy").unwrap(),
            "sandbox"
        );
        assert_eq!(&body[..], br#"{"created":true}"#);
        assert_eq!(record.status, 201);
        assert_eq!(record.outcome, "answered");
        assert_eq!(record.body, r#"{"created":true}"#);
        // The row holds what the sender got.
        assert!(!record.headers.contains_key("set-cookie"));
        assert!(!record.headers.contains_key(LIVE_HEADER));
        assert_eq!(record.headers["content-security-policy"], "sandbox");
        assert_eq!(record.headers["x-app"], "yes");
    }

    #[tokio::test]
    async fn the_edges_stand_ins_pass_through_with_their_outcome() {
        let base = fake_edge(|_req: Request| {
            axum::http::Response::builder()
                .status(502)
                .header(LIVE_HEADER, "offline")
                .body(Body::from("offline"))
                .unwrap()
        })
        .await;
        let relay = relay_to(base, 16);
        let headers = HeaderMap::new();
        let method = Method::POST;
        let (status, answer_headers, _, record) = exchange(&relay, &headers, &method).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(answer_headers.get(LIVE_HEADER).is_none());
        assert_eq!((record.status, record.outcome), (502, "offline"));
    }

    #[tokio::test]
    async fn a_refusing_edge_or_no_edge_is_a_502() {
        let base = fake_edge(|_req: Request| {
            axum::http::Response::builder()
                .status(404)
                .header(LIVE_HEADER, "refused")
                .body(Body::empty())
                .unwrap()
        })
        .await;
        let headers = HeaderMap::new();
        let method = Method::GET;
        let (status, _, _, record) = exchange(&relay_to(base, 16), &headers, &method).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(record.outcome, "unreachable");

        // Nothing listens on this port.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (status, _, _, record) = exchange(&relay_to(closed, 16), &headers, &method).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!((record.status, record.outcome), (502, "unreachable"));
    }

    #[tokio::test]
    async fn an_account_past_its_live_relays_is_asked_to_retry() {
        let (release_tx, release_rx) = tokio::sync::watch::channel(false);
        let base = {
            let app = Router::new().fallback(any(move || {
                let mut rx = release_rx.clone();
                async move {
                    while !*rx.borrow() {
                        if rx.changed().await.is_err() {
                            break;
                        }
                    }
                    (StatusCode::OK, "late")
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            format!("http://{addr}")
        };
        let relay = std::sync::Arc::new(relay_to(base.clone(), 1));
        let first = {
            let relay = relay.clone();
            tokio::spawn(async move {
                let headers = HeaderMap::new();
                let method = Method::POST;
                exchange(&relay, &headers, &method).await.3
            })
        };
        // Let the first relay take the account's one slot.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let headers = HeaderMap::new();
        let method = Method::POST;
        let (status, answer_headers, _, record) = exchange(&relay, &headers, &method).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(answer_headers.get("retry-after").unwrap(), "5");
        assert_eq!(record.outcome, "busy");

        // The cap across all accounts: another account is turned away too.
        let shared = std::sync::Arc::new(relay_with(base, 16, 1));
        let held = {
            let shared = shared.clone();
            tokio::spawn(async move {
                let headers = HeaderMap::new();
                let method = Method::POST;
                exchange(&shared, &headers, &method).await.3
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut other = live_request(&headers, &method);
        other.limit_key = "user:2";
        let (response, recorded) = shared.relay(other).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(recorded.await.unwrap().outcome, "busy");

        release_tx.send(true).unwrap();
        assert_eq!(first.await.unwrap().outcome, "answered");
        assert_eq!(held.await.unwrap().outcome, "answered");
    }

    #[tokio::test]
    async fn a_long_answer_streams_whole_and_keeps_its_start() {
        // 200 KB in many chunks: the sender gets all of it, the row 64 KB.
        let base = fake_edge(|_req: Request| {
            let chunks = (0..200).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 1024])));
            axum::http::Response::builder()
                .status(200)
                .header("content-type", "text/plain")
                .header(LIVE_HEADER, "answered")
                .body(Body::from_stream(futures_util::stream::iter(chunks)))
                .unwrap()
        })
        .await;
        let headers = HeaderMap::new();
        let method = Method::POST;
        let (status, _, body, record) = exchange(&relay_to(base, 16), &headers, &method).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.len(), 200 * 1024);
        assert_eq!(record.body.len(), RECORDED_BODY_BYTES);
        assert!(record.body_truncated);
        assert_eq!(record.outcome, "answered");
    }

    #[tokio::test]
    async fn the_answer_starts_before_the_app_finishes() {
        // The app sends its first chunk, then waits: the sender already has
        // the head and that chunk, and the record waits for the end.
        let (go_tx, go_rx) = tokio::sync::watch::channel(false);
        let base = fake_edge(move |_req: Request| {
            let mut go = go_rx.clone();
            let rest = futures_util::stream::once(async move {
                while !*go.borrow() {
                    if go.changed().await.is_err() {
                        break;
                    }
                }
                Ok::<_, std::io::Error>(Bytes::from_static(b"second"))
            });
            let first = futures_util::stream::once(async {
                Ok::<_, std::io::Error>(Bytes::from_static(b"first "))
            });
            axum::http::Response::builder()
                .status(200)
                .header(LIVE_HEADER, "answered")
                .body(Body::from_stream(futures_util::StreamExt::chain(
                    first, rest,
                )))
                .unwrap()
        })
        .await;
        let relay = relay_to(base, 16);
        let headers = HeaderMap::new();
        let method = Method::POST;
        let (response, mut recorded) = relay.relay(live_request(&headers, &method)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body().into_data_stream();
        let first = futures_util::StreamExt::next(&mut body)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&first[..], b"first ");
        assert!(recorded.try_recv().is_err());
        go_tx.send(true).unwrap();
        let second = futures_util::StreamExt::next(&mut body)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&second[..], b"second");
        assert!(futures_util::StreamExt::next(&mut body).await.is_none());
        drop(body);
        let record = recorded.await.unwrap();
        assert_eq!(record.body, "first second");
        assert!(!record.body_truncated);
    }

    #[tokio::test]
    async fn a_sender_that_leaves_early_is_recorded_as_cut() {
        let base = fake_edge(|_req: Request| {
            let chunks = (0..100).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![b'y'; 1024])));
            axum::http::Response::builder()
                .status(200)
                .header(LIVE_HEADER, "answered")
                .body(Body::from_stream(futures_util::stream::iter(chunks)))
                .unwrap()
        })
        .await;
        let relay = relay_to(base, 16);
        let headers = HeaderMap::new();
        let method = Method::POST;
        let (response, recorded) = relay.relay(live_request(&headers, &method)).await;
        let mut body = response.into_body().into_data_stream();
        let first = futures_util::StreamExt::next(&mut body)
            .await
            .unwrap()
            .unwrap();
        drop(body);
        let record = recorded.await.unwrap();
        assert!(record.body_truncated);
        assert!(record.body.len() >= first.len());
        assert!(record.body.chars().all(|c| c == 'y'));
    }

    #[tokio::test]
    async fn an_answer_past_the_cap_is_broken_off_and_recorded_as_refused() {
        // 1.5 MB in 64 KB chunks: the sender's read fails, the row keeps the
        // start and says refused.
        let base = fake_edge(|_req: Request| {
            let chunks =
                (0..24).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![b'z'; 64 * 1024])));
            axum::http::Response::builder()
                .status(200)
                .header("content-type", "text/plain")
                .header(LIVE_HEADER, "answered")
                .body(Body::from_stream(futures_util::stream::iter(chunks)))
                .unwrap()
        })
        .await;
        let relay = relay_to(base, 16);
        let headers = HeaderMap::new();
        let method = Method::POST;
        let (response, recorded) = relay.relay(live_request(&headers, &method)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let read = axum::body::to_bytes(response.into_body(), usize::MAX).await;
        assert!(read.is_err(), "the sender must not get a clean, cut answer");
        let record = recorded.await.unwrap();
        assert_eq!(record.outcome, "refused");
        assert!(record.body_truncated);
        assert_eq!(record.body.len(), RECORDED_BODY_BYTES);
    }

    #[tokio::test]
    async fn the_edges_refusal_of_an_answer_passes_on_as_refused() {
        // A 502 marked refused is the edge turning the app's answer down (a
        // download, say), not a fault of ours.
        let base = fake_edge(|_req: Request| {
            axum::http::Response::builder()
                .status(502)
                .header("content-type", "application/json")
                .header(LIVE_HEADER, "refused")
                .body(Body::from(r#"{"error":"not passed back"}"#))
                .unwrap()
        })
        .await;
        let headers = HeaderMap::new();
        let method = Method::POST;
        let (status, _, body, record) = exchange(&relay_to(base, 16), &headers, &method).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(&body[..], br#"{"error":"not passed back"}"#);
        assert_eq!((record.status, record.outcome), (502, "refused"));
    }

    #[test]
    fn the_app_learns_where_the_sender_sent_it() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("x-forwarded-prefix", "/evil"),
            ("forwarded", "for=6.6.6.6;host=evil.example;proto=http"),
            ("x-forwarded-port", "8443"),
            ("x-forwarded-ssl", "off"),
            ("x-forwarded-for", "6.6.6.6"),
            ("x-original-host", "evil.example"),
            ("x-forwarded-uri", "/evil"),
        ] {
            headers.insert(
                HeaderName::from_static(name),
                HeaderValue::from_static(value),
            );
        }
        headers.insert("x-acme", HeaderValue::from_static("kept"));
        forwarded_headers(
            &mut headers,
            Forwarded {
                host: Some("go.webhooks.cc"),
                https: true,
                slug: "acme",
                uri: "/slack/events?team=1",
                sender: "203.0.113.9",
            },
        );
        assert_eq!(headers["x-forwarded-host"], "go.webhooks.cc");
        assert_eq!(headers["x-forwarded-uri"], "/slack/events?team=1");
        assert_eq!(headers.get_all("x-forwarded-uri").iter().count(), 1);
        assert_eq!(headers["x-forwarded-proto"], "https");
        assert_eq!(headers["x-forwarded-prefix"], "/w/acme");
        assert_eq!(headers["x-forwarded-for"], "203.0.113.9");
        assert_eq!(headers.get_all("x-forwarded-prefix").iter().count(), 1);
        for gone in [
            "forwarded",
            "x-forwarded-port",
            "x-forwarded-ssl",
            "x-original-host",
        ] {
            assert!(headers.get(gone).is_none(), "{gone}");
        }
        assert_eq!(headers["x-acme"], "kept");

        // In development the public URL is http, and an unknown sender
        // gets no X-Forwarded-For at all, never one of its own.
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("6.6.6.6"));
        forwarded_headers(
            &mut headers,
            Forwarded {
                host: Some("localhost:3001"),
                https: false,
                slug: "acme",
                uri: "/",
                sender: "",
            },
        );
        assert_eq!(headers["x-forwarded-proto"], "http");
        assert!(headers.get("x-forwarded-for").is_none());
    }

    #[tokio::test]
    async fn an_answer_without_a_body_is_recorded_whole() {
        // A server never reads the body of a 204 (or a 304, or an answer to
        // HEAD): dropping it unread must not read as an answer cut off.
        for (status, method) in [(204, Method::POST), (304, Method::GET), (200, Method::HEAD)] {
            let base = fake_edge(move |_req: Request| {
                axum::http::Response::builder()
                    .status(status)
                    .header(LIVE_HEADER, "answered")
                    .body(Body::empty())
                    .unwrap()
            })
            .await;
            let relay = relay_to(base, 16);
            let headers = HeaderMap::new();
            let (response, recorded) = relay.relay(live_request(&headers, &method)).await;
            assert_eq!(response.status().as_u16(), status);
            drop(response);
            let record = recorded.await.unwrap();
            assert!(!record.body_truncated, "{status} {method}");
            assert_eq!(record.outcome, "answered");
        }
        // A stated length of 0 is whole too.
        let base = fake_edge(|_req: Request| {
            axum::http::Response::builder()
                .status(200)
                .header(LIVE_HEADER, "answered")
                .header("content-length", "0")
                .body(Body::empty())
                .unwrap()
        })
        .await;
        let relay = relay_to(base, 16);
        let headers = HeaderMap::new();
        let method = Method::POST;
        let (response, recorded) = relay.relay(live_request(&headers, &method)).await;
        drop(response);
        assert!(!recorded.await.unwrap().body_truncated);
    }
}
