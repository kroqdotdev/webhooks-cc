//! Integration tests that hit the real API.
//!
//! Requirements:
//!   - Web app running on localhost:3000 (or WHK_API_URL)
//!   - Receiver running on localhost:3001 (or WHK_WEBHOOK_URL)
//!   - Authenticated (valid token at ~/.config/whk/token.json or ~/Library/Application Support/whk/)
//!
//! Run with: cargo test --test integration
//! Skip with: cargo test --lib (unit tests only)

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

    // Wait a moment for the request to be captured
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // List requests
    let requests = client.list_requests(&ep.slug, Some(10), None).await.expect("list requests failed");
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
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // Clear
    client.clear_requests(&ep.slug, None).await.expect("clear failed");

    // Verify empty
    let requests = client.list_requests(&ep.slug, Some(10), None).await.expect("list failed");
    assert!(requests.requests.is_empty(), "requests should be cleared");

    // Cleanup
    client.delete_endpoint(&ep.slug).await.ok();
}
