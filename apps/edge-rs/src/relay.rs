//! The live relay: `whk tunnel --live` (registry.rs keeps those sessions by
//! endpoint id). The receiver captures a request as usual, then sends it
//! here, on the private network only (never routed by Caddy), as
//! `<method> /v1/live/<endpoint_id><rest>` with the original headers and
//! exact body and `x-whk-relay-auth: <EDGE_SECRET>`. The edge removes that
//! header, sends the request down the session's tunnel to
//! `localhost:<port>` with `<rest>` as its path, and streams the app's
//! answer back, so the sender gets what the app said.
//!
//! None of the share's front door applies: no notice, password or report
//! button, and the bytes are not metered as sharing data, since each
//! request is already a capture on the account's request quota. The answer
//! goes out on the capture host (go.webhooks.cc), for free accounts too, so
//! it has rules of its own ([`check`]): what an API answers with (JSON, XML,
//! form data, text other than script), no downloads, at most [`MAX_ANSWER`].
//! What the edge says itself carries `x-whk-live`:
//!
//! - `offline` (502): no live session for the endpoint.
//! - `unreachable` (502): the session is open, but nothing answers on the
//!   local port, or the tunnel dropped mid-request.
//! - `timeout` (504): no answer's head within [`HEAD_TIMEOUT`].
//! - `busy` (503): the account has too many requests in flight.
//! - `refused` (502): the app's answer is not passed back ([`check`]); the
//!   CLI hears why. (A 404 `refused` is a request without the secret.)
//! - `answered`: on the app's own answer, whatever its status, so the
//!   receiver can tell the app's 502 from the edge's.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{HeaderValue, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use whk_tunnel::{EdgeMessage, HEADER_NOTHING_LISTENING};

use crate::{Body, State, header_str, pages};

/// Where the receiver's relayed requests arrive.
pub const PATH_PREFIX: &str = "/v1/live/";
/// The receiver's proof that it is the receiver.
pub const AUTH_HEADER: &str = "x-whk-relay-auth";
/// What the edge says about the answer (see the module's words).
pub const LIVE_HEADER: &str = "x-whk-live";
/// How long the app has to start its answer (a second in the tests).
pub const HEAD_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(25)
};
/// The most of an answer passed back: a webhook's answer is a few bytes of
/// JSON or text. A longer stated length is refused up front.
pub const MAX_ANSWER: usize = 1024 * 1024;
/// Where a stream with no stated length is broken off: a little past
/// [`MAX_ANSWER`], so the receiver, which cuts at [`MAX_ANSWER`] itself, is
/// the one that ends it and records why.
const STREAM_CUT: usize = MAX_ANSWER + 64 * 1024;
/// A path segment's most, for the endpoint id.
const ID_MAX: usize = 64;

pub async fn serve(state: State, address: SocketAddr) -> anyhow::Result<()> {
    let listener = TcpListener::bind(address).await?;
    tracing::info!(listen = %address, "relay up");
    serve_on(state, listener).await;
    Ok(())
}

async fn serve_on(state: State, listener: TcpListener) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                tracing::warn!(error = %e, "relay accept failed");
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
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

/// The endpoint id and the rest of the path (always starting `/`), from
/// `/v1/live/<id><rest>`.
fn split_path(path_and_query: &str) -> Option<(&str, String)> {
    let after = path_and_query.strip_prefix(PATH_PREFIX)?;
    let end = after.find(['/', '?']).unwrap_or(after.len());
    let (id, rest) = after.split_at(end);
    let ok = !id.is_empty()
        && id.len() <= ID_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return None;
    }
    let rest = if rest.starts_with('/') {
        rest.to_string()
    } else {
        format!("/{rest}")
    };
    Some((id, rest))
}

/// Why an app's answer is not passed back, in words for the developer.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    Download,
    Kind(String),
    Untyped,
    Mixed,
    TooLarge,
}

impl Refusal {
    pub fn describe(&self) -> String {
        match self {
            Refusal::Download => "a download".into(),
            Refusal::Kind(kind) => format!("an answer of type {kind}"),
            Refusal::Untyped => "an answer with a body but no content type".into(),
            Refusal::Mixed => "an answer with more than one content type".into(),
            Refusal::TooLarge => format!("an answer over {} MB", MAX_ANSWER / (1024 * 1024)),
        }
    }
}

