use anyhow::Result;
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, method_color, red};
use crate::types::SseEvent;
use crate::util::format::format_bytes;

pub async fn run(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    if !json {
        let url = client.webhook_url_for(slug);
        println!("\n  {} Listening on {}", green("●"), bold(slug));
        println!("  {} {}", dim("Webhook URL:"), url);
        println!("  {}\n", dim("Press Ctrl+C to stop."));
    }

    let (tx, mut rx) = mpsc::channel(64);
    let stream_client = client.clone();
    let stream_slug = slug.to_string();

    let stream_handle = tokio::spawn(async move {
        stream_client.stream_requests(&stream_slug, tx).await
    });

    // Process events until Ctrl+C or stream ends
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
                            println!(
                                "  {} {} {} {}",
                                dim(&time.to_string()),
                                method_color(&req.method),
                                req.path,
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
                    SseEvent::Timeout => {
                        if !json {
                            println!("  {} Stream timed out.", dim("●"));
                        }
                    }
                    SseEvent::Connected => {}
                }
            }
            _ = tokio::signal::ctrl_c() => {
                break;
            }
        }
    }

    stream_handle.abort();
    Ok(())
}
