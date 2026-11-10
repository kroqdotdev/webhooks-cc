//! The webhooks.cc tunnel protocol, shared by the edge (`apps/edge-rs`) and
//! the CLI (`apps/cli-rs`).
//!
//! `whk share` (and `whk tunnel --live`) opens a WebSocket to the edge's [`CONNECT_PATH`], with its
//! API key and what it wants in the request headers. The edge asks the web
//! app whether the share may open; if not, it answers the upgrade with an
//! error status and an [`ErrorBody`]. If so, it upgrades and sends
//! [`EdgeMessage::Ready`] as a text message.
//!
//! From then on binary messages carry a yamux session (see [`mux`]) in
//! which the edge is the client: each visitor connection becomes a stream
//! the edge opens, and the CLI pipes it to the local port untouched. Text
//! messages carry [`EdgeMessage`]s alongside, such as one line per request.

pub mod mux;
pub mod splice;
pub mod ws;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// The WebSocket the CLI connects to.
pub const CONNECT_PATH: &str = "/v1/connect";

/// `Authorization: Bearer whcc_...` carries the API key.
pub const HEADER_NAME: &str = "x-whk-name";
/// What the CLI runs on, shown on the dashboard: "mads-laptop, macOS".
pub const HEADER_CLIENT: &str = "x-whk-client";
/// The local port, so the edge can set `Host: localhost:<port>`.
pub const HEADER_PORT: &str = "x-whk-port";
pub const HEADER_VERSION: &str = "x-whk-version";
/// One `whk share` run, the same across its reconnects, so a share that
/// was stopped stays stopped when the CLI never heard why.
pub const HEADER_INSTANCE: &str = "x-whk-instance";
/// `whk share --password`: the password visitors need, as hex of its
/// UTF-8 (a header carries only ASCII).
pub const HEADER_PASSWORD: &str = "x-whk-password";
/// What the session is for: `share` (the default when absent: a preview
/// at a name) or `live` (`whk tunnel --live`: the receiver relays an
/// endpoint's captures down the tunnel, and there is no preview).
pub const HEADER_KIND: &str = "x-whk-kind";
/// `whk tunnel --live`: the slug of the endpoint whose captures come down
/// the tunnel.
pub const HEADER_ENDPOINT: &str = "x-whk-endpoint";
/// On the CLI's own 502 when nothing listens on the port; the edge shows
/// visitors its page for that instead.
pub const HEADER_NOTHING_LISTENING: &str = "x-whk-nothing-listening";

/// What the edge says to the CLI, as WebSocket text messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EdgeMessage {
    /// The share is open at `url` (for a live session: `name` is the
    /// endpoint's slug and `url` its capture URL). `expires_at` is when its plan's time
    /// runs out (RFC 3339), if it has a limit, `expires_in` the same in
    /// seconds, and `notice` whether visitors see the notice first (Free).
    /// Older CLIs ignore the fields they do not know.
    #[serde(rename_all = "camelCase")]
    Ready {
        name: String,
        url: String,
        expires_at: Option<String>,
        #[serde(default)]
        expires_in: Option<u64>,
        #[serde(default)]
        notice: bool,
        /// Whether visitors need a password.
        #[serde(default)]
        password: bool,
    },
    /// One visitor request, after its response started.
    Request {
        method: String,
        path: String,
        status: u16,
        ms: u64,
    },
    /// Something to show as it is.
    Notice { text: String },
    /// The edge is closing the share, and why.
    Closing { reason: String },
}

/// The body of a refused connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: String,
}