/// Types an API answers with. Script is left out, even as `text/*`: the
/// capture host is no place to serve it from.
fn api_type(kind: &str) -> bool {
    let script = kind.contains("javascript") || kind.contains("ecmascript");
    !script
        && (kind.starts_with("text/")
            || kind == "application/json"
            || kind == "application/xml"
            || kind == "application/x-www-form-urlencoded"
            || (kind.starts_with("application/")
                && (kind.ends_with("+json") || kind.ends_with("+xml"))))
}

/// Whether an app's answer may go back to the sender on the capture host.
pub fn check(status: StatusCode, headers: &http::HeaderMap) -> Result<(), Refusal> {
    if status.is_informational()
        || status == StatusCode::NO_CONTENT
        || status == StatusCode::NOT_MODIFIED
    {
        return Ok(());
    }
    let attachment = headers.get_all("content-disposition").iter().any(|v| {
        v.to_str().map_or(true, |d| {
            d.trim_start()
                .to_ascii_lowercase()
                .starts_with("attachment")
        })
    });
    if attachment {
        return Err(Refusal::Download);
    }
    let length = header_str(headers, "content-length").and_then(|l| l.parse::<u64>().ok());
    if length.is_some_and(|l| l > MAX_ANSWER as u64) {
        return Err(Refusal::TooLarge);
    }
    let mut types = headers.get_all(header::CONTENT_TYPE).iter();
    let kind = match (types.next(), types.next()) {
        (None, _) => None,
        (Some(_), Some(_)) => return Err(Refusal::Mixed),
        (Some(value), None) => {
            let value = value.to_str().map_err(|_| Refusal::Mixed)?;
            if value.contains(',') {
                return Err(Refusal::Mixed);
            }
            Some(
                value
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase(),
            )
            .filter(|k| !k.is_empty())
        }
    };
    match kind {
        None if length == Some(0) => Ok(()),
        None => Err(Refusal::Untyped),
        Some(kind) if api_type(&kind) => Ok(()),
        Some(kind) => Err(Refusal::Kind(kind)),
    }
}

/// An answer the edge gives itself, marked with what happened.
fn said(status: StatusCode, live: &'static str, message: &str) -> Response<Body> {
    let body = serde_json::json!({ "error": message }).to_string();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .header(LIVE_HEADER, live)
        .body(pages::full(body))
        .unwrap()
}

