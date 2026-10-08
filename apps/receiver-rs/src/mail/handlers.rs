//! Internal mail API handlers.
//!
//! `POST /internal/mail/check` answers the MX host's RCPT question.
//! `POST /internal/mail/deliver` captures an accepted message once per
//! distinct endpoint among its recipients.
//!
//! Counting: one accepted email is one request per recipient endpoint, and
//! anything refused counts nothing. Retries are protected in the database:
//! every email row stores the message hash, and a delivery the MX host marks
//! as a retry comes back `duplicate` for endpoints that already have the
//! message (`capture_webhook`, migration 00048). A message sent again on
//! purpose is not a retry and is captured again.
//!
//! How the MX host answers the sender: any `transient` result means 451 (the
//! sender retries; the MX host sets `retry` on that attempt); otherwise any
//! `captured` or `duplicate` means 250; otherwise the message is refused.
//! Because retries cannot double-count, every outcome that is not certain is
//! reported as `transient` rather than bounced.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::address::{AddressError, MailAddress, parse_recipient};
use super::auth;
use super::parse::{self, ParsedEmail, StoredBody};
use crate::AppState;
use crate::handlers::log_throttle::LogThrottle;
use crate::handlers::webhook::{
    DbFailure, NOTIFICATION_PREVIEW_LEN, NotificationInfo, classify_db_error, resolve_billing_key,
    sanitize_ip, spawn_notification, sqlstate_of, strip_nul, truncate_preview,
};
use crate::metrics;

pub const CHECK_PATH: &str = "/internal/mail/check";
pub const DELIVER_PATH: &str = "/internal/mail/deliver";

/// Largest message the MX host accepts (SMTP SIZE).
pub const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;
/// Base64 length of `MAX_MESSAGE_BYTES`, checked before decoding.
const MAX_RAW_BASE64: usize = MAX_MESSAGE_BYTES.div_ceil(3) * 4;
/// More recipients than the MX host ever forwards for one message.
const MAX_RECIPIENTS: usize = 50;
/// Upper bound for the MX-supplied `tls` and `auth` objects.
const MAX_META_BYTES: usize = 16 * 1024;
const MAX_TEXT_FIELD: usize = 255;
/// Deliveries decoded, parsed and held in memory at the same time.
pub const DELIVER_CONCURRENCY: usize = 4;
const DELIVER_SLOT_WAIT: Duration = Duration::from_secs(10);
const UNAUTHORIZED_LOG_WINDOW: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
struct CheckRequest {
    address: String,
}

#[derive(Serialize)]
struct CheckResponse {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint_id: Option<String>,
}

#[derive(Deserialize)]
struct DeliverRequest {
    recipients: Vec<String>,
    #[serde(default)]
    envelope_from: String,
    #[serde(default)]
    client_ip: String,
    #[serde(default)]
    client_rdns: Option<String>,
    #[serde(default)]
    helo: Option<String>,
    #[serde(default)]
    tls: Option<Value>,
    #[serde(default)]
    auth: Option<Value>,
    #[serde(default)]
    received_at: Option<DateTime<Utc>>,
    /// True when the MX host answered 451 for this exact message before.
    #[serde(default)]
    retry: bool,
    /// Set only by the dashboard's "Send test email". Stored as `smtp.test`,
    /// so the dashboard can tell its own sample apart from real mail without
    /// trusting anything in the message, which any sender controls. The MX
    /// host never sets it.
    #[serde(default)]
    test: bool,
    /// Standard base64 of the message exactly as received. The MX host must
    /// not add trace headers to it: retries are matched by its hash.
    raw: String,
}

#[derive(Serialize, Debug, PartialEq)]
struct RecipientResult {
    recipient: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

#[derive(Serialize)]
struct DeliverResponse {
    results: Vec<RecipientResult>,
}

/// The fields of `capture_webhook`'s result the email path needs. Decoding
/// the full HTTP shape would fail on an endpoint whose mock response is
/// incomplete, and a stored email must never be reported as failed.
#[derive(Deserialize)]
struct EmailCapture {
    status: String,
    request_id: Option<String>,
    notification_url: Option<String>,
    billing_key: Option<String>,
}

fn unauthorized_log_throttle() -> &'static LogThrottle {
    static THROTTLE: OnceLock<LogThrottle> = OnceLock::new();
    THROTTLE.get_or_init(|| LogThrottle::new(UNAUTHORIZED_LOG_WINDOW, 16))
}

