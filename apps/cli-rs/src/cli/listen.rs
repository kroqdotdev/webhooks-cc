use anyhow::Result;
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::api::stream::join_stream;
use crate::cli::output::{
    bold, dim, green, method_color, print_reconnected, print_reconnecting, red,
};
use crate::cli::output::{sanitize, sanitize_line};
use crate::types::{CapturedRequest, SseEvent};
use crate::util::format::format_bytes;

/// Said once the server has opened the stream, so a slug that does not
/// exist (or is not yours) fails without saying it is listening first.
fn print_banner(client: &ApiClient, slug: &str) -> std::io::Result<()> {
    let url = client.webhook_url_for(slug);
    crate::try_outln!(
        "\n  {} Listening on {}",
        green("●"),
        bold(&sanitize_line(slug))
    )?;
    crate::try_outln!("  {} {}", dim("Webhook URL:"), sanitize_line(&url))?;
    crate::try_outln!("  {}\n", dim("Press Ctrl+C to stop."))
}

pub async fn run(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    let mut announced = json;

    // SSE stream (reconnects on its own; see ApiClient::stream_requests)
    let (tx, mut rx) = mpsc::channel(64);
    let stream_client = client.clone();
    let stream_slug = slug.to_string();

    let stream_handle =
        tokio::spawn(async move { stream_client.stream_requests(&stream_slug, tx).await });

    let mut reconnecting = false;
    let mut interrupted = false;
    // A reader that went away (`whk listen | head -1`) stops the stream as
    // Ctrl+C does: nobody reads what comes next. Output goes through
    // `try_outln!`, so a failed write ends the loop instead of panicking, and
    // main reads the error (a closed stdout is a quiet exit 0).
    let mut write_error: Option<std::io::Error> = None;

    // Process events until Ctrl+C, endpoint deletion, or a terminal stream error
    loop {
        tokio::select! {
            event = rx.recv() => {
                let Some(event) = event else { break };
                if !announced && matches!(event, SseEvent::Connected | SseEvent::Request(_)) {
                    announced = true;
                    write_error = print_banner(client, slug).err();
                }
                match event {
                    SseEvent::Request(req) => {
                        let written = if json {
                            crate::try_outln!("{}", serde_json::to_string(&req.json()).unwrap_or_default())
                        } else {
                            crate::try_outln!("{}", listen_line(&req))
                        };
                        if let Err(error) = written {
                            write_error = Some(error);
                        }
                    }
                    SseEvent::EndpointDeleted => {
                        if json {
                            crate::outln!("{}", serde_json::json!({ "event": "endpoint_deleted" }));
                        } else {
                            crate::outln!("\n  {} Endpoint was deleted.", red("●"));
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
                if write_error.is_some() {
                    break;
                }
            }
            _ = tokio::signal::ctrl_c() => {
                interrupted = true;
                break;
            }
        }
    }

    // Make any in-flight send in the stream task fail fast, then collect its result.
    drop(rx);
    if let Some(error) = write_error {
        stream_handle.abort();
        return Err(error.into());
    }
    join_stream(stream_handle, interrupted).await
}

/// One line per arrival: the time, the method, the path (for an email the
/// recipient and the subject), the signature check, the size and the id
/// (for `whk requests get`).
fn listen_line(req: &CapturedRequest) -> String {
    let time = chrono::Local::now().format("%H:%M:%S").to_string();
    // The stream sends an email's headers, not its parsed summary, so the
    // subject comes from either (`email_subject`).
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
    let signature = match req.signature_verified {
        Some(ok) => {
            let provider = sanitize(req.signing_provider.as_deref().unwrap_or("?"));
            let mark = if ok { green("✓") } else { red("✗") };
            format!(" {mark} {provider}")
        }
        None => String::new(),
    };
    format!(
        "  {} {} {}{}  {}  {}",
        dim(&time),
        method_color(&req.method),
        what,
        signature,
        dim(&format_bytes(req.size)),
        dim(&sanitize(&req.id)),
    )
}
