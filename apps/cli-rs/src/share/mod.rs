//! A tunnel session with the edge, for `whk share` (a preview at a name on
//! sharehooks.cc) and `whk tunnel --live` (the receiver relays an
//! endpoint's captures down the tunnel, and the sender gets the local
//! app's answer).
//!
//! The CLI opens a WebSocket to the edge's `/v1/connect` with its bearer
//! and what it wants in headers (`whk_tunnel`). The edge asks the web app
//! whether it may open; a refusal is an HTTP error with a JSON `error`. Once
//! open, the edge opens a yamux stream for every visitor connection (or
//! relayed capture), and the CLI pipes it to the local port. A dropped
//! connection is tried again with a growing wait; a refusal or the edge
//! closing the session ends it.

pub mod events;
pub mod qr;

use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use whk_tunnel::mux::{self, MuxStream};
use whk_tunnel::{
    CONNECT_PATH, EdgeMessage, ErrorBody, HEADER_CLIENT, HEADER_ENDPOINT, HEADER_INSTANCE,
    HEADER_KIND, HEADER_NAME, HEADER_NOTHING_LISTENING, HEADER_PASSWORD, HEADER_PORT,
    HEADER_REQUEST_ID, HEADER_VERSION, PROTOCOL_VERSION, splice, ws,
};

use crate::api::ApiClient;
use crate::tunnel::join_path;

/// Where the CLI reaches the edge unless `WHK_TUNNEL_URL` says otherwise.
pub const DEFAULT_TUNNEL_URL: &str = "wss://tunnel.webhooks.cc";

/// The longest a reconnect waits.
const MAX_WAIT: Duration = Duration::from_secs(30);

/// The most a relayed request's head may take (`--live`, and a share with
/// something to change); a longer one is answered 431 by the CLI itself.
const MAX_HEAD: usize = 64 * 1024;

/// How long opening the connection to the edge (TCP, TLS and the upgrade)
/// may take before it counts as unreachable and is tried again.
const CONNECT_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(20)
};

/// The edge to connect to: `WHK_TUNNEL_URL`, else the default.
pub fn tunnel_url() -> String {
    std::env::var("WHK_TUNNEL_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_TUNNEL_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// What the session is for.
#[derive(Debug, Clone)]
pub enum Kind {
    /// `whk share`: a preview, under a reserved name or a random one.
    Share {
        name: Option<String>,
        password: Option<String>,
    },
    /// `whk tunnel --live`: the endpoint whose captures come down the tunnel.
    Live { endpoint: String },
}

/// For `--live` with a target path or `-H` headers: each relayed request's
/// path goes under `base_path`, and `headers` replace any of the same name.
#[derive(Debug, Clone, Default)]
pub struct Rewrite {
    pub base_path: String,
    pub headers: Vec<(String, String)>,
}

impl Rewrite {
    fn is_empty(&self) -> bool {
        (self.base_path.is_empty() || self.base_path == "/") && self.headers.is_empty()
    }
}

/// Told the id of each capture the relay brings down the tunnel, before the
/// local app gets it (`--live`, from an edge that sends the id).
pub type OnRelayed = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

pub struct Session {
    pub tunnel_url: String,
    pub api: ApiClient,
    pub kind: Kind,
    /// Which address streams go to: `localhost` tries IPv4, then IPv6.
    pub host: LocalHost,
    pub port: u16,
    pub rewrite: Option<Rewrite>,
    /// What the CLI runs on, for the dashboard: "laptop, Linux".
    pub client: String,
    /// `--live`: see [`OnRelayed`].
    pub on_relayed: Option<OnRelayed>,
}

/// What happened, for whoever shows it.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    /// Open at `url` (the first time, or at a new address).
    Ready {
        name: String,
        url: String,
        expires_at: Option<String>,
        expires_in: Option<u64>,
        notice: bool,
        password: bool,
    },
    /// Open again at the same address after the connection dropped.
    Reconnected,
    /// One visitor request (or relayed capture), after its answer started.
    Request {
        method: String,
        path: String,
        status: u16,
        ms: u64,
        /// A relayed capture's id, from an edge that sends it.
        request_id: Option<String>,
    },
    /// Something the edge said, as it is.
    Notice(String),
    /// Unreachable or dropped; trying again in `seconds`.
    Retrying { message: String, seconds: u64 },
}

/// This machine, for the dashboard: "laptop, Linux".
pub fn client_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "linux" => "Linux",
        "windows" => "Windows",
        other => other,
    };
    let host: String = host.chars().filter(|c| !c.is_control()).take(60).collect();
    if host.is_empty() {
        os.to_string()
    } else {
        format!("{host}, {os}")
    }
}