async fn handle(state: State, req: Request<Incoming>) -> Response<Body> {
    let authorized = header_str(req.headers(), AUTH_HEADER)
        .is_some_and(|given| crate::control::same_secret(given, &state.config.edge_secret));
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_default();
    let Some((endpoint_id, rest)) = split_path(&path).filter(|_| authorized) else {
        return said(StatusCode::NOT_FOUND, "refused", "Not found");
    };
    let Some(session) = state.registry.get_live(endpoint_id) else {
        return said(
            StatusCode::BAD_GATEWAY,
            "offline",
            "No live tunnel is open for this endpoint.",
        );
    };
    let Some(_hold) = session.door.streams.enter(crate::limits::ACCOUNT_STREAMS) else {
        return said(
            StatusCode::SERVICE_UNAVAILABLE,
            "busy",
            "Too many requests in flight through this live tunnel.",
        );
    };
    let started = Instant::now();
    let method = req.method().to_string();
    let unreachable = |session: &crate::registry::Session, status: u16| {
        session.notify(&EdgeMessage::Request {
            method: method.clone(),
            path: rest.clone(),
            status,
            ms: started.elapsed().as_millis() as u64,
        });
    };
    let Ok(stream) = session.opener.open().await else {
        unreachable(&session, 502);
        return said(
            StatusCode::BAD_GATEWAY,
            "unreachable",
            "The live tunnel dropped.",
        );
    };
    let Ok((mut sender, connection)) = hyper::client::conn::http1::Builder::new()
        .handshake(TokioIo::new(stream))
        .await
    else {
        unreachable(&session, 502);
        return said(
            StatusCode::BAD_GATEWAY,
            "unreachable",
            "The live tunnel dropped.",
        );
    };
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let (mut parts, body) = req.into_parts();
    parts.uri = rest.parse().unwrap_or_else(|_| http::Uri::from_static("/"));
    parts.version = http::Version::HTTP_11;
    parts.headers.remove(AUTH_HEADER);
    // Webhooks do not upgrade: one request, one answer.
    crate::strip_hop_by_hop(&mut parts.headers, false);
    let local_host = format!("localhost:{}", session.port);
    parts
        .headers
        .insert(header::HOST, HeaderValue::from_str(&local_host).unwrap());

    let response = match tokio::time::timeout(
        HEAD_TIMEOUT,
        sender.send_request(Request::from_parts(parts, body)),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => {
            unreachable(&session, 502);
            return said(
                StatusCode::BAD_GATEWAY,
                "unreachable",
                "The app closed the connection without an answer.",
            );
        }
        Err(_) => {
            unreachable(&session, 504);
            return said(
                StatusCode::GATEWAY_TIMEOUT,
                "timeout",
                "The app did not answer in time.",
            );
        }
    };
    let status = response.status();
    if response.headers().contains_key(HEADER_NOTHING_LISTENING) {
        unreachable(&session, 502);
        return said(
            StatusCode::BAD_GATEWAY,
            "unreachable",
            &format!(
                "Nothing is running on port {} on the computer running whk.",
                session.port
            ),
        );
    }
    let (mut parts, body) = response.into_parts();
    parts.version = http::Version::HTTP_11;
    crate::strip_hop_by_hop(&mut parts.headers, false);
    if let Err(refusal) = check(status, &parts.headers) {
        unreachable(&session, 502);
        if session.limits.should_warn_blocked(Instant::now()) {
            session.notify(&EdgeMessage::Notice {
                text: format!(
                    "Not passed back to the sender: {} at {}. A live tunnel passes back what an API answers with (JSON, XML, form data or text, not script), up to {} MB, and no downloads.",
                    refusal.describe(),
                    rest.chars().take(120).collect::<String>(),
                    MAX_ANSWER / (1024 * 1024)
                ),
            });
        }
        return said(
            StatusCode::BAD_GATEWAY,
            "refused",
            "The app's answer was not passed back.",
        );
    }
    session.notify(&EdgeMessage::Request {
        method,
        path: rest,
        status: status.as_u16(),
        ms: started.elapsed().as_millis() as u64,
    });
    parts
        .headers
        .insert(LIVE_HEADER, HeaderValue::from_static("answered"));
    // The hold on the account's streams lasts until the answer is through.
    let body = Holding {
        inner: Limited::new(body, STREAM_CUT).boxed(),
        _hold,
    };
    Response::from_parts(parts, Body::new(body))
}

/// An answer's body that keeps the account's stream counted until it ends.
struct Holding {
    inner: Body,
    _hold: crate::limits::StreamGuard,
}

impl hyper::body::Body for Holding {
    type Data = Bytes;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
        std::pin::Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use http_body_util::Full;
    use tokio_tungstenite::WebSocketStream;
    use tokio_tungstenite::tungstenite::protocol::Role;
    use whk_tunnel::{mux, ws};

    use super::*;
    use crate::config::Config;
    use crate::registry::{Opening, Registry, Session};

    #[test]
    fn the_path_names_the_endpoint_and_keeps_the_rest() {
        assert_eq!(
            split_path("/v1/live/ep_123/stripe/events?x=1"),
            Some(("ep_123", "/stripe/events?x=1".to_string()))
        );
        assert_eq!(split_path("/v1/live/ep-1"), Some(("ep-1", "/".to_string())));
        assert_eq!(
            split_path("/v1/live/ep1?a=b"),
            Some(("ep1", "/?a=b".to_string()))
        );
        assert_eq!(split_path("/v1/live/"), None);
        assert_eq!(split_path("/v1/live/../x"), None);
        assert_eq!(split_path("/v1/other/ep1"), None);
        assert_eq!(split_path(&format!("/v1/live/{}", "a".repeat(65))), None);
    }

    fn state() -> State {
        let config = Config::testing("http://127.0.0.1:9");
        let held = crate::held::Held::new(config.held_up_max);
        State {
            access: crate::access_log::AccessLog::default(),
            web: crate::web::Web::new(&config),
            registry: Registry::new(config.pace, held.clone()),
            held,
            config: Arc::new(config),
            connects: Arc::default(),
            meter: Arc::default(),
        }
    }

