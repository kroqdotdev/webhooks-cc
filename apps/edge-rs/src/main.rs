//! webhooks-edge: the tunnel service behind `whk share` and
//! `whk tunnel --live`.
//!
//! One plain-HTTP listener (TLS ends at the Caddy in front) serves two
//! kinds of request, told apart by host:
//!
//! - `<name>.sharehooks.cc`: a visitor. The request goes down the tunnel of
//!   the share with that name, as a new yamux stream the CLI pipes to its
//!   local port. The bare domain sends visitors to the docs.
//! - anything else, at [`CONNECT_PATH`]: `whk share` or `whk tunnel --live`
//!   opening a tunnel, after the web app says it may (see `web.rs`).
//!
//! A second listener (relay.rs), on the private network only, takes the
//! receiver's captures for endpoints with a live session and sends them
//! down that session's tunnel.

mod access_log;
mod config;
mod content;
mod control;
mod debugger;
mod decode;
mod door;
mod gate;
mod held;
mod inject;
mod limits;
mod line;
mod meter;
mod notice;
mod observability;
mod pace;
mod pages;
mod registry;
mod relay;
mod slow;
mod web;
mod words;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Either, Empty, Full, Limited, combinators::BoxBody};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use whk_tunnel::{
    CONNECT_PATH, EdgeMessage, HEADER_CLIENT, HEADER_ENDPOINT, HEADER_INSTANCE, HEADER_KIND,
    HEADER_NAME, HEADER_NOTHING_LISTENING, HEADER_PASSWORD, HEADER_PORT, mux, splice, ws,
};

use config::Config;
use registry::{Opening, Registry, Session};
use web::{Opened, Web};

/// Any body the edge sends: its own pages, or the laptop's, cut off at
/// [`content::MAX_RESPONSE`] (hence the boxed error).
pub type Body = BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone)]
pub struct State {
    config: Arc<Config>,
    access: access_log::AccessLog,
    web: Web,
    registry: Registry,
    connects: Arc<limits::ConnectLimits>,
    /// What each share sends visitors, and who is past their allowance
    /// (meter.rs).
    meter: Arc<meter::Meter>,
    /// The answers held up for visitors who fell behind (held.rs).
    held: Arc<held::Held>,
    /// Pages being decoded at once (decode.rs).
    decodes: Arc<decode::Decodes>,
}

fn main() -> anyhow::Result<()> {
    // StatOSS first, before the runtime starts its threads, so they and the
    // panic hook see the client. Dropping the guard at the end sends what is
    // queued.
    let statoss = observability::init();
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        // Colours for a terminal, plain text for the journal.
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout())),
        )
        .with(statoss.is_enabled().then(observability::layer))
        .init();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    let config = Config::from_env()?;
    let words = words::load(config.words_file.as_deref())?;
    pages::set_app_url(&config.app_url);
    let web = Web::new(&config);
    let held = held::Held::new(config.held_up_max);
    let state = State {
        access: access_log::AccessLog::open(config.access_log_dir.clone()),
        web,
        registry: Registry::new(config.pace, held.clone()),
        held,
        config: Arc::new(config),
        connects: Arc::default(),
        meter: Arc::default(),
        decodes: Arc::default(),
    };
    // Before listening: the start closes every share the web app had open,
    // which must not include ones opened here.
    state.web.started().await;
    let control = state.clone();
    tokio::spawn(async move {
        if let Err(e) = control::serve(control).await {
            tracing::error!(error = %e, "control listener failed");
        }
    });
    tokio::spawn(control::sync(state.clone()));
    if let Some(address) = state.config.relay_listen {
        let relaying = state.clone();
        tokio::spawn(async move {
            if let Err(e) = relay::serve(relaying, address).await {
                tracing::error!(error = %e, "relay listener failed");
            }
        });
    }
    let listener = listen(state.config.listen)?;
    tracing::info!(
        listen = %state.config.listen,
        previews = %state.config.preview_domain,
        relay = ?state.config.relay_listen,
        pace = ?state.config.pace,
        held_up_max = state.config.held_up_max,
        words,
        "edge up"
    );

    let stopping = stop_signal();
    tokio::pin!(stopping);
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = &mut stopping => {
                // What visitors took since the last sync is not lost to a
                // restart or a deploy.
                tracing::info!("stopping: handing over the last counts");
                control::last_sync(&state).await;
                return Ok(());
            }
        };
        let (stream, remote) = match accepted {
            Ok(accepted) => accepted,
            Err(e) => {
                tracing::warn!(error = %e, "accept failed");
                continue;
            }
        };
        no_delay(&stream);
        let state = state.clone();
        tokio::spawn(async move {
            // Watched once it serves a visitor: counted among the answers
            // held up when it falls behind, closed when it takes nothing.
            let conn = Arc::new(held::Conn::default());
            let stream = held::Watched::new(stream, conn.clone(), state.held.clone());
            let service = service_fn(move |req| {
                let state = state.clone();
                let conn = conn.clone();
                async move { Ok::<_, Infallible>(handle(state, req, remote, conn).await) }
            });
            let _ = server()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await;
        });
    }
}

/// The kernel's send buffer for each connection (it doubles this for its
/// own bookkeeping). Linux grows one up to 4 MiB for a reader that went
/// slow, and the container's memory counts it; next to Caddy on the same
/// host, this much keeps any one connection at full speed.
const SEND_BUFFER: u32 = 64 * 1024;

/// The visitors' and tunnels' listener; what it accepts inherits its send
/// buffer.
fn listen(address: SocketAddr) -> std::io::Result<TcpListener> {
    let socket = if address.is_ipv4() {
        tokio::net::TcpSocket::new_v4()?
    } else {
        tokio::net::TcpSocket::new_v6()?
    };
    socket.set_reuseaddr(true)?;
    socket.set_send_buffer_size(SEND_BUFFER)?;
    socket.bind(address)?;
    socket.listen(1024)
}

/// What hyper may hold for one visitor's request on each side of the edge
/// (its default is about 400 KiB): what a slow visitor's answer piles up
/// here, besides the tunnel stream's window (mux.rs). Also the most a
/// request's or an answer's head may be, give or take a read: more than
/// the 16 KiB Node's servers take.
const BUFFER: usize = 32 * 1024;

/// How a visitor's or a tunnel's connection is served.
fn server() -> http1::Builder {
    let mut builder = http1::Builder::new();
    builder
        // A visitor gets 20 seconds to send its headers (hyper only keeps
        // that timeout with a timer), on a new connection or an idle one.
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(20))
        .max_buf_size(BUFFER);
    builder
}

/// Small writes go out at once. With Nagle's algorithm a tunnel's yamux
/// frames (a header and its body are two writes) and a visitor's chunks
/// waited for the peer's delayed ACK: some 40 ms a request.
fn no_delay(stream: &tokio::net::TcpStream) {
    if let Err(e) = stream.set_nodelay(true) {
        tracing::debug!(error = %e, "TCP_NODELAY not set");
    }
}

