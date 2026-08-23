use anyhow::Result;
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::api::stream::join_stream;
use crate::cli::output::{
    bold, dim, green, method_color, print_reconnected, print_reconnecting, red,
};
use crate::types::SseEvent;
use crate::util::format::format_bytes;

pub async fn run(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    if !json {
        let url = client.webhook_url_for(slug);
        println!("\n  {} Listening on {}", green("●"), bold(slug));
        println!("  {} {}", dim("Webhook URL:"), url);
        println!("  {}\n", dim("Press Ctrl+C to stop."));
    }

    // SSE stream (reconnects on its own; see ApiClient::stream_requests)
    let (tx, mut rx) = mpsc::channel(64);
    let stream_client = client.clone();
    let stream_slug = slug.to_string();

    let stream_handle =
        tokio::spawn(async move { stream_client.stream_requests(&stream_slug, tx).await });

    let mut reconnecting = false;
    let mut interrupted = false;

    // Process events until Ctrl+C, endpoint deletion, or a terminal stream error
    loop {
        tokio::select! {
            event = rx.recv() => {
                let Some(event) = event else { break };
                match event {
                    SseEvent::Request(req) => {
                        if json {
                            println!("{}", serde_json::to_string(&req).unwrap_or_default());
                        } else {
                            let time = chrono::Local::now().format("%H:%M:%S");
                            let sig_status = match req.signature_verified {
                                Some(true) => {
                                    let provider = req.signing_provider.as_deref().unwrap_or("?");
                                    format!(" {} {}", green("✓"), provider)
                                }
                                Some(false) => {
                                    let provider = req.signing_provider.as_deref().unwrap_or("?");
                                    format!(" {} {}", red("✗"), provider)
                                }
                                None => String::new(),
                            };
                            println!(
                                "  {} {} {}{}  {}",
                                dim(&time.to_string()),
                                method_color(&req.method),
                                req.path,
                                sig_status,
                                dim(&format_bytes(req.size)),
                            );
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
            _ = tokio::signal::ctrl_c() => {
                interrupted = true;
                break;
            }
        }
    }

    // Make any in-flight send in the stream task fail fast, then collect its result.
    drop(rx);
    join_stream(stream_handle, interrupted).await
}
