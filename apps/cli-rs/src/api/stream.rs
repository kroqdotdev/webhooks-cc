use anyhow::{Context, Result};
use futures::StreamExt;
use tokio::sync::mpsc;

use super::ApiClient;
use crate::types::{CapturedRequest, SseEvent};

impl ApiClient {
    /// Connect to the SSE stream for an endpoint and send events to the channel.
    /// Blocks until the stream ends or the channel is closed.
    pub async fn stream_requests(
        &self,
        slug: &str,
        tx: mpsc::Sender<SseEvent>,
    ) -> Result<()> {
        self.require_auth()?;
        let headers = self.auth_headers()?;

        let resp = self
            .http
            .get(self.url(&format!("/api/stream/{slug}")))
            .headers(headers)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .send()
            .await
            .context("failed to connect to SSE stream")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("SSE stream error: {} {}", status, body);
        }

        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();
        let mut event_type = String::new();
        let mut data_lines: Vec<String> = Vec::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("stream read error")?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() {
                    // Dispatch event
                    if !data_lines.is_empty() {
                        let data = data_lines.join("\n");
                        let event = parse_sse_event(&event_type, &data);
                        if let Some(ev) = event {
                            if tx.send(ev).await.is_err() {
                                return Ok(()); // receiver dropped
                            }
                        }
                    }
                    event_type.clear();
                    data_lines.clear();
                } else if let Some(rest) = line.strip_prefix("event:") {
                    event_type = rest.trim().to_string();
                } else if let Some(rest) = line.strip_prefix("data:") {
                    data_lines.push(rest.trim_start().to_string());
                } else if line.starts_with(':') {
                    // Comment / keepalive — ignore
                }
            }
        }

        Ok(())
    }
}

fn parse_sse_event(event_type: &str, data: &str) -> Option<SseEvent> {
    match event_type {
        "connected" => Some(SseEvent::Connected {
            slug: data.to_string(),
        }),
        "request" => {
            let req: CapturedRequest = serde_json::from_str(data).ok()?;
            Some(SseEvent::Request(req))
        }
        "endpoint_deleted" => Some(SseEvent::EndpointDeleted),
        "timeout" => Some(SseEvent::Timeout),
        _ => {
            // Try parsing as a request if no explicit event type
            if !data.is_empty() {
                if let Ok(req) = serde_json::from_str::<CapturedRequest>(data) {
                    return Some(SseEvent::Request(req));
                }
            }
            None
        }
    }
}
