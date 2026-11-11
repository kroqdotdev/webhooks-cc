use anyhow::Result;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::api::stream::join_stream;
use crate::cli::output::{
    bold, dim, green, method_color, print_reconnected, print_reconnecting, red, sanitize,
    sanitize_line,
};
use crate::share::{self, Kind, Rewrite, Session, Update};
use crate::tunnel::{EMAIL_SKIPPED, EmailOptions, Tunnel, email_target_url, parse_target};
use crate::types::{
    CapturedRequest, CreateEndpointRequest, EmailFormat, ForwardResult, LiveResponse, SseEvent,
};

/// What the tunnel does with captured emails, from its flags: `None` skips
/// them (`--no-email`).
pub fn email_options(
    format: EmailFormat,
    path: Option<String>,
    mailgun_signing_key: Option<String>,
    no_email: bool,
) -> Option<EmailOptions> {
    (!no_email).then_some(EmailOptions {
        format,
        path,
        mailgun_signing_key,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    client: &ApiClient,
    target: &str,
    endpoint_slug: Option<&str>,
    ephemeral: bool,
    headers: Vec<String>,
    emails: Option<EmailOptions>,
    live: bool,
    json: bool,
) -> Result<()> {
    let target_url = parse_target(target)?;
    let live_target = if live {
        Some(live_target(target)?)
    } else {
        None
    };

    let mut extra_headers = HashMap::new();
    for h in &headers {
        let (k, v) = h
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("invalid header: {h} (expected Key:Value)"))?;
        extra_headers.insert(k.trim().to_string(), v.trim().to_string());
    }

    // Create or reuse endpoint
    let (slug, email_address, created) = match endpoint_slug {
        Some(s) => {
            // Only for the banner, so a failure here is not one.
            let address = match emails {
                Some(_) => client
                    .get_endpoint(s)
                    .await
                    .ok()
                    .and_then(|ep| ep.email_address),
                None => None,
            };
            (s.to_string(), address, false)
        }
        None => {
            let req = CreateEndpointRequest {
                name: None,
                is_ephemeral: if ephemeral { Some(true) } else { None },
                expires_at: None,
                mock_response: None,
            };
            let ep = client.create_endpoint(&req).await?;
            (ep.slug, ep.email_address, true)
        }
    };

    let webhook_url = client.webhook_url_for(&slug);
    let email_url = emails
        .as_ref()
        .map(|options| email_target_url(&target_url, options.path.as_deref()));
    let email_format = emails.as_ref().map(|options| options.format);

    if json {
        println!(
            "{}",
            serde_json::json!({
                "event": "started",
                "slug": slug,
                "webhook_url": webhook_url,
                "target": target_url,
                "email_address": email_address,
                "email_target": email_url,
                "email_format": email_format.map(EmailFormat::as_str),
                "live": live,
            })
        );
    } else {
        println!("\n  {} Tunnel active", green("●"));
        println!("  {} {}", dim("Webhook URL:"), bold(&webhook_url));
        println!("  {} {}", dim("Forwarding to:"), bold(&target_url));
        if live {
            println!(
                "  {} {}",
                dim("Live:"),
                dim("senders get your app's answer while whk runs")
            );
        }
        match (&emails, &email_url) {
            (Some(options), Some(url)) => {
                if let Some(ref address) = email_address {
                    println!("  {} {}", dim("Email address:"), bold(address));
                }
                println!(
                    "  {} {} {}",
                    dim("Emails to:"),
                    bold(url),
                    dim(&email_shape(options))
                );
            }
            _ => println!("  {} {}", dim("Emails:"), dim(EMAIL_SKIPPED)),
        }
        println!("  {}\n", dim("Press Ctrl+C to stop."));
    }

    // --live: the edge relays each HTTP capture down this session while the
    // sender waits. The SSE stream below still brings every capture; only
    // emails, and HTTP captures while the relay is down, are forwarded from it.
    let (live_tx, mut live_rx) = mpsc::channel::<Update>(256);
    // --live: whether the relay is up, and which captures it carried. The
    // session updates it as things happen, so nothing shown late (or not
    // shown, when the output falls behind) changes what is forwarded.
    let relay = Arc::new(Mutex::new(LiveRelay::default()));
    let session_relay = relay.clone();
    let pipe_relay = relay.clone();
    let on_relayed: share::OnRelayed =
        Arc::new(move |id: &str| lock(&pipe_relay).relayed_request(id, Instant::now()));
    let mut live_task = live_target.map(|(local, base_path)| {
        let session = Session {
            tunnel_url: share::tunnel_url(),
            api: client.clone(),
            kind: Kind::Live {
                endpoint: slug.clone(),
            },
            host: local.host,
            port: local.port,
            rewrite: Some(Rewrite {
                base_path,
                headers: extra_headers
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            }),
            client: share::client_name(),
            on_relayed: Some(on_relayed),
        };
        tokio::spawn(async move {
            let mut send = |update: Update| {
                lock(&session_relay).on_update(&update);
                let _ = live_tx.try_send(update);
            };
            share::run(&session, &mut send).await
        })
    });

    let mut tunnel = Tunnel::new(target_url, extra_headers)?;
    if let Some(options) = emails {
        tunnel = tunnel.with_emails(client.clone(), options);
    }

    // SSE stream (reconnects on its own; see ApiClient::stream_requests)
    let (tx, mut rx) = mpsc::channel(64);
    let stream_client = client.clone();
    let stream_slug = slug.clone();

    let stream_handle =
        tokio::spawn(async move { stream_client.stream_requests(&stream_slug, tx).await });

    let mut reconnecting = false;
    let mut interrupted = false;
    // --live: looks for stream copies the relay never carried.
    let mut held_check = tokio::time::interval(Duration::from_secs(1));
    // --live refused before it was ever up (another relay, a limit, no
    // access): the tunnel ends with that as its error.
    let mut live_refused: Option<String> = None;

    // One for the whole run, so a signal that arrives while an arm is busy
    // (forwarding a capture) is still seen.
    let shutdown = crate::cli::share::shutdown_signal();
    tokio::pin!(shutdown);

    // Process events until Ctrl+C, endpoint deletion, or a terminal stream error
    loop {
        tokio::select! {
            event = rx.recv() => {
                let Some(event) = event else { break };
                match event {
                    SseEvent::Request(req) => {
                        // --live: HTTP captures come through the edge while
                        // the relay is up; while it is not, they are
                        // forwarded from the stream like a plain tunnel's.
                        let req = if live && !req.is_email() {
                            let mut relay = lock(&relay);
                            let Some(req) = relay.admit(*req, Instant::now()) else { continue };
                            if relay.announce() {
                                drop(relay);
                                if json {
                                    println!(
                                        "{}",
                                        serde_json::json!({ "event": "live_fallback" })
                                    );
                                } else {
                                    println!(
                                        "  {} {}",
                                        dim("●"),
                                        dim(LIVE_FALLBACK)
                                    );
                                }
                            }
                            req
                        } else {
                            *req
                        };
                        // --no-email: the email is listed, not posted.
                        if req.is_email() && email_format.is_none() {
                            if json {
                                println!(
                                    "{}",
                                    serde_json::json!({
                                        "event": "skipped",
                                        "reason": "email",
                                        "method": req.method,
                                        "path": req.path,
                                        "subject": req.email_subject(),
                                    })
                                );
                            } else {
                                println!("{}", request_line(&req, &dim(EMAIL_SKIPPED)));
                            }
                            continue;
                        }
                        deliver(&tunnel, &req, json, email_format).await;
                    }
                    SseEvent::EndpointDeleted => {
                        if json {
                            println!("{}", serde_json::json!({ "event": "endpoint_deleted" }));
                        } else {
                            println!("\n  {} Endpoint was deleted.", red("●"));
                        }
                        break;
                    }
                    SseEvent::Reconnecting { attempt, delay_ms, reason } => {
                        reconnecting = true;
                        print_reconnecting(json, attempt, delay_ms, &reason);
                    }
                    SseEvent::Connected => {
                        if reconnecting {
                            reconnecting = false;
                            print_reconnected(json);
                        }
                    }
                    // The server rotates every stream after 30 minutes; the
                    // stream layer reconnects transparently.
                    SseEvent::Timeout => {}
                }
            }
            update = live_rx.recv(), if live_task.is_some() => {
                if let Some(update) = update {
                    show_live_update(update, json);
                }
            }
            _ = held_check.tick(), if live => {
                let (due, dropped) = {
                    let mut relay = lock(&relay);
                    (relay.due(Instant::now()), relay.take_dropped())
                };
                if dropped > 0 {
                    show_live_update(Update::Notice(dropped_note(dropped)), json);
                }
                let due = if due.is_empty() { due } else { undelivered(client, due).await };
                if !due.is_empty() && !json {
                    println!("  {} {}", dim("●"), dim(&not_relayed(due.len())));
                }
                for req in due {
                    deliver(&tunnel, &req, json, email_format).await;
                }
            }
            ended = async { live_task.as_mut().expect("guarded").await }, if live_task.is_some() => {
                live_task = None;
                // Show what the session said before it ended.
                while let Ok(update) = live_rx.try_recv() {
                    show_live_update(update, json);
                }
                match ended {
                    Ok(Ok(reason)) => live_stopped(json, &reason),
                    Ok(Err(e)) => live_refused = Some(format!("{e:#}")),
                    Err(e) => live_stopped(json, &format!("{e}")),
                }
                break;
            }
            _ = &mut shutdown => {
                interrupted = true;
                // Ctrl-C or SIGTERM ends a live relay as cleanly as the edge
                // ending it: say so, the way `whk share` prints `stopped`.
                if live_task.is_some() {
                    live_stopped(json, STOPPED_HERE);
                }
                break;
            }
        }
    }
    if let Some(task) = live_task {
        task.abort();
    }

    // Make any in-flight send in the stream task fail fast, then collect its result.
    drop(rx);
    let stream_result = join_stream(stream_handle, interrupted).await;

    // Cleanup: only endpoints we created, and only when asked to (--ephemeral).
    if created {
        if ephemeral {
            if let Err(e) = client.delete_endpoint(&slug).await {
                eprintln!("  {} Could not delete endpoint {slug}: {e:#}", dim("●"));
            }
        } else if json {
            println!(
                "{}",
                serde_json::json!({ "event": "endpoint_kept", "slug": slug })
            );
        } else {
            println!("\n  {} Endpoint kept: {}", dim("●"), bold(&slug));
            println!(
                "    {} whk tunnel {target} --endpoint {slug}",
                dim("Reuse: ")
            );
            println!("    {} whk delete {slug}", dim("Delete:"));
        }
    }

    if let Some(message) = live_refused {
        anyhow::bail!(message);
    }
    stream_result
}

/// The local server and base path of a `--live` target: the same forms as
/// plain `whk tunnel` ("8080", "8080/api/webhooks", "localhost:8080",
/// "127.0.0.1:8080/api"). Relayed requests go there, under that path.
pub fn live_target(target: &str) -> Result<(share::LocalTarget, String)> {
    let (local, path) = share::parse_local_target(target)?;
    Ok((local, path.trim_end_matches('/').to_string()))
}

/// Forwards a capture from the stream to the local app and prints how it
/// went.
async fn deliver(
    tunnel: &Tunnel,
    req: &CapturedRequest,
    json: bool,
    email_format: Option<EmailFormat>,
) {
    let result = tunnel.forward(req).await;
    if json {
        println!("{}", forwarded_event(req, &result, email_format));
    } else {
        let status = if result.success {
            green(&result.to_string())
        } else {
            red(&result.to_string())
        };
        println!("{}", request_line(req, &status));
    }
}

/// The relay's state, whoever held the lock last (it holds no invariant a
/// panic could break halfway).
fn lock(relay: &Mutex<LiveRelay>) -> std::sync::MutexGuard<'_, LiveRelay> {
    relay.lock().unwrap_or_else(|e| e.into_inner())
}

