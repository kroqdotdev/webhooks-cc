use anyhow::{Context, Result};
use futures::StreamExt;
use reqwest::StatusCode;
use reqwest::header::{DATE, HeaderMap};
use std::collections::VecDeque;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::{ApiClient, extract_error};
use crate::types::{CapturedRequest, SseEvent};

const MAX_BUFFER_SIZE: usize = 1024 * 1024; // 1 MB
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// The server emits a `: keepalive` comment every 30 s. Three missed keepalives
/// means the connection is dead even if TCP has not noticed yet.
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const BACKOFF_BASE: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// How many request IDs to remember for de-duplicating replays after a reconnect.
const RECENT_IDS_CAPACITY: usize = 256;
/// A rotation (`event: timeout`) sooner than this after connecting counts as
/// "rapid"; `RAPID_ROTATION_LIMIT` rapid rotations in a row go through backoff.
const MIN_ROTATION_INTERVAL: Duration = Duration::from_secs(5);
const RAPID_ROTATION_LIMIT: u32 = 2;

/// Why a single stream connection ended.
#[derive(Debug)]
enum StreamEnd {
    /// The server rotated the stream (`event: timeout`). Reconnect immediately.
    Rotated,
    /// Terminal: the endpoint was deleted or the consumer dropped the receiver.
    Done,
    /// Transient failure. Reconnect with backoff.
    Failed(String),
}

/// Why a connection attempt was rejected.
#[derive(Debug)]
enum ConnectError {
    /// Retrying will not help (bad token, no access, endpoint gone).
    Terminal(String),
    /// Worth retrying (network error, 5xx, rate limit).
    Transient(String),
}

impl ApiClient {
    /// Connect to the SSE stream for an endpoint and send events to the channel.
    ///
    /// Reconnects transparently when the server rotates the stream (every 30
    /// minutes), when the connection drops, or when no data arrives for
    /// `READ_IDLE_TIMEOUT`. Each reconnect passes `?since=<ms>` so requests
    /// captured during the gap are replayed. Emits [`SseEvent::Reconnecting`]
    /// before each backoff wait.
    ///
    /// Returns `Ok(())` when the endpoint is deleted or the receiver is dropped,
    /// and `Err` for terminal failures (not logged in, 401/403/404).
    pub async fn stream_requests(&self, slug: &str, tx: mpsc::Sender<SseEvent>) -> Result<()> {
        self.require_auth()?;
        let headers = self.auth_headers()?;

        let sse_client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .context("failed to create SSE client")?;

        let base_url = self.url(&format!("/api/stream/{}", urlencoding::encode(slug)));
        let mut cursor = ResumeCursor::default();
        let mut attempt: u32 = 0;
        let mut rapid_rotations: u32 = 0;

        loop {
            if tx.is_closed() {
                return Ok(());
            }

            let url = stream_url(&base_url, cursor.since());
            // Rotation age is measured from when the stream actually opened, so
            // connection setup latency cannot disguise an immediate rotation.
            let mut opened = std::time::Instant::now();
            let outcome = match connect(&sse_client, &url, &headers, slug).await {
                Ok(resp) => {
                    opened = std::time::Instant::now();
                    // Floor for the resume cursor: the server's clock (at or before
                    // the connection start) or, without a Date header, the client
                    // clock with a one-second margin for skew.
                    cursor.set_floor_once(
                        server_time_ms(resp.headers()).unwrap_or_else(|| now_ms() - 1_000),
                    );
                    read_stream(resp, &tx, &mut cursor, &mut attempt).await
                }
                Err(ConnectError::Terminal(msg)) => anyhow::bail!(msg),
                Err(ConnectError::Transient(msg)) => StreamEnd::Failed(msg),
            };

            // A scheduled rotation normally arrives after 30 minutes. Two in a row
            // within seconds of connecting mean the server is bouncing us, so route
            // that through the backoff path instead of a tight reconnect loop.
            let outcome = match outcome {
                StreamEnd::Rotated => {
                    if opened.elapsed() < MIN_ROTATION_INTERVAL {
                        rapid_rotations += 1;
                    } else {
                        rapid_rotations = 0;
                    }
                    if rapid_rotations >= RAPID_ROTATION_LIMIT {
                        StreamEnd::Failed("stream rotated immediately after connecting".to_string())
                    } else {
                        StreamEnd::Rotated
                    }
                }
                other => other,
            };

            match outcome {
                StreamEnd::Done => return Ok(()),
                StreamEnd::Rotated => continue,
                StreamEnd::Failed(reason) => {
                    rapid_rotations = 0;
                    attempt += 1;
                    let delay = with_jitter(next_backoff(attempt));
                    let event = SseEvent::Reconnecting {
                        attempt,
                        delay_ms: delay.as_millis() as u64,
                        reason,
                    };
                    if tx.send(event).await.is_err() {
                        return Ok(());
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = tx.closed() => return Ok(()),
                    }
                }
            }
        }
    }
}