/// 401 for a request whose signature is missing, stale or wrong. Logged at
/// most once a minute per path.
pub(crate) fn unauthorized(path: &str, reason: &auth::AuthError) -> Response {
    metrics::mail_ingest("unauthorized");
    if let Some(suppressed) = unauthorized_log_throttle().check(path, Instant::now()) {
        tracing::warn!(
            path,
            ?reason,
            suppressed,
            "rejected unsigned mail ingest request"
        );
    }
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    body: &[u8],
) -> Option<Response> {
    match auth::verify(
        state.config.capture_shared_secret.as_bytes(),
        headers,
        "POST",
        path,
        body,
        Utc::now().timestamp(),
    ) {
        Ok(()) => None,
        Err(e) => Some(unauthorized(path, &e)),
    }
}

fn bad_request(reason: &'static str) -> Response {
    metrics::mail_ingest("bad_request");
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({ "error": reason })),
    )
        .into_response()
}

fn too_large() -> Response {
    metrics::mail_ingest("too_large");
    (StatusCode::PAYLOAD_TOO_LARGE, "too large").into_response()
}

fn retry_later() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, "retry").into_response()
}

/// `POST /internal/mail/check` `{address}` → `{status, endpoint_id?}`.
pub async fn check(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(denied) = authenticate(&state, &headers, CHECK_PATH, &body) {
        return denied;
    }
    let Ok(request) = serde_json::from_slice::<CheckRequest>(&body) else {
        return bad_request("invalid_json");
    };

    if state.config.mail_ingest_paused {
        metrics::mail_ingest("check_paused");
        return axum::Json(CheckResponse {
            status: "paused",
            endpoint_id: None,
        })
        .into_response();
    }

    let address = match parse_recipient(&request.address, &state.config.mail_domains) {
        Ok(address) => address,
        Err(e) => {
            metrics::mail_ingest(match e {
                AddressError::Invalid => "check_invalid",
                AddressError::RelayDenied => "check_relay_denied",
            });
            return axum::Json(CheckResponse {
                status: e.as_status(),
                endpoint_id: None,
            })
            .into_response();
        }
    };

    let lookup: Result<Value, sqlx::Error> = sqlx::query_scalar("SELECT check_email_recipient($1)")
        .bind(&address.slug)
        .fetch_one(&state.pool)
        .await;
    let value = match lookup {
        Ok(value) => value,
        Err(e) => {
            metrics::mail_ingest("check_failed");
            tracing::error!(
                slug = address.slug,
                sqlstate = sqlstate_of(&e).as_deref().unwrap_or("none"),
                error = %e,
                "check_email_recipient failed"
            );
            return retry_later();
        }
    };
    let (status, outcome) = match value.get("status").and_then(Value::as_str) {
        Some("ok") => ("ok", "check_ok"),
        Some("unknown") => ("unknown", "check_unknown"),
        Some("expired") => ("expired", "check_expired"),
        Some("guest") => ("guest", "check_guest"),
        Some("over_quota") => ("over_quota", "check_over_quota"),
        other => {
            // An answer this code does not know must not become a permanent
            // bounce; the MX host retries later.
            metrics::mail_ingest("check_failed");
            tracing::error!(slug = address.slug, status = ?other, "unexpected check_email_recipient status");
            return retry_later();
        }
    };
    metrics::mail_ingest(outcome);
    let endpoint_id = value
        .get("endpoint_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    axum::Json(CheckResponse {
        status,
        endpoint_id,
    })
    .into_response()
}

/// One endpoint's share of a message: every recipient address that resolved to
/// the same slug. The first address (and its tag) represents the capture.
struct SlugGroup {
    slug: String,
    addresses: Vec<MailAddress>,
    /// Positions of these recipients in the request.
    positions: Vec<usize>,
}

/// The message after the CPU-heavy work, which runs off the async runtime.
struct Prepared {
    size: usize,
    hash: String,
    parsed: ParsedEmail,
    stored: StoredBody,
}

enum PrepareError {
    InvalidBase64,
    TooLarge,
}