/// What `whk tunnel --live` says when it let stream copies go to keep its
/// wait bounded.
fn dropped_note(count: usize) -> String {
    format!(
        "Too many captures at once: {count} not forwarded from the stream, as the live relay most likely carried them."
    )
}

/// What `whk tunnel --live` says before forwarding captures the relay never
/// carried, which the stream brought while the relay was up.
fn not_relayed(count: usize) -> String {
    let what = if count == 1 {
        "1 capture".to_string()
    } else {
        format!("{count} captures")
    };
    format!(
        "Forwarding {what} from the stream that the live relay did not carry (made while this computer was offline, or turned away at the edge)."
    )
}

/// What `whk tunnel --live` says when the relay is down and captures come
/// from the stream instead.
const LIVE_FALLBACK: &str = "The live relay is not connected: forwarding captures from the stream like a plain tunnel until it is back (senders get 502 for 2 minutes, then the endpoint's mock).";

/// How long the edge's line for a relayed capture is remembered, for its
/// copy on the stream to find. Long, since the stream can be down for a
/// while (it waits 90 s on a silent connection) and replays what it missed
/// when it is back.
const RELAYED_KEPT: Duration = Duration::from_secs(15 * 60);

/// At most this many remembered relayed captures.
const RELAYED_MAX: usize = 10_000;