/// Ctrl-C, or the SIGTERM Docker sends to stop the container.
async fn stop_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("a SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

/// Previews on sharehooks.cc stay out of search results: what people share
/// there is theirs, often unfinished, and is not ours to have indexed under
/// our name. A header, since a preview's robots.txt is the shared site's
/// own.
fn keep_out_of_search(headers: &mut http::HeaderMap) {
    headers.insert(
        http::HeaderName::from_static("x-robots-tag"),
        http::HeaderValue::from_static("noindex, nofollow"),
    );
}

async fn handle(
    state: State,
    req: Request<Incoming>,
    remote: SocketAddr,
    conn: Arc<held::Conn>,
) -> Response<Body> {
    let host = host_of(req.headers(), req.uri());
    // A preview's every path is the shared site's, the health one included.
    if let Some(name) = state.config.name_of(&host) {
        conn.serves_visitors();
        let address = visitor_address(req.headers(), remote);
        let key = visitor_key(&address);
        let session = state.registry.get(&name);
        let asked = meter::Asked::of(&state.meter, &req, &key);
        let entry = access_log::Entry::of(&req, &host, address);
        let owner = session.map(|s| meter::Owner {
            kind: door::Kind::Share,
            id: s.id.clone(),
            user_id: s.user_id.clone(),
        });
        let access = state.access.clone();
        let meter = state.meter.clone();
        let mut response = proxy(state, req, name, host, remote, conn).await;
        keep_out_of_search(response.headers_mut());
        // What a case needs is what reached a share: a name nothing is
        // shared under, or a visitor turned away by the limits, is only
        // sampled (access_log.rs).
        let turned_away = response
            .extensions()
            .get::<meter::OwnPage>()
            .is_some_and(|p| p.0 == pages::TOO_MANY);
        let reach = if owner.is_some() && !turned_away {
            access_log::Reach::Share
        } else {
            access_log::Reach::Elsewhere
        };
        access.record(
            entry.answered(
                &response,
                owner.as_ref().map(|o| (o.id.as_str(), o.user_id.as_str())),
            ),
            reach,
        );
        return match owner {
            Some(owner) => meter::Metered::wrap(meter, owner, asked, response),
            None => response,
        };
    }
    // The bare preview domain is no preview: it points at the docs.
    if state.config.is_bare_domain(&host) {
        return redirect(&format!("{}/docs/share", state.config.app_url));
    }
    if req.uri().path() == pages::SAMPLE_PATH {
        return pages::notice_sample(&state.config.preview_domain, &state.config.app_url);
    }
    // For the box's own checks only (a container name, an address,
    // localhost), never on a public name such as tunnel.webhooks.cc.
    if req.uri().path() == "/__edge/health" && internal_host(&host) {
        return Response::new(pages::full(format!(
            "ok, {} shares\n",
            state.registry.len()
        )));
    }
    if req.uri().path() == CONNECT_PATH {
        return connect(state, req, remote).await;
    }
    pages::unknown_host()
}

/// Whether a Host names the box from inside: an address, `localhost`, or a
/// bare name with no dot (a container's, `edge:4000`), never a public name.
fn internal_host(host: &str) -> bool {
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.split_once(']').map(|(ip, _)| ip))
        .unwrap_or_else(|| host.rsplit_once(':').map_or(host, |(h, _)| h));
    bare.parse::<std::net::IpAddr>().is_ok()
        || bare.eq_ignore_ascii_case("localhost")
        || (!bare.is_empty() && !bare.contains('.'))
}

fn host_of(headers: &HeaderMap, uri: &http::Uri) -> String {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(str::to_string)
        .or_else(|| uri.authority().map(|a| a.to_string()))
        .unwrap_or_default()
        .to_lowercase()
}

pub(crate) fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

// The tunnel --------------------------------------------------------------

async fn connect(state: State, mut req: Request<Incoming>, remote: SocketAddr) -> Response<Body> {
    let headers = req.headers();
    let address = visitor_address(headers, remote);
    let network = visitor_key(&address);
    if !state.connects.allow(&network, Instant::now()) {
        // A server error, so the CLI waits and tries again.
        return pages::refused(503, "Too many tunnel connections from your network.");
    }
    let upgrade_ok =
        header_str(headers, "upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    let Some(key) = header_str(headers, "sec-websocket-key").map(str::to_string) else {
        return pages::refused(400, "This is the webhooks.cc tunnel. Use `whk share`.");
    };
    if !upgrade_ok {
        return pages::refused(400, "This is the webhooks.cc tunnel. Use `whk share`.");
    }
    let Some(api_key) = header_str(headers, "authorization")
        .and_then(|a| a.strip_prefix("Bearer "))
        .map(str::to_string)
    else {
        return pages::refused(401, "Run `whk auth login` first.");
    };
    let Some(port) = header_str(headers, HEADER_PORT).and_then(|p| p.parse::<u16>().ok()) else {
        return pages::refused(400, "Say which local port to share.");
    };
    let live = match header_str(headers, HEADER_KIND) {
        None | Some("share") => false,
        Some("live") => true,
        Some(_) => return pages::refused(400, "Unknown kind of tunnel. Run `whk update`."),
    };
    let endpoint = header_str(headers, HEADER_ENDPOINT).map(str::to_string);
    if live && endpoint.is_none() {
        return pages::refused(400, "Say which endpoint the live tunnel is for.");
    }
    let name = header_str(headers, HEADER_NAME).map(str::to_string);
    // A run id, so a stop the CLI misses sticks across its reconnects.
    let Some(instance) = header_str(headers, HEADER_INSTANCE).map(str::to_string) else {
        return pages::refused(426, "This version of whk is too old. Run `whk update`.");
    };
    let client = header_str(headers, HEADER_CLIENT)
        .unwrap_or("an unnamed computer")
        .to_string();
    let password = match header_str(headers, HEADER_PASSWORD) {
        None => None,
        Some(hex_text) => match hex::decode(hex_text)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
        {
            Some(password) => Some(password),
            None => {
                return pages::refused(400, "The password could not be read. Run `whk update`.");
            }
        },
    };
    if live && password.is_some() {
        return pages::refused(400, "A live tunnel takes no password.");
    }

    let opened = match state
        .web
        .open(&web::OpenRequest {
            api_key: &api_key,
            name: name.as_deref(),
            client: &client,
            instance: Some(&instance),
            address: &address,
            password: password.as_deref(),
            kind: if live { "live" } else { "share" },
            endpoint: endpoint.as_deref(),
        })
        .await
    {
        Ok(opened) => opened,
        Err(refused) => return pages::refused(refused.status, &refused.error),
    };
    if live && opened.endpoint_id.is_none() {
        tracing::error!("the web app opened a live tunnel without its endpoint");
        state
            .web
            .closed(&opened.share_id, "no endpoint for the live tunnel")
            .await;
        return pages::refused(503, "webhooks.cc answered oddly. Try again in a moment.");
    }
    // A share never carries an endpoint, whatever the web app said.
    let opened = if live {
        opened
    } else {
        Opened {
            endpoint_id: None,
            ..opened
        }
    };

    let upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(run_session(state, upgrade, opened, port, instance));

    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(
            header::SEC_WEBSOCKET_ACCEPT,
            derive_accept_key(key.as_bytes()),
        )
        .body(empty())
        .unwrap()
}

async fn run_session(state: State, upgrade: OnUpgrade, opened: Opened, port: u16, run: String) {
    let upgraded = match upgrade.await {
        Ok(upgraded) => upgraded,
        Err(e) => {
            tracing::warn!(error = %e, "tunnel upgrade failed");
            state.web.closed(&opened.share_id, "upgrade failed").await;
            return;
        }
    };
    let socket =
        WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(ws::config()))
            .await;
    let (bytes, mut text) = ws::split(socket);
    text.incoming.close();
    let (opener, inbound, mut mux_task) = mux::spawn(bytes, yamux::Mode::Client);
    // The CLI has nothing to open towards the edge or to say to it: its
    // streams are reset and its text dropped at once, never buffered.
    drop(inbound);

    let ready = EdgeMessage::Ready {
        name: opened.name.clone(),
        url: opened.url.clone(),
        expires_at: opened.expires_at.clone(),
        expires_in: opened.expires_in,
        notice: opened.notice,
        password: opened.gate.is_some(),
    };
    text.send(serde_json::to_string(&ready).unwrap()).await;

    let session = Arc::new(Session::new(
        Opening {
            share_id: opened.share_id.clone(),
            user_id: opened.user_id.clone(),
            name: opened.name.clone(),
            port,
            endpoint_id: opened.endpoint_id.clone(),
            // A live session's traffic never meets the door (relay.rs).
            notice: opened.notice && opened.endpoint_id.is_none(),
            gate: opened.gate.clone().filter(|_| opened.endpoint_id.is_none()),
            run: run.clone(),
        },
        opener,
        text.sender(),
        state.registry.account(&opened.user_id),
    ));
    match state.registry.insert_unless_closed(session.clone()) {
        Ok(Some(old)) => old.close(if session.endpoint_id.is_some() {
            "a newer live tunnel took this endpoint"
        } else {
            "a newer share took this name"
        }),
        Ok(None) => {}
        // Stopped while it was opening: it ends below without serving.
        Err(reason) => session.close(&reason),
    }
    tracing::info!(
        name = %session.name,
        user = %session.user_id,
        live = session.endpoint_id.is_some(),
        "share open"
    );

    let mut closing = session.closing();
    let time_limit = async {
        match opened.expires_in {
            Some(seconds) => tokio::time::sleep(Duration::from_secs(seconds)).await,
            None => std::future::pending().await,
        }
    };
    // What ended it, for the record, and what the CLI should hear: nothing
    // when the tunnel itself dropped.
    let (reason, tell) = tokio::select! {
        _ = &mut mux_task => ("closed".to_string(), None),
        _ = time_limit => ("time limit".to_string(), Some("the plan's time limit".to_string())),
        changed = closing.wait_for(Option::is_some) => {
            let why = changed
                .ok()
                .and_then(|r| r.clone())
                .unwrap_or_else(|| "closed".to_string());
            (why.clone(), Some(why))
        }
    };
    // Visitors find nothing at once, while the CLI is still being told.
    state.registry.remove(&session);
    if let Some(why) = tell {
        // Waits for room behind queued traffic rather than dropping it, so
        // the CLI hears why and stops instead of reconnecting.
        let message = serde_json::to_string(&EdgeMessage::Closing { reason: why }).unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), text.send(message)).await;
    }
    if !mux_task.is_finished() {
        // Long enough for the Closing message to leave.
        tokio::time::sleep(Duration::from_millis(300)).await;
        mux_task.abort();
    }
    state.registry.remove(&session);
    drop(text);
    state.web.closed(&session.id, &reason).await;
    tracing::info!(name = %session.name, reason, "share closed");
}