fn prepare(raw_base64: String) -> Result<Prepared, PrepareError> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(raw_base64.as_bytes())
        .map_err(|_| PrepareError::InvalidBase64)?;
    drop(raw_base64);
    if raw.len() > MAX_MESSAGE_BYTES {
        return Err(PrepareError::TooLarge);
    }
    Ok(Prepared {
        size: raw.len(),
        hash: hex::encode(Sha256::digest(&raw)),
        parsed: parse::parse_message(&raw),
        stored: parse::stored_body(&raw),
    })
}

/// Holds one of the delivery slots for the whole delivery request, taken
/// before the body is read: the slots bound how many messages (each up to
/// about 14 MiB of base64, plus its decoded and parsed copies) are in memory
/// at once. Waiting longer than `DELIVER_SLOT_WAIT` answers 503, which the MX
/// host turns into "try later".
pub async fn delivery_slot(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let Ok(Ok(_slot)) = tokio::time::timeout(
        DELIVER_SLOT_WAIT,
        state.mail_deliver_slots.clone().acquire_owned(),
    )
    .await
    else {
        metrics::mail_ingest("deliver_busy");
        return retry_later();
    };
    next.run(request).await
}

/// `POST /internal/mail/deliver` → `{results: [{recipient, status, request_id?}]}`,
/// one result per requested recipient, in request order.
pub async fn deliver(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(denied) = authenticate(&state, &headers, DELIVER_PATH, &body) {
        return denied;
    }
    let Ok(request) = serde_json::from_slice::<DeliverRequest>(&body) else {
        return bad_request("invalid_json");
    };
    drop(body);
    if request.recipients.is_empty() || request.recipients.len() > MAX_RECIPIENTS {
        return bad_request("recipient_count");
    }
    if request.raw.len() > MAX_RAW_BASE64 {
        return too_large();
    }

    if state.config.mail_ingest_paused {
        metrics::mail_ingest("deliver_paused");
        let results = request
            .recipients
            .into_iter()
            .map(|recipient| RecipientResult {
                recipient,
                status: "transient",
                request_id: None,
            })
            .collect();
        return axum::Json(DeliverResponse { results }).into_response();
    }

    let DeliverRequest {
        recipients,
        envelope_from,
        client_ip,
        client_rdns,
        helo,
        tls,
        auth,
        received_at,
        retry,
        test,
        raw,
    } = request;

    let prepared = match tokio::task::spawn_blocking(move || prepare(raw)).await {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(PrepareError::InvalidBase64)) => return bad_request("invalid_raw"),
        Ok(Err(PrepareError::TooLarge)) => return too_large(),
        Err(e) => {
            metrics::mail_ingest("transient");
            tracing::error!(error = %e, "mail parsing task failed");
            return retry_later();
        }
    };

    let (groups, immediate) = group_recipients(&recipients, &state.config.mail_domains);
    let mut statuses: Vec<Option<(&'static str, Option<String>)>> = vec![None; recipients.len()];
    for (position, status) in immediate {
        statuses[position] = Some((status, None));
    }

    if !groups.is_empty() {
        let headers_json = serde_json::to_value(&prepared.parsed.headers)
            .unwrap_or_else(|_| Value::Object(Map::new()));
        let received_at = clamp_received_at(received_at, Utc::now());
        let client_ip = sanitize_ip(client_ip.trim());
        let mut smtp_base = json!({
            "helo": helo.as_deref().map(short_text),
            "client_ip": client_ip,
            "client_rdns": client_rdns.as_deref().map(short_text),
            "envelope_from": short_text(&envelope_from),
            "tls": bounded_object(tls),
            "size": prepared.size,
        });
        if test {
            smtp_base["test"] = Value::Bool(true);
        }
        let auth_doc = bounded_object(auth);

        for group in &groups {
            let outcome = capture_for_slug(
                &state,
                CaptureInput {
                    group,
                    prepared: &prepared,
                    headers_json: &headers_json,
                    smtp_base: &smtp_base,
                    auth_doc: &auth_doc,
                    client_ip: &client_ip,
                    received_at,
                    retry,
                },
            )
            .await;
            for &position in &group.positions {
                statuses[position] = Some(outcome.clone());
            }
        }
    }

    let results = recipients
        .into_iter()
        .zip(statuses)
        .map(|(recipient, outcome)| {
            let (status, request_id) = outcome.unwrap_or(("failed", None));
            RecipientResult {
                recipient,
                status,
                request_id,
            }
        })
        .collect();
    axum::Json(DeliverResponse { results }).into_response()
}