/// How long the route of a capture an older edge relayed (one that names no
/// ids) is remembered, for its stream copy to match.
const ROUTES_KEPT: Duration = Duration::from_secs(30);

/// At most this many remembered routes.
const ROUTES_MAX: usize = 512;

/// How long a stream copy that came while the relay was up waits to be
/// matched, from an edge that names captures only in its lines: it names a
/// capture once the app answered, or after 25 s without an answer. A copy
/// not named by then was never relayed (made while this computer was
/// offline, or turned away at the edge) and, unless the API says the relay
/// dealt with it, is forwarded from the stream instead.
const HELD_FOR: Duration = Duration::from_secs(40);

/// The same wait once the edge has shown it sends each capture's id with
/// the relayed request itself: the id is marked as the request arrives,
/// before the app is called, so the app's 25 s no longer count, only how
/// long the relay takes to reach this computer.
const HELD_FOR_WITH_IDS: Duration = Duration::from_secs(15);

/// At most this many stream copies wait, and at most this many bytes of
/// them. Past either, the oldest goes: forwarded (after the API check) when
/// it has waited [`OVERFLOW_MIN_AGE`], since by then the relay would have
/// marked it; otherwise dropped, as the relay most likely has it.
const HELD_MAX: usize = 512;
const HELD_BYTES: usize = 32 * 1024 * 1024;
const OVERFLOW_MIN_AGE: Duration = Duration::from_secs(5);

/// How long the API may take to say whether the relay dealt with a copy.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// At most this many of those checks run at once.
const CHECKS_AT_ONCE: usize = 8;

/// A stream copy waiting for the edge to name it.
struct Held {
    request: CapturedRequest,
    at: Instant,
    bytes: usize,
}