// Visitors ----------------------------------------------------------------

/// Headers that belong to one hop and are not passed on (RFC 9110 7.6.1).
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

pub(crate) fn wants_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(header::UPGRADE)
        && header_str(headers, "connection").is_some_and(|c| {
            c.split(',')
                .any(|t| t.trim().eq_ignore_ascii_case("upgrade"))
        })
}

/// Headers `Connection` may not take away: what says what a body is. A
/// laptop answering `Connection: content-type` would otherwise have its
/// type checked (content.rs) and then dropped, and the visitor would get an
/// untyped body to sniff or save.
const NEVER_HOP_BY_HOP: &[&str] = &[
    "content-type",
    "content-length",
    "content-encoding",
    "content-disposition",
];

fn strip_hop_by_hop(headers: &mut HeaderMap, keep_upgrade: bool) {
    let listed: Vec<String> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|c| c.split(','))
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty() && !NEVER_HOP_BY_HOP.contains(&t.as_str()))
        .collect();
    for name in HOP_BY_HOP
        .iter()
        .copied()
        .chain(listed.iter().map(String::as_str))
    {
        if keep_upgrade && (name == "connection" || name == "upgrade") {
            continue;
        }
        headers.remove(name);
    }
}

/// Dev servers refuse a hot-reload WebSocket from a host they do not know:
/// Next.js (outside `allowedDevOrigins`) and webpack-dev-server check its
/// Origin. A request from the preview's own page is same-origin to the
/// visitor, so it gets the local origin, as Host does. Only for WebSockets
/// and Next's dev endpoints: Server Actions compare Origin with
/// X-Forwarded-Host, which stays public. Any other site keeps its Origin and
/// is still refused.
fn rewrite_origin(
    headers: &mut HeaderMap,
    public_origin: &str,
    local_origin: &str,
    path: &str,
    upgrading: bool,
) {
    // Next's own endpoints, under any basePath; not a page called /_next-steps.
    let dev_endpoint = path.contains("/_next/") || path.contains("/__nextjs");
    if !(upgrading || dev_endpoint) {
        return;
    }
    if header_str(headers, "origin").is_some_and(|o| o.eq_ignore_ascii_case(public_origin))
        && let Ok(v) = HeaderValue::from_str(local_origin)
    {
        headers.insert(header::ORIGIN, v);
    }
}

/// The visitor's address. In production the Caddy in front sets
/// CF-Connecting-IP from Cloudflare's header only when the request came
/// from Cloudflare, and to the real peer otherwise. Without it, the last
/// X-Forwarded-For entry, which the nearest proxy wrote.
fn visitor_address(headers: &HeaderMap, remote: SocketAddr) -> String {
    let ip = |v: &str| v.trim().parse::<std::net::IpAddr>().ok();
    header_str(headers, "cf-connecting-ip")
        .and_then(ip)
        .or_else(|| {
            header_str(headers, "x-forwarded-for")
                .and_then(|f| f.rsplit(',').next())
                .and_then(ip)
        })
        .unwrap_or_else(|| remote.ip())
        .to_string()
}

/// Whom the per-visitor limits count: the address, or for IPv6 its /56.
/// Providers hand a household or a server at least a /64, and often a /56
/// or a /48, so counting per /64 would let one of them be 256 visitors or
/// more.
fn visitor_key(address: &str) -> String {
    match address.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/56", s[0], s[1], s[2], s[3] & 0xff00)
            }
        },
        _ => address.to_string(),
    }
}

/// How long a visitor's WebSocket may carry nothing either way before the
/// edge ends it. Live reload sends pings well within this.
const SOCKET_IDLE: Duration = Duration::from_secs(10 * 60);

/// Resolves once `activity` has been still for `limit`.
async fn idle_for(activity: &meter::LastMoved, limit: Duration) {
    loop {
        let idle = activity.idle();
        if idle >= limit {
            return;
        }
        tokio::time::sleep((limit - idle).min(Duration::from_secs(30))).await;
    }
}

