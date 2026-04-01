use anyhow::{Context, Result};
use futures::StreamExt;
use std::time::Duration;
use tokio::sync::mpsc;

use super::ApiClient;
use crate::types::{CapturedRequest, SseEvent};

const MAX_BUFFER_SIZE: usize = 1024 * 1024; // 1 MB

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

        let sse_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .context("failed to create SSE client")?;

        let resp = sse_client
            .get(self.url(&format!("/api/stream/{}", urlencoding::encode(slug))))
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

            // Guard against unbounded buffer growth
            if buffer.len() > MAX_BUFFER_SIZE {
                buffer.clear();
                event_type.clear();
                data_lines.clear();
                continue;
            }

            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
                buffer.drain(..newline_pos + 1);

                if line.is_empty() {
                    if !data_lines.is_empty() {
                        let data = data_lines.join("\n");
                        let event = parse_sse_event(&event_type, &data);
                        if let Some(ev) = event {
                            if tx.send(ev).await.is_err() {
                                return Ok(());
                            }
                        }
                    }
                    event_type.clear();
                    data_lines.clear();
                } else if let Some(rest) = line.strip_prefix("event:") {
                    event_type = rest.trim().to_string();
                } else if let Some(rest) = line.strip_prefix("data:") {
                    data_lines.push(rest.trim_start().to_string());
                }
                // Comments (lines starting with ':') are silently ignored
            }
        }

        Ok(())
    }
}

fn parse_sse_event(event_type: &str, data: &str) -> Option<SseEvent> {
    match event_type {
        "connected" => {
            let _: serde_json::Value = serde_json::from_str(data).ok()?;
            Some(SseEvent::Connected)
        }
        "request" => {
            let req: CapturedRequest = serde_json::from_str(data).ok()?;
            Some(SseEvent::Request(req))
        }
        "endpoint_deleted" => Some(SseEvent::EndpointDeleted),
        "timeout" => Some(SseEvent::Timeout),
        _ => {
            if !data.is_empty() {
                if let Ok(req) = serde_json::from_str::<CapturedRequest>(data) {
                    return Some(SseEvent::Request(req));
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_connected_event() {
        let event = parse_sse_event("connected", r#"{"slug":"test","endpointId":"ep-1"}"#);
        assert!(matches!(event, Some(SseEvent::Connected)));
    }

    #[test]
    fn test_parse_connected_invalid_json() {
        let event = parse_sse_event("connected", "not json");
        assert!(event.is_none());
    }

    #[test]
    fn test_parse_request_event() {
        let data = r#"{"_id":"r1","endpointId":"ep","method":"POST","path":"/","headers":{},"queryParams":{},"ip":"1.2.3.4","size":0,"receivedAt":123}"#;
        let event = parse_sse_event("request", data);
        match event {
            Some(SseEvent::Request(req)) => {
                assert_eq!(req.id, "r1");
                assert_eq!(req.method, "POST");
            }
            _ => panic!("expected Request event"),
        }
    }

    #[test]
    fn test_parse_request_invalid_json() {
        let event = parse_sse_event("request", "not json");
        assert!(event.is_none());
    }

    #[test]
    fn test_parse_endpoint_deleted() {
        let event = parse_sse_event("endpoint_deleted", "");
        assert!(matches!(event, Some(SseEvent::EndpointDeleted)));
    }

    #[test]
    fn test_parse_timeout() {
        let event = parse_sse_event("timeout", "");
        assert!(matches!(event, Some(SseEvent::Timeout)));
    }

    #[test]
    fn test_parse_unknown_event_with_request_data() {
        let data = r#"{"id":"r1","endpointId":"ep","method":"GET","path":"/","headers":{},"queryParams":{},"ip":"1.2.3.4","size":0,"receivedAt":123}"#;
        let event = parse_sse_event("", data);
        assert!(matches!(event, Some(SseEvent::Request(_))));
    }

    #[test]
    fn test_parse_unknown_event_empty_data() {
        let event = parse_sse_event("", "");
        assert!(event.is_none());
    }

    #[test]
    fn test_parse_unknown_event_garbage_data() {
        let event = parse_sse_event("custom_event", "some random data");
        assert!(event.is_none());
    }
}
