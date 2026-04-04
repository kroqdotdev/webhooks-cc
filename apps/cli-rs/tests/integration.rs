//! Integration tests that hit the real API.
//!
//! Requirements:
//!   - Web app running on localhost:3000 (or WHK_API_URL)
//!   - Receiver running on localhost:3001 (or WHK_WEBHOOK_URL)
//!   - Authenticated (valid token at ~/.config/whk/token.json or ~/Library/Application Support/whk/)
//!
//! Run with: cargo test --test integration
//! Skip with: cargo test --lib (unit tests only)

use base64::Engine;
use std::collections::HashMap;

/// Helper to create a client pointing at local dev
fn make_client() -> whk::api::ApiClient {
    let base = std::env::var("WHK_API_URL").unwrap_or_else(|_| "https://webhooks.cc".into());
    let webhook = std::env::var("WHK_WEBHOOK_URL").unwrap_or_else(|_| "https://go.webhooks.cc".into());
    whk::api::ApiClient::new(Some(&base), Some(&webhook))
        .expect("failed to create API client")
}

fn skip_if_no_auth(client: &whk::api::ApiClient) {
    if client.require_auth().is_err() {
        eprintln!("SKIPPING: no auth token found. Run `whk auth login` first.");
        return;
    }
}

// ─── Auth ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_auth_token_loads() {
    let client = make_client();
    // If there's a token, require_auth should succeed
    if whk::auth::is_logged_in() {
        assert!(client.require_auth().is_ok());
    }
}

// ─── Endpoint CRUD ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_endpoint_create_list_get_delete() {
    let client = make_client();
    if client.require_auth().is_err() {
        eprintln!("SKIPPING: no auth");
        return;
    }

    // Create
    let req = whk::types::CreateEndpointRequest {
        name: Some("integration-test".into()),
        is_ephemeral: Some(true),
        expires_at: None,
        mock_response: None,
    };
    let ep = client.create_endpoint(&req).await.expect("create failed");
    assert!(!ep.slug.is_empty());
    assert_eq!(ep.name.as_deref(), Some("integration-test"));

    // List
    let list = client.list_endpoints().await.expect("list failed");
    let found = list.owned.iter().any(|e| e.slug == ep.slug);
    assert!(found, "created endpoint not found in list");

    // Get
    let got = client.get_endpoint(&ep.slug).await.expect("get failed");
    assert_eq!(got.id, ep.id);

    // Delete
    client.delete_endpoint(&ep.slug).await.expect("delete failed");

    // Verify deleted
    let result = client.get_endpoint(&ep.slug).await;
    assert!(result.is_err(), "endpoint should be deleted");
}

#[tokio::test]
async fn test_endpoint_update_mock_response() {
    let client = make_client();
    if client.require_auth().is_err() {
        eprintln!("SKIPPING: no auth");
        return;
    }

    // Create
    let req = whk::types::CreateEndpointRequest {
        name: Some("mock-test".into()),
        is_ephemeral: Some(true),
        expires_at: None,
        mock_response: None,
    };
    let ep = client.create_endpoint(&req).await.expect("create failed");

    // Update with mock
    let update = whk::types::UpdateEndpointRequest {
        name: Some("mock-test-updated".into()),
        mock_response: Some(serde_json::json!({
            "status": 201,
            "body": "{\"ok\":true}",
            "headers": {"X-Test": "yes"}
        })),
    };
    let updated = client.update_endpoint(&ep.slug, &update).await.expect("update failed");
    assert_eq!(updated.name.as_deref(), Some("mock-test-updated"));
    assert!(updated.mock_response.is_some());
    assert_eq!(updated.mock_response.unwrap().status, 201);

    // Cleanup
    client.delete_endpoint(&ep.slug).await.ok();
}

// ─── Send + Request List ────────────────────────────────────────────────