async fn proxy(
    state: State,
    req: Request<Incoming>,
    name: String,
    host: String,
    remote: SocketAddr,
    conn: Arc<held::Conn>,
) -> Response<Body> {
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let public_origin = format!("{}://{host}", state.config.public_scheme);
    // Where to report this address: on the notice and the edge's own pages.
    let report = report_url(&state.config.app_url, &format!("{public_origin}{path}"));
    // Our contacts, for whoever checks a preview's host for them.
    if req.uri().path() == SECURITY_TXT_PATH {
        return redirect(&format!("{}{SECURITY_TXT_PATH}", state.config.app_url));
    }
    let visit = Visit {
        host: &host,
        path: &path,
        public_origin: &public_origin,
        report: &report,
        remote,
        conn: &conn,
    };
    let Some(session) = state.registry.get(&name) else {
        return pages::nothing_shared(&host, &report);
    };
    let started = Instant::now();
    let method = req.method().to_string();
    let head = req.method() == Method::HEAD;
    if state.meter.is_over(&session.user_id) && session.limits.should_warn_over(started) {
        session.notify(&EdgeMessage::Notice {
            text: format!(
                "This month's sharing data on your plan is used up, so visitors see a page saying the preview is paused. See {}/account.",
                state.config.app_url
            ),
        });
    }
    let (mut req, entered) = match front_door(&state, &session.door, req, &visit, || {
        warn_limited(&session, started)
    })
    .await
    {
        Admission::Entered(req, entered) => (req, *entered),
        Admission::Answered(answer) => return answer,
    };
    let Entered {
        visitor,
        page_visit,
        upgrading,
        gated,
        guard,
        socket,
        paces,
    } = entered;

    // Werkzeug's debugger answers these itself, and its console runs code
    // on the laptop: never passed on (debugger.rs).
    if debugger::asks_for_debugger(req.uri().query()) {
        return debugger_refused(&session, method, path, started, &report);
    }

    let Ok(stream) = session.opener.open().await else {
        return pages::laptop_gone(&report);
    };
    let Ok((mut sender, connection)) = hyper::client::conn::http1::Builder::new()
        .max_buf_size(BUFFER)
        .handshake(TokioIo::new(stream))
        .await
    else {
        return pages::laptop_gone(&report);
    };
    let held = guard.clone();
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
        drop(held);
    });

    let visitor_upgrade = upgrading.then(|| hyper::upgrade::on(&mut req));
    let (mut parts, body) = req.into_parts();
    parts.uri = path.parse().unwrap_or_else(|_| http::Uri::from_static("/"));
    // Where Werkzeug's console page would be (debugger.rs).
    let console = debugger::may_be_console(parts.uri.path());
    parts.version = http::Version::HTTP_11;
    strip_hop_by_hop(&mut parts.headers, upgrading);
    notice::strip_request_cookies(&mut parts.headers);
    // The visitor's own cookies or credentials make a response theirs:
    // never cached by Cloudflare then.
    let credentialed = parts.headers.contains_key(header::COOKIE)
        || parts.headers.contains_key(header::AUTHORIZATION);
    // What the browser asks for it as: an image for an <img> (content.rs).
    let dest = header_str(&parts.headers, "sec-fetch-dest").map(str::to_string);
    // A page comes back uncompressed, so the report button can be added;
    // Cloudflare compresses it again on the way to the visitor.
    if page_visit {
        parts.headers.remove(header::ACCEPT_ENCODING);
    }
    // Dev servers such as Vite refuse hosts they do not know: the local
    // server sees itself, and the real address travels as X-Forwarded-Host.
    let local_host = format!("localhost:{}", session.port);
    parts
        .headers
        .insert(header::HOST, HeaderValue::from_str(&local_host).unwrap());
    rewrite_origin(
        &mut parts.headers,
        &public_origin,
        &format!("http://{local_host}"),
        parts.uri.path(),
        upgrading,
    );
    if let Ok(v) = HeaderValue::from_str(&host) {
        parts.headers.insert("x-forwarded-host", v);
    }
    parts.headers.insert(
        "x-forwarded-proto",
        HeaderValue::from_str(&state.config.public_scheme).unwrap(),
    );
    if let Ok(v) = HeaderValue::from_str(&visitor) {
        parts.headers.insert("x-forwarded-for", v);
    }

    // A body that stops coming ends the request (slow.rs). A WebSocket's
    // request has no body; its socket has its own idle timeout. What the
    // visitor sends is data like what they get: counted against the
    // account's month and the visitor's day, and sent at the share's pace
    // (meter.rs, pace.rs).
    let body = meter::CountedBody::wrap(
        slow::Steady::new(body).boxed(),
        state.meter.clone(),
        meter::Owner {
            kind: door::Kind::Share,
            id: session.id.clone(),
            user_id: session.user_id.clone(),
        },
        &visitor_key(&visitor),
    );
    let body = pace::Paced::wrap(body, paces.for_uploads());
    let response = match sender.send_request(Request::from_parts(parts, body)).await {
        Ok(response) => response,
        // The CLI answers 502 itself when nothing listens on the port, so
        // this is a server that closed the connection without an answer.
        Err(_) => {
            session.notify(&EdgeMessage::Request {
                method,
                path,
                status: 503,
                ms: started.elapsed().as_millis() as u64,
                request_id: None,
            });
            return pages::no_answer(session.port, &report);
        }
    };
    let status = response.status();
    if response.headers().contains_key(HEADER_NOTHING_LISTENING) {
        // The CLI's line shows what the visitor got: the edge's page.
        let page = pages::nothing_running(session.port, &report);
        session.notify(&EdgeMessage::Request {
            method,
            path,
            status: page.status().as_u16(),
            ms: started.elapsed().as_millis() as u64,
            request_id: None,
        });
        return page;
    }
    // Werkzeug's console page, once its answer shows it is (debugger.rs):
    // a page that short is read whole, then passed on if it is the app's.
    let mut response = if console && debugger::could_be_console_page(status, response.headers()) {
        let (parts, body) = response.into_parts();
        let page = match body.collect().await {
            Ok(page) => page.to_bytes(),
            Err(_) => {
                session.notify(&EdgeMessage::Request {
                    method,
                    path,
                    status: 503,
                    ms: started.elapsed().as_millis() as u64,
                    request_id: None,
                });
                return pages::no_answer(session.port, &report);
            }
        };
        if debugger::is_console_page(&page) {
            return debugger_refused(&session, method, path, started, &report);
        }
        Response::from_parts(parts, Either::Right(Full::new(page)))
    } else {
        response.map(Either::Left)
    };
    // Web pages only: no videos, audio or downloads (content.rs). What
    // belongs to the laptop's hop goes first, so the check sees what the
    // visitor will get.
    let pass = match status {
        StatusCode::SWITCHING_PROTOCOLS => Ok((content::Pass::AsSent, None)),
        _ => {
            strip_hop_by_hop(response.headers_mut(), false);
            content::check(status, response.headers(), dest.as_deref()).and_then(|pass| {
                // A page load compressed in a way the edge cannot read
                // could not get the report button or the phishing look
                // (decode.rs).
                if !page_visit {
                    return Ok((pass, None));
                }
                decode::codec_of(response.headers())
                    .map(|codec| (pass, codec))
                    .map_err(content::Refusal::Encoding)
            })
        }
    };
    let (pass, codec) = match pass {
        Ok(pass) => pass,
        Err(refusal) => {
            let page = pages::not_served(&refusal, &report);
            session.notify(&EdgeMessage::Request {
                method,
                path: path.clone(),
                status: page.status().as_u16(),
                ms: started.elapsed().as_millis() as u64,
                request_id: None,
            });
            if session.limits.should_warn_blocked(Instant::now()) {
                session.notify(&EdgeMessage::Notice {
                    text: format!(
                        "Not passed to visitors: {} at {}. Previews share web pages, not videos, audio or downloads.",
                        refusal.describe(),
                        path.chars().take(120).collect::<String>()
                    ),
                });
            }
            return page;
        }
    };
    session.notify(&EdgeMessage::Request {
        method,
        path: path.clone(),
        status: status.as_u16(),
        ms: started.elapsed().as_millis() as u64,
        request_id: None,
    });

    if status == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(visitor_upgrade) = visitor_upgrade {
            let local_upgrade = hyper::upgrade::on(&mut response);
            let meter = state.meter.clone();
            let owner = meter::Owner {
                kind: door::Kind::Share,
                id: session.id.clone(),
                user_id: session.user_id.clone(),
            };
            let who = visitor_key(&visitor);
            tokio::spawn(async move {
                if let (Ok(visitor), Ok(local)) = (visitor_upgrade.await, local_upgrade.await) {
                    // What the laptop sends the visitor counts as it goes,
                    // no faster than the share's pace (pace.rs), and ends
                    // the socket once the data runs out (meter.rs).
                    let visitor = pace::PacedSocket::new(TokioIo::new(visitor), paces);
                    let mut visitor = meter::CountedSocket::new(visitor, meter, owner, &who);
                    let activity = visitor.activity();
                    // Ends soon after either side does, so a server that
                    // keeps a left visitor's socket half-open does not
                    // hold the counts (splice.rs); and after a long while
                    // with nothing either way, so idle sockets cannot hold
                    // the visitor's and the account's streams for good.
                    let mut local = TokioIo::new(local);
                    tokio::select! {
                        _ = splice::splice(&mut visitor, &mut local, splice::LINGER) => {}
                        _ = idle_for(&activity, SOCKET_IDLE) => {}
                    }
                }
                drop(socket);
                drop(guard);
            });
        }
        let (mut parts, _) = response.into_parts();
        notice::strip_response_cookies(&mut parts.headers, cookie_host(&host));
        return Response::from_parts(parts, empty());
    }

    let (mut parts, body) = response.into_parts();
    // The visitor always gets HTTP/1.1, whatever the local server spoke.
    parts.version = http::Version::HTTP_11;
    strip_hop_by_hop(&mut parts.headers, false);
    // An error sent with no type, as plain text (content.rs).
    if pass == content::Pass::AsText {
        content::as_text(&mut parts.headers);
    }
    notice::strip_response_cookies(&mut parts.headers, cookie_host(&host));
    // To the address the visitor used.
    rewrite_location(&mut parts.headers, session.port, &public_origin);
    // Kept by Cloudflare only briefly, and only plain images anyone may see,
    // so Cloudflare's CSAM Scanning Tool (on for sharehooks.cc) checks them.
    // Everything else never: a cached page would reach visitors without the
    // edge (the notice, a stop), and a dev server's files change anyway.
    // Never behind a password: Cloudflare would hand a cached copy to
    // anyone asking, password or not.
    let cdn = if gated.is_none() && shared_image(status, &parts.headers, credentialed) {
        "public, max-age=60"
    } else {
        "no-store"
    };
    parts.headers.insert(
        "cloudflare-cdn-cache-control",
        HeaderValue::from_static(cdn),
    );

    // Pages get the report button, and a look for phishing (inject.rs),
    // whatever their status: a phishing page served as a 404 is still a
    // page. An SVG opened as a page can hold a form too, so it is looked
    // at, though it gets no button. A compressed one is read back first
    // and goes on uncompressed (decode.rs).
    let kind = header_str(&parts.headers, "content-type")
        .map(|t| {
            t.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    let has_body =
        !(head || status == StatusCode::NO_CONTENT || status == StatusCode::NOT_MODIFIED);
    let html = matches!(kind.as_str(), "text/html" | "application/xhtml+xml");
    // Shown as a page, and able to hold a form, but no place for a script
    // tag: an SVG, or XML (which a browser draws as XHTML when its root
    // says so). Looked at for phishing, with no button.
    let scanned = kind == "image/svg+xml"
        || matches!(kind.as_str(), "text/xml" | "application/xml")
        || kind.ends_with("+xml");
    let looked_at = page_visit && has_body && (html || scanned);
    let body: Body = body.map_err(Into::into).boxed();
    let body: Body = match codec.filter(|_| looked_at) {
        Some(codec) => {
            // A decoder holds its window for as long as the page streams:
            // capped per account and for the edge (decode.rs).
            let Some(slot) = state.decodes.take(&session.user_id) else {
                return pages::too_many(&report);
            };
            let body = if codec == decode::Codec::Brotli {
                match decode::brotli_checked(body).await {
                    Ok(body) => body,
                    Err(why) => {
                        return pages::not_served(&content::Refusal::Encoding(why), &report);
                    }
                }
            } else {
                body
            };
            parts.headers.remove(header::CONTENT_ENCODING);
            parts.headers.remove(header::CONTENT_LENGTH);
            decode::decode(body, codec, slot)
        }
        None => body,
    };
    let page_url = format!("{public_origin}{path}");
    let body = if looked_at && html {
        parts.headers.remove(header::CONTENT_LENGTH);
        with_badge(&state, &session.door, body, page_url)
    } else if looked_at {
        with_scan(&state, &session.door, body, page_url)
    } else {
        body
    };
    // An untyped error ends at its smaller cap, whole (content.rs), and so
    // does a redirect's body: a browser never shows it, and a client that
    // does not follow redirects must not get a file through one.
    let redirect = content::is_redirect(status, &parts.headers);
    if redirect
        && header_str(&parts.headers, "content-length")
            .and_then(|l| l.parse::<usize>().ok())
            .is_none_or(|l| l > content::MAX_REDIRECT_BODY)
    {
        parts.headers.remove(header::CONTENT_LENGTH);
    }
    let body = match pass {
        content::Pass::AsText => content::Capped::new(body, content::MAX_UNTYPED_ERROR).boxed(),
        content::Pass::AsSent if redirect => {
            content::Capped::new(body, content::MAX_REDIRECT_BODY).boxed()
        }
        content::Pass::AsSent => body,
    };
    // Cut off past the cap when the length was not stated up front, and
    // sent no faster than the share's pace (pace.rs).
    let body = pace::Paced::wrap(Limited::new(body, content::MAX_RESPONSE).boxed(), paces);
    Response::from_parts(parts, body)
}

/// Werkzeug's debugger, kept from a visitor (debugger.rs): our page,
/// the request in the CLI's log, and once a connection, why.
fn debugger_refused(
    session: &Session,
    method: String,
    path: String,
    started: Instant,
    report: &str,
) -> Response<Body> {
    let page = pages::debugger_refused(report);
    session.notify(&EdgeMessage::Request {
        method,
        path,
        status: page.status().as_u16(),
        ms: started.elapsed().as_millis() as u64,
        request_id: None,
    });
    if session.limits.should_warn_debugger() {
        session.notify(&EdgeMessage::Notice {
            text: debugger::NOTICE.into(),
        });
    }
    page
}

/// What a visit is to: the preview's host, the path asked for, and where
/// to report it.
pub(crate) struct Visit<'a> {
    pub host: &'a str,
    pub path: &'a str,
    pub public_origin: &'a str,
    pub report: &'a str,
    pub remote: SocketAddr,
    /// The visitor's connection (held.rs).
    pub conn: &'a Arc<held::Conn>,
}