/// Resolve a spawned `stream_requests` task once the consumer loop has exited.
///
/// After Ctrl+C the task is aborted and the result is `Ok`. Otherwise the task
/// has already finished (the channel closed or it sent a terminal event), so
/// its result is awaited and a terminal stream error is returned to the caller
/// instead of being dropped on the floor.
pub async fn join_stream(handle: JoinHandle<Result<()>>, interrupted: bool) -> Result<()> {
    if interrupted {
        handle.abort();
        return Ok(());
    }
    match handle.await {
        Ok(result) => result,
        Err(e) if e.is_cancelled() => Ok(()),
        Err(e) => Err(anyhow::anyhow!("stream task failed: {e}")),
    }
}

/// Open one SSE connection. Classifies HTTP rejections so the caller knows
/// whether retrying makes sense.
async fn connect(
    client: &reqwest::Client,
    url: &str,
    headers: &HeaderMap,
    slug: &str,
) -> std::result::Result<reqwest::Response, ConnectError> {
    let request = client
        .get(url)
        .headers(headers.clone())
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .send();

    let resp = match tokio::time::timeout(CONNECT_TIMEOUT, request).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            let chain = format!("{:#}", anyhow::Error::new(e.without_url()));
            return Err(ConnectError::Transient(format!("connect failed: {chain}")));
        }
        Err(_) => {
            return Err(ConnectError::Transient(format!(
                "timed out after {}s waiting for the stream to open",
                CONNECT_TIMEOUT.as_secs()
            )));
        }
    };

    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }

    let body = resp.text().await.unwrap_or_default();
    let detail = extract_error(status, &body);
    Err(classify_http_rejection(status, slug, &detail))
}

fn classify_http_rejection(status: StatusCode, slug: &str, detail: &str) -> ConnectError {
    match status {
        StatusCode::UNAUTHORIZED => ConnectError::Terminal(format!(
            "Stream rejected: not authenticated ({detail}). Run `whk auth login` to log in again."
        )),
        StatusCode::FORBIDDEN => ConnectError::Terminal(format!(
            "Stream rejected: you do not have access to endpoint `{slug}` ({detail})."
        )),
        StatusCode::NOT_FOUND => ConnectError::Terminal(format!("Endpoint not found: `{slug}`.")),
        StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS => {
            ConnectError::Transient(format!("server returned {status}"))
        }
        s if s.is_client_error() => ConnectError::Terminal(format!("Stream rejected: {detail}")),
        s => ConnectError::Transient(format!("server returned {s}")),
    }
}