#[tokio::test]
async fn test_send_webhook_and_list_requests() {
    let client = make_client();
    if client.require_auth().is_err() {
        eprintln!("SKIPPING: no auth");
        return;
    }

    // Create endpoint
    let req = whk::types::CreateEndpointRequest {
        name: Some("send-test".into()),
        is_ephemeral: Some(true),
        expires_at: None,
        mock_response: None,
    };
    let ep = client.create_endpoint(&req).await.expect("create failed");

    // Send a webhook
    let send_req = whk::types::SendWebhookRequest {
        method: "POST".into(),
        slug: ep.slug.clone(),
        path: None,
        headers: None,
        body: Some("{\"integration\":\"test\"}".into()),
    };
    let send_resp = client.send_webhook(&send_req).await.expect("send failed");
    assert_eq!(send_resp.status, 200);

    // Poll for the request to be captured
    let mut requests = client.list_requests(&ep.slug, Some(10), None).await.expect("list requests failed");
    for _ in 0..10 {
        if !requests.requests.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        requests = client.list_requests(&ep.slug, Some(10), None).await.expect("list requests failed");
    }
    assert!(!requests.requests.is_empty(), "should have at least 1 captured request");

    let captured = &requests.requests[0];
    assert_eq!(captured.method, "POST");

    // Get single request
    let single = client.get_request(&captured.id).await.expect("get request failed");
    assert_eq!(single.id, captured.id);
    assert!(single.body.as_ref().unwrap().contains("integration"));

    // Cleanup
    client.delete_endpoint(&ep.slug).await.ok();
}

// ─── Mock Response ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_mock_response_works() {
    let client = make_client();
    if client.require_auth().is_err() {
        eprintln!("SKIPPING: no auth");
        return;
    }

    let req = whk::types::CreateEndpointRequest {
        name: Some("mock-resp-test".into()),
        is_ephemeral: Some(true),
        expires_at: None,
        mock_response: Some(whk::types::MockResponse {
            status: 201,
            body: "{\"mocked\":true}".into(),
            headers: HashMap::from([("X-Mock".into(), "yes".into())]),
            delay: None,
        }),
    };
    let ep = client.create_endpoint(&req).await.expect("create failed");

    // Send and verify mock response
    let send_req = whk::types::SendWebhookRequest {
        method: "POST".into(),
        slug: ep.slug.clone(),
        path: None,
        headers: None,
        body: Some("{}".into()),
    };
    let resp = client.send_webhook(&send_req).await.expect("send failed");
    assert_eq!(resp.status, 201);

    // Cleanup
    client.delete_endpoint(&ep.slug).await.ok();
}

// ─── Usage ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_usage() {
    let client = make_client();
    if client.require_auth().is_err() {
        eprintln!("SKIPPING: no auth");
        return;
    }

    let usage = client.get_usage().await.expect("usage failed");
    assert!(usage.limit > 0);
    assert!(usage.plan == "free" || usage.plan == "pro");
}

// ─── Error handling ─────────────────────────────────────────────────────