/// An id for this run, sent on every reconnect: a share stopped while the
/// tunnel was down is not opened again.
pub fn instance_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

/// The password for `--password`: `WHK_SHARE_PASSWORD`, for scripts and
/// agents, or typed twice at a terminal without being shown.
pub fn read_password() -> Result<String> {
    use std::io::IsTerminal;
    let password = match std::env::var("WHK_SHARE_PASSWORD") {
        Ok(p) if !p.is_empty() => p,
        _ => {
            if !std::io::stdin().is_terminal() {
                bail!("Type the password at a terminal, or set WHK_SHARE_PASSWORD.");
            }
            let first = rpassword::prompt_password("Password for visitors: ")?;
            let again = rpassword::prompt_password("Once more: ")?;
            if first != again {
                bail!("The two passwords differ. Run it again.");
            }
            first
        }
    };
    password_problem(&password).map_or(Ok(password), |problem| bail!(problem))
}

/// What is wrong with a password for visitors, if anything (the web app
/// checks the same).
pub fn password_problem(password: &str) -> Option<&'static str> {
    let length = password.chars().count();
    if length < 8 {
        Some("Use a password of at least 8 characters.")
    } else if length > 200 {
        Some("Keep the password under 200 characters.")
    } else {
        None
    }
}

/// A password as the edge takes it: hex of its UTF-8, since a header
/// carries only ASCII.
pub fn password_header(password: &str) -> String {
    hex::encode(password.as_bytes())
}

/// Why one connection ended.
enum Ended {
    Dropped,
    Closed(String),
}

/// Why one connection could not open.
#[derive(Debug, PartialEq)]
enum Failure {
    /// The edge (or the web app behind it) said no: stop.
    Refused { status: u16, message: String },
    /// Not reachable, or the edge's own trouble: try again.
    Transient(String),
}

/// Statuses the edge refuses with on purpose: a bad request, the key, the
/// plan or the account, a missing name or endpoint, a name in use, a run
/// that was stopped, an old CLI.
const FINAL_STATUSES: [u16; 7] = [400, 401, 403, 404, 409, 410, 426];

/// An answer to the upgrade. Only the edge's own refusal ends the share:
/// one of its final statuses with its `ErrorBody` JSON. Everything else is
/// worth another try: 5xx and 429 are passing trouble, and an answer
/// without the edge's body (a Cloudflare page, a proxy in between) never
/// came from the edge at all.
fn refusal(status: u16, body: Option<&[u8]>) -> Failure {
    let edge_said = body
        .and_then(|b| serde_json::from_slice::<ErrorBody>(b).ok())
        .map(|b| b.error)
        .filter(|e| !e.is_empty());
    match edge_said {
        Some(message) if FINAL_STATUSES.contains(&status) => Failure::Refused { status, message },
        Some(message) => Failure::Transient(message),
        None => Failure::Transient(format!("The tunnel answered {status}.")),
    }
}

/// A wait with up to half of it again added at random, so CLIs that lost
/// the edge together (a deploy, a restart) do not all come back at once.
fn jittered(wait: Duration) -> Duration {
    let half = (wait.as_millis() / 2) as u64;
    wait + Duration::from_millis(rand::random_range(0..=half))
}

/// The next wait after a drop: back to a second when the connection had
/// lasted a while, so a share that drops right after opening never spins.
fn next_wait(wait: Duration, lasted: Duration) -> Duration {
    if lasted > Duration::from_secs(30) {
        Duration::from_secs(1)
    } else {
        wait
    }
}

fn doubled(wait: Duration) -> Duration {
    (wait * 2).min(MAX_WAIT)
}

/// Whether a refusal ends the share as a stop rather than an error: once it
/// has been live, a refusal on reconnecting means it was ended meanwhile
/// (stopped on webhooks.cc, the time limit, a plan change, or the key
/// revoked, a 401 that a fresh agent token did not cure), and 410 always
/// means it was stopped. The caller spends the one token refresh on a 401
/// before asking.
fn refusal_is_a_stop(status: u16, was_live: bool) -> bool {
    status == 410 || was_live
}

