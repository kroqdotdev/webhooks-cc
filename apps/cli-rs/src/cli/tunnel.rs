use anyhow::Result;
use std::collections::HashMap;
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::api::stream::join_stream;
use crate::cli::output::{
    bold, dim, green, method_color, print_reconnected, print_reconnecting, red, sanitize,
    sanitize_line,
};
use crate::share::{self, Kind, Rewrite, Session, Update};
use crate::tunnel::{EMAIL_SKIPPED, EmailOptions, Tunnel, email_target_url, parse_target};
use crate::types::{CapturedRequest, CreateEndpointRequest, EmailFormat, ForwardResult, SseEvent};

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
        };
        tokio::spawn(async move {
            let mut send = |update: Update| {
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
    // --live: whether the relay is up, and which captures it carried.
    let mut relay = LiveRelay::default();
    // --live refused before it was ever up (another relay, a limit, no
    // access): the tunnel ends with that as its error.
    let mut live_refused: Option<String> = None;

    // Process events until Ctrl+C, endpoint deletion, or a terminal stream error
    loop {
        tokio::select! {
            event = rx.recv() => {
                let Some(event) = event else { break };
                match event {
                    // --live: HTTP captures come through the edge while the
                    // relay is up; while it is not, they are forwarded from
                    // the stream like a plain tunnel's.
                    SseEvent::Request(req) if live && !req.is_email() && !relay.forward(&req.id, &req.method, &req.path) => {}
                    SseEvent::Request(req) => {
                        if live && !req.is_email() && relay.announce() {
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

                        let result = tunnel.forward(&req).await;

                        if json {
                            println!("{}", forwarded_event(&req, &result, email_format));
                        } else {
                            let status = if result.success {
                                green(&result.to_string())
                            } else {
                                red(&result.to_string())
                            };
                            println!("{}", request_line(&req, &status));
                        }
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
                    relay.on_update(&update);
                    show_live_update(update, json);
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
            _ = crate::cli::share::shutdown_signal() => {
                interrupted = true;
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

/// What `whk tunnel --live` says when the relay is down and captures come
/// from the stream instead.
const LIVE_FALLBACK: &str = "The live relay is not connected: forwarding captures from the stream like a plain tunnel until it is back (senders get 502 for 2 minutes, then the endpoint's mock).";

/// How long a capture is remembered on either side (the edge's relay line
/// or the stream's copy), so the two can be matched up.
const RELAYED_KEPT: std::time::Duration = std::time::Duration::from_secs(30);

/// At most this many remembered captures of each kind.
const RELAYED_MAX: usize = 512;

/// `whk tunnel --live`'s view of its relay: whether it is up, and which
/// captures it carried, so none is forwarded twice from the stream and none
/// it did not carry is skipped.
///
/// Every capture reaches the CLI twice: as the edge's line for the relay
/// (after the app answered) and as a copy on the stream (whenever the web app
/// sends it). Whichever comes first is remembered until the other matches
/// it. An edge that names the capture's id is matched by id; an older one by
/// method and path.
#[derive(Default)]
struct LiveRelay {
    connected: bool,
    announced: bool,
    /// Ids the edge said it relayed, not yet seen on the stream.
    relayed_ids: Vec<(String, std::time::Instant)>,
    /// Method and path of captures an older edge relayed (no id), not yet
    /// seen on the stream.
    relayed_routes: Vec<(String, String, std::time::Instant)>,
    /// Stream copies skipped while the relay was up, not yet named by the
    /// edge: by id and by route.
    seen_ids: Vec<(String, std::time::Instant)>,
    seen_routes: Vec<(String, String, std::time::Instant)>,
}

impl LiveRelay {
    fn prune(&mut self, now: std::time::Instant) {
        let fresh = |at: &std::time::Instant| now.duration_since(*at) < RELAYED_KEPT;
        self.relayed_ids.retain(|(_, at)| fresh(at));
        self.relayed_routes.retain(|(_, _, at)| fresh(at));
        self.seen_ids.retain(|(_, at)| fresh(at));
        self.seen_routes.retain(|(_, _, at)| fresh(at));
        for list in [&mut self.relayed_ids, &mut self.seen_ids] {
            if list.len() > RELAYED_MAX {
                list.drain(..list.len() - RELAYED_MAX);
            }
        }
        for list in [&mut self.relayed_routes, &mut self.seen_routes] {
            if list.len() > RELAYED_MAX {
                list.drain(..list.len() - RELAYED_MAX);
            }
        }
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
                let now = std::time::Instant::now();
                self.prune(now);
                let path = path_only(path);
                match request_id {
                    Some(id) => {
                        // The stream's copy came first: they are matched.
                        if let Some(i) = self.seen_ids.iter().position(|(s, _)| s == id) {
                            self.seen_ids.remove(i);
                        } else {
                            self.relayed_ids.push((id.clone(), now));
                        }
                    }
                    None => {
                        if let Some(i) = self
                            .seen_routes
                            .iter()
                            .position(|(m, p, _)| m.eq_ignore_ascii_case(method) && p == path)
                        {
                            self.seen_routes.remove(i);
                        } else {
                            self.relayed_routes
                                .push((method.clone(), path.to_string(), now));
                        }
                    }
                }
            }
            Update::Notice(_) => {}
        }
    }

    /// Whether a capture from the stream goes to the local app: never one
    /// the relay carried; otherwise only while the relay is down.
    fn forward(&mut self, id: &str, method: &str, path: &str) -> bool {
        let now = std::time::Instant::now();
        self.prune(now);
        let path = path_only(path);
        if let Some(i) = self.relayed_ids.iter().position(|(s, _)| s == id) {
            self.relayed_ids.remove(i);
            return false;
        }
        if let Some(i) = self
            .relayed_routes
            .iter()
            .position(|(m, p, _)| m.eq_ignore_ascii_case(method) && p == path)
        {
            self.relayed_routes.remove(i);
            return false;
        }
        if self.connected {
            // The edge has it (its line comes once the app answered):
            // remember the copy so that line finds it.
            self.seen_ids.push((id.to_string(), now));
            self.seen_routes
                .push((method.to_string(), path.to_string(), now));
            return false;
        }
        true
    }

    /// True the first time a capture is forwarded from the stream since the
    /// relay went down, to say so once.
    fn announce(&mut self) -> bool {
        !std::mem::replace(&mut self.announced, true)
    }
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

fn live_stopped(json: bool, reason: &str) {
    if json {
        println!(
            "{}",
            serde_json::json!({ "event": "live_stopped", "reason": reason })
        );
    } else {
        println!(
            "\n  {} Live relay stopped: {}",
            red("●"),
            sanitize_line(reason)
        );
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
        assert!(relay.forward("c0", "POST", "/hooks"));
        assert!(relay.announce());
        assert!(!relay.announce());
        relay.on_update(&Update::Reconnected);
        // Up: the edge carries them, whichever side arrives first.
        assert!(!relay.forward("c1", "POST", "/hooks"));
        relay.on_update(&relayed("POST", "/hooks?x=1", Some("c1")));
        relay.on_update(&relayed("POST", "/hooks", Some("c2")));
        relay.on_update(&dropped());
        // Down: the one it carried just before is not sent again, others are.
        assert!(!relay.forward("c2", "POST", "/hooks"));
        assert!(relay.forward("c3", "POST", "/hooks"));
        assert!(relay.forward("c4", "GET", "/other"));
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
                    assert!(!relay.forward(&id, "POST", "/hooks"));
                } else {
                    assert!(!relay.forward(&id, "POST", "/hooks"));
                    relay.on_update(&relayed("POST", "/hooks", named));
                }
            }
            relay.on_update(&dropped());
            for i in 0..10 {
                assert!(
                    relay.forward(&format!("n{i}"), "POST", "/hooks"),
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
        assert!(relay.forward("b", "POST", "/hooks"));
        // Its own copy, arriving late, is not sent twice.
        assert!(!relay.forward("a", "POST", "/hooks"));
    }
}
