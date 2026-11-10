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
    HEADER_VERSION, PROTOCOL_VERSION, splice, ws,
};

use crate::api::ApiClient;
use crate::tunnel::join_path;

/// Where the CLI reaches the edge unless `WHK_TUNNEL_URL` says otherwise.
pub const DEFAULT_TUNNEL_URL: &str = "wss://tunnel.webhooks.cc";

/// The longest a reconnect waits.
const MAX_WAIT: Duration = Duration::from_secs(30);

/// The most a relayed request's head may take before it is passed on
/// unchanged (`--live` with a path or `-H` headers to add).
const MAX_HEAD: usize = 64 * 1024;

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

pub struct Session {
    pub tunnel_url: String,
    pub api: ApiClient,
    pub kind: Kind,
    pub port: u16,
    pub rewrite: Option<Rewrite>,
    /// What the CLI runs on, for the dashboard: "laptop, Linux".
    pub client: String,
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

/// An answer to the upgrade: 5xx is the edge's trouble and worth another
/// try; anything else is a refusal (bad key, name taken, plan limit,
/// stopped run).
fn refusal(status: u16, body: Option<&[u8]>) -> Failure {
    let message = body
        .and_then(|b| serde_json::from_slice::<ErrorBody>(b).ok())
        .map(|b| b.error)
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| format!("The tunnel answered {status}."));
    if status >= 500 {
        Failure::Transient(message)
    } else {
        Failure::Refused { status, message }
    }
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

/// Runs the session until the edge closes it (the reason, as the edge
/// gave it) or refuses it (an error with the edge's words).
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
                tokio::time::sleep(wait).await;
                wait = doubled(wait);
            }
            // An agent's access token may have run out: one more try with
            // a new one before giving up.
            Err(Failure::Refused { status: 401, .. })
                if !refreshed && session.api.bearer_refreshes() =>
            {
                refreshed = true;
            }
            Err(Failure::Refused { message, .. }) => bail!(message),
            Err(Failure::Transient(message)) => {
                on(Update::Retrying {
                    message,
                    seconds: wait.as_secs(),
                });
                tokio::time::sleep(wait).await;
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
            message: "Not logged in. Run `whk auth login` first.".to_string(),
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
    let socket =
        match tokio_tungstenite::connect_async_with_config(request, Some(ws::config()), true).await
        {
            Ok((socket, _)) => socket,
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                return Err(refusal(
                    response.status().as_u16(),
                    response.body().as_deref(),
                ));
            }
            Err(e) => {
                return Err(Failure::Transient(format!(
                    "Could not reach the tunnel ({e})."
                )));
            }
        };

    let (bytes, mut text) = ws::split(socket);
    let (_opener, mut inbound, mut mux_task) = mux::spawn(bytes, yamux::Mode::Server);
    let rewrite = session.rewrite.clone().filter(|r| !r.is_empty());

    loop {
        tokio::select! {
            stream = inbound.recv() => match stream {
                Some(stream) => { tokio::spawn(pipe(stream, session.port, rewrite.clone())); }
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
                    Ok(EdgeMessage::Request { method, path, status, ms }) => {
                        on(Update::Request { method, path, status, ms });
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

/// Connects one stream from the edge to the local port and copies both
/// ways until soon after either side ends (`splice`). With nothing
/// listening there, it answers 502 itself, marked so the edge can show
/// visitors its own page.
async fn pipe(mut stream: MuxStream, port: u16, rewrite: Option<Rewrite>) {
    let local = match TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => Ok(s),
        Err(_) => TcpStream::connect(("::1", port)).await,
    };
    let Ok(mut local) = local else {
        let _ = stream.write_all(&nothing_listening(port)).await;
        let _ = stream.shutdown().await;
        return;
    };
    let _ = local.set_nodelay(true);
    if let Some(rewrite) = rewrite {
        match rewritten_head(&mut stream, &rewrite).await {
            Ok(head) => {
                if local.write_all(&head).await.is_err() {
                    return;
                }
            }
            Err(_) => return,
        }
    }
    splice::splice(&mut stream, &mut local, splice::LINGER).await;
}

/// The CLI's own 502 when nothing listens on the port.
pub fn nothing_listening(port: u16) -> Vec<u8> {
    let body = format!("Nothing is running on localhost:{port}.\n");
    format!(
        "HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\n{HEADER_NOTHING_LISTENING}: 1\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// Reads a relayed request's head and gives it back with its path under
/// the target's base path and the `-H` headers in place of any of the same
/// name, followed by whatever of the body came with it. A head that never
/// ends within `MAX_HEAD` is passed on as it came.
async fn rewritten_head<S: AsyncRead + Unpin>(
    stream: &mut S,
    rewrite: &Rewrite,
) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = find_head_end(&buf) {
            let (head, rest) = buf.split_at(end);
            let mut out = rewrite_head(head, rewrite).unwrap_or_else(|| head.to_vec());
            out.extend_from_slice(rest);
            return Ok(out);
        }
        if buf.len() >= MAX_HEAD {
            return Ok(buf);
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(buf);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// Where the head ends: just past its blank line.
fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// The head (ending in its blank line) with the path joined to the base
/// path and the headers replaced; `None` when it is not an HTTP/1 request.
pub fn rewrite_head(head: &[u8], rewrite: &Rewrite) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.splitn(3, ' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if !version.starts_with("HTTP/") {
        return None;
    }
    let target = if rewrite.base_path.is_empty() || rewrite.base_path == "/" {
        target.to_string()
    } else {
        join_path(&rewrite.base_path, target)
    };
    let mut out = format!("{method} {target} {version}\r\n");
    let replaced = |line: &str| {
        line.split_once(':').is_some_and(|(name, _)| {
            rewrite
                .headers
                .iter()
                .any(|(extra, _)| extra.eq_ignore_ascii_case(name.trim()))
        })
    };
    for line in lines.filter(|l| !l.is_empty()) {
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
    out.push_str("\r\n");
    Some(out.into_bytes())
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

/// The port of a `whk share` target: "3000", "localhost:3000" or
/// "http://localhost:3000". Only this machine can be shared.
pub fn parse_share_target(target: &str) -> Result<u16> {
    let rest = target
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let rest = rest.trim_end_matches('/');
    let port = match rest.rsplit_once(':') {
        Some((host, port)) => {
            let host = host.trim_start_matches('[').trim_end_matches(']');
            if !matches!(host, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0") {
                bail!("Only this machine can be shared: give a port, such as `whk share 3000`.");
            }
            port
        }
        None => rest,
    };
    match port.parse::<u16>() {
        Ok(0) | Err(_) => bail!("Give the local port to share, such as `whk share 3000`."),
        Ok(port) => Ok(port),
    }
}

#[cfg(test)]
mod tests;