/// Split recipients into per-slug groups (in first-seen order) and immediate
/// results, by position, for addresses that cannot be captured at all.
fn group_recipients(
    recipients: &[String],
    domains: &[String],
) -> (Vec<SlugGroup>, Vec<(usize, &'static str)>) {
    let mut groups: Vec<SlugGroup> = Vec::new();
    let mut immediate = Vec::new();
    for (position, recipient) in recipients.iter().enumerate() {
        match parse_recipient(recipient, domains) {
            Ok(address) => match groups.iter_mut().find(|g| g.slug == address.slug) {
                Some(group) => {
                    group.addresses.push(address);
                    group.positions.push(position);
                }
                None => groups.push(SlugGroup {
                    slug: address.slug.clone(),
                    addresses: vec![address],
                    positions: vec![position],
                }),
            },
            Err(e) => immediate.push((position, e.as_status())),
        }
    }
    (groups, immediate)
}

struct CaptureInput<'a> {
    group: &'a SlugGroup,
    prepared: &'a Prepared,
    headers_json: &'a Value,
    smtp_base: &'a Value,
    auth_doc: &'a Value,
    client_ip: &'a str,
    received_at: DateTime<Utc>,
    retry: bool,
}

/// Capture one endpoint's copy. Returns the result status and request id.
async fn capture_for_slug(
    state: &AppState,
    input: CaptureInput<'_>,
) -> (&'static str, Option<String>) {
    let slug = input.group.slug.as_str();
    let primary = &input.group.addresses[0];
    let path = primary.normalized();

    let mut envelope_to: Vec<String> = Vec::new();
    for address in &input.group.addresses {
        let normalized = address.normalized();
        if !envelope_to.contains(&normalized) {
            envelope_to.push(normalized);
        }
    }
    let mut email = input.prepared.parsed.doc.clone();
    email.insert("tag".into(), json!(primary.tag));
    email.insert(
        "raw_truncated".into(),
        Value::Bool(input.prepared.stored.truncated),
    );
    email.insert("auth".into(), input.auth_doc.clone());
    let mut smtp = input.smtp_base.clone();
    if let Value::Object(map) = &mut smtp {
        map.insert("envelope_to".into(), json!(envelope_to));
    }
    email.insert("smtp".into(), smtp);
    let email = Value::Object(email);

    let limit_key = match state.capture_limiter.cached_key(slug) {
        Some(key) => key,
        None => resolve_billing_key(state, slug).await,
    };
    let acquire_timeout = Duration::from_secs(state.config.pg_acquire_timeout_secs);
    let Some(permit) = state
        .capture_limiter
        .acquire(&limit_key, acquire_timeout)
        .await
    else {
        metrics::mail_ingest("account_busy");
        return ("transient", None);
    };
    let result: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "SELECT capture_webhook($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
    )
    .bind(slug)
    .bind("EMAIL")
    .bind(&path)
    .bind(input.headers_json)
    .bind(&input.prepared.stored.text)
    .bind(Value::Object(Map::new()))
    .bind("message/rfc822")
    .bind(input.client_ip)
    .bind(input.received_at)
    .bind(&input.prepared.stored.raw)
    .bind("email")
    .bind(&email)
    .bind(&input.prepared.hash)
    .bind(input.retry)
    .bind(i32::try_from(input.prepared.size).ok())
    .fetch_one(&state.pool)
    .await;
    drop(permit);

    let value = match result {
        Ok(value) => value,
        Err(e) => {
            let status = email_failure_status(&e);
            metrics::mail_ingest(status);
            tracing::error!(
                slug,
                status,
                sqlstate = sqlstate_of(&e).as_deref().unwrap_or("none"),
                error = %e,
                "email capture failed"
            );
            return (status, None);
        }
    };
    let capture: EmailCapture = match serde_json::from_value(value) {
        Ok(capture) => capture,
        Err(e) => {
            // The row may well exist; the sender's retry will find it.
            metrics::mail_ingest("transient");
            tracing::error!(slug, error = %e, "failed to read capture_webhook result for email");
            return ("transient", None);
        }
    };
    if let Some(ref billing_key) = capture.billing_key {
        state.capture_limiter.remember(slug, billing_key);
    }

    match capture.status.as_str() {
        "ok" => {
            metrics::mail_ingest("captured");
            if let Some(url) = capture
                .notification_url
                .as_deref()
                .filter(|u| !u.is_empty())
            {
                spawn_notification(NotificationInfo {
                    limiter: state.notification_limiter.clone(),
                    redis: state.redis.clone(),
                    url: url.to_string(),
                    slug: slug.to_string(),
                    method: "EMAIL".to_string(),
                    path: path.clone(),
                    ip: input.client_ip.to_string(),
                    preview: notification_preview(&input.prepared.parsed),
                    received_at: input.received_at.to_rfc3339(),
                    proxy_url: state.config.notify_proxy_url.clone(),
                    proxy_secret: state.config.notify_secret.clone(),
                    cooldown: Duration::from_secs(state.config.notification_cooldown_secs),
                    timeout_secs: state.config.notification_timeout_secs,
                });
            }
            ("captured", capture.request_id)
        }
        "duplicate" => {
            metrics::mail_ingest("duplicate");
            ("duplicate", capture.request_id)
        }
        "not_found" => {
            metrics::mail_ingest("unknown");
            ("unknown", None)
        }
        "expired" => {
            metrics::mail_ingest("expired");
            ("expired", None)
        }
        "not_allowed" => {
            metrics::mail_ingest("guest");
            ("guest", None)
        }
        "quota_exceeded" => {
            metrics::mail_ingest("over_quota");
            ("over_quota", None)
        }
        other => {
            metrics::mail_ingest("transient");
            tracing::error!(
                slug,
                status = other,
                "unexpected capture_webhook status for email"
            );
            ("transient", None)
        }
    }
}