/// What the front door did with a request: answered it itself, or let it
/// in with what the rest of its way needs.
pub(crate) enum Admission {
    Answered(Response<Body>),
    Entered(Request<Incoming>, Box<Entered>),
}

/// A request let in, with what the rest of its way needs.
pub(crate) struct Entered {
    pub visitor: String,
    pub page_visit: bool,
    pub upgrading: bool,
    /// The password version, when the door has one (the visitor had it).
    pub gated: Option<String>,
    /// The visitor's and the account's counts, held until the answer ends.
    pub guard: Arc<(
        limits::StreamGuard,
        limits::StreamGuard,
        limits::StreamGuard,
    )>,
    /// For a WebSocket, the visitor's count of open sockets, held while it
    /// is open.
    pub socket: Option<limits::StreamGuard>,
    /// How fast the answer may go to the visitor (pace.rs).
    pub paces: pace::Paces,
}

/// The front door of a share: the limits, the edge's own paths (continue,
/// the report button, its flags, a password), a password, and the notice.
/// Answers itself, or lets the request through.
pub(crate) async fn front_door(
    state: &State,
    door: &Arc<door::Door>,
    req: Request<Incoming>,
    visit: &Visit<'_>,
    on_limited: impl Fn(),
) -> Admission {
    // If the visitor falls behind, the answer's place among those held up
    // is the account's (held.rs).
    visit.conn.serves(door.paces.owner());
    let started = Instant::now();
    let visitor = visitor_address(req.headers(), visit.remote);
    let key = visitor_key(&visitor);
    if !door.limits.allow(&key, started) {
        on_limited();
        return Admission::Answered(pages::too_many(visit.report));
    }
    // One visitor took their day's share of it (meter.rs).
    if state.meter.visitor_spent(&door.id, &key) {
        return Admission::Answered(pages::visitor_spent(visit.report));
    }
    match req.uri().path() {
        notice::CONTINUE_PATH => {
            return Admission::Answered(
                continue_visit(state, door, req, visit.public_origin).await,
            );
        }
        inject::BADGE_PATH => return Admission::Answered(badge(state)),
        inject::FLAG_PATH => {
            return Admission::Answered(
                browser_flag(state, door, req, visit.public_origin, &key).await,
            );
        }
        gate::UNLOCK_PATH => {
            return Admission::Answered(
                unlock(state, door, req, visit.host, visit.public_origin, &key).await,
            );
        }
        _ => {}
    }
    let upgrading = wants_upgrade(req.headers());
    let page_visit = notice::is_page_visit(req.headers(), upgrading);
    let secret = state.config.edge_secret.as_bytes();
    // A password (gate.rs): nothing behind the door without the cookie.
    let gated = door.gate();
    if let Some(version) = &gated
        && !gate::has_pass(
            req.headers(),
            secret,
            &door.name,
            version,
            state.config.secure(),
            unix_now(),
        )
    {
        return Admission::Answered(if page_visit {
            pages::password_page(StatusCode::OK, visit.host, visit.path, visit.report, None)
        } else {
            pages::locked()
        });
    }
    // The account used its plan's data for the month (meter.rs). After the
    // password: a locked preview says no more than before to a stranger.
    if state.meter.is_over(&door.user_id) {
        return Admission::Answered(pages::over_allowance(visit.report));
    }
    if door.notice
        && page_visit
        && !notice::has_seen(
            req.headers(),
            secret,
            &door.notice_key(),
            state.config.secure(),
            unix_now(),
        )
    {
        return Admission::Answered(pages::visitor_notice(visit.host, visit.path, visit.report));
    }
    // Counted against the visitor and the account until the response or
    // WebSocket ends: the connection task and the upgrade's copy each hold
    // the guards.
    let Some(visitor_hold) = door.limits.enter_visitor(&key) else {
        on_limited();
        return Admission::Answered(pages::too_many(visit.report));
    };
    let Some(account_hold) = door.streams.enter(limits::ACCOUNT_STREAMS) else {
        on_limited();
        return Admission::Answered(pages::too_many(visit.report));
    };
    let Some(share_hold) = door.share_streams.enter(limits::SHARE_STREAMS) else {
        on_limited();
        return Admission::Answered(pages::too_many(visit.report));
    };
    // A WebSocket stays open, so one visitor may hold only a few.
    let socket = if upgrading {
        let Some(socket) = door.limits.enter_socket(&key) else {
            on_limited();
            return Admission::Answered(pages::too_many(visit.report));
        };
        Some(socket)
    } else {
        None
    };
    Admission::Entered(
        req,
        Box::new(Entered {
            visitor,
            page_visit,
            upgrading,
            gated,
            guard: Arc::new((visitor_hold, account_hold, share_hold)),
            socket,
            paces: door.paces.clone().on(visit.conn.clone()),
        }),
    )
}

/// A page with the report button added, and a look at its start for
/// phishing once that has passed (inject.rs).
pub(crate) fn with_badge<B>(state: &State, door: &Arc<door::Door>, body: B, page: String) -> Body
where
    B: hyper::body::Body<Data = Bytes> + Send + Sync + Unpin + 'static,
    B::Error: Into<inject::BoxError>,
{
    inject::Inject::new(body, scan(state, door, page)).boxed()
}