    /// A local app on a port, answering as `answer` says.
    async fn app<F, Fut>(answer: F) -> u16
    where
        F: Fn(Request<Incoming>) -> Fut + Clone + Send + Sync + 'static,
        Fut: std::future::Future<Output = Response<Full<Bytes>>> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let answer = answer.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let answer = answer.clone();
                        async move { Ok::<_, Infallible>(answer(req).await) }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        port
    }

    /// A live session for `endpoint`, whose CLI end pipes every stream to
    /// `port` on this machine, as `whk tunnel --live` does.
    async fn live_session(state: &State, endpoint: &str, port: u16) -> Arc<Session> {
        let (edge_io, cli_io) = tokio::io::duplex(1 << 20);
        let (opener, inbound, _task) = mux::spawn(edge_io, yamux::Mode::Client);
        drop(inbound);
        let (_cli_opener, mut streams, _cli_task) = mux::spawn(cli_io, yamux::Mode::Server);
        tokio::spawn(async move {
            while let Some(mut stream) = streams.recv().await {
                tokio::spawn(async move {
                    if let Ok(mut local) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await
                    {
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut local).await;
                    }
                });
            }
        });
        // The CLI's text messages go to a socket nobody reads.
        let (text_io, _other) = tokio::io::duplex(1 << 16);
        std::mem::forget(_other);
        let socket = WebSocketStream::from_raw_socket(text_io, Role::Server, None).await;
        let (_bytes, text) = ws::split(socket);
        std::mem::forget(_bytes);
        let session = Arc::new(Session::new(
            Opening {
                share_id: "share-1".into(),
                user_id: "user-1".into(),
                name: "acme-hooks".into(),
                port,
                endpoint_id: Some(endpoint.into()),
                notice: false,
                gate: None,
                run: "run-1".into(),
            },
            opener,
            text.sender(),
            state.registry.account("user-1"),
        ));
        std::mem::forget(text);
        state.registry.insert(session.clone());
        session
    }

    async fn relay(state: &State) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(serve_on(state.clone(), listener));
        format!("http://{address}")
    }

    #[tokio::test]
    async fn a_capture_reaches_the_app_and_its_answer_comes_back() {
        let state = state();
        let port = app(|req: Request<Incoming>| async move {
            let host = header_str(req.headers(), "host").unwrap_or("").to_string();
            let auth = req.headers().contains_key(AUTH_HEADER);
            let path = req.uri().to_string();
            let body = req.into_body().collect().await.unwrap().to_bytes();
            Response::builder()
                .status(201)
                .header("content-type", "text/plain")
                .header("x-app", "yes")
                .body(Full::new(Bytes::from(format!(
                    "{host}|{auth}|{path}|{}",
                    String::from_utf8_lossy(&body)
                ))))
                .unwrap()
        })
        .await;
        live_session(&state, "ep1", port).await;
        let base = relay(&state).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/live/ep1/hooks/stripe?x=1"))
            .header(AUTH_HEADER, "s")
            .body("{\"id\":\"evt_1\"}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 201);
        assert_eq!(response.headers()[LIVE_HEADER], "answered");
        assert_eq!(response.headers()["x-app"], "yes");
        assert_eq!(
            response.text().await.unwrap(),
            format!("localhost:{port}|false|/hooks/stripe?x=1|{{\"id\":\"evt_1\"}}")
        );
    }

    #[tokio::test]
    async fn no_session_is_offline_and_a_wrong_secret_is_not_found() {
        let state = state();
        let base = relay(&state).await;
        let client = reqwest::Client::new();
        let offline = client
            .post(format!("{base}/v1/live/nobody/x"))
            .header(AUTH_HEADER, "s")
            .send()
            .await
            .unwrap();
        assert_eq!(offline.status(), 502);
        assert_eq!(offline.headers()[LIVE_HEADER], "offline");
        for auth in [Some("wrong"), None] {
            let mut request = client.post(format!("{base}/v1/live/nobody/x"));
            if let Some(auth) = auth {
                request = request.header(AUTH_HEADER, auth);
            }
            let refused = request.send().await.unwrap();
            assert_eq!(refused.status(), 404, "{auth:?}");
        }
    }

    #[tokio::test]
    async fn a_slow_app_times_out_with_504() {
        let state = state();
        let port = app(|_req: Request<Incoming>| async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Response::new(Full::new(Bytes::new()))
        })
        .await;
        live_session(&state, "ep2", port).await;
        let base = relay(&state).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/live/ep2/slow"))
            .header(AUTH_HEADER, "s")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 504);
        assert_eq!(response.headers()[LIVE_HEADER], "timeout");
    }

    #[tokio::test]
    async fn nothing_on_the_port_is_unreachable() {
        let state = state();
        // A port nothing listens on: bound, then let go.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        live_session(&state, "ep3", port).await;
        let base = relay(&state).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/live/ep3/x"))
            .header(AUTH_HEADER, "s")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 502);
        assert_eq!(response.headers()[LIVE_HEADER], "unreachable");
    }

    #[test]
    fn only_api_answers_go_back() {
        let with = |pairs: &[(&'static str, &'static str)]| {
            let mut h = http::HeaderMap::new();
            for (k, v) in pairs {
                h.append(*k, HeaderValue::from_static(v));
            }
            h
        };
        let ok = |pairs: &[(&'static str, &'static str)]| check(StatusCode::OK, &with(pairs));
        for kind in [
            "application/json",
            "application/json; charset=utf-8",
            "application/problem+json",
            "application/xml",
            "application/soap+xml",
            "text/xml",
            "text/plain",
            "text/html",
            "application/x-www-form-urlencoded",
        ] {
            assert_eq!(ok(&[("content-type", kind)]), Ok(()), "{kind}");
        }
        for kind in [
            "application/javascript",
            "text/javascript",
            "application/octet-stream",
            "video/mp4",
            "image/png",
            "application/pdf",
        ] {
            assert!(
                matches!(ok(&[("content-type", kind)]), Err(Refusal::Kind(_))),
                "{kind}"
            );
        }
        assert_eq!(
            ok(&[
                ("content-type", "application/json"),
                ("content-disposition", "attachment; filename=a.exe")
            ]),
            Err(Refusal::Download)
        );
        assert_eq!(
            ok(&[("content-type", "application/json, video/mp4")]),
            Err(Refusal::Mixed)
        );
        assert_eq!(
            ok(&[
                ("content-type", "text/plain"),
                ("content-type", "video/mp4")
            ]),
            Err(Refusal::Mixed)
        );
        assert_eq!(
            ok(&[
                ("content-type", "text/plain"),
                ("content-length", "1048577")
            ]),
            Err(Refusal::TooLarge)
        );
        // No type is fine for nothing at all.
        assert_eq!(ok(&[("content-length", "0")]), Ok(()));
        assert_eq!(ok(&[("content-length", "3")]), Err(Refusal::Untyped));
        assert_eq!(check(StatusCode::NO_CONTENT, &with(&[])), Ok(()));
    }

    #[tokio::test]
    async fn a_download_is_not_passed_back() {
        let state = state();
        let port = app(|_req: Request<Incoming>| async move {
            Response::builder()
                .header("content-type", "application/octet-stream")
                .body(Full::new(Bytes::from_static(b"MZ\x90\x00")))
                .unwrap()
        })
        .await;
        live_session(&state, "ep4", port).await;
        let base = relay(&state).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/live/ep4/x"))
            .header(AUTH_HEADER, "s")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 502);
        assert_eq!(response.headers()[LIVE_HEADER], "refused");
    }

    #[tokio::test]
    async fn a_stated_length_past_the_cap_is_refused_up_front() {
        let state = state();
        let port = app(|_req: Request<Incoming>| async move {
            Response::builder()
                .header("content-type", "text/plain")
                .body(Full::new(Bytes::from(vec![b'x'; MAX_ANSWER + 1])))
                .unwrap()
        })
        .await;
        live_session(&state, "ep5", port).await;
        let base = relay(&state).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/live/ep5/x"))
            .header(AUTH_HEADER, "s")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 502);
        assert_eq!(response.headers()[LIVE_HEADER], "refused");
    }
}