/// How a failed capture query is reported. Only data errors (SQLSTATE classes
/// 22 and 23), where the message itself is the problem and a retry would fail
/// the same way, are permanent. Everything else, including schema and
/// privilege errors an operator can fix, is transient: the sender keeps the
/// message, and a retry cannot be billed twice.
fn email_failure_status(e: &sqlx::Error) -> &'static str {
    if let DbFailure::Transient = classify_db_error(e) {
        return "transient";
    }
    match sqlstate_of(e) {
        Some(code) if code.starts_with("22") || code.starts_with("23") => "failed",
        _ => "transient",
    }
}

/// The MX host's clock decides retention and ordering, so a value far from
/// the receiver's own clock is replaced by now.
fn clamp_received_at(sent: Option<DateTime<Utc>>, now: DateTime<Utc>) -> DateTime<Utc> {
    match sent {
        Some(t) if t >= now - TimeDelta::hours(1) && t <= now + TimeDelta::minutes(1) => t,
        _ => now,
    }
}

fn notification_preview(parsed: &ParsedEmail) -> String {
    let preview = match &parsed.subject {
        Some(subject) if !subject.is_empty() => format!("{subject}\n{}", parsed.preview),
        _ => parsed.preview.clone(),
    };
    truncate_preview(&preview, NOTIFICATION_PREVIEW_LEN)
}

/// HELO names, reverse DNS and envelope senders: NUL-free and length-capped.
fn short_text(s: &str) -> String {
    let cleaned = strip_nul(s.trim());
    cleaned.chars().take(MAX_TEXT_FIELD).collect()
}