/// `whk tunnel --live`'s view of its relay: whether it is up, and which
/// captures it carried, so none is forwarded twice from the stream and none
/// it did not carry is skipped.
///
/// Every capture the relay carries reaches the CLI twice: as the edge's
/// line for the relay (after the app answered) and as a copy on the stream
/// (whenever the web app sends it). Whichever comes first is remembered
/// until the other matches it. An edge that names the capture's id is
/// matched by id; an older one by method and path. A copy that came while
/// the relay was up and is never named was not relayed, and goes to the app
/// from the stream after [`HELD_FOR`].
#[derive(Default)]
struct LiveRelay {
    connected: bool,
    announced: bool,
    /// Ids the edge said it relayed, not yet seen on the stream, oldest first.
    relayed_ids: VecDeque<(String, Instant)>,
    relayed_set: HashSet<String>,
    /// Method and path of captures an older edge relayed (no id), not yet
    /// seen on the stream.
    relayed_routes: VecDeque<(String, String, Instant)>,
    /// Stream copies that came while the relay was up, not yet named by the
    /// edge, oldest first.
    held: VecDeque<Held>,
    held_bytes: usize,
    /// Copies let go early to keep `held` bounded, to forward next.
    released: Vec<CapturedRequest>,
    /// Copies dropped to keep `held` bounded, not yet reported.
    dropped: usize,
    /// Whether relayed requests have carried their capture's id.
    ids_in_requests: bool,
}

impl LiveRelay {
    fn prune(&mut self, now: Instant) {
        while let Some((id, at)) = self.relayed_ids.front() {
            if now.duration_since(*at) < RELAYED_KEPT && self.relayed_ids.len() <= RELAYED_MAX {
                break;
            }
            self.relayed_set.remove(id);
            self.relayed_ids.pop_front();
        }
        while let Some((_, _, at)) = self.relayed_routes.front() {
            if now.duration_since(*at) < ROUTES_KEPT && self.relayed_routes.len() <= ROUTES_MAX {
                break;
            }
            self.relayed_routes.pop_front();
        }
    }

    fn take_held(&mut self, i: usize) -> Option<CapturedRequest> {
        let held = self.held.remove(i)?;
        self.held_bytes -= held.bytes;
        Some(held.request)
    }

    fn on_update(&mut self, update: &Update) {
        match update {
            Update::Ready { .. } | Update::Reconnected => {
                self.connected = true;
                self.announced = false;
            }
            Update::Retrying { .. } => self.connected = false,
            Update::Request {
                method,
                path,
                request_id,
                ..
            } => {
                let now = Instant::now();
                self.prune(now);
                let path = path_only(path);
                match request_id {
                    // Whatever its status: a capture the edge turned away
                    // as busy got the sender a 503, and its retry is relayed.
                    Some(id) => self.relayed(id, now),
                    None => {
                        if let Some(i) = self.held.iter().position(|h| {
                            h.request.method.eq_ignore_ascii_case(method)
                                && path_only(&h.request.path) == path
                        }) {
                            self.take_held(i);
                        } else {
                            self.relayed_routes
                                .push_back((method.clone(), path.to_string(), now));
                        }
                    }
                }
            }
            Update::Notice(_) => {}
        }
    }

    /// The relay carried the capture `id` (the edge's line said so, or the
    /// relayed request carried it): its copy on the stream is not
    /// forwarded, whether it came already or comes later.
    fn relayed(&mut self, id: &str, now: Instant) {
        self.prune(now);
        if let Some(i) = self.held.iter().position(|h| h.request.id == id) {
            self.take_held(i);
        } else if self.relayed_set.insert(id.to_string()) {
            self.relayed_ids.push_back((id.to_string(), now));
        }
    }

    /// A relayed request carried the capture's id, before the app got it.
    fn relayed_request(&mut self, id: &str, now: Instant) {
        self.ids_in_requests = true;
        self.relayed(id, now);
    }

    fn held_for(&self) -> Duration {
        if self.ids_in_requests {
            HELD_FOR_WITH_IDS
        } else {
            HELD_FOR
        }
    }

    /// A capture from the stream: given back to forward to the local app at
    /// once, or kept. Never one the relay carried; while the relay is up, a
    /// copy waits for the edge to name it (see [`LiveRelay::due`]); while it
    /// is down, it goes now.
    fn admit(&mut self, request: CapturedRequest, now: Instant) -> Option<CapturedRequest> {
        self.prune(now);
        // Its entry in `relayed_ids` goes with the next prune.
        if self.relayed_set.remove(&request.id) {
            return None;
        }
        let path = path_only(&request.path);
        if let Some(i) = self
            .relayed_routes
            .iter()
            .position(|(m, p, _)| m.eq_ignore_ascii_case(&request.method) && p == path)
        {
            self.relayed_routes.remove(i);
            return None;
        }
        if !self.connected {
            return Some(request);
        }
        // The edge most likely has it (its line comes once the app
        // answered): keep the copy until that line names it.
        let bytes = request.body.as_ref().map_or(0, String::len)
            + request.body_raw.as_ref().map_or(0, String::len);
        self.held_bytes += bytes;
        self.held.push_back(Held {
            request,
            at: now,
            bytes,
        });
        while self.held.len() > HELD_MAX || (self.held_bytes > HELD_BYTES && self.held.len() > 1) {
            let waited = self
                .held
                .front()
                .is_some_and(|h| now.duration_since(h.at) >= OVERFLOW_MIN_AGE);
            if let Some(request) = self.take_held(0) {
                if waited {
                    self.released.push(request);
                } else {
                    self.dropped += 1;
                }
            }
        }
        None
    }

    /// How many copies were dropped to keep the wait bounded since last
    /// asked.
    fn take_dropped(&mut self) -> usize {
        std::mem::take(&mut self.dropped)
    }