/// The look for phishing alone, with nothing added: an SVG opened as a
/// page.
pub(crate) fn with_scan<B>(state: &State, door: &Arc<door::Door>, body: B, page: String) -> Body
where
    B: hyper::body::Body<Data = Bytes> + Send + Sync + Unpin + 'static,
    B::Error: Into<inject::BoxError>,
{
    inject::Inject::scan_only(body, scan(state, door, page)).boxed()
}

/// Where a page's start goes to be looked at, and the look itself.
fn scan(
    state: &State,
    door: &Arc<door::Door>,
    page: String,
) -> tokio::sync::oneshot::Sender<Bytes> {
    let (scan_tx, scan_rx) = tokio::sync::oneshot::channel::<Bytes>();
    if !door.was_flagged() {
        let web = state.web.clone();
        let door = door.clone();
        tokio::spawn(async move {
            let Ok(copy) = scan_rx.await else { return };
            let why = inject::phishing_signals(&copy);
            if !why.is_empty() && door.flag_once() {
                web.flag(&door, &page, &why, false).await;
            }
        });
    }
    scan_tx
}

/// A plain image that one visitor may see as well as another: an answer to
/// a request without the visitor's own cookies, not marked private, setting
/// no cookie. SVG is left out, since it can carry a script.
pub(crate) fn shared_image(status: StatusCode, headers: &HeaderMap, credentialed: bool) -> bool {
    let kind = header_str(headers, "content-type")
        .map(|t| {
            t.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    status == StatusCode::OK
        && !credentialed
        && kind.starts_with("image/")
        && kind != "image/svg+xml"
        && !headers.contains_key(header::SET_COOKIE)
        && !header_str(headers, "cache-control")
            .is_some_and(|c| c.to_ascii_lowercase().contains("private"))
}

const SECURITY_TXT_PATH: &str = "/.well-known/security.txt";

/// The report form, with the address to report filled in.
fn report_url(app_url: &str, address: &str) -> String {
    let address: String = address.chars().take(1500).collect();
    format!(
        "{app_url}/report?url={}",
        form_urlencoded::byte_serialize(address.as_bytes()).collect::<String>()
    )
}

fn redirect(to: &str) -> Response<Body> {
    meter::own_page(
        Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, to)
            .header(header::CACHE_CONTROL, "no-store")
            .body(empty())
            .unwrap(),
        meter::INTERNAL,
    )
}

/// A visitor typed a password on the password page (gate.rs). Only the
/// page's own form counts, tries are limited, and the web app says whether
/// it is right. The version it answers with is the one in force, so a
/// change the edge missed takes hold here too.
async fn unlock(
    state: &State,
    door: &door::Door,
    req: Request<Incoming>,
    host: &str,
    public_origin: &str,
    visitor: &str,
) -> Response<Body> {
    if door.gate().is_none() {
        return redirect("/");
    }
    // The report link names the page being opened, not this form's address.
    let again = |status, to: &str, error| {
        let report = report_url(&state.config.app_url, &format!("{public_origin}{to}"));
        pages::password_page(status, host, to, &report, error)
    };
    if req.method() != Method::POST || !notice::from_notice_page(req.headers(), public_origin) {
        return again(StatusCode::OK, "/", None);
    }
    if !door.limits.try_password(visitor, Instant::now()) {
        return again(
            StatusCode::TOO_MANY_REQUESTS,
            "/",
            Some("Too many tries. Wait a few minutes, then try again."),
        );
    }
    let Ok(body) = Limited::new(req.into_body(), 4096).collect().await else {
        return again(StatusCode::OK, "/", None);
    };
    let (password, to) = gate::form(&body.to_bytes());
    match state.web.unlock(door, &password).await {
        Some(Some(version)) => {
            door.set_gate(Some(version.clone()));
            let cookie = gate::pass_cookie(
                state.config.edge_secret.as_bytes(),
                &door.name,
                &version,
                state.config.secure(),
                unix_now(),
            );
            pages::continue_to(&to, &cookie)
        }
        Some(None) => again(
            StatusCode::FORBIDDEN,
            &to,
            Some("That password isn't right."),
        ),
        None => again(
            StatusCode::SERVICE_UNAVAILABLE,
            &to,
            Some("The password couldn't be checked just now. Try again in a moment."),
        ),
    }
}

/// What badge.js saw once a page had run (inject.rs): a flag for staff,
/// once per share, like the edge's own look at the page as sent.
/// The answer is the same whatever was sent, so it tells a sender nothing.
async fn browser_flag(
    state: &State,
    door: &Arc<door::Door>,
    req: Request<Incoming>,
    public_origin: &str,
    visitor: &str,
) -> Response<Body> {
    let answer = || {
        meter::own_page(
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header(header::CACHE_CONTROL, "no-store")
                .body(empty())
                .unwrap(),
            meter::INTERNAL,
        )
    };
    // From the page itself only: another site cannot post here for it.
    let same_origin = req.method() == Method::POST
        && header_str(req.headers(), "sec-fetch-site").is_none_or(|s| s == "same-origin");
    if !same_origin || !door.limits.try_flag(visitor, Instant::now()) {
        return answer();
    }
    let Ok(body) = Limited::new(req.into_body(), 4096).collect().await else {
        return answer();
    };
    let Some((why, url)) = inject::browser_signals(&body.to_bytes()) else {
        return answer();
    };
    if door.flag_once() {
        let page = url
            .filter(|u| u.starts_with(&format!("{public_origin}/")))
            .map(|u| u.chars().take(2000).collect())
            .unwrap_or_else(|| format!("{public_origin}/"));
        let web = state.web.clone();
        let door = door.clone();
        tokio::spawn(async move { web.flag(&door, &page, &why, true).await });
    }
    answer()
}

/// The report button's script (inject.rs, badge.js).
fn badge(state: &State) -> Response<Body> {
    let script = Response::builder()
        .header(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .header("cloudflare-cdn-cache-control", "no-store")
        .body(pages::full(inject::badge_script(&state.config.app_url)))
        .unwrap();
    meter::own_page(script, meter::INTERNAL)
}

/// Tells the CLI, now and then, that visitors are being turned away.
fn warn_limited(session: &Session, now: Instant) {
    if session.limits.should_warn(now) {
        session.notify(&EdgeMessage::Notice {
            text: "Visitors are sending more requests than a share takes, so some get \"Too many requests\".".into(),
        });
    }
}

/// Continue on the visitor notice: back to the page, with the cookie that
/// lets this browser through. Anything not posted from the notice page
/// itself goes back to the notice.
async fn continue_visit(
    state: &State,
    door: &door::Door,
    req: Request<Incoming>,
    public_origin: &str,
) -> Response<Body> {
    if req.method() != Method::POST || !notice::from_notice_page(req.headers(), public_origin) {
        return meter::own_page(
            Response::builder()
                .status(StatusCode::SEE_OTHER)
                .header(header::LOCATION, "/")
                .body(empty())
                .unwrap(),
            meter::INTERNAL,
        );
    }
    let body = Limited::new(req.into_body(), 4096)
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let to = notice::form_target(&body);
    let cookie = notice::seen_cookie(
        state.config.edge_secret.as_bytes(),
        &door.notice_key(),
        state.config.secure(),
        unix_now(),
    );
    pages::continue_to(&to, &cookie)
}

/// The host a cookie's Domain is compared with: the preview's, no port.
fn cookie_host(host: &str) -> &str {
    host.rsplit_once(':')
        .filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit()))
        .map_or(host, |(name, _)| name)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A redirect to the local server's own address goes to the public one.
fn rewrite_location(headers: &mut HeaderMap, port: u16, public: &str) {
    let Some(location) = header_str(headers, "location").map(str::to_string) else {
        return;
    };
    for local in [
        format!("http://localhost:{port}"),
        format!("http://127.0.0.1:{port}"),
    ] {
        if let Some(rest) = location.strip_prefix(&local)
            && (rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'))
        {
            if let Ok(v) = HeaderValue::from_str(&format!("{public}{rest}")) {
                headers.insert(header::LOCATION, v);
            }
            return;
        }
    }
}

pub(crate) fn empty() -> Body {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC: &str = "https://calm-otter.sharehooks.cc";
    const LOCAL: &str = "http://localhost:3000";

    fn origin_after(origin: &str, path: &str, upgrading: bool) -> String {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        rewrite_origin(&mut headers, PUBLIC, LOCAL, path, upgrading);
        header_str(&headers, "origin").unwrap().to_string()
    }

    #[test]
    fn hot_reload_from_the_preview_gets_the_local_origin() {
        assert_eq!(origin_after(PUBLIC, "/_next/hmr", true), LOCAL);
        assert_eq!(origin_after(PUBLIC, "/", true), LOCAL);
        assert_eq!(
            origin_after("HTTPS://Calm-Otter.sharehooks.cc", "/ws", true),
            LOCAL
        );
    }

    #[test]
    fn next_dev_endpoints_from_the_preview_get_the_local_origin() {
        assert_eq!(
            origin_after(PUBLIC, "/__nextjs_original-stack-frames", false),
            LOCAL
        );
        assert_eq!(
            origin_after(PUBLIC, "/_next/static/chunks/a.js", false),
            LOCAL
        );
    }

    #[test]
    fn the_health_check_answers_only_from_inside() {
        for host in [
            "127.0.0.1:4000",
            "edge:4000",
            "health",
            "localhost",
            "[::1]:4000",
            "10.20.0.4",
        ] {
            assert!(internal_host(host), "{host}");
        }
        for host in [
            "tunnel.webhooks.cc",
            "sharehooks.cc",
            "acme.sharehooks.cc:443",
            "",
        ] {
            assert!(!internal_host(host), "{host}");
        }
    }

    #[test]
    fn previews_stay_out_of_search() {
        let mut headers = http::HeaderMap::new();
        headers.insert("x-robots-tag", http::HeaderValue::from_static("all"));
        keep_out_of_search(&mut headers);
        assert_eq!(headers["x-robots-tag"], "noindex, nofollow");
    }

    #[test]
    fn server_actions_keep_the_public_origin() {
        assert_eq!(origin_after(PUBLIC, "/checkout", false), PUBLIC);
        assert_eq!(origin_after(PUBLIC, "/blog/_next-steps", false), PUBLIC);
    }

    #[test]
    fn visitors_are_counted_by_address_or_ipv6_56() {
        assert_eq!(visitor_key("203.0.113.7"), "203.0.113.7");
        assert_eq!(visitor_key("2001:db8:1:2:aaaa::1"), "2001:db8:1:0::/56");
        // One /64 is one visitor, and so are the /64s of one /56.
        assert_eq!(
            visitor_key("2001:db8:1:2:bbbb:cccc:dddd:eeee"),
            visitor_key("2001:db8:1:2::9")
        );
        assert_eq!(
            visitor_key("2001:db8:1:2::1"),
            visitor_key("2001:db8:1:ff::1")
        );
        assert_ne!(
            visitor_key("2001:db8:1:2::1"),
            visitor_key("2001:db8:1:100::1")
        );
        assert_eq!(visitor_key("unknown"), "unknown");
        assert_eq!(visitor_key("::ffff:203.0.113.7"), "203.0.113.7");
    }

    #[tokio::test]
    async fn connections_send_small_writes_at_once() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let _client = tokio::net::TcpStream::connect(address).await.unwrap();
        let (accepted, _) = listener.accept().await.unwrap();
        assert!(!accepted.nodelay().unwrap(), "Nagle is on by default");
        no_delay(&accepted);
        assert!(accepted.nodelay().unwrap());
    }

    #[tokio::test]
    async fn accepted_connections_keep_a_small_send_buffer() {
        let listener = listen("127.0.0.1:0".parse().unwrap()).unwrap();
        let address = listener.local_addr().unwrap();
        let _client = tokio::net::TcpStream::connect(address).await.unwrap();
        let (accepted, _) = listener.accept().await.unwrap();
        let socket = tokio::net::TcpSocket::from_std_stream(accepted.into_std().unwrap());
        // Linux reports twice what was asked, for its bookkeeping.
        let size = socket.send_buffer_size().unwrap();
        assert!((SEND_BUFFER..=2 * SEND_BUFFER).contains(&size), "{size}");
    }

    /// The status a visitor gets for a request whose Cookie header is this long.
    async fn status_for_cookie(bytes: usize) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut visitor, edge) = tokio::io::duplex(1 << 20);
        tokio::spawn(async move {
            let service = service_fn(|_req| async { Ok::<_, Infallible>(Response::new(empty())) });
            let _ = server().serve_connection(TokioIo::new(edge), service).await;
        });
        let request = format!(
            "GET / HTTP/1.1\r\nhost: a.localhost\r\ncookie: {}\r\n\r\n",
            "a".repeat(bytes)
        );
        let _ = visitor.write_all(request.as_bytes()).await;
        let mut answer = vec![0u8; 64];
        let n = visitor.read(&mut answer).await.unwrap();
        String::from_utf8_lossy(&answer[..n])[9..12]
            .parse()
            .unwrap()
    }

    #[tokio::test]
    async fn request_heads_are_read_up_to_the_buffer() {
        // Node's servers take 16 KiB of head; the edge takes about BUFFER.
        assert_eq!(status_for_cookie(16 * 1024).await, 200);
        assert_eq!(status_for_cookie(28 * 1024).await, 200);
        assert_eq!(status_for_cookie(100 * 1024).await, 431);
    }

    /// An edge on a free port, as `run` serves it, with no web app behind it.
    async fn edge() -> (String, State) {
        let config = Config::testing("http://127.0.0.1:9");
        let held = held::Held::new(config.held_up_max);
        let state = State {
            access: access_log::AccessLog::default(),
            web: Web::new(&config),
            registry: Registry::new(config.pace, held.clone()),
            held,
            config: Arc::new(config),
            connects: Arc::default(),
            meter: Arc::default(),
            decodes: Arc::default(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let serving = state.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, remote)) = listener.accept().await else {
                    return;
                };
                let state = serving.clone();
                tokio::spawn(async move {
                    let conn = Arc::new(held::Conn::default());
                    let service = service_fn(move |req| {
                        let state = state.clone();
                        let conn = conn.clone();
                        async move { Ok::<_, Infallible>(handle(state, req, remote, conn).await) }
                    });
                    let _ = server()
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await;
                });
            }
        });
        (format!("http://{address}"), state)
    }

    async fn get(base: &str, host: &str, path: &str) -> reqwest::Response {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(format!("{base}{path}"))
            .header("host", host)
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn the_bare_domain_points_at_the_docs_and_an_idle_name_says_so() {
        let (base, _state) = edge().await;
        let bare = get(&base, "sharehooks.localhost:4000", "/").await;
        assert_eq!(bare.status(), 302);
        assert_eq!(
            bare.headers()["location"],
            "http://localhost:3000/docs/share"
        );
        let idle = get(&base, "calm-otter.sharehooks.localhost:4000", "/").await;
        assert_eq!(idle.status(), 404);
        assert_eq!(idle.headers()["x-robots-tag"], "noindex, nofollow");
        let html = idle.text().await.unwrap();
        assert!(html.contains("Nothing is shared here"));
        assert!(html.contains("http://localhost:3000/report?url="));
        assert!(html.contains("by webhooks.cc"));
        let contacts = get(
            &base,
            "calm-otter.sharehooks.localhost:4000",
            "/.well-known/security.txt",
        )
        .await;
        assert_eq!(contacts.status(), 302);
        assert_eq!(
            contacts.headers()["location"],
            "http://localhost:3000/.well-known/security.txt"
        );
        let other = get(&base, "example.com", "/").await;
        assert_eq!(other.status(), 421);
    }

    #[tokio::test]
    async fn the_tunnel_asks_for_a_login_and_a_known_kind() {
        let (base, _state) = edge().await;
        let client = reqwest::Client::new();
        let upgrade = |kind: Option<&str>, auth: bool| {
            let mut r = client
                .get(format!("{base}{CONNECT_PATH}"))
                .header("host", "tunnel.webhooks.cc")
                .header("connection", "Upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .header("sec-websocket-version", "13")
                .header(HEADER_PORT, "3000")
                .header(HEADER_INSTANCE, "run-1");
            if let Some(kind) = kind {
                r = r.header(HEADER_KIND, kind);
            }
            if auth {
                r = r.bearer_auth("whcc_test");
            }
            r
        };
        let no_login = upgrade(None, false).send().await.unwrap();
        assert_eq!(no_login.status(), 401);
        let odd_kind = upgrade(Some("other"), true).send().await.unwrap();
        assert_eq!(odd_kind.status(), 400);
        let live_without_endpoint = upgrade(Some("live"), true).send().await.unwrap();
        assert_eq!(live_without_endpoint.status(), 400);
        let body: serde_json::Value = live_without_endpoint.json().await.unwrap();
        assert!(body["error"].as_str().unwrap().contains("endpoint"));
    }

    #[test]
    fn other_sites_keep_their_origin() {
        assert_eq!(
            origin_after("https://evil.example", "/_next/hmr", true),
            "https://evil.example"
        );
        assert_eq!(
            origin_after("https://other.sharehooks.cc", "/_next/hmr", true),
            "https://other.sharehooks.cc"
        );
        assert_eq!(origin_after("null", "/_next/hmr", true), "null");
    }

    /// A share named `acme` whose laptop answers every request with `raw`
    /// (a whole HTTP/1.1 response), then closes.
    async fn share_answering(state: &State, raw: Vec<u8>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (edge_io, cli_io) = tokio::io::duplex(1 << 20);
        let (opener, inbound, task) = mux::spawn(edge_io, yamux::Mode::Client);
        drop(inbound);
        std::mem::forget(task);
        let (cli_opener, mut streams, cli_task) = mux::spawn(cli_io, yamux::Mode::Server);
        std::mem::forget(cli_opener);
        std::mem::forget(cli_task);
        let raw = Arc::new(raw);
        tokio::spawn(async move {
            while let Some(mut stream) = streams.recv().await {
                let raw = raw.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let mut got = Vec::new();
                    loop {
                        let n = stream.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        got.extend_from_slice(&buf[..n]);
                        if got.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let _ = stream.write_all(&raw).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        let (text_io, other) = tokio::io::duplex(1 << 16);
        std::mem::forget(other);
        let socket = WebSocketStream::from_raw_socket(text_io, Role::Server, None).await;
        let (bytes, text) = ws::split(socket);
        std::mem::forget(bytes);
        let session = Arc::new(Session::new(
            Opening {
                share_id: "s1".into(),
                user_id: "u1".into(),
                name: "acme".into(),
                port: 3000,
                endpoint_id: None,
                notice: false,
                gate: None,
                run: "run-1".into(),
            },
            opener,
            text.sender(),
            state.registry.account("u1"),
        ));
        std::mem::forget(text);
        state.registry.insert(session);
    }

    /// A page load of `acme` against a laptop answering `head` and `body`.
    async fn visit(head: &str, body: &[u8]) -> (u16, HeaderMap, Vec<u8>) {
        let (base, state) = edge().await;
        let mut raw = format!("{head}\r\nconnection: close\r\n\r\n").into_bytes();
        raw.extend_from_slice(body);
        share_answering(&state, raw).await;
        let r = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(format!("{base}/x"))
            .header("host", "acme.sharehooks.localhost:4000")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        let headers = r.headers().clone();
        let body = r.bytes().await.unwrap_or_default().to_vec();
        (status, headers, body)
    }

    const PAGE: &str = "<html><head><title>Acme</title></head><body>hi</body></html>";

    fn badged(body: &[u8]) -> bool {
        String::from_utf8_lossy(body).contains("/__whk/badge.js")
    }

    #[tokio::test]
    async fn every_page_gets_the_button_whatever_its_status_or_type() {
        for head in [
            "HTTP/1.1 200 OK\r\ncontent-type: text/html",
            "HTTP/1.1 404 Not Found\r\ncontent-type: text/html; charset=utf-8",
            "HTTP/1.1 500 Internal Server Error\r\ncontent-type: text/html",
            "HTTP/1.1 200 OK\r\ncontent-type: application/xhtml+xml",
        ] {
            let (status, _, body) = visit(head, PAGE.as_bytes()).await;
            assert!(badged(&body), "{head}: {status}");
        }
    }

    #[tokio::test]
    async fn a_compressed_page_is_read_back_and_gets_the_button() {
        use tokio::io::AsyncWriteExt;
        let mut encoder = async_compression::tokio::write::GzipEncoder::new(Vec::new());
        encoder.write_all(PAGE.as_bytes()).await.unwrap();
        encoder.shutdown().await.unwrap();
        let gzipped = encoder.into_inner();
        let (status, headers, body) = visit(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-encoding: gzip",
            &gzipped,
        )
        .await;
        assert_eq!(status, 200);
        assert!(headers.get("content-encoding").is_none());
        assert!(badged(&body));
        assert!(String::from_utf8_lossy(&body).contains("<title>Acme</title>"));
        // An encoding the edge cannot read is refused on a page load.
        let (status, _, body) = visit(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-encoding: zstd",
            b"\x28\xb5\x2f\xfd",
        )
        .await;
        assert_eq!(status, 403);
        assert!(!badged(&body));
    }

    #[tokio::test]
    async fn type_tricks_do_not_get_past_the_check() {
        // A list of types, two headers, Connection naming the type, and a
        // redirect without a place to go.
        for head in [
            "HTTP/1.1 200 OK\r\ncontent-type: text/html, video/mp4",
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-type: application/octet-stream",
            "HTTP/1.1 302 Found\r\nlocation: \r\ncontent-type: application/octet-stream",
        ] {
            let (status, _, _) = visit(head, b"MZ\x90\x00").await;
            assert_eq!(status, 403, "{head}");
        }
        let (status, headers, _) = visit(
            "HTTP/1.1 200 OK\r\nconnection: content-type\r\ncontent-type: text/plain",
            b"text",
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(headers["content-type"], "text/plain");
    }

    #[tokio::test]
    async fn an_empty_encoding_before_gzip_is_refused_not_passed_compressed() {
        use tokio::io::AsyncWriteExt;
        let mut encoder = async_compression::tokio::write::GzipEncoder::new(Vec::new());
        encoder.write_all(PAGE.as_bytes()).await.unwrap();
        encoder.shutdown().await.unwrap();
        let (status, _, body) = visit(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-encoding: \r\ncontent-encoding: gzip",
            &encoder.into_inner(),
        )
        .await;
        assert_eq!(status, 403);
        assert!(!badged(&body));
    }

    #[tokio::test]
    async fn a_16_mib_brotli_window_is_refused_on_a_page_load() {
        // WBITS 24 in the stream's first byte, then anything: the edge
        // refuses before a decoder reserves the window.
        let (status, _, _) = visit(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-encoding: br",
            &[0x0f, 0x00, 0x00, 0x00],
        )
        .await;
        assert_eq!(status, 403);
    }

    #[tokio::test]
    async fn xml_shown_as_a_page_is_looked_at_but_not_changed() {
        let xml = "<?xml version=\"1.0\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>Acme</title></head></html>";
        for kind in ["text/xml", "application/xml", "application/rss+xml"] {
            let (status, _, body) = visit(
                &format!("HTTP/1.1 200 OK\r\ncontent-type: {kind}"),
                xml.as_bytes(),
            )
            .await;
            assert_eq!(status, 200, "{kind}");
            assert_eq!(String::from_utf8_lossy(&body), xml, "{kind}");
        }
        // Compressed XML on a page load is read back like a page.
        use tokio::io::AsyncWriteExt;
        let mut encoder = async_compression::tokio::write::GzipEncoder::new(Vec::new());
        encoder.write_all(xml.as_bytes()).await.unwrap();
        encoder.shutdown().await.unwrap();
        let (status, headers, body) = visit(
            "HTTP/1.1 200 OK\r\ncontent-type: application/xml\r\ncontent-encoding: gzip",
            &encoder.into_inner(),
        )
        .await;
        assert_eq!(status, 200);
        assert!(headers.get("content-encoding").is_none());
        assert_eq!(String::from_utf8_lossy(&body), xml);
    }

    #[tokio::test]
    async fn a_redirects_body_is_cut_to_a_few_kilobytes() {
        let zip = vec![b'P'; 200 * 1024];
        for head in [
            "HTTP/1.1 302 Found\r\nlocation: /\r\ncontent-type: application/zip".to_string(),
            format!(
                "HTTP/1.1 302 Found\r\nlocation: /\r\ncontent-type: application/zip\r\ncontent-length: {}",
                zip.len()
            ),
        ] {
            let (status, headers, body) = visit(&head, &zip).await;
            assert_eq!(status, 302);
            assert!(body.len() <= content::MAX_REDIRECT_BODY, "{}", body.len());
            assert!(headers.get("content-length").is_none_or(|l| {
                l.to_str().unwrap().parse::<usize>().unwrap() <= content::MAX_REDIRECT_BODY
            }));
        }
    }
}