/// Runs the session until the edge closes it or a refusal ends a share
/// that was live (the reason, as given), or refuses it before it was ever
/// live (an error with the edge's words).
pub async fn run(session: &Session, on: &mut (dyn FnMut(Update) + Send)) -> Result<String> {
    let instance = instance_id();
    let mut wait = Duration::from_secs(1);
    let mut last_url: Option<String> = None;
    let mut refreshed = false;
    loop {
        let started = Instant::now();
        match once(session, &instance, &mut last_url, refreshed, on).await {
            Ok(Ended::Closed(reason)) => return Ok(reason),
            Ok(Ended::Dropped) => {
                refreshed = false;
                wait = next_wait(wait, started.elapsed());
                on(Update::Retrying {
                    message: "The connection dropped.".to_string(),
                    seconds: wait.as_secs(),
                });
                tokio::time::sleep(jittered(wait)).await;
                wait = doubled(wait);
            }
            // An agent's access token may have run out: one more try with
            // a new one before giving up.
            Err(Failure::Refused { status: 401, .. })
                if !refreshed && session.api.bearer_refreshes() =>
            {
                refreshed = true;
            }
            Err(Failure::Refused { status, message })
                if refusal_is_a_stop(status, last_url.is_some()) =>
            {
                return Ok(message);
            }
            Err(Failure::Refused { message, .. }) => bail!(message),
            Err(Failure::Transient(message)) => {
                on(Update::Retrying {
                    message,
                    seconds: wait.as_secs(),
                });
                tokio::time::sleep(jittered(wait)).await;
                wait = doubled(wait);
            }
        }
    }
}

async fn once(
    session: &Session,
    instance: &str,
    last_url: &mut Option<String>,
    refresh: bool,
    on: &mut (dyn FnMut(Update) + Send),
) -> Result<Ended, Failure> {
    let bearer = session
        .api
        .bearer_token(refresh)
        .await
        .map_err(|e| Failure::Transient(format!("Could not get a token ({e:#}).")))?
        .ok_or_else(|| Failure::Refused {
            status: 401,
            message: match crate::api::ignored_key_hint() {
                Some(hint) => format!("Not logged in. {hint}"),
                None => "Not logged in. Run `whk auth login` first.".to_string(),
            },
        })?;
    let url = format!("{}{CONNECT_PATH}", session.tunnel_url);
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| Failure::Refused {
            status: 0,
            message: format!("Bad tunnel address {url}: {e}"),
        })?;
    let headers = request.headers_mut();
    let value = |v: &str| HeaderValue::from_str(v).unwrap_or(HeaderValue::from_static(""));
    headers.insert("authorization", value(&format!("Bearer {bearer}")));
    headers.insert(HEADER_PORT, value(&session.port.to_string()));
    headers.insert(HEADER_CLIENT, value(&session.client));
    headers.insert(HEADER_VERSION, value(&PROTOCOL_VERSION.to_string()));
    headers.insert(HEADER_INSTANCE, value(instance));
    headers.insert(
        "user-agent",
        value(&format!("whk-cli/{}", env!("WHK_VERSION"))),
    );
    match &session.kind {
        Kind::Share { name, password } => {
            if let Some(name) = name {
                headers.insert(HEADER_NAME, value(name));
            }
            if let Some(password) = password {
                headers.insert(HEADER_PASSWORD, value(&password_header(password)));
            }
        }
        Kind::Live { endpoint } => {
            headers.insert(HEADER_KIND, value("live"));
            headers.insert(HEADER_ENDPOINT, value(endpoint));
        }
    }

    ensure_crypto();
    // A network that swallows packets would otherwise hold the connect
    // until the kernel gives up, minutes later, with no retry meanwhile.
    let connecting = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(ws::config()), true),
    );
    let socket = match connecting.await {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => {
            return Err(refusal(
                response.status().as_u16(),
                response.body().as_deref(),
            ));
        }
        Ok(Err(e)) => {
            return Err(Failure::Transient(format!(
                "Could not reach the tunnel ({e})."
            )));
        }
        Err(_) => {
            return Err(Failure::Transient(format!(
                "The tunnel did not answer within {} s.",
                CONNECT_TIMEOUT.as_secs()
            )));
        }
    };

    let (bytes, mut text) = ws::split(socket);
    let (_opener, mut inbound, mut mux_task) = mux::spawn(bytes, yamux::Mode::Server);
    // A live session always reads the head, to say where the request was
    // sent (X-Forwarded-Uri); a share only when there is something to change.
    let (rewrite, relayed) = match session.kind {
        Kind::Live { .. } => (
            Some(session.rewrite.clone().unwrap_or_default()),
            Some(Relayed(session.on_relayed.clone())),
        ),
        Kind::Share { .. } => (session.rewrite.clone().filter(|r| !r.is_empty()), None),
    };

    loop {
        tokio::select! {
            stream = inbound.recv() => match stream {
                Some(stream) => {
                    let target = LocalTarget { host: session.host, port: session.port };
                    tokio::spawn(pipe(stream, target, rewrite.clone(), relayed.clone()));
                }
                None => return Ok(Ended::Dropped),
            },
            message = text.incoming.recv() => {
                let Some(message) = message else { return Ok(Ended::Dropped) };
                match serde_json::from_str::<EdgeMessage>(&message) {
                    Ok(EdgeMessage::Ready { name, url, expires_at, expires_in, notice, password }) => {
                        if last_url.as_deref() == Some(url.as_str()) {
                            on(Update::Reconnected);
                        } else {
                            *last_url = Some(url.clone());
                            on(Update::Ready { name, url, expires_at, expires_in, notice, password });
                        }
                    }
                    Ok(EdgeMessage::Request { method, path, status, ms, request_id }) => {
                        on(Update::Request { method, path, status, ms, request_id });
                    }
                    Ok(EdgeMessage::Notice { text }) => on(Update::Notice(text)),
                    Ok(EdgeMessage::Closing { reason }) => return Ok(Ended::Closed(reason)),
                    Err(_) => {}
                }
            },
            _ = &mut mux_task => return Ok(Ended::Dropped),
        }
    }
}