    /// The stream copies never matched within [`LiveRelay::held_for`] (and
    /// any let go early), oldest first: most likely not relayed, so they go
    /// to the app from the stream, once each, after [`undelivered`] asked
    /// the API.
    fn due(&mut self, now: Instant) -> Vec<CapturedRequest> {
        let mut due = std::mem::take(&mut self.released);
        let held_for = self.held_for();
        while self
            .held
            .front()
            .is_some_and(|h| now.duration_since(h.at) >= held_for)
        {
            if let Some(request) = self.take_held(0) {
                due.push(request);
            }
        }
        due
    }

    /// True the first time a capture is forwarded from the stream since the
    /// relay went down, to say so once.
    fn announce(&mut self) -> bool {
        !std::mem::replace(&mut self.announced, true)
    }
}

/// Whether the relay dealt with a capture, by the record of what its
/// sender got: an answer, a timeout, a refused answer or a busy refusal (the
/// sender retries, and the retry is relayed). `offline` and `unreachable`,
/// or no record, mean the app never got it.
fn relay_dealt_with(live: Option<&LiveResponse>) -> bool {
    live.is_some_and(|live| !matches!(live.outcome.as_str(), "offline" | "unreachable"))
}

/// Of the due stream copies, the ones to forward, in order: each read again
/// from the API, and skipped when its record shows the relay dealt with it
/// (an edge line lost under load). A read that fails or takes too long
/// forwards it: at least once beats never.
async fn undelivered(client: &ApiClient, due: Vec<CapturedRequest>) -> Vec<CapturedRequest> {
    use futures::StreamExt;
    futures::stream::iter(due)
        .map(|request| async move {
            let read = tokio::time::timeout(CHECK_TIMEOUT, client.get_request(&request.id)).await;
            match read {
                Ok(Ok(fresh)) if relay_dealt_with(fresh.live_response.as_deref()) => None,
                _ => Some(request),
            }
        })
        .buffered(CHECKS_AT_ONCE)
        .filter_map(std::future::ready)
        .collect()
        .await
}

/// A path without its query.
fn path_only(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

fn show_live_update(update: Update, json: bool) {
    match update {
        Update::Ready { .. } => {
            if json {
                println!("{}", serde_json::json!({ "event": "live_connected" }));
            } else {
                println!("  {} {}", green("●"), dim("Live relay connected"));
            }
        }
        Update::Reconnected => {
            if json {
                println!("{}", serde_json::json!({ "event": "live_reconnected" }));
            } else {
                print_reconnected(false);
            }
        }
        Update::Request {
            method,
            path,
            status,
            ms,
            request_id,
        } => {
            if json {
                let mut event = serde_json::json!({
                    "event": "relayed",
                    "method": method,
                    "path": path,
                    "status": status,
                    "duration_ms": ms,
                });
                if let Some(id) = request_id {
                    event["request_id"] = serde_json::Value::String(id);
                }
                println!("{event}");
            } else {
                println!(
                    "{}",
                    crate::cli::share::request_line(&method, &path, status, ms)
                );
            }
        }
        Update::Notice(text) => {
            if json {
                println!("{}", serde_json::json!({ "event": "notice", "text": text }));
            } else {
                println!("  {} {}", dim("●"), sanitize(&text));
            }
        }
        Update::Retrying { message, seconds } => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "event": "live_retrying", "message": message, "seconds": seconds })
                );
            } else {
                println!(
                    "  {} {}",
                    dim("●"),
                    dim(&format!(
                        "Live relay: {} Trying again in {seconds}s.",
                        sanitize_line(&message)
                    ))
                );
            }
        }
    }
}

/// Why a live relay ended when its user stopped `whk`.
const STOPPED_HERE: &str = "you stopped it on this computer";

fn live_stopped(json: bool, reason: &str) {
    println!("{}", live_stopped_line(json, reason));
}

fn live_stopped_line(json: bool, reason: &str) -> String {
    if json {
        serde_json::json!({ "event": "live_stopped", "reason": reason }).to_string()
    } else {
        format!(
            "\n  {} Live relay stopped: {}",
            red("●"),
            sanitize_line(reason)
        )
    }
}

/// How emails are posted, for the banner.
fn email_shape(options: &EmailOptions) -> String {
    if options.format == EmailFormat::Mailgun && options.signing_key().is_none() {
        format!(
            "({}, unsigned without --mailgun-signing-key)",
            options.format.label()
        )
    } else {
        format!("({})", options.format.label())
    }
}

/// One line of output for a delivery: the time, the method and path, or for
/// an email the recipient and subject, then the outcome.
fn request_line(req: &CapturedRequest, outcome: &str) -> String {
    let time = chrono::Local::now().format("%H:%M:%S").to_string();
    let what = if req.is_email() {
        let subject = req
            .email_subject()
            .unwrap_or_else(|| "(no subject)".to_string());
        format!(
            "{} {}",
            sanitize_line(&req.path),
            bold(&sanitize_line(&subject))
        )
    } else {
        sanitize(&req.path)
    };
    format!(
        "  {} {} {} -> {}",
        dim(&time),
        method_color(&req.method),
        what,
        outcome
    )
}

