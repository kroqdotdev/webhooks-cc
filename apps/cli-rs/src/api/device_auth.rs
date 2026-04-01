use anyhow::{Context, Result};

use super::ApiClient;
use crate::types::{ClaimResponse, DeviceCodeResponse, PollResponse};

impl ApiClient {
    /// Start the device auth flow — creates a device code for the user to authorize.
    pub async fn create_device_code(&self) -> Result<DeviceCodeResponse> {
        let resp = self.post("/api/auth/device-code", &serde_json::json!({})).await?;
        serde_json::from_str(&resp.body).context("failed to parse device code response")
    }

    /// Poll the status of a device code. Returns "pending", "authorized", or "expired".
    pub async fn poll_device_code(&self, device_code: &str) -> Result<PollResponse> {
        let resp = self
            .get(&format!("/api/auth/device-poll?code={}", urlencoding::encode(device_code)))
            .await?;
        serde_json::from_str(&resp.body).context("failed to parse poll response")
    }

    /// Claim a device code after user authorization, receiving an API key.
    pub async fn claim_device_code(&self, device_code: &str) -> Result<ClaimResponse> {
        let resp = self
            .post(
                "/api/auth/device-claim",
                &serde_json::json!({ "deviceCode": device_code }),
            )
            .await?;
        serde_json::from_str(&resp.body).context("failed to parse claim response")
    }
}