/// rustls needs a crypto provider; ring is the one reqwest uses too.
fn ensure_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Connects to the local server: the address given, or for `localhost`
/// IPv4 then IPv6.
async fn connect_local(target: LocalTarget) -> std::io::Result<TcpStream> {
    match target.host {
        LocalHost::V4 => TcpStream::connect(("127.0.0.1", target.port)).await,
        LocalHost::V6 => TcpStream::connect(("::1", target.port)).await,
        LocalHost::Localhost => match TcpStream::connect(("127.0.0.1", target.port)).await {
            Ok(s) => Ok(s),
            Err(_) => TcpStream::connect(("::1", target.port)).await,
        },
    }
}

/// Whether anything answers on the local target now, within a second.
pub async fn local_answers(target: LocalTarget) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(1), connect_local(target)).await,
        Ok(Ok(_))
    )
}

/// A live session's streams are relayed captures: their heads carry the
/// capture's id ([`HEADER_REQUEST_ID`]), which is taken out and told to the
/// callback, if there is one.
#[derive(Clone)]
struct Relayed(Option<OnRelayed>);

/// Connects one stream from the edge to the local server and copies both
/// ways until soon after either side ends (`splice`). With nothing
/// listening there, it answers 502 itself, marked so the edge can show
/// visitors its own page.
async fn pipe(
    mut stream: MuxStream,
    target: LocalTarget,
    rewrite: Option<Rewrite>,
    relayed: Option<Relayed>,
) {
    let Ok(mut local) = connect_local(target).await else {
        let _ = stream.write_all(&nothing_listening(target)).await;
        let _ = stream.shutdown().await;
        return;
    };
    let _ = local.set_nodelay(true);
    if let Some(rewrite) = rewrite {
        match rewritten_head(&mut stream, &rewrite, relayed.is_some()).await {
            Ok(Head::Ready { bytes, request_id }) => {
                // Marked before the app has it, so its copy on the stream
                // is never forwarded as well.
                if let (Some(Relayed(Some(on_relayed))), Some(id)) = (&relayed, &request_id) {
                    on_relayed(id);
                }
                if local.write_all(&bytes).await.is_err() {
                    return;
                }
            }
            // Passed on unchanged it would miss the base path and the -H
            // headers, so the app would see a request it was not sent.
            Ok(Head::TooLarge) => {
                drop(local);
                let _ = stream.write_all(&head_too_large()).await;
                let _ = stream.shutdown().await;
                return;
            }
            Err(_) => return,
        }
    }
    splice::splice(&mut stream, &mut local, splice::LINGER).await;
}