/// The `--json` line for a delivery. Emails add their kind, subject and the
/// format they were posted in.
fn forwarded_event(
    req: &CapturedRequest,
    result: &ForwardResult,
    email_format: Option<EmailFormat>,
) -> serde_json::Value {
    let mut event = serde_json::json!({
        "event": "forwarded",
        "method": req.method,
        "path": req.path,
        "status": result.status_code,
        "duration_ms": result.duration.as_millis(),
        "success": result.success,
        "error": result.error,
    });
    if req.is_email() {
        event["kind"] = "email".into();
        event["subject"] = req.email_subject().into();
        event["format"] = email_format.map(EmailFormat::as_str).into();
    }
    event
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_live_relay_stopped_here_says_so_in_json() {
        let line = live_stopped_line(true, STOPPED_HERE);
        let event: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(event["event"], "live_stopped");
        assert_eq!(event["reason"], "you stopped it on this computer");
    }

    use super::*;
    use std::time::Duration;

    fn email() -> CapturedRequest {
        let json = r#"{"_id":"e1","endpointId":"ep","method":"EMAIL","path":"acme+run@mailhooks.cc","headers":{"subject":"Your code\r\n  12:00:00 POST /fake"},"queryParams":{},"ip":"192.0.2.1","size":48,"receivedAt":1,"kind":"email"}"#;
        serde_json::from_str(json).unwrap()
    }

    fn ok() -> ForwardResult {
        ForwardResult {
            success: true,
            status_code: Some(204),
            duration: Duration::from_millis(12),
            error: None,
        }
    }

    #[test]
    fn live_targets_are_a_local_server_and_a_base_path() {
        use share::{LocalHost, LocalTarget};
        let at = |host, port| LocalTarget { host, port };
        assert_eq!(
            live_target("3000").unwrap(),
            (at(LocalHost::Localhost, 3000), String::new())
        );
        assert_eq!(
            live_target("8080/api/webhooks/").unwrap(),
            (at(LocalHost::Localhost, 8080), "/api/webhooks".to_string())
        );
        assert_eq!(
            live_target("localhost:3000").unwrap(),
            (at(LocalHost::Localhost, 3000), String::new())
        );
        assert_eq!(
            live_target("127.0.0.1:5173/hooks").unwrap(),
            (at(LocalHost::V4, 5173), "/hooks".to_string())
        );
        assert!(live_target("0").is_err());
        assert!(live_target("abc").is_err());
        assert!(live_target("https://localhost:3000").is_err());
    }

    #[test]
    fn email_options_follow_the_flags() {
        let options =
            email_options(EmailFormat::Postmark, Some("/in".into()), None, false).unwrap();
        assert_eq!(options.format, EmailFormat::Postmark);
        assert_eq!(options.path.as_deref(), Some("/in"));
        assert!(email_options(EmailFormat::Json, None, None, true).is_none());
    }

    #[test]
    fn an_email_line_shows_the_recipient_and_subject_on_one_line() {
        let line = request_line(&email(), "204");
        assert!(line.contains("acme+run@mailhooks.cc"), "{line}");
        assert!(line.contains("Your code"), "{line}");
        assert!(!line.contains('\n') && !line.contains('\r'), "{line}");
    }

    #[test]
    fn forwarded_event_for_an_email_names_its_kind_subject_and_format() {
        let event = forwarded_event(&email(), &ok(), Some(EmailFormat::Sendgrid));
        assert_eq!(event["event"], "forwarded");
        assert_eq!(event["kind"], "email");
        assert_eq!(event["method"], "EMAIL");
        assert_eq!(event["path"], "acme+run@mailhooks.cc");
        assert_eq!(event["subject"], "Your code\r\n  12:00:00 POST /fake");
        assert_eq!(event["format"], "sendgrid");
        assert_eq!(event["status"], 204);
        assert_eq!(event["success"], true);
    }

    #[test]
    fn forwarded_event_for_http_is_unchanged_apart_from_the_error() {
        let mut request = email();
        request.kind = Some("http".into());
        request.method = "POST".into();
        request.path = "/hooks/stripe".into();
        let event = forwarded_event(&request, &ok(), Some(EmailFormat::Json));
        assert_eq!(event["path"], "/hooks/stripe");
        assert!(event.get("kind").is_none() && event.get("format").is_none());
        assert!(event["error"].is_null());
    }
    fn relayed(method: &str, path: &str, id: Option<&str>) -> Update {
        Update::Request {
            method: method.into(),
            path: path.into(),
            status: 200,
            ms: 3,
            request_id: id.map(str::to_string),
        }
    }

    fn capture(id: &str, method: &str, path: &str) -> CapturedRequest {
        let mut request = email();
        request.id = id.into();
        request.kind = Some("http".into());
        request.method = method.into();
        request.path = path.into();
        request
    }

    /// Whether the relay hands a stream copy over to forward at once.
    fn forwards(relay: &mut LiveRelay, id: &str, method: &str, path: &str) -> bool {
        relay
            .admit(capture(id, method, path), Instant::now())
            .is_some()
    }

    fn ids(requests: Vec<CapturedRequest>) -> Vec<String> {
        requests.into_iter().map(|r| r.id).collect()
    }

    fn dropped() -> Update {
        Update::Retrying {
            message: "The connection dropped.".into(),
            seconds: 1,
        }
    }

    #[test]
    fn the_live_relay_skips_what_it_carried_and_forwards_the_rest() {
        let mut relay = LiveRelay::default();
        // Before it is up, captures go from the stream.
        assert!(forwards(&mut relay, "c0", "POST", "/hooks"));
        assert!(relay.announce());
        assert!(!relay.announce());
        relay.on_update(&Update::Reconnected);
        // Up: the edge carries them, whichever side arrives first.
        assert!(!forwards(&mut relay, "c1", "POST", "/hooks"));
        relay.on_update(&relayed("POST", "/hooks?x=1", Some("c1")));
        relay.on_update(&relayed("POST", "/hooks", Some("c2")));
        relay.on_update(&dropped());
        // Down: the one it carried just before is not sent again, others are.
        assert!(!forwards(&mut relay, "c2", "POST", "/hooks"));
        assert!(forwards(&mut relay, "c3", "POST", "/hooks"));
        assert!(forwards(&mut relay, "c4", "GET", "/other"));
        // It says so again after the next drop.
        assert!(relay.announce());
    }

    #[test]
    fn captures_after_a_drop_are_forwarded_however_many_were_relayed_before() {
        // The reviewer's case: ten relayed POST /hooks, their stream copies
        // seen while connected, then a drop: the next POSTs must reach the app.
        for edge_names_ids in [true, false] {
            let mut relay = LiveRelay::default();
            relay.on_update(&Update::Reconnected);
            for i in 0..10 {
                let id = format!("r{i}");
                let named = edge_names_ids.then_some(id.as_str());
                if i % 2 == 0 {
                    relay.on_update(&relayed("POST", "/hooks", named));
                    assert!(!forwards(&mut relay, &id, "POST", "/hooks"));
                } else {
                    assert!(!forwards(&mut relay, &id, "POST", "/hooks"));
                    relay.on_update(&relayed("POST", "/hooks", named));
                }
            }
            relay.on_update(&dropped());
            for i in 0..10 {
                assert!(
                    forwards(&mut relay, &format!("n{i}"), "POST", "/hooks"),
                    "capture {i} after the drop (ids from the edge: {edge_names_ids})"
                );
            }
        }
    }

    #[test]
    fn a_capture_relayed_just_before_a_drop_is_matched_by_its_id_only() {
        let mut relay = LiveRelay::default();
        relay.on_update(&Update::Reconnected);
        relay.on_update(&relayed("POST", "/hooks", Some("a")));
        relay.on_update(&dropped());
        // Another capture to the same path is not mistaken for it.
        assert!(forwards(&mut relay, "b", "POST", "/hooks"));
        // Its own copy, arriving late, is not sent twice.
        assert!(!forwards(&mut relay, "a", "POST", "/hooks"));
    }

    #[test]
    fn captures_made_offline_are_forwarded_once_when_the_relay_reconnects_first() {
        // The reviewer's case: both connections were down, the relay came
        // back first, then the stream replayed what was captured meanwhile.
        let mut relay = LiveRelay::default();
        relay.on_update(&Update::Reconnected);
        relay.on_update(&dropped());
        relay.on_update(&Update::Reconnected);
        let now = Instant::now();
        for i in 0..5 {
            let copy = capture(&format!("gap{i}"), "POST", "/hooks");
            assert!(relay.admit(copy, now).is_none(), "held, not skipped");
        }
        // Not before the edge had its chance to name them.
        assert!(relay.due(now + Duration::from_secs(1)).is_empty());
        let later = now + HELD_FOR;
        assert_eq!(
            ids(relay.due(later)),
            ["gap0", "gap1", "gap2", "gap3", "gap4"]
        );
        // Once each.
        assert!(relay.due(later + HELD_FOR).is_empty());
        assert!(relay.held.is_empty() && relay.held_bytes == 0);
    }

    #[test]
    fn a_stream_copy_the_edge_names_is_never_forwarded() {
        let mut relay = LiveRelay::default();
        relay.on_update(&Update::Reconnected);
        let now = Instant::now();
        // The copy first, then the edge's line, by id and (older edge) by route.
        assert!(relay.admit(capture("a", "POST", "/hooks"), now).is_none());
        assert!(
            relay
                .admit(capture("b", "PUT", "/other?x=1"), now)
                .is_none()
        );
        assert!(relay.admit(capture("c", "POST", "/hooks"), now).is_none());
        relay.on_update(&relayed("POST", "/hooks", Some("a")));
        relay.on_update(&relayed("PUT", "/other", None));
        // Only the one it never named goes, and only after the wait.
        assert_eq!(ids(relay.due(now + HELD_FOR)), ["c"]);
    }

    #[test]
    fn a_relayed_capture_stays_matched_while_the_stream_catches_up() {
        // The stream was down for a while with the relay up: the copies it
        // replays later are still the ones the relay carried.
        let mut relay = LiveRelay::default();
        relay.on_update(&Update::Reconnected);
        relay.on_update(&relayed("POST", "/hooks", Some("early")));
        let much_later = Instant::now() + Duration::from_secs(120);
        assert!(
            relay
                .admit(capture("early", "POST", "/hooks"), much_later)
                .is_none()
        );
        assert!(relay.due(much_later + HELD_FOR).is_empty());
    }

    #[test]
    fn at_the_cap_an_old_copy_is_forwarded_and_a_young_one_dropped() {
        let mut relay = LiveRelay::default();
        relay.on_update(&Update::Reconnected);
        let now = Instant::now();
        assert!(relay.admit(capture("old", "POST", "/"), now).is_none());
        let later = now + OVERFLOW_MIN_AGE;
        for i in 1..=HELD_MAX {
            let copy = capture(&format!("h{i}"), "POST", "/");
            assert!(relay.admit(copy, later).is_none());
        }
        // The oldest had waited long enough to be unrelayed: it goes, after
        // the API check.
        assert_eq!(relay.held.len(), HELD_MAX);
        assert_eq!(ids(relay.due(later)), ["old"]);
        assert_eq!(relay.take_dropped(), 0);
        // One that came just now most likely is being relayed: dropped, and
        // said so once.
        assert!(relay.admit(capture("next", "POST", "/"), later).is_none());
        assert!(relay.due(later).is_empty());
        assert_eq!(relay.take_dropped(), 1);
        assert_eq!(relay.take_dropped(), 0);
        let mut big = capture("big", "POST", "/");
        big.body = Some("x".repeat(HELD_BYTES));
        assert!(relay.admit(big, later).is_none());
        assert!(relay.held_bytes <= HELD_BYTES);
        assert_eq!(relay.take_dropped(), 1, "the oldest made room");
    }

    #[test]
    fn a_capture_the_edge_turned_away_as_busy_is_handled() {
        let mut relay = LiveRelay::default();
        relay.on_update(&Update::Reconnected);
        let now = Instant::now();
        assert!(relay.admit(capture("b", "POST", "/hooks"), now).is_none());
        relay.on_update(&Update::Request {
            method: "POST".into(),
            path: "/hooks".into(),
            status: 503,
            ms: 0,
            request_id: Some("b".into()),
        });
        assert!(relay.due(now + HELD_FOR).is_empty());
    }

    #[test]
    fn an_id_carried_by_the_relayed_request_marks_it_and_shortens_the_wait() {
        let mut relay = LiveRelay::default();
        relay.on_update(&Update::Reconnected);
        let now = Instant::now();
        // Before the copy arrives, and after.
        relay.relayed_request("early", now);
        assert!(relay.admit(capture("early", "POST", "/"), now).is_none());
        assert!(relay.admit(capture("late", "POST", "/"), now).is_none());
        relay.relayed_request("late", now);
        // An edge that sends ids with the request needs no 25 s for the app.
        assert!(relay.admit(capture("gap", "POST", "/"), now).is_none());
        assert!(
            relay
                .due(now + HELD_FOR_WITH_IDS - Duration::from_secs(1))
                .is_empty()
        );
        assert_eq!(ids(relay.due(now + HELD_FOR_WITH_IDS)), ["gap"]);
    }

    #[test]
    fn the_relay_dealt_with_a_capture_unless_its_record_says_offline_or_unreachable() {
        let record = |outcome: &str| LiveResponse {
            outcome: outcome.into(),
            ..LiveResponse::default()
        };
        for outcome in ["answered", "timeout", "refused", "busy"] {
            assert!(relay_dealt_with(Some(&record(outcome))), "{outcome}");
        }
        for outcome in ["offline", "unreachable"] {
            assert!(!relay_dealt_with(Some(&record(outcome))), "{outcome}");
        }
        assert!(!relay_dealt_with(None));
    }

    #[tokio::test]
    async fn due_copies_are_checked_with_the_api_before_they_go() {
        use axum::{Json, Router, extract::Path, http::StatusCode, routing::get};
        let app = Router::new().route(
            "/api/requests/{id}",
            get(|Path(id): Path<String>| async move {
                let outcome = match id.as_str() {
                    "fails" => return Err(StatusCode::INTERNAL_SERVER_ERROR),
                    "none" => None,
                    other => Some(other.trim_end_matches(char::is_numeric).to_string()),
                };
                let mut record = serde_json::json!({
                    "id": id, "endpointId": "ep", "method": "POST", "path": "/hooks",
                    "receivedAt": 1
                });
                if let Some(outcome) = outcome {
                    record["liveResponse"] = serde_json::json!({
                        "status": 200, "headers": {}, "body": "", "bodyTruncated": false,
                        "bodyEncoding": "utf8", "ms": 3, "outcome": outcome
                    });
                }
                Ok(Json(record))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client =
            ApiClient::with_credentials(Some(&base), Some(&base), Some("whcc_test".into()), None)
                .unwrap();
        let due = [
            "answered1",
            "offline1",
            "busy1",
            "none",
            "timeout1",
            "unreachable1",
            "refused1",
            "fails",
        ]
        .map(|id| capture(id, "POST", "/hooks"))
        .to_vec();
        assert_eq!(
            ids(undelivered(&client, due).await),
            ["offline1", "none", "unreachable1", "fails"]
        );
    }

    #[test]
    fn copies_go_at_once_while_the_relay_is_down() {
        // The normal fallback path waits for nothing.
        let mut relay = LiveRelay::default();
        assert!(forwards(&mut relay, "d1", "POST", "/hooks"));
        relay.on_update(&Update::Reconnected);
        relay.on_update(&dropped());
        assert!(forwards(&mut relay, "d2", "POST", "/hooks"));
        assert!(relay.held.is_empty());
    }
}
