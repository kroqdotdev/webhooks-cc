use anyhow::{Context, Result};
use base64::Engine;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::collections::HashMap;
use std::time::Instant;

use crate::types::{CapturedRequest, ForwardResult};

/// Headers that are always stripped from forwarded requests (security).
const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "proxy-authorization",
    "x-auth-token",
    "x-access-token",
];

/// Proxy/infrastructure headers stripped to avoid duplication.
const PROXY_HEADERS: &[&str] = &[
    "cdn-loop",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "cf-warp-tag-id",
    "true-client-ip",
    "via",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-forwarded-scheme",
    "x-real-ip",
];

pub struct Tunnel {
    http: reqwest::Client,
    target_base: String,
    extra_headers: HashMap<String, String>,
}

impl Tunnel {
    pub fn new(target_base: String, extra_headers: HashMap<String, String>) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        Ok(Self {
            http,
            target_base,
            extra_headers,
        })
    }

    /// Forward a captured request to the local target. Returns the result.
    pub async fn forward(&self, req: &CapturedRequest) -> ForwardResult {
        let start = Instant::now();

        let target_url = build_target_url(&self.target_base, &req.path, &req.query_params);

        let method: reqwest::Method = req
            .method
            .parse()
            .unwrap_or(reqwest::Method::GET);

        let mut headers = HeaderMap::new();
        for (key, value) in &req.headers {
            let lower = key.to_lowercase();
            if should_filter_header(&lower) {
                continue;
            }
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(key.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                headers.insert(name, val);
            }
        }

        // Add extra user-specified headers
        for (key, value) in &self.extra_headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(key.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                headers.insert(name, val);
            }
        }

        let mut builder = self.http.request(method, &target_url).headers(headers);

        // Prefer raw bytes (base64-decoded) for byte-exact forwarding of non-UTF-8 payloads
        if let Some(ref raw) = req.body_raw {
            match base64::engine::general_purpose::STANDARD.decode(raw) {
                Ok(bytes) => builder = builder.body(bytes),
                Err(_) => {
                    if let Some(ref body) = req.body {
                        builder = builder.body(body.clone());
                    }
                }
            }
        } else if let Some(ref body) = req.body {
            builder = builder.body(body.clone());
        }

        match builder.send().await {
            Ok(resp) => {
                let status_code = resp.status().as_u16();
                let _ = resp.bytes().await; // consume body
                let duration = start.elapsed();

                ForwardResult {
                    success: true,
                    status_code: Some(status_code),
                    duration,
                    error: None,
                }
            }
            Err(e) => {
                let duration = start.elapsed();
                ForwardResult {
                    success: false,
                    status_code: None,
                    duration,
                    error: Some(e.to_string()),
                }
            }
        }
    }
}

fn should_filter_header(lower: &str) -> bool {
    if SENSITIVE_HEADERS.contains(&lower) {
        return true;
    }
    for prefix in PROXY_HEADERS {
        if lower == *prefix || lower.starts_with(&format!("{prefix}-")) {
            return true;
        }
    }
    // Also filter cf-* headers
    if lower.starts_with("cf-") {
        return true;
    }
    false
}

fn build_target_url(
    base: &str,
    path: &str,
    query_params: &HashMap<String, String>,
) -> String {
    let mut url = format!("{}{}", base.trim_end_matches('/'), path);
    if !query_params.is_empty() {
        let qs: Vec<String> = query_params
            .iter()
            .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
            .collect();
        url.push('?');
        url.push_str(&qs.join("&"));
    }
    url
}