/// The CLI's own 431 for a request whose head is over [`MAX_HEAD`].
pub fn head_too_large() -> Vec<u8> {
    let body = format!(
        "The request's headers are over {} KB, more than whk passes to the app.\n",
        MAX_HEAD / 1024
    );
    format!(
        "HTTP/1.1 431 Request Header Fields Too Large\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// The CLI's own 502 when nothing listens on the port.
pub fn nothing_listening(target: LocalTarget) -> Vec<u8> {
    let body = format!("Nothing is running on {}.\n", target.display());
    format!(
        "HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\n{HEADER_NOTHING_LISTENING}: 1\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// A relayed request's head, read.
#[derive(Debug, PartialEq)]
enum Head {
    /// What to send the local server: the head as rewritten (or as it came,
    /// when it is not HTTP/1 or the stream ended first), then whatever of
    /// the body came with it; and a relayed capture's id, taken out of it.
    Ready {
        bytes: Vec<u8>,
        request_id: Option<String>,
    },
    /// No end within [`MAX_HEAD`].
    TooLarge,
}

/// Reads a relayed request's head and gives it back with its path under
/// the target's base path and the `-H` headers in place of any of the same
/// name, followed by whatever of the body came with it. With `take_id` (a
/// live session), the capture's id comes out of the head.
async fn rewritten_head<S: AsyncRead + Unpin>(
    stream: &mut S,
    rewrite: &Rewrite,
    take_id: bool,
) -> std::io::Result<Head> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = find_head_end(&buf) {
            if end > MAX_HEAD {
                return Ok(Head::TooLarge);
            }
            let (head, rest) = buf.split_at(end);
            let (mut bytes, request_id) = rewrite_head_taking(head, rewrite, take_id)
                .unwrap_or_else(|| (head.to_vec(), None));
            bytes.extend_from_slice(rest);
            return Ok(Head::Ready { bytes, request_id });
        }
        if buf.len() >= MAX_HEAD {
            return Ok(Head::TooLarge);
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(Head::Ready {
                bytes: buf,
                request_id: None,
            });
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// Where the head ends: just past its blank line.
fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// The header that carries a relayed request's original path and query, as
/// the sender sent it after `/w/<slug>`, so an app behind a base path can
/// rebuild the public URL it was signed for.
pub const FORWARDED_URI: &str = "X-Forwarded-Uri";

/// The head (ending in its blank line) with the path joined to the base
/// path, the headers replaced and [`FORWARDED_URI`] set to the path as it
/// came (any the sender sent dropped); `None` when it is not an HTTP/1
/// request.
pub fn rewrite_head(head: &[u8], rewrite: &Rewrite) -> Option<Vec<u8>> {
    rewrite_head_taking(head, rewrite, false).map(|(bytes, _)| bytes)
}

/// A capture id as the receiver makes them: short, and only letters,
/// digits and dashes.
fn plain_id(value: &str) -> Option<String> {
    let value = value.trim();
    let plain = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    plain.then(|| value.to_string())
}

/// [`rewrite_head`], and with `take_id` every [`HEADER_REQUEST_ID`] line
/// taken out, the first one's value given back.
fn rewrite_head_taking(
    head: &[u8],
    rewrite: &Rewrite,
    take_id: bool,
) -> Option<(Vec<u8>, Option<String>)> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.splitn(3, ' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if !version.starts_with("HTTP/") {
        return None;
    }
    let original = target;
    let target = if rewrite.base_path.is_empty() || rewrite.base_path == "/" {
        target.to_string()
    } else {
        join_path(&rewrite.base_path, target)
    };
    let mut out = format!("{method} {target} {version}\r\n");
    let mut request_id = None;
    let mut lines: Vec<&str> = lines.filter(|l| !l.is_empty()).collect();
    if take_id {
        lines.retain(|line| {
            let Some((name, value)) = line.split_once(':') else {
                return true;
            };
            if !name.trim().eq_ignore_ascii_case(HEADER_REQUEST_ID) {
                return true;
            }
            if request_id.is_none() {
                request_id = plain_id(value);
            }
            false
        });
    }
    let replaced = |line: &str| {
        line.split_once(':').is_some_and(|(name, _)| {
            let name = name.trim();
            name.eq_ignore_ascii_case(FORWARDED_URI)
                || rewrite
                    .headers
                    .iter()
                    .any(|(extra, _)| extra.eq_ignore_ascii_case(name))
        })
    };
    for line in lines {
        if !replaced(line) {
            out.push_str(line);
            out.push_str("\r\n");
        }
    }
    for (name, value) in &rewrite.headers {
        // A header with a line break would start a new one.
        if name.contains(['\r', '\n', ':']) || value.contains(['\r', '\n']) {
            continue;
        }
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!("{FORWARDED_URI}: {original}\r\n"));
    out.push_str("\r\n");
    Some((out.into_bytes(), request_id))
}

/// "2 h", "1 h 30 min", "45 min".
pub fn duration(seconds: u64) -> String {
    let minutes = seconds.div_ceil(60);
    match (minutes / 60, minutes % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// A visitor's method or path, safe to print: control and invisible
/// characters escaped (no terminal tricks, no text that reads backwards),
/// and long ones cut.
pub fn printable(text: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, c) in text.chars().enumerate() {
        if i == max {
            out.push_str("...");
            break;
        }
        let invisible = c.is_control()
            || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}');
        if invisible {
            out.extend(c.escape_unicode());
        } else {
            out.push(c);
        }
    }
    out
}

/// Which local address a target names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalHost {
    /// `localhost` (or a bare port, or 0.0.0.0): IPv4, then IPv6.
    Localhost,
    /// `127.0.0.1`.
    V4,
    /// `[::1]`.
    V6,
}

/// The local server a share or live tunnel connects to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTarget {
    pub host: LocalHost,
    pub port: u16,
}

impl LocalTarget {
    /// "localhost:3000", "127.0.0.1:3000" or "[::1]:3000".
    pub fn display(&self) -> String {
        match self.host {
            LocalHost::Localhost => format!("localhost:{}", self.port),
            LocalHost::V4 => format!("127.0.0.1:{}", self.port),
            LocalHost::V6 => format!("[::1]:{}", self.port),
        }
    }

    /// The target as an http:// base URL.
    pub fn http_base(&self) -> String {
        format!("http://{}", self.display())
    }
}

/// Reads a local target: "3000", "3000/api", "localhost:3000",
/// "127.0.0.1:3000/api", "[::1]:3000" or "http://localhost:3000/api". The
/// path comes back as written ("" when there is none). Only this machine,
/// and only plain HTTP: the tunnel copies bytes to the port, so it cannot
/// speak TLS to a local HTTPS server.
pub fn parse_local_target(target: &str) -> Result<(LocalTarget, String)> {
    let target = target.trim();
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("https://") {
        bail!(
            "Local HTTPS servers aren't supported: whk talks plain HTTP to your app. Serve it over HTTP (most dev servers do by default) and give that port, such as 3000."
        );
    }
    if let Some((scheme, _)) = lower.split_once("://")
        && scheme != "http"
    {
        bail!(
            "{scheme}:// isn't something whk can forward to: it speaks plain HTTP to a local web server. Give that server's port, such as 3000, or http://localhost:3000."
        );
    }
    let rest = if lower.starts_with("http://") {
        &target["http://".len()..]
    } else {
        target
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        match after.split_once("]:") {
            Some((host, port)) => (host, port),
            None => (after.trim_end_matches(']'), ""),
        }
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, port),
            None if authority.bytes().all(|b| b.is_ascii_digit()) => ("", authority),
            None => (authority, ""),
        }
    };
    let host = match host.to_ascii_lowercase().as_str() {
        "" | "localhost" | "0.0.0.0" => LocalHost::Localhost,
        "127.0.0.1" => LocalHost::V4,
        "::1" => LocalHost::V6,
        _ => bail!("Only this machine can be reached: give a local port, such as 3000."),
    };
    match port.parse::<u16>() {
        Ok(0) | Err(_) => bail!("Give the local port, such as 3000 or localhost:3000."),
        Ok(port) => Ok((LocalTarget { host, port }, path.to_string())),
    }
}

/// The local server of a `whk share` target: "3000", "localhost:3000",
/// "127.0.0.1:3000" or "http://localhost:3000". A share is a whole port, so
/// a path is refused rather than dropped.
pub fn parse_share_target(target: &str) -> Result<LocalTarget> {
    let (local, path) = parse_local_target(target)?;
    let path = path.trim_end_matches('/');
    if !path.is_empty() {
        bail!(
            "whk share shares a whole port, not a path: run `whk share {}` and open {path} on the link.",
            local.port
        );
    }
    Ok(local)
}

#[cfg(test)]
mod tests;