/// MX-supplied metadata: kept only when it is a JSON object of modest size
/// without NUL (which jsonb rejects).
fn bounded_object(value: Option<Value>) -> Value {
    let Some(value @ Value::Object(_)) = value else {
        return Value::Null;
    };
    match serde_json::to_string(&value) {
        Ok(text) if text.len() <= MAX_META_BYTES && !text.contains("\\u0000") => value,
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::handlers::capture_limiter::CaptureLimiter;
    use crate::handlers::webhook::new_notification_limiter;
    use axum::http::HeaderValue;
    use std::sync::Arc;

    const SECRET: &str = "test-secret";

    fn domains() -> Vec<String> {
        vec!["mailhooks.cc".to_string()]
    }

    /// A state whose database is never reached: these tests only cover paths
    /// that answer before any query.
    fn test_state(paused: bool) -> AppState {
        let mut config = Config::for_tests();
        config.capture_shared_secret = SECRET.to_string();
        config.mail_ingest_paused = paused;
        AppState {
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://nobody@127.0.0.1:1/none")
                .unwrap(),
            config,
            notification_limiter: new_notification_limiter(),
            capture_limiter: Arc::new(CaptureLimiter::new(4)),
            redis: None,
            mail_deliver_slots: Arc::new(tokio::sync::Semaphore::new(DELIVER_CONCURRENCY)),
        }
    }

    fn signed(path: &str, body: &Value) -> (HeaderMap, Bytes) {
        let body = serde_json::to_vec(body).unwrap();
        let now = Utc::now().timestamp();
        let mut headers = HeaderMap::new();
        headers.insert(
            auth::TIMESTAMP_HEADER,
            HeaderValue::from_str(&now.to_string()).unwrap(),
        );
        headers.insert(
            auth::SIGNATURE_HEADER,
            HeaderValue::from_str(&auth::sign(SECRET.as_bytes(), now, "POST", path, &body))
                .unwrap(),
        );
        (headers, Bytes::from(body))
    }

    async fn json_of(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[tokio::test]
    async fn refuses_unsigned_requests() {
        let state = test_state(false);
        let response = check(
            State(state),
            HeaderMap::new(),
            Bytes::from_static(br#"{"address":"a@mailhooks.cc"}"#),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn paused_check_answers_paused() {
        let (headers, body) = signed(CHECK_PATH, &json!({"address": "abc@mailhooks.cc"}));
        let (status, value) = json_of(check(State(test_state(true)), headers, body).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value, json!({"status": "paused"}));
    }

    #[tokio::test]
    async fn paused_deliver_answers_transient_for_everyone() {
        let payload = json!({
            "recipients": ["a@mailhooks.cc", "x@example.com"],
            "raw": b64("Subject: x\r\n\r\ny"),
        });
        let (headers, body) = signed(DELIVER_PATH, &payload);
        let (status, value) = json_of(deliver(State(test_state(true)), headers, body).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            value["results"],
            json!([
                {"recipient": "a@mailhooks.cc", "status": "transient"},
                {"recipient": "x@example.com", "status": "transient"},
            ])
        );
    }

    #[tokio::test]
    async fn answers_unroutable_recipients_in_request_order_without_the_database() {
        let payload = json!({
            "recipients": ["bad slug@mailhooks.cc", "x@example.com"],
            "raw": b64("Subject: x\r\n\r\ny"),
        });
        let (headers, body) = signed(DELIVER_PATH, &payload);
        let (status, value) = json_of(deliver(State(test_state(false)), headers, body).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            value["results"],
            json!([
                {"recipient": "bad slug@mailhooks.cc", "status": "invalid"},
                {"recipient": "x@example.com", "status": "relay_denied"},
            ])
        );
    }

    #[tokio::test]
    async fn rejects_bad_base64_and_oversized_messages() {
        let (headers, body) = signed(
            DELIVER_PATH,
            &json!({"recipients": ["a@mailhooks.cc"], "raw": "%%%"}),
        );
        let response = deliver(State(test_state(false)), headers, body).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let (headers, body) = signed(
            DELIVER_PATH,
            &json!({"recipients": ["a@mailhooks.cc"], "raw": "A".repeat(MAX_RAW_BASE64 + 4)}),
        );
        let response = deliver(State(test_state(false)), headers, body).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn rejects_empty_and_huge_recipient_lists() {
        for recipients in [
            Vec::new(),
            vec!["a@mailhooks.cc".to_string(); MAX_RECIPIENTS + 1],
        ] {
            let (headers, body) = signed(
                DELIVER_PATH,
                &json!({"recipients": recipients, "raw": b64("x")}),
            );
            let response = deliver(State(test_state(false)), headers, body).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    async fn through_router(
        state: AppState,
        path: &str,
        headers: HeaderMap,
        body: Bytes,
    ) -> StatusCode {
        use tower::ServiceExt;
        let mut request = axum::http::Request::post(path)
            .body(axum::body::Body::from(body))
            .unwrap();
        *request.headers_mut() = headers;
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            crate::mail::router(state).oneshot(request),
        )
        .await
        .expect("router answered in time")
        .unwrap();
        response.status()
    }

    #[tokio::test]
    async fn a_delivery_without_a_free_slot_is_refused_before_its_body_is_read() {
        let state = test_state(false);
        state.mail_deliver_slots.close();
        let payload = json!({"recipients": ["a@mailhooks.cc"], "raw": b64("Subject: x\r\n\r\ny")});
        let (headers, body) = signed(DELIVER_PATH, &payload);
        assert_eq!(
            through_router(state, DELIVER_PATH, headers, body).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn the_signature_precheck_runs_before_the_slot() {
        let state = test_state(false);
        state.mail_deliver_slots.close();
        let status = through_router(
            state,
            DELIVER_PATH,
            HeaderMap::new(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn recipient_checks_do_not_need_a_delivery_slot() {
        let state = test_state(true);
        state.mail_deliver_slots.close();
        let (headers, body) = signed(CHECK_PATH, &json!({"address": "a@mailhooks.cc"}));
        assert_eq!(
            through_router(state, CHECK_PATH, headers, body).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn a_delivery_with_a_free_slot_reaches_the_handler() {
        let (headers, body) = signed(
            DELIVER_PATH,
            &json!({"recipients": ["x@example.com"], "raw": b64("Subject: x\r\n\r\ny")}),
        );
        assert_eq!(
            through_router(test_state(false), DELIVER_PATH, headers, body).await,
            StatusCode::OK
        );
    }

    #[test]
    fn groups_recipients_by_slug_and_keeps_positions() {
        let recipients = vec![
            "b@mailhooks.cc".to_string(),
            "a+one@mailhooks.cc".to_string(),
            "x@example.com".to_string(),
            "A+two@mailhooks.cc".to_string(),
            "bad slug@mailhooks.cc".to_string(),
        ];
        let (groups, immediate) = group_recipients(&recipients, &domains());
        let slugs: Vec<&str> = groups.iter().map(|g| g.slug.as_str()).collect();
        assert_eq!(slugs, vec!["b", "a"]);
        assert_eq!(groups[1].positions, vec![1, 3]);
        assert_eq!(groups[1].addresses[0].tag.as_deref(), Some("one"));
        assert_eq!(immediate, vec![(2, "relay_denied"), (4, "invalid")]);
    }

    #[test]
    fn clamps_implausible_receive_times() {
        let now = Utc::now();
        assert_eq!(clamp_received_at(None, now), now);
        let recent = now - TimeDelta::minutes(5);
        assert_eq!(clamp_received_at(Some(recent), now), recent);
        assert_eq!(clamp_received_at(Some(now - TimeDelta::days(3)), now), now);
        assert_eq!(clamp_received_at(Some(now + TimeDelta::hours(2)), now), now);
    }

    #[test]
    fn keeps_only_small_metadata_objects() {
        assert_eq!(
            bounded_object(Some(json!({"spf": "pass"}))),
            json!({"spf": "pass"})
        );
        assert_eq!(bounded_object(Some(json!("pass"))), Value::Null);
        assert_eq!(bounded_object(None), Value::Null);
        let big = json!({ "x": "y".repeat(MAX_META_BYTES) });
        assert_eq!(bounded_object(Some(big)), Value::Null);
        assert_eq!(bounded_object(Some(json!({"x": "a\u{0}b"}))), Value::Null);
    }

    #[test]
    fn only_a_caller_that_says_so_marks_a_delivery_as_a_test() {
        let mx: DeliverRequest =
            serde_json::from_value(json!({"recipients": ["a@mailhooks.cc"], "raw": ""})).unwrap();
        assert!(!mx.test);
        let dashboard: DeliverRequest = serde_json::from_value(
            json!({"recipients": ["a@mailhooks.cc"], "raw": "", "test": true}),
        )
        .unwrap();
        assert!(dashboard.test);
    }

    #[test]
    fn caps_short_text_fields() {
        assert_eq!(short_text("  mail.example.com "), "mail.example.com");
        assert_eq!(short_text(&"h".repeat(1000)).len(), MAX_TEXT_FIELD);
        assert!(!short_text("a\0b").contains('\0'));
    }

    #[test]
    fn prefixes_the_preview_with_the_subject() {
        let parsed = parse::parse_message(b"Subject: Hello\r\n\r\nBody text\r\n");
        let preview = notification_preview(&parsed);
        assert!(preview.starts_with("Hello\nBody text"));
        assert!(preview.chars().count() <= NOTIFICATION_PREVIEW_LEN);
    }

    #[test]
    fn treats_only_data_errors_as_permanent() {
        assert_eq!(
            email_failure_status(&sqlx::Error::PoolTimedOut),
            "transient"
        );
        assert_eq!(email_failure_status(&sqlx::Error::RowNotFound), "transient");
    }
}
