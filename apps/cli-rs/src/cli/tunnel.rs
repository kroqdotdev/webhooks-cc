use anyhow::Result;
use std::collections::HashMap;
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::api::stream::join_stream;
use crate::cli::output::{
    bold, dim, green, method_color, print_reconnected, print_reconnecting, red,
};
use crate::tunnel::{Tunnel, parse_target};
use crate::types::{CreateEndpointRequest, SseEvent};

pub async fn run(
    client: &ApiClient,
    target: &str,
    endpoint_slug: Option<&str>,
    ephemeral: bool,
    headers: Vec<String>,
    json: bool,
) -> Result<()> {
    let target_url = parse_target(target)?;

    let mut extra_headers = HashMap::new();
    for h in &headers {
        let (k, v) = h
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("invalid header: {h} (expected Key:Value)"))?;
        extra_headers.insert(k.trim().to_string(), v.trim().to_string());
    }

    // Create or reuse endpoint
    let (slug, created) = match endpoint_slug {
        Some(s) => (s.to_string(), false),
        None => {
            let req = CreateEndpointRequest {
                name: None,
                is_ephemeral: if ephemeral { Some(true) } else { None },
                expires_at: None,
                mock_response: None,
            };
            let ep = client.create_endpoint(&req).await?;
            (ep.slug, true)
        }
    };

    let webhook_url = client.webhook_url_for(&slug);

    if json {
        println!(
            "{}",
            serde_json::json!({
                "event": "started",
                "slug": slug,
                "webhook_url": webhook_url,
                "target": target_url,
            })
        );
    } else {
        println!("\n  {} Tunnel active", green("●"));
        println!("  {} {}", dim("Webhook URL:"), bold(&webhook_url));
        println!("  {} {}", dim("Forwarding to:"), bold(&target_url));
        println!("  {}\n", dim("Press Ctrl+C to stop."));
    }

    let tunnel = Tunnel::new(target_url, extra_headers)?;

    // SSE stream (reconnects on its own; see ApiClient::stream_requests)
    let (tx, mut rx) = mpsc::channel(64);
    let stream_client = client.clone();
    let stream_slug = slug.clone();

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
                        let method = req.method.clone();
                        let path = req.path.clone();
                        let result = tunnel.forward(&req).await;

                        if json {
                            println!(
                                "{}",
                                serde_json::json!({
                                    "event": "forwarded",
                                    "method": method,
                                    "path": path,
                                    "status": result.status_code,
                                    "duration_ms": result.duration.as_millis(),
                                    "success": result.success,
                                })
                            );
                        } else {
                            let time = chrono::Local::now().format("%H:%M:%S");
                            let status = if result.success {
                                green(&result.to_string())
                            } else {
                                red(&result.to_string())
                            };
                            println!(
                                "  {} {} {} -> {}",
                                dim(&time.to_string()),
                                method_color(&method),
                                path,
                                status,
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

    stream_result
}