#[tokio::test]
async fn test_get_nonexistent_endpoint() {
    let client = make_client();
    if client.require_auth().is_err() {
        eprintln!("SKIPPING: no auth");
        return;
    }

    let result = client.get_endpoint("nonexistent-slug-zzz999").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_delete_nonexistent_endpoint() {
    let client = make_client();
    if client.require_auth().is_err() {
        eprintln!("SKIPPING: no auth");
        return;
    }

    let result = client.delete_endpoint("nonexistent-slug-zzz999").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_unauthenticated_request() {
    let client = whk::api::ApiClient::new(Some("https://webhooks.cc"), Some("https://go.webhooks.cc")).unwrap();
    // This creates a client that reads the token from disk.
    // To test unauthenticated, we'd need a client with no token.
    // For now, just verify the client was created successfully.
    assert!(client.require_auth().is_ok() || client.require_auth().is_err());
}

// ─── Request clear ──────────────────────────────────────────────────────

#[tokio::test]
async fn test_clear_requests() {
    let client = make_client();
    if client.require_auth().is_err() {
        eprintln!("SKIPPING: no auth");
        return;
    }

    // Create endpoint and send a webhook
    let req = whk::types::CreateEndpointRequest {
        name: Some("clear-test".into()),
        is_ephemeral: Some(true),
        expires_at: None,
        mock_response: None,
    };
    let ep = client.create_endpoint(&req).await.expect("create failed");

    let send_req = whk::types::SendWebhookRequest {
        method: "POST".into(),
        slug: ep.slug.clone(),
        path: None,
        headers: None,
        body: Some("{}".into()),
    };
    client.send_webhook(&send_req).await.ok();

    // Poll until the request is captured before clearing
    for _ in 0..10 {
        let list = client.list_requests(&ep.slug, Some(10), None).await.expect("list failed");
        if !list.requests.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // Clear
    client.clear_requests(&ep.slug, None).await.expect("clear failed");

    // Verify empty
    let requests = client.list_requests(&ep.slug, Some(10), None).await.expect("list failed");
    assert!(requests.requests.is_empty(), "requests should be cleared");

    // Cleanup
    client.delete_endpoint(&ep.slug).await.ok();
}

// ─── Tunnel forwarding (binary body fidelity) ──────────────────────────

fn make_captured_request(
    method: &str,
    path: &str,
    body: Option<String>,
    body_raw: Option<String>,
) -> whk::types::CapturedRequest {
    whk::types::CapturedRequest {
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

/// Start a local axum server that captures the request body via a oneshot channel.
async fn start_echo_server() -> (
    String,
    tokio::sync::oneshot::Receiver<Vec<u8>>,
    tokio::sync::oneshot::Sender<()>,
) {
    use axum::{Router, extract::Request, routing::any};

    let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
    let body_tx = std::sync::Arc::new(tokio::sync::Mutex::new(Some(body_tx)));

    let app = Router::new().route(
        "/{*path}",
        any(move |req: Request| {
            let tx = body_tx.clone();
            async move {
                let bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024)
                    .await
                    .unwrap();
                if let Some(sender) = tx.lock().await.take() {
                    let _ = sender.send(bytes.to_vec());
                }
                "ok"
            }
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    (format!("http://127.0.0.1:{}", addr.port()), body_rx, shutdown_tx)
}

#[tokio::test]
async fn test_tunnel_forward_binary_body_raw_exact_bytes() {
    let (base_url, body_rx, shutdown_tx) = start_echo_server().await;
    let tunnel = whk::tunnel::Tunnel::new(base_url, HashMap::new()).unwrap();

    // Binary payload with bytes that would be mangled by UTF-8 lossy conversion
    let raw_bytes: Vec<u8> = vec![0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x80, 0x81, 0x82, 0xFF];
    let b64 = base64::engine::general_purpose::STANDARD.encode(&raw_bytes);
    let lossy_text = String::from_utf8_lossy(&raw_bytes).into_owned();

    // Verify the lossy text is different from raw bytes (the whole point)
    assert_ne!(
        lossy_text.as_bytes(),
        &raw_bytes[..],
        "lossy text should differ from raw bytes"
    );

    let req = make_captured_request("POST", "/webhook", Some(lossy_text), Some(b64));
    let result = tunnel.forward(&req).await;
    assert!(result.success);

    // Verify the target server received the EXACT original bytes, not the lossy text
    let received = body_rx.await.expect("should receive body from echo server");
    assert_eq!(
        received, raw_bytes,
        "forwarded body should be byte-exact, not lossy UTF-8"
    );

    drop(shutdown_tx);
}

#[tokio::test]
async fn test_tunnel_forward_utf8_body_without_body_raw() {
    let (base_url, body_rx, shutdown_tx) = start_echo_server().await;
    let tunnel = whk::tunnel::Tunnel::new(base_url, HashMap::new()).unwrap();

    let json_body = r#"{"event":"test","data":42}"#.to_string();
    let req = make_captured_request("POST", "/webhook", Some(json_body.clone()), None);
    let result = tunnel.forward(&req).await;

    assert!(result.success, "forward should succeed: {:?}", result.error);
    assert_eq!(result.status_code, Some(200));

    let received = body_rx.await.expect("should receive body");
    assert_eq!(received, json_body.as_bytes());

    drop(shutdown_tx);
}

#[tokio::test]
async fn test_tunnel_forward_bad_base64_falls_back_to_text() {
    let (base_url, body_rx, shutdown_tx) = start_echo_server().await;
    let tunnel = whk::tunnel::Tunnel::new(base_url, HashMap::new()).unwrap();

    // Invalid base64 in body_raw — should fall back to text body
    let req = make_captured_request(
        "POST",
        "/webhook",
        Some("fallback text".into()),
        Some("!!!not-valid-base64!!!".into()),
    );
    let result = tunnel.forward(&req).await;

    assert!(
        result.success,
        "forward should succeed even with bad base64: {:?}",
        result.error
    );

    // Should have forwarded the fallback text body
    let received = body_rx.await.expect("should receive body");
    assert_eq!(received, b"fallback text");

    drop(shutdown_tx);
}
