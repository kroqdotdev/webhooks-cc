use anyhow::{Context, Result};

use super::ApiClient;
use crate::types::{ClaimResponse, DeviceCodeResponse, PollResponse};

// The device login runs before there is a login, so these routes go without
// a bearer: a saved agent connection is never exchanged for them, and one
// the human disconnected (or a token endpoint that is briefly down) cannot
// stop `whk auth login`.
impl ApiClient {
    /// Start the device auth flow: creates a device code for the user to
    /// authorize. The approval page shows `client` and whether the login
    /// runs on another machine (`remote`), so the person can tell their own
    /// login from one someone sent them.
    pub async fn create_device_code(&self, remote: bool) -> Result<DeviceCodeResponse> {
        let client = format!("whk {} on {}", env!("WHK_VERSION"), std::env::consts::OS);
        let resp = self
            .post_anonymous(
                "/api/auth/device-code",
                &serde_json::json!({ "client": client, "remote": remote }),
            )
            .await?;
        serde_json::from_str(&resp.body).context("failed to parse device code response")
    }

    /// Poll the status of a device code: "pending", "authorized", "denied" or "expired".
    pub async fn poll_device_code(&self, device_code: &str) -> Result<PollResponse> {
        let resp = self
            .get_anonymous(&format!(
                "/api/auth/device-poll?code={}",
                crate::util::url::encode(device_code)
            ))
            .await?;
        serde_json::from_str(&resp.body).context("failed to parse poll response")
    }

    /// Claim a device code after user authorization, receiving an API key.
    pub async fn claim_device_code(&self, device_code: &str) -> Result<ClaimResponse> {
        let resp = self
            .post_anonymous(
                "/api/auth/device-claim",
                &serde_json::json!({ "deviceCode": device_code }),
            )
            .await?;
        serde_json::from_str(&resp.body).context("failed to parse claim response")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{CredentialStore, Slot, SlotKind};
    use axum::Router;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use std::sync::{Arc, Mutex};

    /// A saved account connection whose token endpoint is down: the device
    /// login neither exchanges its assertion nor sends a bearer.
    #[tokio::test]
    async fn the_device_login_sends_no_bearer_and_never_exchanges() {
        let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
        let exchanges = Arc::new(Mutex::new(0u32));
        let record = |seen: Arc<Mutex<Vec<Option<String>>>>, body: &'static str| {
            move |headers: HeaderMap| async move {
                let auth = headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .map(String::from);
                seen.lock().unwrap().push(auth);
                ([("content-type", "application/json")], body)
            }
        };
        let counted = exchanges.clone();
        let app = Router::new()
            .route(
                "/api/auth/device-code",
                post(record(
                    seen.clone(),
                    r#"{"deviceCode":"dc","userCode":"ABCD-1234","verificationUrl":"https://example.test/cli/verify","expiresAt":1900000000000}"#,
                )),
            )
            .route(
                "/api/auth/device-poll",
                get(record(seen.clone(), r#"{"status":"authorized"}"#)),
            )
            .route(
                "/api/auth/device-claim",
                post(record(
                    seen.clone(),
                    r#"{"apiKey":"whcc_login","userId":"u1","email":"dev@example.com"}"#,
                )),
            )
            .route(
                "/api/oauth2/token",
                post(move || async move {
                    *counted.lock().unwrap() += 1;
                    (StatusCode::SERVICE_UNAVAILABLE, "down").into_response()
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let dir = std::env::temp_dir().join(format!("whk-device-{:x}", rand::random::<u64>()));
        let store = CredentialStore::at(Some(dir.join("agent.json")), &base);
        let expires = crate::agent::credentials::format_timestamp(
            chrono::Utc::now().timestamp_millis() + 86_400_000,
        );
        let slot = Slot::new("reg-1", "claimed-assert", &expires, &[]).unwrap();
        store.save(SlotKind::Claimed, &slot);
        let client =
            ApiClient::with_credentials(Some(&base), Some(&base), None, Some(store)).unwrap();
        assert!(client.can_refresh(), "the client holds an agent connection");

        let device = client.create_device_code(false).await.unwrap();
        let poll = client.poll_device_code(&device.device_code).await.unwrap();
        let claim = client.claim_device_code(&device.device_code).await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(poll.status, "authorized");
        assert_eq!(claim.api_key, "whcc_login");
        assert_eq!(*seen.lock().unwrap(), vec![None, None, None]);
        assert_eq!(*exchanges.lock().unwrap(), 0);
    }

    /// The device code request says which client asks and whether it runs
    /// on another machine, and reads the link with the code in it when the
    /// server sends one (older servers do not).
    #[tokio::test]
    async fn the_device_code_carries_client_and_remote() {
        let body: Arc<Mutex<Option<serde_json::Value>>> = Arc::default();
        let seen = body.clone();
        let app = Router::new().route(
            "/api/auth/device-code",
            post(move |axum::Json(value): axum::Json<serde_json::Value>| async move {
                *seen.lock().unwrap() = Some(value);
                (
                    [("content-type", "application/json")],
                    r#"{"deviceCode":"dc","userCode":"ABCD-1234","verificationUrl":"https://example.test/cli/verify","verificationUrlComplete":"https://example.test/cli/verify?code=ABCD-1234","expiresAt":1900000000000}"#,
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ApiClient::with_credentials(Some(&base), Some(&base), None, None).unwrap();

        let device = client.create_device_code(true).await.unwrap();
        assert_eq!(
            device.verification_url_complete.as_deref(),
            Some("https://example.test/cli/verify?code=ABCD-1234")
        );
        let sent = body.lock().unwrap().clone().unwrap();
        assert_eq!(sent["remote"], true);
        assert!(sent["client"].as_str().unwrap().starts_with("whk "));

        let old: crate::types::DeviceCodeResponse = serde_json::from_str(
            r#"{"deviceCode":"dc","userCode":"ABCD-1234","verificationUrl":"https://x.test/cli/verify","expiresAt":1}"#,
        )
        .unwrap();
        assert_eq!(old.verification_url_complete, None);
    }
}