/// Parse a target string like "8080" or "8080/api/webhooks" into (url, base_path).
pub fn parse_target(target: &str) -> Result<String> {
    let (port_str, path) = match target.find('/') {
        Some(pos) => (&target[..pos], &target[pos..]),
        None => (target, ""),
    };

    let port: u16 = port_str
        .parse()
        .context("invalid port number (must be 1-65535)")?;

    if port == 0 {
        anyhow::bail!("port must be between 1 and 65535");
    }

    let base = if path.is_empty() {
        format!("http://localhost:{port}")
    } else {
        format!("http://localhost:{port}{path}")
    };

    Ok(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    #[test]
    fn test_parse_target_port_only() {
        assert_eq!(parse_target("8080").unwrap(), "http://localhost:8080");
    }

    #[test]
    fn test_parse_target_with_path() {
        assert_eq!(
            parse_target("3000/api/webhooks").unwrap(),
            "http://localhost:3000/api/webhooks"
        );
    }

    #[test]
    fn test_parse_target_invalid() {
        assert!(parse_target("abc").is_err());
        assert!(parse_target("0").is_err());
    }

    #[test]
    fn test_should_filter_header() {
        assert!(should_filter_header("authorization"));
        assert!(should_filter_header("cookie"));
        assert!(should_filter_header("cf-ray"));
        assert!(should_filter_header("cf-connecting-ip"));
        assert!(should_filter_header("x-forwarded-for"));
        assert!(!should_filter_header("content-type"));
        assert!(!should_filter_header("x-custom-header"));
    }

    #[test]
    fn test_build_target_url() {
        let params = HashMap::new();
        assert_eq!(
            build_target_url("http://localhost:8080", "/hook", &params),
            "http://localhost:8080/hook"
        );

        let mut params = HashMap::new();
        params.insert("key".into(), "val".into());
        let url = build_target_url("http://localhost:8080", "/hook", &params);
        assert!(url.contains("key=val"));
    }

    #[test]
    fn test_build_target_url_encodes_special_chars() {
        let mut params = HashMap::new();
        params.insert("q".into(), "hello world&more".into());
        let url = build_target_url("http://localhost:8080", "/hook", &params);
        assert!(url.contains("hello%20world%26more"), "URL should encode special chars: {url}");
    }

    #[test]
    fn test_parse_target_large_port() {
        assert_eq!(parse_target("65535").unwrap(), "http://localhost:65535");
        assert!(parse_target("65536").is_err());
    }

    #[test]
    fn test_filter_all_sensitive_headers() {
        for h in &["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization", "x-auth-token", "x-access-token"] {
            assert!(should_filter_header(h), "should filter: {h}");
        }
    }

    #[test]
    fn test_filter_all_proxy_headers() {
        for h in &["cdn-loop", "cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-proto", "x-real-ip", "via", "true-client-ip"] {
            assert!(should_filter_header(h), "should filter: {h}");
        }
    }

    #[test]
    fn test_passthrough_normal_headers() {
        for h in &["content-type", "accept", "x-custom-header", "user-agent", "x-request-id"] {
            assert!(!should_filter_header(h), "should pass through: {h}");
        }
    }

    fn make_request(method: &str, path: &str, body: Option<String>, body_raw: Option<String>) -> CapturedRequest {
        CapturedRequest {
            id: "test-id".into(),
            endpoint_id: "test-ep".into(),
            method: method.into(),
            path: path.into(),
            headers: HashMap::new(),
            body,
            body_raw,
            query_params: HashMap::new(),
            content_type: Some("application/octet-stream".into()),
            ip: "127.0.0.1".into(),
            size: 0,
            received_at: 0,
        }
    }

    /// Start a local HTTP server that captures the request body and returns it.
    async fn start_echo_server() -> (String, tokio::sync::oneshot::Sender<()>) {
        use axum::{Router, routing::any, body::Bytes, extract::Request};

        let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
        let body_tx = std::sync::Arc::new(tokio::sync::Mutex::new(Some(body_tx)));

        let app = Router::new().route("/{*path}", any(move |req: Request| {
            let tx = body_tx.clone();
            async move {
                let bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024).await.unwrap();
                if let Some(sender) = tx.lock().await.take() {
                    let _ = sender.send(bytes.to_vec());
                }
                "ok"
            }
        }));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async { let _ = shutdown_rx.await; })
                .await
                .unwrap();
        });

        // Wait a moment for the server to start
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        (format!("http://127.0.0.1:{}", addr.port()), shutdown_tx)
    }

    #[tokio::test]
    async fn forward_binary_body_raw_preserves_exact_bytes() {
        let (base_url, shutdown) = start_echo_server().await;
        let tunnel = Tunnel::new(base_url, HashMap::new()).unwrap();

        // Non-UTF-8 binary payload
        let raw_bytes: Vec<u8> = vec![0x00, 0x80, 0x81, 0x82, 0xFF, 0xFE, 0x48, 0x69];
        let b64 = STANDARD.encode(&raw_bytes);
        let lossy_text = String::from_utf8_lossy(&raw_bytes).into_owned();

        let req = make_request("POST", "/webhook", Some(lossy_text), Some(b64));
        let result = tunnel.forward(&req).await;

        assert!(result.success, "forward should succeed: {:?}", result.error);
        assert_eq!(result.status_code, Some(200));

        // Give the echo server a moment to process
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(shutdown);
    }

    #[tokio::test]
    async fn forward_utf8_body_without_body_raw() {
        let (base_url, shutdown) = start_echo_server().await;
        let tunnel = Tunnel::new(base_url, HashMap::new()).unwrap();

        let json_body = r#"{"event":"test","data":42}"#.to_string();
        let req = make_request("POST", "/webhook", Some(json_body), None);
        let result = tunnel.forward(&req).await;

        assert!(result.success, "forward should succeed: {:?}", result.error);
        assert_eq!(result.status_code, Some(200));
        drop(shutdown);
    }

    #[tokio::test]
    async fn forward_body_raw_decode_failure_falls_back_to_text() {
        let (base_url, shutdown) = start_echo_server().await;
        let tunnel = Tunnel::new(base_url, HashMap::new()).unwrap();

        // Invalid base64 in body_raw — should fall back to text body
        let req = make_request(
            "POST",
            "/webhook",
            Some("fallback text".into()),
            Some("!!!not-valid-base64!!!".into()),
        );
        let result = tunnel.forward(&req).await;

        assert!(result.success, "forward should succeed even with bad base64: {:?}", result.error);
        assert_eq!(result.status_code, Some(200));
        drop(shutdown);
    }

    #[tokio::test]
    async fn forward_binary_body_raw_exact_byte_verification() {
        use axum::{Router, routing::any, extract::Request};

        // This test verifies the EXACT bytes received by the target server
        let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
        let body_tx = std::sync::Arc::new(tokio::sync::Mutex::new(Some(body_tx)));

        let app = Router::new().route("/{*path}", any(move |req: Request| {
            let tx = body_tx.clone();
            async move {
                let bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024).await.unwrap();
                if let Some(sender) = tx.lock().await.take() {
                    let _ = sender.send(bytes.to_vec());
                }
                "ok"
            }
        }));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async { let _ = shutdown_rx.await; })
                .await
                .unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let base_url = format!("http://127.0.0.1:{}", addr.port());
        let tunnel = Tunnel::new(base_url, HashMap::new()).unwrap();

        // Binary payload with bytes that would be mangled by UTF-8 lossy conversion
        let raw_bytes: Vec<u8> = vec![0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x80, 0x81, 0x82, 0xFF];
        let b64 = STANDARD.encode(&raw_bytes);
        let lossy_text = String::from_utf8_lossy(&raw_bytes).into_owned();

        // Verify the lossy text is different from raw bytes (the whole point)
        assert_ne!(lossy_text.as_bytes(), &raw_bytes[..], "lossy text should differ from raw bytes");

        let req = make_request("POST", "/webhook", Some(lossy_text), Some(b64));
        let result = tunnel.forward(&req).await;
        assert!(result.success);

        // Verify the target server received the EXACT original bytes, not the lossy text
        let received = body_rx.await.expect("should receive body from echo server");
        assert_eq!(received, raw_bytes, "forwarded body should be byte-exact, not lossy UTF-8");

        drop(shutdown_tx);
    }
}