/// Read one SSE connection to completion, forwarding parsed events.
async fn read_stream(
    resp: reqwest::Response,
    tx: &mpsc::Sender<SseEvent>,
    cursor: &mut ResumeCursor,
    attempt: &mut u32,
) -> StreamEnd {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut event_type = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    loop {
        let chunk = match tokio::time::timeout(READ_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(Some(Err(e))) => return StreamEnd::Failed(format!("read error: {e}")),
            Ok(None) => return StreamEnd::Failed("connection closed by server".to_string()),
            Err(_) => {
                return StreamEnd::Failed(format!(
                    "no data received for {}s",
                    READ_IDLE_TIMEOUT.as_secs()
                ));
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Guard against unbounded buffer growth
        if buffer.len() > MAX_BUFFER_SIZE {
            buffer.clear();
            event_type.clear();
            data_lines.clear();
            continue;
        }

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
            buffer.drain(..newline_pos + 1);

            if line.is_empty() {
                if !data_lines.is_empty() {
                    let data = data_lines.join("\n");
                    if let Some(ev) = parse_sse_event(&event_type, &data)
                        && let Some(end) = dispatch(ev, tx, cursor, attempt).await
                    {
                        return end;
                    }
                }
                event_type.clear();
                data_lines.clear();
            } else if let Some(rest) = line.strip_prefix("event:") {
                event_type = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            } else if line.starts_with(':') {
                // Comment line: the server's periodic keepalive. Proof of a live,
                // healthy connection, so the backoff counter starts over.
                *attempt = 0;
            }
        }
    }
}

/// Forward one parsed event to the consumer. Returns `Some` when the
/// connection should stop being read.
async fn dispatch(
    event: SseEvent,
    tx: &mpsc::Sender<SseEvent>,
    cursor: &mut ResumeCursor,
    attempt: &mut u32,
) -> Option<StreamEnd> {
    let after = match &event {
        // `connected` arrives on every accept, including from a server that then
        // drops us immediately, so it is not evidence of a healthy stream and
        // must not reset the backoff counter (keepalives and requests do).
        SseEvent::Connected => None,
        SseEvent::Request(req) => {
            *attempt = 0;
            if !cursor.observe(&req.id, req.received_at) {
                return None; // replayed duplicate after a reconnect
            }
            None
        }
        SseEvent::Timeout => Some(StreamEnd::Rotated),
        SseEvent::EndpointDeleted => Some(StreamEnd::Done),
        SseEvent::Reconnecting { .. } => None,
    };

    if tx.send(event).await.is_err() {
        return Some(StreamEnd::Done);
    }
    after
}

/// Where to resume after a reconnect.
///
/// The server replays requests whose `receivedAt` is strictly greater than
/// `since`, so the cursor is the largest `receivedAt` delivered so far. Before
/// any request has been seen it falls back to the server time of the first
/// connection (`floor`) so requests that arrive while the CLI is reconnecting
/// are still replayed.
///
/// Postgres stores `received_at` with microsecond precision while `receivedAt`
/// is truncated to milliseconds, so the newest request is usually replayed once
/// more after a reconnect; `recent_ids` drops those duplicates.
#[derive(Debug, Default)]
struct ResumeCursor {
    last_received_at: Option<i64>,
    floor: Option<i64>,
    recent_ids: VecDeque<String>,
}

impl ResumeCursor {
    /// Value for the `?since=` query parameter, if any.
    fn since(&self) -> Option<i64> {
        self.last_received_at.or(self.floor)
    }

    /// Record the server time of the first successful connection.
    fn set_floor_once(&mut self, ts_ms: i64) {
        if self.floor.is_none() {
            self.floor = Some(ts_ms);
        }
    }

    /// Record a delivered request. Returns `false` if it was already delivered.
    fn observe(&mut self, id: &str, received_at: i64) -> bool {
        if self.recent_ids.iter().any(|seen| seen == id) {
            return false;
        }
        if self.recent_ids.len() == RECENT_IDS_CAPACITY {
            self.recent_ids.pop_front();
        }
        self.recent_ids.push_back(id.to_string());
        self.last_received_at = Some(
            self.last_received_at
                .map_or(received_at, |cur| cur.max(received_at)),
        );
        true
    }
}

fn stream_url(base: &str, since: Option<i64>) -> String {
    match since {
        Some(ts) => format!("{base}?since={ts}"),
        None => base.to_string(),
    }
}

/// Exponential backoff: 1s, 2s, 4s, 8s, 16s, then 30s. `attempt` starts at 1.
fn next_backoff(attempt: u32) -> Duration {
    let exp = attempt.saturating_sub(1).min(16);
    let secs = BACKOFF_BASE.as_secs().saturating_mul(1u64 << exp);
    Duration::from_secs(secs.min(BACKOFF_MAX.as_secs()))
}

/// Add up to 10% random jitter so many clients do not reconnect in lockstep.
fn with_jitter(base: Duration) -> Duration {
    let max_jitter_ms = (base.as_millis() / 10) as u64;
    base + Duration::from_millis(rand::random_range(0..=max_jitter_ms))
}

/// Server clock from the `Date` response header. The header has one-second
/// precision, so this is the start of the second the connection opened in, i.e.
/// at or before the server's own connection start: a replay floor here can
/// only over-replay (handled by the recent-id dedup), never skip a request that
/// was captured in the same second as the drop.
fn server_time_ms(headers: &HeaderMap) -> Option<i64> {
    let raw = headers.get(DATE)?.to_str().ok()?;
    let parsed = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    Some(parsed.timestamp() * 1000)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn parse_sse_event(event_type: &str, data: &str) -> Option<SseEvent> {
    match event_type {
        "connected" => {
            let _: serde_json::Value = serde_json::from_str(data).ok()?;
            Some(SseEvent::Connected)
        }
        "request" => {
            let req: CapturedRequest = serde_json::from_str(data).ok()?;
            Some(SseEvent::Request(Box::new(req)))
        }
        "endpoint_deleted" => Some(SseEvent::EndpointDeleted),
        "timeout" => Some(SseEvent::Timeout),
        _ => {
            if !data.is_empty()
                && let Ok(req) = serde_json::from_str::<CapturedRequest>(data)
            {
                return Some(SseEvent::Request(Box::new(req)));
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_connected_event() {
        let event = parse_sse_event("connected", r#"{"slug":"test","endpointId":"ep-1"}"#);
        assert!(matches!(event, Some(SseEvent::Connected)));
    }

    #[test]
    fn test_parse_connected_invalid_json() {
        let event = parse_sse_event("connected", "not json");
        assert!(event.is_none());
    }

    #[test]
    fn test_parse_request_event() {
        let data = r#"{"_id":"r1","endpointId":"ep","method":"POST","path":"/","headers":{},"queryParams":{},"ip":"1.2.3.4","size":0,"receivedAt":123}"#;
        let event = parse_sse_event("request", data);
        match event {
            Some(SseEvent::Request(req)) => {
                assert_eq!(req.id, "r1");
                assert_eq!(req.method, "POST");
            }
            _ => panic!("expected Request event"),
        }
    }

    #[test]
    fn test_parse_request_invalid_json() {
        let event = parse_sse_event("request", "not json");
        assert!(event.is_none());
    }

    #[test]
    fn test_parse_endpoint_deleted() {
        let event = parse_sse_event("endpoint_deleted", "");
        assert!(matches!(event, Some(SseEvent::EndpointDeleted)));
    }

    #[test]
    fn test_parse_timeout() {
        let event = parse_sse_event("timeout", "");
        assert!(matches!(event, Some(SseEvent::Timeout)));
    }

    #[test]
    fn test_parse_unknown_event_with_request_data() {
        let data = r#"{"id":"r1","endpointId":"ep","method":"GET","path":"/","headers":{},"queryParams":{},"ip":"1.2.3.4","size":0,"receivedAt":123}"#;
        let event = parse_sse_event("", data);
        assert!(matches!(event, Some(SseEvent::Request(_))));
    }

    #[test]
    fn test_parse_unknown_event_empty_data() {
        let event = parse_sse_event("", "");
        assert!(event.is_none());
    }

    #[test]
    fn test_parse_unknown_event_garbage_data() {
        let event = parse_sse_event("custom_event", "some random data");
        assert!(event.is_none());
    }

    // ─── Backoff ────────────────────────────────────────────────────────

    #[test]
    fn test_next_backoff_doubles_and_caps() {
        assert_eq!(next_backoff(1), Duration::from_secs(1));
        assert_eq!(next_backoff(2), Duration::from_secs(2));
        assert_eq!(next_backoff(3), Duration::from_secs(4));
        assert_eq!(next_backoff(4), Duration::from_secs(8));
        assert_eq!(next_backoff(5), Duration::from_secs(16));
        assert_eq!(next_backoff(6), Duration::from_secs(30));
        assert_eq!(next_backoff(7), Duration::from_secs(30));
        assert_eq!(next_backoff(u32::MAX), Duration::from_secs(30));
    }

    #[test]
    fn test_next_backoff_zero_attempt_is_base() {
        assert_eq!(next_backoff(0), BACKOFF_BASE);
    }

    #[test]
    fn test_with_jitter_stays_within_ten_percent() {
        for _ in 0..50 {
            let d = with_jitter(Duration::from_secs(10));
            assert!(d >= Duration::from_secs(10));
            assert!(d <= Duration::from_secs(11));
        }
    }

    // ─── Resume cursor ──────────────────────────────────────────────────

    #[test]
    fn test_cursor_starts_without_since() {
        let cursor = ResumeCursor::default();
        assert_eq!(cursor.since(), None);
        assert_eq!(
            stream_url("http://x/api/stream/s", cursor.since()),
            "http://x/api/stream/s"
        );
    }

    #[test]
    fn test_cursor_tracks_max_received_at() {
        let mut cursor = ResumeCursor::default();
        assert!(cursor.observe("a", 100));
        assert!(cursor.observe("b", 300));
        assert!(cursor.observe("c", 200)); // out of order replay
        assert_eq!(cursor.since(), Some(300));
        assert_eq!(
            stream_url("http://x/api/stream/s", cursor.since()),
            "http://x/api/stream/s?since=300"
        );
    }

    #[test]
    fn test_cursor_floor_used_until_first_request() {
        let mut cursor = ResumeCursor::default();
        cursor.set_floor_once(1_000);
        cursor.set_floor_once(2_000); // ignored: floor is set once
        assert_eq!(cursor.since(), Some(1_000));
        cursor.observe("a", 5_000);
        assert_eq!(cursor.since(), Some(5_000));
    }

    #[test]
    fn test_cursor_request_before_floor_does_not_move_since_backwards() {
        // The floor only matters while nothing has been seen; once a request is
        // delivered its receivedAt is authoritative, even if older than the floor.
        let mut cursor = ResumeCursor::default();
        cursor.set_floor_once(10_000);
        cursor.observe("a", 9_000);
        assert_eq!(cursor.since(), Some(9_000));
    }

    #[test]
    fn test_cursor_drops_duplicate_ids() {
        let mut cursor = ResumeCursor::default();
        assert!(cursor.observe("a", 100));
        assert!(!cursor.observe("a", 100));
        assert!(cursor.observe("b", 100));
    }

    #[test]
    fn test_cursor_recent_ids_bounded() {
        let mut cursor = ResumeCursor::default();
        for i in 0..RECENT_IDS_CAPACITY + 10 {
            assert!(cursor.observe(&format!("id-{i}"), i as i64));
        }
        assert_eq!(cursor.recent_ids.len(), RECENT_IDS_CAPACITY);
        // The oldest id fell out of the window and would be accepted again.
        assert!(cursor.observe("id-0", 0));
        // A recent one is still remembered.
        assert!(!cursor.observe(&format!("id-{}", RECENT_IDS_CAPACITY + 9), 0));
    }

    // ─── HTTP classification ────────────────────────────────────────────

    #[test]
    fn test_classify_terminal_statuses() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::BAD_REQUEST,
        ] {
            assert!(
                matches!(
                    classify_http_rejection(status, "s", "d"),
                    ConnectError::Terminal(_)
                ),
                "{status} should be terminal"
            );
        }
    }

    #[test]
    fn test_classify_transient_statuses() {
        for status in [
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert!(
                matches!(
                    classify_http_rejection(status, "s", "d"),
                    ConnectError::Transient(_)
                ),
                "{status} should be transient"
            );
        }
    }

    #[test]
    fn test_classify_messages_mention_slug_and_login() {
        let ConnectError::Terminal(msg) =
            classify_http_rejection(StatusCode::UNAUTHORIZED, "my-slug", "Invalid token (401)")
        else {
            panic!("expected terminal");
        };
        assert!(msg.contains("whk auth login"), "{msg}");

        let ConnectError::Terminal(msg) =
            classify_http_rejection(StatusCode::NOT_FOUND, "my-slug", "Endpoint not found (404)")
        else {
            panic!("expected terminal");
        };
        assert!(msg.contains("my-slug"), "{msg}");
    }

    #[test]
    fn test_server_time_ms_parses_date_header() {
        let mut headers = HeaderMap::new();
        headers.insert(DATE, "Sat, 22 Aug 2026 10:00:00 GMT".parse().unwrap());
        let ts = server_time_ms(&headers).unwrap();
        // Start of the second (at or before the real connection time), not the end.
        let expected = chrono::DateTime::parse_from_rfc3339("2026-08-22T10:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(ts, expected);
        assert!(server_time_ms(&HeaderMap::new()).is_none());
    }
}

/// End-to-end tests against a scripted fake SSE server.
#[cfg(test)]
mod live_tests {
    use super::*;
    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::extract::{Query, State};
    use axum::http::StatusCode as AxStatus;
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    const REQ_1: &str = r#"{"_id":"r1","endpointId":"ep","method":"POST","path":"/a","headers":{},"queryParams":{},"ip":"1.2.3.4","size":0,"receivedAt":1000}"#;
    const REQ_2: &str = r#"{"_id":"r2","endpointId":"ep","method":"POST","path":"/b","headers":{},"queryParams":{},"ip":"1.2.3.4","size":0,"receivedAt":2000}"#;

    /// What the fake server does for the n-th connection.
    enum Script {
        /// Serve these raw SSE frames, then close the connection.
        Sse(Vec<String>),
        /// Reject with this HTTP status.
        Status(u16),
    }

    #[derive(Default)]
    struct Shared {
        scripts: Vec<Script>,
        /// `since` query parameter of each connection, in order.
        seen_since: Vec<Option<String>>,
    }

    fn frame(event: &str, data: &str) -> String {
        format!("event: {event}\ndata: {data}\n\n")
    }

    async fn handler(
        State(shared): State<Arc<Mutex<Shared>>>,
        Query(q): Query<HashMap<String, String>>,
    ) -> Response {
        let mut s = shared.lock().unwrap();
        let n = s.seen_since.len();
        s.seen_since.push(q.get("since").cloned());
        match s.scripts.get(n) {
            Some(Script::Status(code)) => (
                AxStatus::from_u16(*code).unwrap(),
                r#"{"error":"scripted failure"}"#,
            )
                .into_response(),
            Some(Script::Sse(frames)) => {
                let chunks: Vec<std::result::Result<Bytes, std::convert::Infallible>> =
                    frames.iter().map(|f| Ok(Bytes::from(f.clone()))).collect();
                (
                    [("content-type", "text/event-stream")],
                    Body::from_stream(futures::stream::iter(chunks)),
                )
                    .into_response()
            }
            None => (AxStatus::INTERNAL_SERVER_ERROR, "no script for connection").into_response(),
        }
    }

    async fn start_server(scripts: Vec<Script>) -> (String, Arc<Mutex<Shared>>) {
        let shared = Arc::new(Mutex::new(Shared {
            scripts,
            seen_since: Vec::new(),
        }));
        let app = Router::new()
            .route("/api/stream/{slug}", get(handler))
            .with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://127.0.0.1:{}", addr.port()), shared)
    }

    /// Run `stream_requests` to completion, collecting every event it emits.
    async fn run_client(base: &str) -> (Vec<SseEvent>, Result<()>) {
        let mut client = ApiClient::new(Some(base), Some(base)).unwrap();
        client.set_token("test-token".into());
        let (tx, mut rx) = mpsc::channel(64);
        let handle = tokio::spawn(async move { client.stream_requests("my-slug", tx).await });
        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        let result = handle.await.unwrap();
        (events, result)
    }

    fn kinds(events: &[SseEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| match e {
                SseEvent::Connected => "connected".to_string(),
                SseEvent::Request(r) => format!("request:{}", r.id),
                SseEvent::EndpointDeleted => "endpoint_deleted".to_string(),
                SseEvent::Timeout => "timeout".to_string(),
                SseEvent::Reconnecting { attempt, .. } => format!("reconnecting:{attempt}"),
            })
            .collect()
    }

    #[tokio::test]
    async fn rotation_reconnects_with_since_and_drops_replayed_duplicate() {
        let (base, shared) = start_server(vec![
            Script::Sse(vec![
                frame("connected", r#"{"slug":"my-slug","endpointId":"ep"}"#),
                frame("request", REQ_1),
                frame("timeout", r#"{"reason":"max_duration"}"#),
            ]),
            Script::Sse(vec![
                frame("connected", r#"{"slug":"my-slug","endpointId":"ep"}"#),
                frame("request", REQ_1), // replayed: receivedAt == since (ms truncation)
                frame("request", REQ_2),
                frame("endpoint_deleted", r#"{"slug":"my-slug"}"#),
            ]),
        ])
        .await;

        let (events, result) = tokio::time::timeout(Duration::from_secs(10), run_client(&base))
            .await
            .expect("stream should finish");

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            kinds(&events),
            vec![
                "connected",
                "request:r1",
                "timeout",
                "connected",
                "request:r2",
                "endpoint_deleted"
            ]
        );
        let seen = shared.lock().unwrap().seen_since.clone();
        assert_eq!(seen, vec![None, Some("1000".to_string())]);
    }

    #[tokio::test]
    async fn unauthorized_is_terminal_and_does_not_retry() {
        let (base, shared) = start_server(vec![Script::Status(401), Script::Status(401)]).await;

        let (events, result) = tokio::time::timeout(Duration::from_secs(10), run_client(&base))
            .await
            .expect("stream should finish");

        let err = result.expect_err("401 must be a terminal error");
        assert!(err.to_string().contains("whk auth login"), "{err:#}");
        assert!(events.is_empty(), "{:?}", kinds(&events));
        assert_eq!(shared.lock().unwrap().seen_since.len(), 1, "must not retry");
    }

    #[tokio::test]
    async fn transient_failures_back_off_and_reset_after_keepalive() {
        let (base, shared) = start_server(vec![
            Script::Status(503),
            // Accepts, then closes without delivering anything: `connected`
            // alone must NOT reset the backoff counter.
            Script::Sse(vec![frame("connected", "{}")]),
            // Accepts and proves it is alive with a keepalive comment, then
            // closes: the keepalive resets the counter.
            Script::Sse(vec![
                frame("connected", "{}"),
                ": keepalive\n\n".to_string(),
            ]),
            Script::Sse(vec![
                frame("connected", "{}"),
                frame("endpoint_deleted", "{}"),
            ]),
        ])
        .await;

        let started = std::time::Instant::now();
        let (events, result) = tokio::time::timeout(Duration::from_secs(20), run_client(&base))
            .await
            .expect("stream should finish");

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            kinds(&events),
            vec![
                "reconnecting:1",
                "connected",
                "reconnecting:2", // `connected` then close: no reset, backoff escalates
                "connected",
                "reconnecting:1", // keepalive proved the stream healthy: counter reset
                "connected",
                "endpoint_deleted"
            ]
        );
        // Backoffs of ~1s, ~2s and ~1s (plus up to 10% jitter each).
        assert!(
            started.elapsed() >= Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );

        let reasons: Vec<(u64, String)> = events
            .iter()
            .filter_map(|e| match e {
                SseEvent::Reconnecting {
                    delay_ms, reason, ..
                } => Some((*delay_ms, reason.clone())),
                _ => None,
            })
            .collect();
        assert!(reasons[0].1.contains("503"), "{}", reasons[0].1);
        assert!(reasons[1].1.contains("closed"), "{}", reasons[1].1);
        assert!(reasons[2].1.contains("closed"), "{}", reasons[2].1);
        // attempt 1 -> ~1s, attempt 2 -> ~2s, back to attempt 1 -> ~1s (+10% jitter)
        assert!(
            (1000..=1100).contains(&reasons[0].0),
            "delay {}",
            reasons[0].0
        );
        assert!(
            (2000..=2200).contains(&reasons[1].0),
            "delay {}",
            reasons[1].0
        );
        assert!(
            (1000..=1100).contains(&reasons[2].0),
            "delay {}",
            reasons[2].0
        );

        // Before any request is seen, reconnects resume from the first
        // successful connection's server time (the floor), not from nothing.
        let seen = shared.lock().unwrap().seen_since.clone();
        assert_eq!(seen.len(), 4);
        assert!(seen[0].is_none());
        assert!(
            seen[1].is_none(),
            "no floor before the first successful connect"
        );
        assert!(
            seen[2].is_some() && seen[3].is_some(),
            "floor must be sent once a connect succeeded"
        );
    }

    #[tokio::test]
    async fn dropping_receiver_stops_the_stream() {
        let (base, _shared) = start_server((0..8).map(|_| Script::Status(503)).collect()).await;
        let mut client = ApiClient::new(Some(&base), Some(&base)).unwrap();
        client.set_token("test-token".into());
        let (tx, mut rx) = mpsc::channel(64);
        let handle = tokio::spawn(async move { client.stream_requests("my-slug", tx).await });

        // Wait for the first Reconnecting event, then hang up.
        let first = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("should get an event")
            .expect("channel open");
        assert!(matches!(first, SseEvent::Reconnecting { attempt: 1, .. }));
        drop(rx);

        let result = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("stream task should stop once the receiver is dropped")
            .unwrap();
        assert!(result.is_ok());
    }
}
